import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'

import { LIVE_PROFILE } from './paths.mjs'
import { ensureRegistryDirectories, generationId, writeGenerationMeta } from './registry.mjs'

const HOST_SINGLETON_PATTERNS = [/^react$/u, /^react-dom$/u, /^@deepseek-ai\//u]

const PACKAGE_NAME_PATTERN = /^(?:@[A-Za-z0-9-~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9-~][A-Za-z0-9._~-]*$/u
const GIT_ALLOW_BUILD_PATTERN = /^[A-Za-z0-9@/_.-]+@git\+https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u
const CODELOAD_ALLOW_BUILD_PATTERN = /^[A-Za-z0-9@/_.-]+@https:\/\/codeload\.github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/tar\.gz\/[0-9a-f]{40}$/u
const PINNED_GITHUB_TARGET_PATTERN = /^github:(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)#(?<sha>[0-9a-f]{40})(?<subpath>&path:\/(?:(?!\.\.?\/)[A-Za-z0-9_.-]+\/)*(?!\.\.?$)[A-Za-z0-9_.-]+)?$/u
const PINNED_GIT_APPROVAL_PATTERN = /@git\+ssh:\/\/git@github\.com\//u
const GENERATION_INSTALL_TIMEOUT_MS = 90 * 1000

function isHostSingleton(name) {
  return HOST_SINGLETON_PATTERNS.some((pattern) => pattern.test(name))
}

export function isElectronBinary(executablePath) {
  return typeof executablePath === 'string' &&
    basename(executablePath).toLowerCase().includes('electron')
}

export function generationInstallEnvironment(environment = process.env, executablePath) {
  const isElectron = isElectronBinary(executablePath)
  return {
    ...environment,
    ...(isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    CI: 'true',
    NO_COLOR: '1',
    npm_config_side_effects_cache: 'false'
  }
}

function safeBuildApprovalKey(key) {
  return PACKAGE_NAME_PATTERN.test(key) ||
    GIT_ALLOW_BUILD_PATTERN.test(key) ||
    CODELOAD_ALLOW_BUILD_PATTERN.test(key)
}

export function generationBuildApprovals(workspaceYaml) {
  if (typeof workspaceYaml !== 'string' || workspaceYaml === '') return []
  const blockPattern = /allowBuilds:[ \t]*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)*)/gu
  const approved = new Set()
  for (const block of workspaceYaml.matchAll(blockPattern)) {
    for (const line of block[1].split(/\r?\n/u)) {
      const match = /^[ \t]+(\S.*?)\s*:\s*(true|false)\s*$/u.exec(line)
      if (match === null || match[2] !== 'true') continue
      let key = match[1]
      if (
        key.length >= 2 &&
        ((key.startsWith("'") && key.endsWith("'")) ||
          (key.startsWith('"') && key.endsWith('"')))
      ) {
        key = key.slice(1, -1)
      }
      if (safeBuildApprovalKey(key)) approved.add(key)
    }
  }
  return [...approved]
}

export function pinnedGitBuildApproval(pluginName, pluginSpec, approvals) {
  if (!PACKAGE_NAME_PATTERN.test(pluginName)) return undefined
  const target = PINNED_GITHUB_TARGET_PATTERN.exec(pluginSpec)
  if (target?.groups === undefined) return undefined
  const { owner, repo, sha, subpath = '' } = target.groups
  const stable = `${pluginName}@git+https://github.com/${owner}/${repo}.git`
  const codeload = `${pluginName}@https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`
  if (!approvals.includes(stable) && !approvals.includes(codeload)) return undefined
  return `${pluginName}@git+ssh://git@github.com/${owner}/${repo}.git#${sha}${subpath}`
}

async function stageBuildApprovals(dshHome, stagingDir, profile, pluginName, pluginSpec) {
  const source = join(dshHome, 'profiles', profile, 'pnpm-workspace.yaml')
  let yaml
  try {
    yaml = await readFile(source, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const approvals = generationBuildApprovals(yaml)
  const pinned = pinnedGitBuildApproval(pluginName, pluginSpec, approvals)
  const stagedApprovals = pinned === undefined ? approvals : [...approvals, pinned]
  if (stagedApprovals.length === 0) return []
  const lines = [
    'packages:',
    '  - .',
    '',
    'allowBuilds:',
    ...stagedApprovals.map((key) => `  ${JSON.stringify(key)}: true`),
    ''
  ]
  await writeFile(join(stagingDir, 'pnpm-workspace.yaml'), lines.join('\n'), 'utf8')
  return stagedApprovals
}

async function defaultRunInstall(options, stagingDir) {
  const spawnProcess = options.spawnProcess ?? spawn
  return new Promise((resolve) => {
    const child = spawnProcess(
      options.nodeExecutablePath,
      [options.pnpmEntryPath, 'add', options.pluginSpec,
        ...(options.registry ? [`--registry=${options.registry}`] : []),
        ...(typeof options.autoInstallPeers === 'boolean'
          ? [`--config.auto-install-peers=${options.autoInstallPeers}`] : []),
        ...(options.strictDepBuilds === true ? ['--config.strict-dep-builds=true'] : []),
        ...(Number.isSafeInteger(options.minimumReleaseAge) && options.minimumReleaseAge >= 0
          ? [`--config.minimum-release-age=${options.minimumReleaseAge}`] : [])
      ],
      {
        cwd: stagingDir,
        env: generationInstallEnvironment(options.environment ?? process.env, options.nodeExecutablePath),
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let output = ''
    const collect = (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-64 * 1024)
      options.onOutput?.(chunk.toString())
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      options.installTimeoutMs ?? GENERATION_INSTALL_TIMEOUT_MS
    )
    options.registerChild?.(child)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, output })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: 1, output: `${output}\n${error.message}` })
    })
  })
}

function isInsideDirectory(parent, candidate) {
  const nested = relative(parent, candidate)
  return nested === '' || (!nested.startsWith('..') && !isAbsolute(nested))
}

async function pathInfo(path, missingAllowed = false) {
  try {
    return await lstat(path)
  } catch (error) {
    if (missingAllowed && error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function walkGenerationPackages(generationDir, visitor) {
  const rootInfo = await pathInfo(generationDir)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    await visitor.onUnsafePath(`generation root is not a real directory: ${generationDir}`)
    return
  }
  const root = await realpath(generationDir)

  const safeDirectoryEntries = async (directory, missingAllowed, description) => {
    const info = await pathInfo(directory, missingAllowed)
    if (info === undefined) return undefined
    if (info.isSymbolicLink() || !info.isDirectory()) {
      await visitor.onUnsafePath(`${description} is not a real directory: ${directory}`)
      return undefined
    }
    const resolved = await realpath(directory)
    if (!isInsideDirectory(root, resolved)) {
      await visitor.onUnsafePath(`${description} resolves outside the generation: ${resolved}`)
      return undefined
    }
    return readdir(directory, { withFileTypes: true })
  }

  const walkPackage = async (name, packagePath) => {
    const info = await pathInfo(packagePath)
    if (isHostSingleton(name)) {
      await visitor.onSingleton(name, packagePath, info)
      return
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      await visitor.onUnsafePath(`package ${name} is not a real directory: ${packagePath}`)
      return
    }
    const resolved = await realpath(packagePath)
    if (!isInsideDirectory(root, resolved)) {
      await visitor.onUnsafePath(`package ${name} resolves outside the generation: ${resolved}`)
      return
    }
    await visitor.onPackage(name, packagePath, root)
    await walkModules(join(packagePath, 'node_modules'), true)
  }

  const walkScope = async (scopeName, scopePath) => {
    const info = await pathInfo(scopePath)
    if (scopeName === '@deepseek-ai' && (info.isSymbolicLink() || !info.isDirectory())) {
      await visitor.onSingleton('@deepseek-ai/*', scopePath, info)
      return
    }
    const entries = await safeDirectoryEntries(scopePath, false, `package scope ${scopeName}`)
    if (entries === undefined) return
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      await walkPackage(`${scopeName}/${entry.name}`, join(scopePath, entry.name))
    }
  }

  async function walkModules(modules, missingAllowed) {
    const entries = await safeDirectoryEntries(modules, missingAllowed, 'node_modules')
    if (entries === undefined) return
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '.bin') continue
      const path = join(modules, entry.name)
      if (entry.name.startsWith('@')) await walkScope(entry.name, path)
      else await walkPackage(entry.name, path)
    }
  }

  await walkModules(join(generationDir, 'node_modules'), false)
}

async function hoistHostSingletons(generationDir) {
  const removed = []
  await walkGenerationPackages(generationDir, {
    async onPackage() {},
    async onSingleton(name, path, info) {
      if (info.isSymbolicLink()) await unlink(path)
      else await rm(path, { recursive: true, force: true })
      removed.push(name)
    },
    async onUnsafePath(detail) {
      throw new Error(`generation package tree is not self-contained: ${detail}`)
    }
  })
  return removed
}

function diagnosticLine(output) {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  const coded = lines.find((line) => /\bERR_[A-Z][A-Z0-9_]*\b/u.test(line))
  const named = lines.filter((line) => /EPERM|EBUSY|EEXIST|ENOENT|error/iu.test(line))
  return (coded ?? named.at(-1) ?? lines.at(-1))?.slice(0, 400)
}

export async function installGeneration(options) {
  if (typeof options.autoInstallPeers !== 'boolean') {
    const workspace = await readFile(
      join(options.dshHome, 'profiles', options.profile ?? LIVE_PROFILE, 'pnpm-workspace.yaml'),
      'utf8'
    ).catch((error) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    const policy = /^autoInstallPeers:[ \t]*(true|false)[ \t]*(?:#.*)?\r?$/m.exec(workspace)
    if (policy) options = { ...options, autoInstallPeers: policy[1] === 'true' }
  }
  const { dshHome, pluginSpec, onTrace } = options
  const trace = (line) => onTrace?.(`generation-install: ${line}`)
  const layout = await ensureRegistryDirectories(dshHome)
  const pluginName = options.expectedPluginName ?? (pluginSpec.replace(/@[^@/]+$/u, '') || pluginSpec)

  const stagingDir = join(layout.staging, randomUUID())
  await mkdir(stagingDir, { recursive: true })
  await writeFile(
    join(stagingDir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-generation', private: true, version: '0.0.0' }, undefined, 2)}\n`
  )
  const settings = ['node-linker=hoisted', 'side-effects-cache=false']
  if (options.strictDepBuilds === true) settings.push('strict-dep-builds=true')
  if (Number.isSafeInteger(options.minimumReleaseAge) && options.minimumReleaseAge >= 0) {
    settings.push(`minimum-release-age=${options.minimumReleaseAge}`)
  }
  if (typeof options.registry === 'string' && options.registry !== '') {
    settings.push(`registry=${options.registry.replace(/\/+$/u, '')}/`)
    trace(`pinned staging to ${options.registry}`)
  }
  await writeFile(join(stagingDir, '.npmrc'), `${settings.join('\n')}\n`)

  const cleanupStaging = () => rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)

  try {
    const approvals = await stageBuildApprovals(
      dshHome,
      stagingDir,
      options.profile ?? LIVE_PROFILE,
      pluginName,
      pluginSpec
    )
    if (approvals.length > 0) {
      trace(`forwarded ${approvals.length} approved build-script key(s) into staging`)
    }
    let installSpec = pluginSpec
    if (options.sourceDirectory !== undefined) {
      async function assertNoSymlinks(dir, base = dir) {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = join(dir, entry.name)
          const relPath = relative(base, fullPath)
          const stat = await lstat(fullPath)
          if (stat.isSymbolicLink()) {
            throw new Error(`source directory contains a symlink: ${relPath}`)
          }
          if (stat.isDirectory()) {
            await assertNoSymlinks(fullPath, base)
          }
        }
      }
      await assertNoSymlinks(options.sourceDirectory)

      const sourceCopy = join(stagingDir, 'source', pluginName.replace(/^@/u, '').replace(/[/\\]/gu, '+'))
      await mkdir(join(stagingDir, 'source'), { recursive: true })
      await cp(options.sourceDirectory, sourceCopy, { recursive: true, dereference: false })
      installSpec = `file:${sourceCopy}`
    }
    trace(`installing ${options.sourceSpec ?? pluginSpec} into staging`)
    const approvedGitPrepare = approvals.some((key) => PINNED_GIT_APPROVAL_PATTERN.test(key))
    const installEnvironment = approvedGitPrepare
      ? {
          ...(options.environment ?? process.env),
          npm_config_pm_on_fail: 'ignore',
          PNPM_CONFIG_PM_ON_FAIL: 'ignore'
        }
      : options.environment
    const runInstall = options.runInstall ?? ((dir) => defaultRunInstall({
      ...options,
      environment: installEnvironment,
      pluginSpec: installSpec
    }, dir))
    const started = Date.now()
    const { code, output } = await runInstall(stagingDir)
    if (code !== 0) {
      trace(`pnpm exited ${code} after ${Date.now() - started}ms`)
      for (const line of output.split(/\r?\n/u).slice(-8)) {
        if (line.trim()) trace(`output| ${line.trim()}`)
      }
      await cleanupStaging()
      return { ok: false, detail: diagnosticLine(output) ?? `pnpm exited ${code}` }
    }
    trace(`installed in ${Date.now() - started}ms`)

    const installedManifestPath = join(stagingDir, 'node_modules', pluginName, 'package.json')
    if (!existsSync(installedManifestPath)) {
      await cleanupStaging()
      return { ok: false, detail: `pnpm reported success but ${pluginName} is not on disk` }
    }
    const manifest = JSON.parse(await readFile(installedManifestPath, 'utf8'))
    if (manifest.name !== pluginName) {
      await cleanupStaging()
      return {
        ok: false,
        detail: `installed manifest name ${JSON.stringify(manifest.name)} does not match ${pluginName}`
      }
    }
    const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'

    if (options.expectedVersion !== undefined && version !== options.expectedVersion) {
      await cleanupStaging()
      return { ok: false, detail: `ERR_RESOLVED_VERSION_MISMATCH: expected ${options.expectedVersion}, installed ${version}` }
    }
    const hoisted = await hoistHostSingletons(stagingDir)
    if (hoisted.length > 0) {
      trace(`hoisted ${hoisted.length} host singletons: ${hoisted.slice(0, 6).join(', ')}…`)
    }

    const lockfileText = await readFile(join(stagingDir, 'pnpm-lock.yaml'), 'utf8').catch(() => randomUUID())
    const buildIdentity = options.strictDepBuilds === true || approvals.length > 0
      ? `\nbuild-policy-v1:${JSON.stringify([...approvals].sort())}:${process.platform}:${process.arch}` : ''
    const id = generationId(pluginName, version, lockfileText + buildIdentity)
    const generationDir = join(layout.generations, id)

    if (existsSync(generationDir)) {
      trace(`generation ${id} already exists, reusing`)
      await cleanupStaging()
    } else {
      await writeGenerationMeta(stagingDir, {
        pluginName,
        version,
        ...(options.sourceSpec === undefined ? {} : { sourceSpec: options.sourceSpec })
      })
      await rename(stagingDir, generationDir)
      trace(`promoted to ${id}`)
    }

    return { ok: true, hoisted, generation: { id, pluginName, version, directory: generationDir } }
  } catch (error) {
    await cleanupStaging()
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

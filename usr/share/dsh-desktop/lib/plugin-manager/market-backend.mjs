import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { profileDirectory, PROFILE_NAME_PATTERN } from './paths.mjs'
import { MARKET_PACKAGE } from './market-constants.mjs'
import { installGeneration, isElectronBinary } from './installer.mjs'
import { disableGeneration, listGenerations, readDesired, writeDesired } from './registry.mjs'
import { publishInstalledGeneration } from './projection.mjs'
import { assertSupportedDsh, resolveRunningDshVersion } from './dsh-version.mjs'

export function assertInstallableDshVersion(options = {}) {
  let version
  try {
    const resolve = options.resolveDshVersion ?? resolveRunningDshVersion
    version = options.dshVersion ?? resolve(options)
  } catch (err) {
    throw new Error(`Could not resolve the running DSH version; refusing to install. (${err.message})`)
  }
  if (version === null || version === undefined) {
    throw new Error('Could not resolve the running DSH version; refusing to install.')
  }
  assertSupportedDsh(version)
  return version
}

const OPERATION_TIMEOUT_MS = 15 * 60 * 1000
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export async function readMarketState(dshHome, profile) {
  if (typeof profile !== 'string' || !PROFILE_NAME_PATTERN.test(profile)) {
    throw new TypeError('profile is required')
  }
  const dir = profileDirectory(dshHome, profile)
  const manifest = (await readJson(join(dir, 'package.json'))) ?? {}
  const dependency = manifest.dependencies?.[MARKET_PACKAGE]
  const installed = await readJson(join(dir, 'node_modules', MARKET_PACKAGE, 'package.json'))
  return {
    dependency: typeof dependency === 'string' ? dependency : undefined,
    installedVersion: typeof installed?.version === 'string' ? installed.version : undefined
  }
}

export function resolveDshEntry(candidates = []) {
  const paths = [
    ...candidates,
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
  ]
  const found = paths.find((candidate) => existsSync(candidate))
  if (found === undefined) throw new Error('The running DSH entry could not be identified.')
  return found
}

function packageNameOf(spec) {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return spec
  return spec.slice(0, at)
}

export function routePluginSpec(spec) {
  if (typeof spec !== 'string' || !PACKAGE_NAME_PATTERN.test(packageNameOf(spec))) {
    throw new Error(`Invalid plugin specification: "${spec}"`)
  }
  return packageNameOf(spec) === MARKET_PACKAGE ? 'shared' : 'generation'
}

export function installPlugin(spec, options) {
  return routePluginSpec(spec) === 'shared'
    ? installMarketShared(options)
    : installCommunityPluginAsGeneration(spec, options)
}

export function runDshPlugin(options) {
  const {
    dshEntryPath,
    nodeExecutablePath = process.execPath,
    profile,
    args,
    environment = process.env,
    cwd,
    timeoutMs = OPERATION_TIMEOUT_MS,
    spawnProcess = spawn
  } = options

  if (typeof profile !== 'string' || !PROFILE_NAME_PATTERN.test(profile)) {
    throw new TypeError('profile is required')
  }

  const env = isElectronBinary(nodeExecutablePath)
    ? { ...environment, ELECTRON_RUN_AS_NODE: '1' }
    : environment

  return new Promise((resolve) => {
    const child = spawnProcess(
      nodeExecutablePath,
      [dshEntryPath, 'plugin', '--profile', profile, ...args],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let output = ''
    const collect = (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-64 * 1024)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
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

function diagnostic(output) {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  const coded = lines.find((line) => /\bERR_[A-Z][A-Z0-9_]*\b/u.test(line))
  return (coded ?? lines.at(-1) ?? '').slice(0, 400)
}

export async function installMarketShared(options) {
  assertInstallableDshVersion(options)
  const {
    dshHome,
    profile,
    recommendedVersion,
    dshEntryPath = resolveDshEntry(),
    nodeExecutablePath,
    environment,
    runPlugin = runDshPlugin
  } = options

  if (typeof profile !== 'string' || !PROFILE_NAME_PATTERN.test(profile)) {
    throw new TypeError('profile is required')
  }

  const spec = `${MARKET_PACKAGE}@${recommendedVersion}`
  const { code, output } = await runPlugin({
    dshEntryPath,
    nodeExecutablePath,
    profile,
    args: ['add', '--workspace-root', spec],
    environment,
    cwd: profileDirectory(dshHome, profile)
  })
  if (code !== 0) throw new Error(diagnostic(output) || `dsh plugin exited ${code}`)
}

export async function uninstallMarketShared(options) {
  const {
    dshHome,
    profile,
    dshEntryPath = resolveDshEntry(),
    nodeExecutablePath,
    environment,
    runPlugin = runDshPlugin
  } = options

  if (typeof profile !== 'string' || !PROFILE_NAME_PATTERN.test(profile)) {
    throw new TypeError('profile is required')
  }

  const { code, output } = await runPlugin({
    dshEntryPath,
    nodeExecutablePath,
    profile,
    args: ['remove', '--workspace-root', MARKET_PACKAGE],
    environment,
    cwd: profileDirectory(dshHome, profile)
  })
  if (code !== 0) throw new Error(diagnostic(output) || `dsh plugin exited ${code}`)
}

export async function installCommunityPluginAsGeneration(spec, options) {
  assertInstallableDshVersion(options)
  const { dshHome, profile, expectedVersion, ...installOptions } = options

  if (typeof profile !== 'string' || !PROFILE_NAME_PATTERN.test(profile)) {
    throw new TypeError('profile is required')
  }

  const result = await installGeneration({
    dshHome,
    profile,
    pluginSpec: spec,
    expectedVersion,
    ...installOptions
  })
  if (!result.ok) throw new Error(result.detail ?? 'generation installation failed')

  const desired = await readDesired(dshHome, profile)
  const generations = await listGenerations(dshHome)
  const byId = new Map(generations.map((generation) => [generation.id, generation]))
  const kept = desired.filter((id) => byId.get(id)?.pluginName !== result.generation.pluginName)
  await writeDesired(dshHome, profile, [...kept, result.generation.id])
  try {
    await publishInstalledGeneration(dshHome, result.generation.pluginName, profile, { syncBundles: true })
  } catch (error) {
    await writeDesired(dshHome, profile, desired)
    throw error
  }
  return result.generation
}

export async function disableCommunityPlugin(dshHome, profile, pluginName, options = {}) {
  if (typeof profile !== 'string' || !PROFILE_NAME_PATTERN.test(profile)) {
    throw new TypeError('profile is required')
  }
  if (!await disableGeneration(dshHome, profile, pluginName)) return false
  await options.publish?.(dshHome, pluginName)
  return true
}

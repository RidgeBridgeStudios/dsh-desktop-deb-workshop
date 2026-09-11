import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { LIVE_PROFILE, profileDirectory } from './paths.mjs'
import { MARKET_PACKAGE } from './market-constants.mjs'
import { installGeneration } from './installer.mjs'
import { disableGeneration, listGenerations, readDesired, writeDesired } from './registry.mjs'
import { publishInstalledGeneration } from './projection.mjs'

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

export async function readMarketState(dshHome, profile = LIVE_PROFILE) {
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

export function packageNameOf(spec) {
  const name = String(spec).replace(/@[^@/]+$/u, '')
  if (!PACKAGE_NAME_PATTERN.test(name)) throw new Error(`Unsafe package spec: ${spec}`)
  return name
}

export function routePluginSpec(spec) {
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
    profile = LIVE_PROFILE,
    args,
    environment = process.env,
    cwd,
    timeoutMs = OPERATION_TIMEOUT_MS,
    spawnProcess = spawn
  } = options

  return new Promise((resolve) => {
    const child = spawnProcess(
      nodeExecutablePath,
      [dshEntryPath, 'plugin', '--profile', profile, ...args],
      { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }
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
  const {
    dshHome,
    profile = LIVE_PROFILE,
    recommendedVersion,
    dshEntryPath = resolveDshEntry(),
    nodeExecutablePath,
    environment,
    runPlugin = runDshPlugin
  } = options
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
    profile = LIVE_PROFILE,
    dshEntryPath = resolveDshEntry(),
    nodeExecutablePath,
    environment,
    runPlugin = runDshPlugin
  } = options
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
  const { dshHome, profile = LIVE_PROFILE, expectedVersion, ...installOptions } = options
  const result = await installGeneration({
    dshHome,
    profile,
    pluginSpec: spec,
    expectedVersion,
    ...installOptions
  })
  if (!result.ok) throw new Error(result.detail ?? 'generation installation failed')

  const desired = await readDesired(dshHome)
  const generations = await listGenerations(dshHome)
  const byId = new Map(generations.map((generation) => [generation.id, generation]))
  const kept = desired.filter((id) => byId.get(id)?.pluginName !== result.generation.pluginName)
  await writeDesired(dshHome, [...kept, result.generation.id])
  try {
    await publishInstalledGeneration(dshHome, result.generation.pluginName, profile, { syncBundles: true })
  } catch (error) {
    await writeDesired(dshHome, desired)
    throw error
  }
  return result.generation
}

export async function disableCommunityPlugin(dshHome, pluginName, options = {}) {
  if (!await disableGeneration(dshHome, pluginName)) return false
  await options.publish?.(dshHome, pluginName)
  return true
}

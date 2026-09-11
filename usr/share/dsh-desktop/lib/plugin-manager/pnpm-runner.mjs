import { spawn } from 'node:child_process'
import { existsSync, realpathSync, watch } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolvePnpmEntry } from './pnpm-runtime.mjs'

export const IDLE_TIMEOUT_MS = Number(process.env.DSH_DESKTOP_PNPM_IDLE_TIMEOUT_MS) || 300_000
export const KILL_GRACE_MS = 5_000
export const STALL_AFTER_FAILURE_MS =
  Number(process.env.DSH_DESKTOP_PNPM_FAILURE_STALL_MS) || 20_000
export const RETRY_DELAY_MS = 750
export const MARKER = 'dsh-desktop pnpm runner:'

const PROJECTION_VERSION = 1
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu

const defaultFileSystem = { readFile, writeFile, rename, rm }

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function writeJsonAtomically(path, value, fs) {
  const temporary = `${path}.${process.pid}.${Date.now()}.pnpm-projection.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
    await fs.rename(temporary, path)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function suspendGenerationProjectionForPnpm(profileDirectory, options = {}) {
  const fs = options.fileSystem ?? defaultFileSystem
  const manifestPath = join(profileDirectory, 'package.json')
  let text
  try {
    text = await fs.readFile(manifestPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { plugins: [], restore: async () => undefined }
    throw error
  }

  let manifest
  try {
    manifest = JSON.parse(text)
  } catch (error) {
    throw new Error(`Profile manifest is invalid before pnpm projection isolation: ${errorText(error)}`)
  }
  if (!isRecord(manifest)) {
    throw new Error('Profile manifest root is invalid before pnpm projection isolation.')
  }

  const projection = manifest.dsh?.desktop?.generationProjection
  const projectedPlugins = projection?.version === PROJECTION_VERSION && isRecord(projection.plugins)
    ? Object.keys(projection.plugins).filter((name) => PACKAGE_NAME_PATTERN.test(name))
    : []
  if (projectedPlugins.length === 0) {
    return { plugins: [], restore: async () => undefined }
  }

  const dependencies = manifest.dependencies === undefined ? {} : manifest.dependencies
  const pnpm = manifest.pnpm === undefined ? {} : manifest.pnpm
  const overrides = pnpm.overrides === undefined ? {} : pnpm.overrides
  if (!isRecord(dependencies) || !isRecord(pnpm) || !isRecord(overrides)) {
    throw new Error('Profile dependency fields are invalid before pnpm projection isolation.')
  }

  const owned = new Map(projectedPlugins.map((name) => [name, {
    dependency: Object.hasOwn(dependencies, name)
      ? { present: true, value: dependencies[name] }
      : { present: false },
    override: Object.hasOwn(overrides, name)
      ? { present: true, value: overrides[name] }
      : { present: false }
  }]))
  let changed = false
  for (const name of projectedPlugins) {
    if (Object.hasOwn(dependencies, name)) {
      delete dependencies[name]
      changed = true
    }
    if (Object.hasOwn(overrides, name)) {
      delete overrides[name]
      changed = true
    }
  }
  if (!changed) return { plugins: [], restore: async () => undefined }

  manifest.dependencies = dependencies
  if (Object.keys(overrides).length > 0) pnpm.overrides = overrides
  else delete pnpm.overrides
  if (Object.keys(pnpm).length > 0) manifest.pnpm = pnpm
  else delete manifest.pnpm
  await writeJsonAtomically(manifestPath, manifest, fs)

  let restored = false
  return {
    plugins: projectedPlugins,
    restore: async () => {
      if (restored) return
      const currentText = await fs.readFile(manifestPath, 'utf8')
      let current
      try {
        current = JSON.parse(currentText)
      } catch (error) {
        throw new Error(`Profile manifest is invalid after pnpm projection isolation: ${errorText(error)}`)
      }
      if (!isRecord(current)) {
        throw new Error('Profile manifest root is invalid after pnpm projection isolation.')
      }
      const currentDependencies = isRecord(current.dependencies) ? current.dependencies : {}
      const currentPnpm = isRecord(current.pnpm) ? current.pnpm : {}
      const currentOverrides = isRecord(currentPnpm.overrides) ? currentPnpm.overrides : {}
      for (const [name, state] of owned) {
        if (state.dependency.present) currentDependencies[name] = state.dependency.value
        else delete currentDependencies[name]
        if (state.override.present) currentOverrides[name] = state.override.value
        else delete currentOverrides[name]
      }
      current.dependencies = currentDependencies
      if (Object.keys(currentOverrides).length > 0) currentPnpm.overrides = currentOverrides
      else delete currentPnpm.overrides
      if (Object.keys(currentPnpm).length > 0) current.pnpm = currentPnpm
      else delete current.pnpm
      await writeJsonAtomically(manifestPath, current, fs)
      restored = true
    }
  }
}

function watchProfileActivity(onActivity, cwd = process.cwd()) {
  const watchers = []
  for (const directory of [cwd, join(cwd, 'node_modules'), join(cwd, 'node_modules', '.pnpm')]) {
    try {
      if (!existsSync(directory)) continue
      const watcher = watch(directory, { persistent: false }, onActivity)
      watcher.on('error', () => undefined)
      watchers.push(watcher)
    } catch {
      // An unwatchable directory just does not contribute liveness.
    }
  }
  return () => {
    for (const watcher of watchers) watcher.close()
  }
}

function killTree(child) {
  if (typeof child.pid !== 'number') return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // The direct kill above is the guarantee; this is best effort.
    }
  }
}

export function runPnpm(executable, args, options = {}) {
  const {
    spawnProcess = spawn,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
    killGraceMs = KILL_GRACE_MS,
    kill = killTree,
    watchActivity = watchProfileActivity,
    report = (message) => process.stderr.write(`${MARKER} ${message}\n`),
    environment = process.env,
    cwd = process.cwd(),
    signal
  } = options

  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd,
      env: environment,
      detached: true
    })
    let output = ''
    let idle
    let grace
    let stopped = false
    let settled = false
    let lastActivity = Date.now()
    let onAbort
    const touch = () => {
      lastActivity = Date.now()
    }
    const stopWatching = idleTimeoutMs > 0 ? watchActivity(touch, cwd) : undefined

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(idle)
      clearTimeout(grace)
      stopWatching?.()
      if (onAbort !== undefined && signal !== undefined) {
        signal.removeEventListener('abort', onAbort)
      }
      resolve({ ...result, output, idleTimedOut: stopped })
    }
    const heartbeat = () => {
      clearTimeout(idle)
      if (idleTimeoutMs <= 0) return
      const quietFor = Date.now() - lastActivity
      idle = setTimeout(() => {
        const silence = Date.now() - lastActivity
        if (silence < idleTimeoutMs) {
          heartbeat()
          return
        }
        stopped = true
        report(`pnpm produced no output and touched nothing for ${Math.round(silence / 1000)}s; stopping it`)
        kill(child)
        grace = setTimeout(() => finish({ code: 1, signal: null }), killGraceMs)
        grace.unref?.()
      }, Math.max(idleTimeoutMs - quietFor, 1_000))
      idle.unref?.()
    }
    const cancel = () => {
      if (settled) return
      stopped = true
      report('cancelled; stopping pnpm')
      kill(child)
      grace = setTimeout(() => finish({ code: 1, signal: null }), killGraceMs)
      grace.unref?.()
    }
    if (signal !== undefined) {
      onAbort = cancel
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const observe = (chunk, stream) => {
      output = `${output}${chunk}`.slice(-256 * 1024)
      stream.write(chunk)
      touch()
    }

    child.stdout.on('data', (chunk) => observe(chunk, process.stdout))
    child.stderr.on('data', (chunk) => observe(chunk, process.stderr))
    child.once('error', (error) => {
      clearTimeout(idle)
      clearTimeout(grace)
      stopWatching?.()
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    child.once('exit', (code, signalName) => finish({ code: stopped ? 1 : code, signal: signalName }))
    heartbeat()
  })
}

export async function runPnpmWithProjectionSuspension(executable, args, options = {}) {
  const profileDirectory = options.profileDirectory ?? process.cwd()
  const isolateProjection = options.isolateProjection ?? suspendGenerationProjectionForPnpm
  const report = options.report ?? ((message) => process.stderr.write(`${MARKER} ${message}\n`))
  const isolation = await isolateProjection(profileDirectory, options.isolationOptions)
  if (isolation.plugins.length > 0) {
    report(`excluded ${isolation.plugins.length} generation projection(s) from pnpm`)
  }
  try {
    return await runPnpm(executable, args, options)
  } finally {
    await isolation.restore()
    if (isolation.plugins.length > 0) {
      report(`restored ${isolation.plugins.length} generation projection(s) after pnpm`)
    }
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

export async function ensurePnpmShim(home) {
  const directory = join(home, '.desktop-bin')
  await mkdir(directory, { recursive: true })
  const pnpmEntry = resolvePnpmEntry()
  const executable = process.execPath
  const runner = fileURLToPath(new URL('./pnpm-runner.mjs', import.meta.url))

  const pnpmPath = join(directory, 'pnpm')
  await writeFile(
    pnpmPath,
    `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${shellQuote(executable)} ${shellQuote(runner)} ${shellQuote(pnpmEntry)} "$@"\n`,
    { encoding: 'utf8', mode: 0o755 }
  )
  await chmod(pnpmPath, 0o755)

  const nodePath = join(directory, 'node')
  await writeFile(
    nodePath,
    `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${shellQuote(executable)} "$@"\n`,
    { encoding: 'utf8', mode: 0o755 }
  )
  await chmod(nodePath, 0o755)

  return directory
}

function isCommandEntry() {
  try {
    return process.argv[1] !== undefined &&
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (isCommandEntry()) {
  const [pnpmEntry, ...pnpmArguments] = process.argv.slice(2)
  if (pnpmEntry === undefined) {
    process.stderr.write('dsh-desktop: the pnpm runner needs the pnpm entry path.\n')
    process.exitCode = 1
  } else {
    const result = await runPnpmWithProjectionSuspension(
      process.execPath,
      [pnpmEntry, ...pnpmArguments],
      { profileDirectory: process.cwd() }
    )
    if (result.signal) {
      process.stderr.write(`dsh-desktop: pnpm terminated with ${result.signal}.\n`)
      process.exitCode = 1
    } else {
      process.exitCode = result.code ?? 1
    }
  }
}

export const RUNNER_PATH = fileURLToPath(import.meta.url)

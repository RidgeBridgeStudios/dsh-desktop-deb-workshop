import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  IDLE_TIMEOUT_MS,
  KILL_GRACE_MS,
  MARKER,
  RETRY_DELAY_MS,
  STALL_AFTER_FAILURE_MS,
  ensurePnpmShim,
  runPnpm,
  runPnpmWithProjectionSuspension,
  suspendGenerationProjectionForPnpm
} from '../usr/share/dsh-desktop/lib/plugin-manager/pnpm-runner.mjs'
import { buildPnpmEnvironment } from '../usr/share/dsh-desktop/lib/plugin-manager/pnpm-runtime.mjs'
import { generationInstallEnvironment } from '../usr/share/dsh-desktop/lib/plugin-manager/installer.mjs'

async function scratch(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-runner-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

async function profileWithProjection(home) {
  const dir = join(home, 'profiles', 'default')
  await mkdir(dir, { recursive: true })
  const manifest = {
    name: 'dsh-profile-default',
    private: true,
    dependencies: { widget: '1.0.0', other: '^2.0.0' },
    pnpm: { overrides: { widget: 'link:../../.generations/live/widget+1.0.0+abc/node_modules/widget' } },
    dsh: {
      profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'widget'] },
      desktop: {
        generationProjection: {
          version: 1,
          plugins: {
            widget: {
              generationId: 'widget+1.0.0+abc',
              visibleVersion: '1.0.0',
              previousOverride: { present: false }
            }
          }
        }
      }
    }
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2))
  return dir
}

async function readManifest(dir) {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
}

function capture() {
  const lines = []
  return { lines, report: (message) => lines.push(message) }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function pidAlive(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return false
    }
    await delay(50)
  }
  return true
}

test('markers and constants match the reference contract', () => {
  assert.equal(MARKER, 'dsh-desktop pnpm runner:')
  assert.equal(IDLE_TIMEOUT_MS, 300_000)
  assert.equal(KILL_GRACE_MS, 5_000)
  assert.equal(STALL_AFTER_FAILURE_MS, 20_000)
  assert.equal(RETRY_DELAY_MS, 750)
})

test('suspend removes projected deps and overrides, and restore puts them back', async (t) => {
  const home = await scratch(t)
  const dir = await profileWithProjection(home)

  const isolation = await suspendGenerationProjectionForPnpm(dir)
  assert.deepEqual(isolation.plugins, ['widget'])
  const isolated = await readManifest(dir)
  assert.equal(Object.hasOwn(isolated.dependencies, 'widget'), false)
  assert.equal(isolated.dependencies.other, '^2.0.0')
  assert.equal(isolated.pnpm?.overrides?.widget, undefined)
  assert.equal(isolated.dsh.profile.bundles.includes('widget'), true)

  await isolation.restore()
  const restored = await readManifest(dir)
  assert.equal(restored.dependencies.widget, '1.0.0')
  assert.match(restored.pnpm.overrides.widget, /^link:/u)

  await isolation.restore()
  assert.deepEqual(await readManifest(dir), restored)
})

test('suspend is a no-op without a generation projection marker', async (t) => {
  const home = await scratch(t)
  const dir = join(home, 'profiles', 'default')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { a: '1.0.0' } }))

  const isolation = await suspendGenerationProjectionForPnpm(dir)
  assert.deepEqual(isolation.plugins, [])
  await isolation.restore()
  assert.equal((await readManifest(dir)).dependencies.a, '1.0.0')
})

test('the all-or-nothing fileSystem seam is used for suspension and restore', async (t) => {
  const home = await scratch(t)
  const dir = await profileWithProjection(home)
  const calls = []
  const real = await import('node:fs/promises')
  const fileSystem = {
    readFile: async (...args) => { calls.push('readFile'); return real.readFile(...args) },
    writeFile: async (...args) => { calls.push('writeFile'); return real.writeFile(...args) },
    rename: async (...args) => { calls.push('rename'); return real.rename(...args) },
    rm: async (...args) => { calls.push('rm'); return real.rm(...args) }
  }

  const isolation = await suspendGenerationProjectionForPnpm(dir, { fileSystem })
  await isolation.restore()
  assert.ok(calls.includes('readFile'))
  assert.ok(calls.includes('writeFile'))
  assert.ok(calls.includes('rename'))
})

test('restores the projection after a successful pnpm run', async (t) => {
  const home = await scratch(t)
  const dir = await profileWithProjection(home)
  const { lines, report } = capture()

  const result = await runPnpmWithProjectionSuspension(
    process.execPath,
    ['-e', 'process.exit(0)'],
    { profileDirectory: dir, report }
  )

  assert.equal(result.code, 0)
  assert.equal((await readManifest(dir)).dependencies.widget, '1.0.0')
  assert.equal(lines.some((line) => line.includes('excluded 1 generation projection')), true)
  assert.equal(lines.some((line) => line.includes('restored 1 generation projection')), true)
})

test('restores the projection even when pnpm fails', async (t) => {
  const home = await scratch(t)
  const dir = await profileWithProjection(home)

  const result = await runPnpmWithProjectionSuspension(
    process.execPath,
    ['-e', 'process.exit(3)'],
    { profileDirectory: dir, report: () => undefined }
  )

  assert.equal(result.code, 3)
  assert.equal((await readManifest(dir)).dependencies.widget, '1.0.0')
  assert.match((await readManifest(dir)).pnpm.overrides.widget, /^link:/u)
})

test('stops an idle pnpm run and reports it', async (t) => {
  const home = await scratch(t)
  const { lines, report } = capture()

  const result = await runPnpm(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 60_000)'],
    { cwd: home, idleTimeoutMs: 200, killGraceMs: 500, report }
  )

  assert.equal(result.idleTimedOut, true)
  assert.equal(result.code, 1)
  assert.equal(lines.some((line) => line.includes('stopping it')), true)
})

test('kills the whole process tree on idle, including grandchildren', async (t) => {
  const home = await scratch(t)
  const script = [
    "const { spawn } = require('node:child_process')",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' })",
    'console.log(grandchild.pid)',
    'setInterval(() => {}, 1_000)'
  ].join('\n')

  const result = await runPnpm(process.execPath, ['-e', script], {
    cwd: home,
    idleTimeoutMs: 500,
    killGraceMs: 800,
    report: () => undefined
  })

  const grandchildPid = Number.parseInt(result.output.trim().split(/\s+/u)[0], 10)
  assert.equal(Number.isInteger(grandchildPid), true)
  assert.equal(await pidAlive(grandchildPid), false)
})

test('the pnpm shim is prepended to PATH for profile operations but not generation installs', async (t) => {
  const home = await scratch(t)
  const shimDir = await ensurePnpmShim(home)

  const shim = await readFile(join(shimDir, 'pnpm'), 'utf8')
  assert.match(shim, /ELECTRON_RUN_AS_NODE=1/u)
  assert.match(shim, /pnpm-runner\.mjs/u)
  assert.equal(existsSync(join(shimDir, 'node')), true)

  const profileEnv = buildPnpmEnvironment(shimDir, { PATH: '/usr/bin' }, process.execPath)
  assert.equal(profileEnv.PATH.split(':')[0], shimDir)

  const generationEnv = generationInstallEnvironment({ PATH: '/usr/bin' })
  assert.equal(generationEnv.PATH, '/usr/bin')
  assert.equal(generationEnv.PATH.includes(shimDir), false)
})

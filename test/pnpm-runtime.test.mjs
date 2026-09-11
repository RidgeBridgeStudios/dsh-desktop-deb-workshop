import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  buildPnpmEnvironment,
  resolvePnpmEntry
} from '../usr/share/dsh-desktop/lib/plugin-manager/pnpm-runtime.mjs'

function run(executable, args, options) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => resolve({ code: 1, stdout, stderr: String(error) }))
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function resolveElectron() {
  if (process.versions.electron) return process.execPath
  const candidates = [
    process.env.DSH_TEST_ELECTRON,
    '/usr/bin/electron',
    '/usr/lib/electron/electron'
  ]
  return candidates.find((candidate) => typeof candidate === 'string' && existsSync(candidate))
}

async function fakeElectronHelper(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-electron-helper-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const helper = join(dir, 'electron')
  const script = [
    '#!/bin/sh',
    'if [ -z "${ELECTRON_RUN_AS_NODE:-}" ]; then',
    '  exit 0',
    'fi',
    `exec ${JSON.stringify(process.execPath)} "$@"`
  ].join('\n')
  await writeFile(helper, `${script}\n`, 'utf8')
  await chmod(helper, 0o755)
  return helper
}

test('resolvePnpmEntry resolves the bundled entry without consulting PATH', () => {
  const saved = process.env.PATH
  process.env.PATH = ''
  try {
    const entry = resolvePnpmEntry()
    assert.equal(existsSync(entry), true)
    assert.match(entry, /[\\/]pnpm[\\/]bin[\\/]pnpm\.cjs$/u)
  } finally {
    process.env.PATH = saved
  }
})

test('resolvePnpmEntry throws when the bundled pnpm package is absent', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-no-pnpm-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const anchor = join(dir, 'anchor.mjs')
  await writeFile(anchor, 'export default undefined\n', 'utf8')
  assert.throws(
    () => resolvePnpmEntry(pathToFileURL(anchor).href),
    /pnpm/u
  )
})

test('buildPnpmEnvironment passes ELECTRON_RUN_AS_NODE through instead of deleting it', () => {
  const withFlag = buildPnpmEnvironment('/bin', {
    PATH: '/usr/bin',
    ELECTRON_RUN_AS_NODE: '1'
  }, '/opt/electron')
  assert.equal(withFlag.ELECTRON_RUN_AS_NODE, '1')

  const withoutFlag = buildPnpmEnvironment('/bin', { PATH: '/usr/bin' }, '/opt/electron')
  assert.equal(Object.hasOwn(withoutFlag, 'ELECTRON_RUN_AS_NODE'), false)
})

test('buildPnpmEnvironment pins pnpm-safe settings and dedupes PATH', () => {
  const env = buildPnpmEnvironment('/bin', { PATH: `/bin${delimiter}/usr/bin` }, '/opt/electron')
  const parts = env.PATH.split(delimiter)
  assert.equal(parts[0], '/bin')
  assert.equal(parts[1], '/opt')
  assert.equal(new Set(parts).size, parts.length)
  assert.equal(env.CI, 'true')
  assert.equal(env.NO_COLOR, '1')
  assert.equal(env.npm_config_side_effects_cache, 'false')
  assert.equal(env.PNPM_CONFIG_SIDE_EFFECTS_CACHE, 'false')
})

test('a Node-mode child runs the packaged pnpm entry; a stripped child silently no-ops', async (t) => {
  const helper = await fakeElectronHelper(t)
  const entry = resolvePnpmEntry()
  const binDir = dirname(entry)

  const nodeModeEnv = buildPnpmEnvironment(
    binDir,
    { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    helper
  )
  const nodeMode = await run(helper, [entry, '--version'], { env: nodeModeEnv })
  assert.equal(nodeMode.code, 0)
  assert.match(nodeMode.stdout, /^\d+\.\d+\.\d+/u)

  const strippedEnv = { ...nodeModeEnv }
  delete strippedEnv.ELECTRON_RUN_AS_NODE
  const stripped = await run(helper, [entry, '--version'], { env: strippedEnv })
  assert.equal(stripped.code, 0)
  assert.equal(stripped.stdout.trim(), '')
})

test('the packaged pnpm entry executes under a real Electron binary in Node mode', async (t) => {
  const electron = resolveElectron()
  if (electron === undefined) return t.skip('no Electron binary available on this host')
  const entry = resolvePnpmEntry()
  const env = buildPnpmEnvironment(
    dirname(entry),
    { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    electron
  )
  const result = await run(electron, [entry, '--version'], { env })
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^\d+\.\d+\.\d+/u)
})

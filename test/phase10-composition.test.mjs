import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SAFE_MODE_PROFILE } from '../usr/share/dsh-desktop/lib/plugin-manager/safe-mode.mjs'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const repoRoot = resolve(__dirname, '..')
const patchFile = join(repoRoot, 'usr/share/dsh-desktop/dsh-desktop.patch.yml')
const pkgJsonFile = join(repoRoot, 'usr/share/dsh-desktop/packages/dsh-desktop-market-installer/package.json')

export function resolveSupervisorDaemonArgs(options = {}) {
  const {
    safeMode = false,
    patchPath = patchFile
  } = options

  const args = []
  if (safeMode) {
    args.push('--profile', SAFE_MODE_PROFILE)
  } else if (patchPath && existsSync(patchPath)) {
    args.push('--patch', patchPath)
  }
  return args
}

test('patch file exists and declares dsh-desktop-market-installer', () => {
  assert.equal(existsSync(patchFile), true, 'dsh-desktop.patch.yml must exist')
  const content = readFileSync(patchFile, 'utf8')
  assert.match(content, /- name:\s+dsh-desktop-market-installer/, 'Must register market installer plugin')
})

test('market-installer package.json conforms to reference schema', () => {
  assert.equal(existsSync(pkgJsonFile), true)
  const pkg = JSON.parse(readFileSync(pkgJsonFile, 'utf8'))
  assert.equal(pkg.name, 'dsh-desktop-market-installer')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, './index.js')
  assert.deepEqual(pkg.exports, {
    '.': './index.js',
    './client': './client.js',
    './package.json': './package.json'
  })
  assert.ok(pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.equal(pkg.dsh?.client?.platform, 'web')
})

test('normal boot composes dsh-desktop-market-installer via --patch', () => {
  const args = resolveSupervisorDaemonArgs({ safeMode: false })
  assert.ok(args.includes('--patch'), 'Normal boot must include --patch')
  const patchIndex = args.indexOf('--patch')
  assert.equal(args[patchIndex + 1], patchFile)
  assert.equal(args.includes('--profile'), false)
})

test('Safe Mode boot strictly omits desktop --patch overlay', () => {
  const args = resolveSupervisorDaemonArgs({ safeMode: true })
  assert.equal(args.includes('--patch'), false, 'Safe Mode must omit --patch to avoid third-party or market plugins')
  assert.ok(args.includes('--profile'), 'Safe Mode must specify --profile')
  const profileIndex = args.indexOf('--profile')
  assert.equal(args[profileIndex + 1], SAFE_MODE_PROFILE)
})

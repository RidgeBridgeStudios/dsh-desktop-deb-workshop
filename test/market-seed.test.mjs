import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ensureDataDirs,
  ensureDefaultProfile,
  ensureMarketSeeded
} from '../usr/share/dsh-desktop/lib/plugin-manager/bootstrap.mjs'
import {
  MARKET_PACKAGE,
  RECOMMENDED_MARKET_VERSION
} from '../usr/share/dsh-desktop/lib/plugin-manager/market-constants.mjs'

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-seed-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('returns alreadySeeded:true when readMarketState reports installed version without installing', async () => {
  let installCalled = false
  const res = await ensureMarketSeeded({
    dshRoot: '/stub/dsh',
    profile: 'default',
    readMarketState: async () => ({ installedVersion: '1.45.1' }),
    installMarketShared: async () => {
      installCalled = true
    }
  })
  assert.deepEqual(res, { ok: true, alreadySeeded: true })
  assert.equal(installCalled, false)
})

test('returns alreadySeeded:true when readMarketState reports dependency without installing', async () => {
  let installCalled = false
  const res = await ensureMarketSeeded({
    dshRoot: '/stub/dsh',
    profile: 'default',
    readMarketState: async () => ({ dependency: '^1.45.1' }),
    installMarketShared: async () => {
      installCalled = true
    }
  })
  assert.deepEqual(res, { ok: true, alreadySeeded: true })
  assert.equal(installCalled, false)
})

test('fresh profile calls installMarketShared once with dshHome, profile, and recommendedVersion', async () => {
  let callCount = 0
  let capturedOptions = null
  const res = await ensureMarketSeeded({
    dshRoot: '/custom/dsh',
    profile: 'custom-profile',
    readMarketState: async () => ({ dependency: undefined, installedVersion: undefined }),
    installMarketShared: async (options) => {
      callCount++
      capturedOptions = options
    }
  })
  assert.equal(res.ok, true)
  assert.equal(callCount, 1)
  assert.equal(capturedOptions.dshHome, '/custom/dsh')
  assert.equal(capturedOptions.profile, 'custom-profile')
  assert.equal(capturedOptions.recommendedVersion, RECOMMENDED_MARKET_VERSION)
})

test('installMarketShared throwing does not reject; returns ok:false with detail', async () => {
  const res = await ensureMarketSeeded({
    dshRoot: '/custom/dsh',
    profile: 'default',
    readMarketState: async () => ({ dependency: undefined, installedVersion: undefined }),
    installMarketShared: async () => {
      throw new Error('network unreachable / offline')
    }
  })
  assert.equal(res.ok, false)
  assert.equal(res.detail, 'network unreachable / offline')
})

test('readMarketState throwing is caught and returns ok:false with detail', async () => {
  const res = await ensureMarketSeeded({
    dshRoot: '/custom/dsh',
    profile: 'default',
    readMarketState: async () => {
      throw new Error('EACCES: permission denied')
    },
    installMarketShared: async () => {}
  })
  assert.equal(res.ok, false)
  assert.match(res.detail, /EACCES/)
})

test('second invocation after a successful first is a no-op with alreadySeeded true', async (t) => {
  const root = await scratch(t)
  await ensureDataDirs({ dshRoot: root })
  await ensureDefaultProfile({ dshRoot: root })

  let installCount = 0
  const installMock = async (opts) => {
    installCount++
    const pkgPath = join(opts.dshHome, 'profiles', opts.profile, 'package.json')
    const manifest = JSON.parse(await readFile(pkgPath, 'utf8'))
    manifest.dependencies = { [MARKET_PACKAGE]: opts.recommendedVersion }
    await writeFile(pkgPath, JSON.stringify(manifest, null, 2))
  }

  const res1 = await ensureMarketSeeded({
    dshRoot: root,
    profile: 'default',
    installMarketShared: installMock
  })
  assert.equal(res1.ok, true)
  assert.equal(installCount, 1)

  const res2 = await ensureMarketSeeded({
    dshRoot: root,
    profile: 'default',
    installMarketShared: installMock
  })
  assert.deepEqual(res2, { ok: true, alreadySeeded: true })
  assert.equal(installCount, 1)
})

test('existing valid pnpm-workspace.yaml containing "- ." is preserved', async (t) => {
  const root = await scratch(t)
  const profileDir = join(root, 'profiles', 'default')
  await mkdir(profileDir, { recursive: true })
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  const custom = 'packages:\n  - .\n  - custom-pkg\n'
  await writeFile(workspacePath, custom, 'utf8')

  await ensureMarketSeeded({
    dshRoot: root,
    profile: 'default',
    readMarketState: async () => ({ dependency: undefined, installedVersion: undefined }),
    installMarketShared: async () => {}
  })

  assert.equal(await readFile(workspacePath, 'utf8'), custom)
})

test('existing pnpm-workspace.yaml without "- ." is updated to contain "- ."', async (t) => {
  const root = await scratch(t)
  const profileDir = join(root, 'profiles', 'default')
  await mkdir(profileDir, { recursive: true })
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  await writeFile(workspacePath, 'packages: []\n', 'utf8')

  await ensureMarketSeeded({
    dshRoot: root,
    profile: 'default',
    readMarketState: async () => ({ dependency: undefined, installedVersion: undefined }),
    installMarketShared: async () => {}
  })

  const content = await readFile(workspacePath, 'utf8')
  assert.ok(content.includes('- .'))
})

test('absent pnpm-workspace.yaml is created and contains "- ."', async (t) => {
  const root = await scratch(t)
  const profileDir = join(root, 'profiles', 'default')
  await mkdir(profileDir, { recursive: true })
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')

  await ensureMarketSeeded({
    dshRoot: root,
    profile: 'default',
    readMarketState: async () => ({ dependency: undefined, installedVersion: undefined }),
    installMarketShared: async () => {}
  })

  const content = await readFile(workspacePath, 'utf8')
  assert.ok(content.includes('- .'))
})

test('idempotent on second call: mtime of pnpm-workspace.yaml is unchanged', async (t) => {
  const root = await scratch(t)
  const profileDir = join(root, 'profiles', 'default')
  await mkdir(profileDir, { recursive: true })
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')

  await ensureMarketSeeded({
    dshRoot: root,
    profile: 'default',
    readMarketState: async () => ({ dependency: undefined, installedVersion: undefined }),
    installMarketShared: async () => {}
  })

  const stat1 = await stat(workspacePath)

  await ensureMarketSeeded({
    dshRoot: root,
    profile: 'default',
    readMarketState: async () => ({ dependency: '^1.45.1', installedVersion: '1.45.1' }),
    installMarketShared: async () => {}
  })

  const stat2 = await stat(workspacePath)
  assert.equal(stat1.mtimeMs, stat2.mtimeMs)
})

test('ensureMarketSeeded returns ok:false when profile is missing or invalid', async () => {
  const res1 = await ensureMarketSeeded({})
  assert.deepEqual(res1, { ok: false, detail: 'profile is required' })

  const res2 = await ensureMarketSeeded({ profile: 'INVALID PROFILE!' })
  assert.deepEqual(res2, { ok: false, detail: 'profile is required' })
})


import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ensureDataDirs,
  ensureDefaultProfile
} from '../usr/share/dsh-desktop/lib/plugin-manager/bootstrap.mjs'

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const EXPECTED = {
  name: 'dsh-profile-default',
  version: '1.0.0',
  private: true,
  type: 'module',
  dependencies: {},
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      patchReload: 'live'
    }
  }
}

test('fresh root creates dirs and manifest with the reference shape', async (t) => {
  const root = await scratch(t)
  const userHome = await scratch(t)
  const dirs = await ensureDataDirs({ dshRoot: root, userHome })
  assert.equal(dirs.ok, true)
  const profile = await ensureDefaultProfile({ dshRoot: root })
  assert.equal(profile.ok, true)
  const manifest = JSON.parse(await readFile(join(root, 'profiles', 'default', 'package.json'), 'utf8'))
  assert.deepEqual(manifest, EXPECTED)
})

test('existing manifest is left byte-identical', async (t) => {
  const root = await scratch(t)
  const userHome = await scratch(t)
  await ensureDataDirs({ dshRoot: root, userHome })
  const profileDir = join(root, 'profiles', 'default')
  await mkdir(profileDir, { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  const custom = '{"name":"custom"}\n'
  await writeFile(manifestPath, custom)
  const res = await ensureDefaultProfile({ dshRoot: root })
  assert.equal(res.ok, true)
  assert.equal(await readFile(manifestPath, 'utf8'), custom)
})

test('idempotent second call', async (t) => {
  const root = await scratch(t)
  const userHome = await scratch(t)
  await ensureDataDirs({ dshRoot: root, userHome })
  assert.equal((await ensureDefaultProfile({ dshRoot: root })).ok, true)
  assert.equal((await ensureDefaultProfile({ dshRoot: root })).ok, true)
})

test('unreadable dsh root returns ok:false with detail', async (t) => {
  if (process.getuid?.() === 0) return t.skip('running as root, permission bits are bypassed')
  const parent = await scratch(t)
  const locked = join(parent, 'locked')
  await mkdir(locked)
  await chmod(locked, 0o000)
  t.after(() => chmod(locked, 0o755).catch(() => undefined))
  const res = await ensureDataDirs({ dshRoot: join(locked, 'dsh'), userHome: parent })
  assert.equal(res.ok, false)
  assert.equal(typeof res.detail, 'string')
  assert.ok(res.detail.length > 0)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { setActiveProfile, createProfile } from '../usr/share/dsh-desktop/lib/plugin-manager/profiles.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliBin = join(__dirname, '..', 'usr', 'share', 'dsh-desktop', 'lib', 'plugin-manager', 'profile-cli.mjs')

async function scratch(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-profile-cli-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

test('profile-cli --validate accepts valid profile names', () => {
  const res1 = spawnSync(process.execPath, [cliBin, '--validate', 'work-dev'])
  assert.equal(res1.status, 0)

  const res2 = spawnSync(process.execPath, [cliBin, '--validate=my_profile.1'])
  assert.equal(res2.status, 0)
})

test('profile-cli --validate rejects invalid and reserved names with exit code 2', () => {
  const res1 = spawnSync(process.execPath, [cliBin, '--validate', 'Invalid_Caps'])
  assert.equal(res1.status, 2)

  const res2 = spawnSync(process.execPath, [cliBin, '--validate', 'safe-mode'])
  assert.equal(res2.status, 2)

  const res3 = spawnSync(process.execPath, [cliBin, '--validate', '.generations'])
  assert.equal(res3.status, 2)
})

test('profile-cli --resolve prioritizes explicit --profile flag over environment and registry', async (t) => {
  const home = await scratch(t)
  await createProfile(home, { name: 'reg-profile' })
  await setActiveProfile(home, 'reg-profile')

  const res = spawnSync(process.execPath, [cliBin, '--resolve', '--profile', 'explicit-prof'], {
    env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'env-prof' },
    encoding: 'utf8'
  })
  assert.equal(res.status, 0)
  assert.equal(res.stdout.trim(), 'explicit-prof')
})

test('profile-cli --resolve prioritizes DSH_PROFILE when explicit flag is absent', async (t) => {
  const home = await scratch(t)
  await createProfile(home, { name: 'reg-profile' })
  await setActiveProfile(home, 'reg-profile')

  const res = spawnSync(process.execPath, [cliBin, '--resolve'], {
    env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'env-prof' },
    encoding: 'utf8'
  })
  assert.equal(res.status, 0)
  assert.equal(res.stdout.trim(), 'env-prof')
})

test('profile-cli --resolve reads active profile from registry when flag and env absent', async (t) => {
  const home = await scratch(t)
  await createProfile(home, { name: 'my-custom' })
  await setActiveProfile(home, 'my-custom')

  const res = spawnSync(process.execPath, [cliBin, '--resolve'], {
    env: { ...process.env, DSH_HOME: home, DSH_PROFILE: '' },
    encoding: 'utf8'
  })
  assert.equal(res.status, 0)
  assert.equal(res.stdout.trim(), 'my-custom')
})

test('profile-cli --resolve falls back to default when no registry exists', async (t) => {
  const home = await scratch(t)
  const res = spawnSync(process.execPath, [cliBin, '--resolve'], {
    env: { ...process.env, DSH_HOME: home, DSH_PROFILE: '' },
    encoding: 'utf8'
  })
  assert.equal(res.status, 0)
  assert.equal(res.stdout.trim(), 'default')
})

test('profile-cli fails with code 2 on missing or unrecognized arguments', () => {
  const res1 = spawnSync(process.execPath, [cliBin])
  assert.equal(res1.status, 2)

  const res2 = spawnSync(process.execPath, [cliBin, '--unknown'])
  assert.equal(res2.status, 2)
})

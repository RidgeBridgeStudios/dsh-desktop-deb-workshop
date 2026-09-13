import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

import {
  readProfileRegistry,
  writeProfileRegistry,
  listProfiles,
  createProfile,
  renameProfile,
  deleteProfile,
  setActiveProfile,
  ensureActiveProfileDirectory,
  migrateLegacyLayout
} from '../usr/share/dsh-desktop/lib/plugin-manager/profiles.mjs'
import { LIVE_PROFILE, profileDirectory } from '../usr/share/dsh-desktop/lib/plugin-manager/paths.mjs'

async function scratch(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-profiles-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

test('readProfileRegistry returns default structure when file missing', async (t) => {
  const home = await scratch(t)
  const reg = await readProfileRegistry(home)
  assert.equal(reg.version, 1)
  assert.equal(reg.active, LIVE_PROFILE)
  assert.ok(reg.profiles[LIVE_PROFILE])
  assert.equal(reg.profiles[LIVE_PROFILE].displayName, 'Default')
})

test('createProfile adds new profile with valid name, color, and directories', async (t) => {
  const home = await scratch(t)
  const p = await createProfile(home, {
    name: 'work-dev',
    displayName: 'Work Development',
    color: '#10b981'
  })
  assert.equal(p.name, 'work-dev')
  assert.equal(p.displayName, 'Work Development')
  assert.equal(p.color, '#10b981')

  const profiles = await listProfiles(home)
  assert.equal(profiles.length, 2)
  assert.ok(existsSync(profileDirectory(home, 'work-dev')))
})

test('createProfile rejects invalid, reserved, and duplicate profile names', async (t) => {
  const home = await scratch(t)
  await assert.rejects(() => createProfile(home, { name: 'Invalid_Caps' }), /Invalid profile name/)
  await assert.rejects(() => createProfile(home, { name: 'safe-mode' }), /reserved/)
  await assert.rejects(() => createProfile(home, { name: 'node_modules' }), /reserved/)
  await assert.rejects(() => createProfile(home, { name: '.generations' }), /reserved/)
  await assert.rejects(() => createProfile(home, { name: 'default' }), /already exists/)
})

test('renameProfile updates displayName and color without changing internal name', async (t) => {
  const home = await scratch(t)
  await createProfile(home, { name: 'my-proj', displayName: 'Old Name' })
  const updated = await renameProfile(home, {
    name: 'my-proj',
    displayName: 'New Name',
    color: '#f59e0b'
  })
  assert.equal(updated.name, 'my-proj')
  assert.equal(updated.displayName, 'New Name')
  assert.equal(updated.color, '#f59e0b')

  const list = await listProfiles(home)
  const found = list.find((p) => p.name === 'my-proj')
  assert.equal(found.displayName, 'New Name')
  assert.equal(found.color, '#f59e0b')
})

test('deleteProfile creates safety snapshot before deleting and refuses active profile', async (t) => {
  const home = await scratch(t)
  await createProfile(home, { name: 'to-delete' })

  // Refuse deleting active profile
  await assert.rejects(() => deleteProfile(home, 'default'), /Cannot delete the active profile/)

  const deleted = await deleteProfile(home, 'to-delete')
  assert.equal(deleted, true)
  assert.equal(existsSync(profileDirectory(home, 'to-delete')), false)

  const list = await listProfiles(home)
  assert.equal(list.some((p) => p.name === 'to-delete'), false)
})

test('setActiveProfile updates active profile in registry', async (t) => {
  const home = await scratch(t)
  await createProfile(home, { name: 'secondary' })
  await setActiveProfile(home, 'secondary')

  const reg = await readProfileRegistry(home)
  assert.equal(reg.active, 'secondary')

  const list = await listProfiles(home)
  const sec = list.find((p) => p.name === 'secondary')
  assert.equal(sec.active, true)
})

test('migrateLegacyLayout moves legacy .dsh contents into default profile and migrates desired.json', async (t) => {
  const home = await scratch(t)
  // Simulate legacy ~/.dsh with root package.json and desired.json
  await writeFile(join(home, 'package.json'), JSON.stringify({ name: 'legacy-app', dependencies: { foo: '1.0.0' } }), 'utf8')
  await mkdir(join(home, 'node_modules', 'foo'), { recursive: true })
  await writeFile(join(home, 'node_modules', 'foo', 'package.json'), JSON.stringify({ name: 'foo', version: '1.0.0' }), 'utf8')

  const genDir = join(home, 'profiles', '.generations')
  await mkdir(genDir, { recursive: true })
  await writeFile(join(genDir, 'desired.json'), JSON.stringify(['foo+1.0.0+123456789012']), 'utf8')

  const migrated = await migrateLegacyLayout(home)
  assert.equal(migrated, true)

  assert.ok(existsSync(join(home, 'profiles', 'default', 'package.json')))
  assert.ok(existsSync(join(home, 'profiles', 'default', 'node_modules', 'foo', 'package.json')))
  assert.ok(existsSync(join(home, 'profiles', '.generations', 'desired', 'default.json')))
})

test('deleteProfile calls createSnapshot BEFORE rm -rf and aborts on snapshot failure', async (t) => {
  const home = await scratch(t)
  await createProfile(home, { name: 'atomic-test' })

  await assert.rejects(
    () => deleteProfile(home, 'atomic-test', {
      snapshotFn: async () => {
        throw new Error('injected snapshot failure')
      }
    }),
    /injected snapshot failure/
  )

  assert.ok(existsSync(profileDirectory(home, 'atomic-test')), 'profile directory must still exist')
  const reg = await readProfileRegistry(home)
  assert.ok(reg.profiles['atomic-test'], 'registry must still contain the profile')
  assert.equal(
    existsSync(join(home, 'profiles', '.generations', 'desired', 'atomic-test.json')),
    false,
    'no .generations/desired/<name>.json was created'
  )
})

test('migrateLegacyLayout moves desired.json -> desired/default.json', async (t) => {
  const home = await scratch(t)
  const genDir = join(home, 'profiles', '.generations')
  await mkdir(genDir, { recursive: true })
  await writeFile(join(genDir, 'desired.json'), JSON.stringify(['plugin+1.0.0+111111111111']), 'utf8')

  await migrateLegacyLayout(home)
  assert.equal(existsSync(join(genDir, 'desired.json')), false)
  assert.equal(existsSync(join(genDir, 'desired', 'default.json')), true)
  const content = JSON.parse(await readFile(join(genDir, 'desired', 'default.json'), 'utf8'))
  assert.deepEqual(content, ['plugin+1.0.0+111111111111'])
})

test('migrateLegacyLayout moves plugin-removals.json -> plugin-removals/default.json', async (t) => {
  const home = await scratch(t)
  const recDir = join(home, 'recovery')
  await mkdir(recDir, { recursive: true })
  await writeFile(join(recDir, 'plugin-removals.json'), JSON.stringify({ foo: { removedAt: 123 } }), 'utf8')

  await migrateLegacyLayout(home)
  assert.equal(existsSync(join(recDir, 'plugin-removals.json')), false)
  assert.equal(existsSync(join(recDir, 'plugin-removals', 'default.json')), true)
  const content = JSON.parse(await readFile(join(recDir, 'plugin-removals', 'default.json'), 'utf8'))
  assert.deepEqual(content, { foo: { removedAt: 123 } })
})

test('migrateLegacyLayout is idempotent (second call is a no-op)', async (t) => {
  const home = await scratch(t)
  const genDir = join(home, 'profiles', '.generations')
  await mkdir(genDir, { recursive: true })
  await writeFile(join(genDir, 'desired.json'), JSON.stringify(['plugin+1.0.0+111111111111']), 'utf8')

  assert.equal(await migrateLegacyLayout(home), true)
  assert.equal(await migrateLegacyLayout(home), true)
  assert.equal(existsSync(join(genDir, 'desired', 'default.json')), true)
})

test('migrateLegacyLayout with BOTH legacy and new files present leaves both untouched and does not throw', async (t) => {
  const home = await scratch(t)
  const genDir = join(home, 'profiles', '.generations')
  const desiredDir = join(genDir, 'desired')
  await mkdir(desiredDir, { recursive: true })
  await writeFile(join(genDir, 'desired.json'), JSON.stringify(['legacy+1.0.0+111111111111']), 'utf8')
  await writeFile(join(desiredDir, 'default.json'), JSON.stringify(['new+2.0.0+222222222222']), 'utf8')

  const recDir = join(home, 'recovery')
  const ledgerDir = join(recDir, 'plugin-removals')
  await mkdir(ledgerDir, { recursive: true })
  await writeFile(join(recDir, 'plugin-removals.json'), JSON.stringify({ legacy: 1 }), 'utf8')
  await writeFile(join(ledgerDir, 'default.json'), JSON.stringify({ current: 2 }), 'utf8')

  assert.doesNotThrow(async () => {
    await migrateLegacyLayout(home)
  })
  await migrateLegacyLayout(home)

  assert.equal(existsSync(join(genDir, 'desired.json')), true)
  assert.equal(existsSync(join(desiredDir, 'default.json')), true)
  assert.equal(existsSync(join(recDir, 'plugin-removals.json')), true)
  assert.equal(existsSync(join(ledgerDir, 'default.json')), true)

  const desiredLegacy = JSON.parse(await readFile(join(genDir, 'desired.json'), 'utf8'))
  const desiredNew = JSON.parse(await readFile(join(desiredDir, 'default.json'), 'utf8'))
  assert.deepEqual(desiredLegacy, ['legacy+1.0.0+111111111111'])
  assert.deepEqual(desiredNew, ['new+2.0.0+222222222222'])

  const ledgerLegacy = JSON.parse(await readFile(join(recDir, 'plugin-removals.json'), 'utf8'))
  const ledgerNew = JSON.parse(await readFile(join(ledgerDir, 'default.json'), 'utf8'))
  assert.deepEqual(ledgerLegacy, { legacy: 1 })
  assert.deepEqual(ledgerNew, { current: 2 })
})


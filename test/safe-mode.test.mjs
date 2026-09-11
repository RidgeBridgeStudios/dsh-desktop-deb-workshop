import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SAFE_MODE_BUNDLES,
  SAFE_MODE_PROFILE,
  buildSafeModeViewModel,
  ensureSafeModeProfile,
  shouldStartInSafeMode
} from '../usr/share/dsh-desktop/lib/plugin-manager/safe-mode.mjs'
import { profilesRoot } from '../usr/share/dsh-desktop/lib/plugin-manager/paths.mjs'

async function scratch(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-safe-mode-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

test('Safe Mode is opt-in through an exact switch', () => {
  assert.equal(shouldStartInSafeMode(['DSH Desktop', '--safe-mode']), true)
  assert.equal(shouldStartInSafeMode(['DSH Desktop', '--safe-mode=false']), false)
  assert.equal(shouldStartInSafeMode(['DSH Desktop']), false)
})

test('ensures an isolated official-core profile and repairs tampering', async (t) => {
  const home = await scratch(t)
  const dir = await ensureSafeModeProfile(home)
  assert.equal(dir, join(profilesRoot(home), SAFE_MODE_PROFILE))

  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, {})
  assert.deepEqual(manifest.dsh.profile.bundles, SAFE_MODE_BUNDLES)
  assert.match(await readFile(join(dir, 'cordis.patch.yml'), 'utf8'), /^\[\]/mu)

  manifest.dsh.profile.bundles.push('third-party-plugin')
  manifest.dependencies['third-party-plugin'] = '1.0.0'
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))

  await ensureSafeModeProfile(home)
  const repaired = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(repaired.dependencies, {})
  assert.deepEqual(repaired.dsh.profile.bundles, SAFE_MODE_BUNDLES)
})

test('Safe Mode shares DSH_HOME without touching the normal profile', async (t) => {
  const home = await scratch(t)
  const normal = join(profilesRoot(home), 'default')
  await mkdir(normal, { recursive: true })
  const normalManifest = JSON.stringify({ name: 'dsh-profile-default', dependencies: { x: '1.0.0' } })
  await writeFile(join(normal, 'package.json'), normalManifest)

  await ensureSafeModeProfile(home)
  assert.equal(await readFile(join(normal, 'package.json'), 'utf8'), normalManifest)
})

test('the Safe Mode view model is localized and blocks on outstanding groups', () => {
  const view = buildSafeModeViewModel({
    locale: 'zh',
    plugins: ['dsh-dream-skin', 'other-plugin'],
    blockingCount: 1,
    recoveryLocked: true
  })
  assert.equal(view.badge, '安全模式')
  assert.deepEqual(view.items.map((item) => item.name), ['dsh-dream-skin', 'other-plugin'])
  assert.match(view.restartConfirm, /1/u)
  assert.equal(view.recoveryLocked, true)

  const english = buildSafeModeViewModel({ locale: 'en', plugins: [] })
  assert.equal(english.badge, 'Safe Mode')
  assert.equal(english.noPlugins, 'There are no removable third-party plugins in this profile.')
  assert.equal(english.restartConfirm, undefined)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { uninstallPlugin, upgradePlugin } from '../usr/share/dsh-desktop/lib/plugin-manager/orchestrator.mjs'
import { readLedger } from '../usr/share/dsh-desktop/lib/plugin-manager/plugin-removal.mjs'
import { profileDirectory } from '../usr/share/dsh-desktop/lib/plugin-manager/paths.mjs'

async function scratch(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-orchestrator-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

test('protected plugins rejected', async (t) => {
  const home = await scratch(t)

  await assert.rejects(
    () => uninstallPlugin({ dshHome: home, profile: 'default', packageName: '@deepseek-ai/dsh-base' }),
    /Refusing to remove core package @deepseek-ai\/dsh-base/
  )

  await assert.rejects(
    () => uninstallPlugin({ dshHome: home, profile: 'default', packageName: '@deepseek-ai/custom-tool' }),
    /Refusing to remove core package @deepseek-ai\/custom-tool/
  )

  await assert.rejects(
    () => uninstallPlugin({ dshHome: home, profile: 'default', packageName: 'dshmarket' }),
    /Refusing to remove core package dshmarket/
  )
})

test('backup failure leaves disabled', async (t) => {
  const home = await scratch(t)

  const result = await uninstallPlugin({
    dshHome: home,
    profile: 'default',
    packageName: 'third-party-broken',
    operations: {
      backup: async () => {
        throw new Error('EACCES: permission denied')
      }
    }
  })

  assert.equal(result.disabled, false)
  assert.equal(result.removed, false)
  assert.equal(result.pending, true)
  assert.match(result.failures[0], /backup failed: EACCES/)

  const ledger = await readLedger(home, 'default')
  const entry = Object.values(ledger.removals).find((e) => e.pluginName === 'third-party-broken')
  assert.ok(entry)
  assert.equal(entry.status, 'disabled')
})

test('detach failure becomes cleanup-pending', async (t) => {
  const home = await scratch(t)

  const result = await uninstallPlugin({
    dshHome: home,
    profile: 'default',
    packageName: 'third-party-broken',
    operations: {
      backup: async () => undefined,
      disable: async () => undefined,
      detach: async () => {
        throw new Error('EBUSY: resource busy or locked')
      }
    }
  })

  assert.equal(result.disabled, true)
  assert.equal(result.removed, false)
  assert.equal(result.pending, true)
  assert.match(result.failures[0], /cleanup failed: EBUSY/)

  const ledger = await readLedger(home, 'default')
  const entry = Object.values(ledger.removals).find((e) => e.pluginName === 'third-party-broken')
  assert.ok(entry)
  assert.equal(entry.status, 'cleanup-pending')
})

test('happy path reaches removed', async (t) => {
  const home = await scratch(t)
  const profileDir = profileDirectory(home, 'default')
  const pluginDir = join(profileDir, 'node_modules', 'third-party-broken')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({ name: 'third-party-broken', version: '1.0.0' }), 'utf8')

  const manifestPath = join(profileDir, 'package.json')
  await writeFile(manifestPath, JSON.stringify({
    dependencies: { 'third-party-broken': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'third-party-broken'] } }
  }, null, 2), 'utf8')

  const result = await uninstallPlugin({
    dshHome: home,
    profile: 'default',
    packageName: 'third-party-broken'
  })

  assert.equal(result.disabled, true)
  assert.equal(result.removed, true)
  assert.equal(result.pending, false)
  assert.deepEqual(result.failures, [])

  const ledger = await readLedger(home, 'default')
  const entry = Object.values(ledger.removals).find((e) => e.pluginName === 'third-party-broken')
  assert.ok(entry)
  assert.equal(entry.status, 'removed')

  // Proves backup exists under <dshHome>/recovery/plugin-removals/<id>/
  const backupFiles = await readdir(entry.backupDirectory)
  assert.ok(backupFiles.length > 0)
})

test('upgradePlugin wraps install, publish and verifyNormalBoot', async (t) => {
  const home = await scratch(t)
  let installed = false
  let published = false
  let verified = false

  const result = await upgradePlugin({
    dshHome: home,
    profile: 'default',
    pluginName: 'third-party-plugin',
    targetVersion: '2.0.0',
    install: async ({ pluginName, targetVersion }) => {
      assert.equal(pluginName, 'third-party-plugin')
      assert.equal(targetVersion, '2.0.0')
      installed = true
    },
    publish: async ({ pluginName }) => {
      assert.equal(pluginName, 'third-party-plugin')
      published = true
    },
    verifyNormalBoot: async () => {
      verified = true
      return true
    }
  })

  assert.equal(installed, true)
  assert.equal(published, true)
  assert.equal(verified, true)
  assert.equal(result.ok, true)
  assert.equal(result.status, 'verified')
})

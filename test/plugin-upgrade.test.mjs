import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  upgradePlugin,
  upgradePluginsBatch
} from '../usr/share/dsh-desktop/lib/plugin-manager/plugin-upgrade.mjs'

test('an upgrade is only successful after a normal-profile verification', async () => {
  const verified = await upgradePlugin({
    pluginName: 'plugin-a',
    targetVersion: '2.0.0',
    install: async () => undefined,
    publish: async () => undefined,
    verifyNormalBoot: async () => true
  })
  assert.deepEqual(verified, { ok: true, status: 'verified', pluginName: 'plugin-a', targetVersion: '2.0.0' })
})

test('a boot that never reaches ready leaves the upgrade unverified and offered again (behavior a, no auto-revert)', async () => {
  const result = await upgradePlugin({
    pluginName: 'plugin-a',
    targetVersion: '2.0.0',
    install: async () => undefined,
    verifyNormalBoot: async () => false
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'unverified')
  assert.equal(result.offeredAgain, true)
})

test('an install failure is reported before any verification', async () => {
  let verified = false
  const result = await upgradePlugin({
    pluginName: 'plugin-a',
    targetVersion: '2.0.0',
    install: async () => { throw new Error('ERR_PNPM_NO_MATCHING_VERSION') },
    verifyNormalBoot: async () => { verified = true; return true }
  })
  assert.equal(result.status, 'install-failed')
  assert.equal(verified, false)
})

test('the batch flow runs upgrades then removals with one verification', async () => {
  const order = []
  let verifyCalls = 0
  const result = await upgradePluginsBatch({
    checks: [
      { packageName: 'a', upgradeReady: true, upgradeVersion: '2.0.0' },
      { packageName: 'b', removalRecommended: true },
      { packageName: 'c', checkFailed: true }
    ],
    applyUpgrade: async (upgrade) => { order.push(`upgrade:${upgrade.packageName}`) },
    applyRemoval: async (name) => { order.push(`remove:${name}`) },
    verifyNormalBoot: async () => { verifyCalls += 1; return true }
  })

  assert.deepEqual(order, ['upgrade:a', 'remove:b'])
  assert.equal(verifyCalls, 1)
  assert.deepEqual(result.skipped, ['c'])
  assert.deepEqual(result.upgraded, ['a'])
  assert.deepEqual(result.removed, ['b'])
  assert.equal(result.verified, true)
  assert.deepEqual(result.invalidated, ['a'])
})

test('the batch flow preserves partial success and does not roll back', async () => {
  const result = await upgradePluginsBatch({
    checks: [
      { packageName: 'a', upgradeReady: true, upgradeVersion: '2.0.0' },
      { packageName: 'b', upgradeReady: true, upgradeVersion: '2.0.0' }
    ],
    applyUpgrade: async (upgrade) => {
      if (upgrade.packageName === 'b') throw new Error('EPERM')
    },
    applyRemoval: async () => undefined,
    verifyNormalBoot: async () => false
  })

  assert.deepEqual(result.upgraded, ['a'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].packageName, 'b')
  assert.equal(result.verified, false)
  assert.deepEqual(result.stillBlocked, ['a'])
  assert.deepEqual(result.invalidated, [])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyRecoveryPlan,
  buildRecoveryPlan
} from '../usr/share/dsh-desktop/lib/plugin-manager/recovery.mjs'
import {
  checkBlockingPluginUpdates,
  planPluginRecovery,
  runPluginRecoveryPlan,
  selectPluginRecoveryTarget
} from '../usr/share/dsh-desktop/lib/plugin-manager/recovery-market.mjs'
import { buildRecoveryViewModel } from '../usr/share/dsh-desktop/lib/plugin-manager/recovery-view.mjs'
import {
  buildExternalComponentNotice,
  cleanupExternalComponents,
  inspectExternalComponents
} from '../usr/share/dsh-desktop/lib/plugin-manager/external-components.mjs'

function candidate(name, extra = {}) {
  return { name, dependencies: {}, optionalDependencies: {}, bundlePatch: '', sources: {}, ...extra }
}

test('batch planning splits upgrades, removals and skips', () => {
  const plan = planPluginRecovery([
    { packageName: 'a', upgradeReady: true, upgradeVersion: '2.0.0' },
    { packageName: 'b', healthStatus: 'incompatible-no-fix' },
    { packageName: 'c', removalRecommended: true },
    { packageName: 'd', checkFailed: true },
    { packageName: 'e' }
  ])
  assert.deepEqual(plan.upgrades, [{ packageName: 'a', targetVersion: '2.0.0', installedVersion: undefined }])
  assert.deepEqual(plan.removals, ['b', 'c'])
  assert.deepEqual(plan.skipped, ['d', 'e'])
})

test('the batch runner upgrades then removes and preserves partial failures', async () => {
  const order = []
  const result = await runPluginRecoveryPlan(
    { upgrades: [{ packageName: 'a', targetVersion: '2.0.0' }], removals: ['b', 'c'] },
    {
      upgrade: async (item) => { order.push(`upgrade:${item.packageName}`) },
      remove: async (name) => {
        order.push(`remove:${name}`)
        if (name === 'c') throw new Error('locked')
      }
    }
  )
  assert.deepEqual(order, ['upgrade:a', 'remove:b', 'remove:c'])
  assert.deepEqual(result.upgraded, ['a'])
  assert.deepEqual(result.removed, ['b'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].packageName, 'c')
})

test('a previously attempted upgrade recommends removal instead', () => {
  const checks = checkBlockingPluginUpdates({
    plugins: ['a', 'b'],
    attemptedUpgrades: ['a'],
    check: (name) => name === 'a'
      ? { upgradeReady: true, upgradeVersion: '2.0.0' }
      : { upgradeReady: true, upgradeVersion: '3.0.0' }
  })
  assert.equal(checks[0].upgradeCandidate, undefined)
  assert.equal(checks[0].removalRecommended, true)
  assert.equal(checks[1].upgradeCandidate.targetVersion, '3.0.0')
})

test('recovery actions are constrained to the allowlist', () => {
  assert.deepEqual(selectPluginRecoveryTarget('upgrade:a', ['a']), { kind: 'upgrade', packageName: 'a' })
  assert.equal(selectPluginRecoveryTarget('uninstall:a', ['b']), undefined)
  assert.equal(selectPluginRecoveryTarget('explode:a', ['a']), undefined)
})

test('the recovery view offers no batch action without a unique candidate', () => {
  const view = buildRecoveryViewModel({ locale: 'en', plugins: [], checks: [] })
  assert.equal(view.canUninstall, false)
  assert.equal(view.primaryLabel, 'Enter Safe Mode')
  assert.equal(view.noCandidate.length > 0, true)
  assert.equal(view.autoProcessLabel, undefined)
})

test('the recovery view names plugins and shows the batch plan', () => {
  const single = buildRecoveryViewModel({
    locale: 'en',
    plugins: ['plugin-a'],
    checks: [{ packageName: 'plugin-a', upgradeReady: true, upgradeVersion: '2.0.0' }]
  })
  assert.equal(single.primaryLabel, 'Remove this plugin and continue')
  assert.equal(single.autoProcessLabel, 'Auto-recover (1 upgrades, 0 removals)')

  const many = buildRecoveryViewModel({ locale: 'zh', plugins: ['a', 'b'], checks: [] })
  assert.equal(many.primaryLabel, '卸载这 2 个插件并继续检测')
  assert.equal(many.retryCheckLabel, undefined)
})

test('attribution limits the plan and never falls back to all plugins', () => {
  const candidates = [
    candidate('plugin-a', { bundlePatch: '- id: storage\n' }),
    candidate('plugin-b', { bundlePatch: '- id: storage\n' })
  ]
  const ambiguous = buildRecoveryPlan({
    candidates,
    duplicateLoaderEntryId: 'storage',
    checks: [
      { packageName: 'plugin-a', upgradeReady: true, upgradeVersion: '2.0.0' },
      { packageName: 'plugin-b', upgradeReady: true, upgradeVersion: '2.0.0' }
    ]
  })
  assert.deepEqual(ambiguous.plugins, [])
  assert.deepEqual(ambiguous.plan.upgrades, [])

  const unique = buildRecoveryPlan({
    candidates: [candidate('plugin-a', { bundlePatch: '- id: storage\n' }), candidate('plugin-b')],
    duplicateLoaderEntryId: 'storage',
    checks: [
      { packageName: 'plugin-a', upgradeReady: true, upgradeVersion: '2.0.0' },
      { packageName: 'plugin-b', upgradeReady: true, upgradeVersion: '2.0.0' }
    ]
  })
  assert.deepEqual(unique.plugins, ['plugin-a'])
  assert.deepEqual(unique.plan.upgrades.map((item) => item.packageName), ['plugin-a'])
})

test('a structured report without provenance is not mixed with log guesses', () => {
  const plan = buildRecoveryPlan({
    candidates: [candidate('plugin-a', { bundlePatch: '- id: storage\n' })],
    startupFailures: [{ packageName: 'leaf-module', chain: [] }],
    logs: ['storage duplicate'],
    duplicateLoaderEntryId: 'storage',
    checks: [{ packageName: 'plugin-a', upgradeReady: true, upgradeVersion: '2.0.0' }]
  })
  assert.equal(plan.source, 'structured')
  assert.deepEqual(plan.plugins, [])
  assert.deepEqual(plan.plan.upgrades, [])
})

test('a structured failure is the preferred source', () => {
  const plan = buildRecoveryPlan({
    candidates: [candidate('plugin-a')],
    startupFailures: [{ owner: { packageName: 'plugin-a' } }],
    logs: ['unrelated']
  })
  assert.equal(plan.source, 'structured')
  assert.deepEqual(plan.plugins, ['plugin-a'])
})

test('applying a recovery plan acts only on the planned plugins', async () => {
  const recoveryPlan = { plugins: ['plugin-a'], plan: { upgrades: [{ packageName: 'plugin-a', targetVersion: '2.0.0' }], removals: [] } }
  const acted = []
  const result = await applyRecoveryPlan(recoveryPlan, {
    upgrade: async (item) => acted.push(`upgrade:${item.packageName}`),
    remove: async (name) => acted.push(`remove:${name}`)
  })
  assert.deepEqual(acted, ['upgrade:plugin-a'])
  assert.deepEqual(result.plugins, ['plugin-a'])
})

test('external components are documented, never touched', async () => {
  assert.deepEqual(inspectExternalComponents(), { managed: false, policy: 'document-only', components: [] })
  assert.deepEqual(await cleanupExternalComponents(), {
    ok: true,
    managed: false,
    matched: 0,
    quarantined: [],
    failures: []
  })
  assert.equal(buildExternalComponentNotice('en').managed, false)
  assert.match(buildExternalComponentNotice('zh').message, /系统单元/u)
})

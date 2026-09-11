import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  configuredProfilePlugins,
  detectPluginRecovery,
  isThirdPartyPackageName,
  resolveAttribution,
  resolveStartupFailureOwners
} from '../usr/share/dsh-desktop/lib/plugin-manager/detection.mjs'

function candidate(name, extra = {}) {
  return { name, dependencies: {}, optionalDependencies: {}, bundlePatch: '', sources: {}, ...extra }
}

test('only third-party, configured bundles are candidates', () => {
  assert.equal(isThirdPartyPackageName('example-plugin'), true)
  assert.equal(isThirdPartyPackageName('@scope/example'), true)
  assert.equal(isThirdPartyPackageName('@deepseek-ai/dsh-base'), false)
  assert.equal(isThirdPartyPackageName('dshmarket'), false)

  const manifest = {
    dependencies: { a: '1.0.0', b: '1.0.0', '@deepseek-ai/dsh-base': '0.1.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'a', 'dshmarket'] } }
  }
  assert.deepEqual(configuredProfilePlugins(manifest), ['a'])
})

test('path 1: a directly named configured root is reported', () => {
  const candidates = [candidate('plugin-a'), candidate('plugin-b')]
  assert.deepEqual(resolveAttribution(candidates, ['plugin-a']), ['plugin-a'])
  assert.deepEqual(resolveAttribution(candidates, ['plugin-b', 'plugin-a']), ['plugin-a', 'plugin-b'])
})

test('path 2: a uniquely owned leaf maps to its single root', () => {
  const candidates = [
    candidate('plugin-a', { dependencies: { 'leaf-module': '1.0.0' } }),
    candidate('plugin-b')
  ]
  assert.deepEqual(resolveAttribution(candidates, ['leaf-module']), ['plugin-a'])
})

test('path 2: a leaf owned by two roots yields no candidate', () => {
  const candidates = [
    candidate('plugin-a', { optionalDependencies: { 'leaf-module': '1.0.0' } }),
    candidate('plugin-b', { bundlePatch: 'name: leaf-module\n' })
  ]
  assert.deepEqual(resolveAttribution(candidates, ['leaf-module']), [])
})

test('path 2: an unowned leaf yields no candidate', () => {
  const candidates = [candidate('plugin-a'), candidate('plugin-b')]
  assert.deepEqual(resolveAttribution(candidates, ['mystery-module']), [])
})

test('path 3: a duplicate loader entry id needs exactly one declaring root', () => {
  const one = [candidate('plugin-a', { bundlePatch: '- id: storage\n' }), candidate('plugin-b')]
  assert.deepEqual(resolveAttribution(one, [], { duplicateLoaderEntryId: 'storage' }), ['plugin-a'])

  const two = [
    candidate('plugin-a', { bundlePatch: '- id: storage\n' }),
    candidate('plugin-b', { bundlePatch: '  - id: "storage" # dup\n' })
  ]
  assert.deepEqual(resolveAttribution(two, [], { duplicateLoaderEntryId: 'storage' }), [])
})

test('path 4: a slot conflict referenced by exactly one root', () => {
  const one = [candidate('plugin-a', { sources: { 'client.js': "register('settings.tab')" } }), candidate('plugin-b')]
  assert.deepEqual(resolveAttribution(one, [], { slotConflictName: 'settings.tab' }), ['plugin-a'])

  const two = [
    candidate('plugin-a', { sources: { 'client.js': "register('settings.tab')" } }),
    candidate('plugin-b', { sources: { 'cordis.patch.yml': 'slot: settings.tab' } })
  ]
  assert.deepEqual(resolveAttribution(two, [], { slotConflictName: 'settings.tab' }), [])
})

test('path 5: an official slot provider maps to the unique dynamic referrer', () => {
  const candidates = [
    candidate('plugin-a', { sources: { 'lib/index.js': "inject: ['@deepseek-ai/dsh-client-ui-slots']" } }),
    candidate('plugin-b')
  ]
  assert.deepEqual(
    resolveAttribution(candidates, [], { slotProviders: ['@deepseek-ai/dsh-client-ui-slots'] }),
    ['plugin-a']
  )
})

test('no evidence yields no candidates', () => {
  const candidates = [candidate('plugin-a'), candidate('plugin-b')]
  assert.deepEqual(resolveAttribution(candidates, []), [])
  assert.deepEqual(resolveAttribution(candidates, ['mystery']), [])
})

test('structured reports take precedence over log correlation', () => {
  const candidates = [candidate('plugin-a'), candidate('plugin-b')]
  const failures = [{ owner: { packageName: 'plugin-b' } }]
  const structured = detectPluginRecovery({
    candidates,
    startupFailures: failures,
    logs: ['plugin-a failed']
  })
  assert.equal(structured.source, 'structured')
  assert.deepEqual(structured.plugins, ['plugin-b'])

  const logs = detectPluginRecovery({ candidates, startupFailures: [], logs: ['plugin-a exploded'] })
  assert.equal(logs.source, 'logs')
  assert.deepEqual(logs.plugins, ['plugin-a'])
})

test('structured owners are restricted to configured roots and exclusions', () => {
  const candidates = [candidate('plugin-a'), candidate('plugin-b')]
  const failures = [
    { owner: { packageName: 'plugin-a' } },
    { owner: { packageName: '@deepseek-ai/dsh-base' } },
    { owner: { packageName: 'plugin-b' } },
    {}
  ]
  assert.deepEqual(resolveStartupFailureOwners(candidates, failures), ['plugin-a', 'plugin-b'])
  assert.deepEqual(resolveStartupFailureOwners(candidates, failures, ['plugin-a']), ['plugin-b'])
})

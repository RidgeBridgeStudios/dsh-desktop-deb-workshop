import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  compareSemver,
  describeNoCompatibleUpdate,
  evaluatePluginUpgrade,
  inferRuntimeCompatibility,
  parseSemver,
  satisfiesRange,
  selectCompatibleUpgrade
} from '../usr/share/dsh-desktop/lib/plugin-manager/compatibility.mjs'

function metadata(versions, latest) {
  const map = {}
  for (const [version, extra] of Object.entries(versions)) {
    map[version] = { name: 'fixture-plugin', version, ...extra }
  }
  return { 'dist-tags': { latest }, versions: map }
}

test('parses and compares semver', () => {
  assert.deepEqual(parseSemver('0.1.2-alpha.4'), {
    major: 0, minor: 1, patch: 2, prerelease: ['alpha', '4']
  })
  assert.equal(compareSemver('1.2.3', '1.2.3-beta.1'), 1)
  assert.equal(compareSemver('1.2.3-beta.2', '1.2.3-beta.10'), -1)
})

test('evaluates comparators and ranges', () => {
  assert.equal(satisfiesRange('1.5.0', '^1.2.0'), true)
  assert.equal(satisfiesRange('2.0.0', '^1.2.0'), false)
  assert.equal(satisfiesRange('1.2.9', '~1.2.0'), true)
  assert.equal(satisfiesRange('1.3.0', '~1.2.0'), false)
  assert.equal(satisfiesRange('0.1.2-alpha.4', '^0.1.2-0'), true)
  assert.equal(satisfiesRange('1.5.0', '>=1.0.0 <2.0.0'), true)
})

test('infers runtime compatibility from peers, engines, minVersion and removed deps', () => {
  const runtime = '0.1.5-rc.1'
  assert.equal(inferRuntimeCompatibility({ peerDependencies: { '@deepseek-ai/dsh': '^0.1.5-0' } }, runtime).compatible, true)
  assert.equal(inferRuntimeCompatibility({ peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' } }, runtime).compatible, true)
  assert.equal(inferRuntimeCompatibility({ peerDependencies: { '@deepseek-ai/cordis': '^5.0.0' } }, runtime).compatible, false)
  assert.equal(inferRuntimeCompatibility({ engines: { dsh: '>=0.2.0' } }, runtime).compatible, false)
  assert.equal(inferRuntimeCompatibility({ dsh: { minVersion: '0.2.0' } }, runtime).compatible, false)
  assert.equal(
    inferRuntimeCompatibility({ dependencies: { '@deepseek-ai/dsh-host-apiproxy': '1.0.0' } }, runtime).compatible,
    false
  )
})

test('picks the newest compatible version', () => {
  const data = metadata({ '1.1.0': {}, '1.2.0': {}, '2.0.0': {} }, '2.0.0')
  assert.deepEqual(selectCompatibleUpgrade(data, '1.0.0', '0.1.5-rc.1'), {
    status: 'upgrade', version: '2.0.0', manifest: data.versions['2.0.0']
  })
})

test('a newer-incompatible latest yields an intermediate version', () => {
  const data = metadata({
    '1.1.0': {},
    '1.2.0': { peerDependencies: { '@deepseek-ai/dsh': '^0.2.0' } },
    '2.0.0': { peerDependencies: { '@deepseek-ai/dsh': '^0.2.0' } }
  }, '2.0.0')
  assert.equal(selectCompatibleUpgrade(data, '1.0.0', '0.1.5-rc.1').version, '1.1.0')
})

test('deprecated versions are skipped', () => {
  const data = metadata({ '1.1.0': { deprecated: 'do not use' }, '1.2.0': {} }, '1.2.0')
  assert.equal(selectCompatibleUpgrade(data, '1.0.0', '0.1.5-rc.1').version, '1.2.0')
})

test('stable installs skip prereleases but prerelease installs accept them', () => {
  const data = metadata({ '1.1.0': {}, '1.3.0-beta.1': {} }, '1.3.0-beta.1')
  assert.equal(selectCompatibleUpgrade(data, '1.0.0', '0.1.5-rc.1').version, '1.1.0')
  assert.equal(selectCompatibleUpgrade(data, '1.0.0-beta.1', '0.1.5-rc.1').version, '1.3.0-beta.1')
})

test('peer, engine and removed-dependency rules each reject a version', () => {
  const peer = metadata({ '1.1.0': { peerDependencies: { '@deepseek-ai/dsh': '^0.2.0' } }, '1.2.0': {} }, '1.2.0')
  assert.equal(selectCompatibleUpgrade(peer, '1.0.0', '0.1.5-rc.1').version, '1.2.0')

  const engine = metadata({ '1.1.0': { engines: { dsh: '>=0.2.0' } }, '1.2.0': {} }, '1.2.0')
  assert.equal(selectCompatibleUpgrade(engine, '1.0.0', '0.1.5-rc.1').version, '1.2.0')

  const minVersion = metadata({ '1.1.0': { dsh: { minVersion: '0.2.0' } }, '1.2.0': {} }, '1.2.0')
  assert.equal(selectCompatibleUpgrade(minVersion, '1.0.0', '0.1.5-rc.1').version, '1.2.0')

  const removed = metadata({ '1.1.0': { dependencies: { '@deepseek-ai/dsh-host-apiproxy': '1.0.0' } }, '1.2.0': {} }, '1.2.0')
  assert.equal(selectCompatibleUpgrade(removed, '1.0.0', '0.1.5-rc.1').version, '1.2.0')
})

test('no compatible update returns the latest-anyway sentinel', () => {
  const data = metadata({ '2.0.0': { peerDependencies: { '@deepseek-ai/dsh': '^0.2.0' } } }, '2.0.0')
  const selection = selectCompatibleUpgrade(data, '1.0.0', '0.1.5-rc.1')
  assert.equal(selection.status, 'latest-anyway')
  assert.equal(selection.version, '2.0.0')
})

test('when latest is not newer there is nothing to offer', () => {
  const data = metadata({ '1.0.0': {} }, '1.0.0')
  assert.deepEqual(selectCompatibleUpgrade(data, '1.0.0', '0.1.5-rc.1'), { status: 'none' })
})

test('evaluatePluginUpgrade reports health and the terminal case', () => {
  const healthy = evaluatePluginUpgrade({
    metadata: metadata({ '1.1.0': {} }, '1.1.0'),
    installedVersion: '1.0.0',
    runtimeVersion: '0.1.5-rc.1'
  })
  assert.equal(healthy.healthStatus, 'upgrade-available')
  assert.equal(healthy.upgradeVersion, '1.1.0')

  const warning = evaluatePluginUpgrade({
    metadata: metadata({ '2.0.0': { peerDependencies: { '@deepseek-ai/dsh': '^0.2.0' } } }, '2.0.0'),
    installedVersion: '1.0.0',
    runtimeVersion: '0.1.5-rc.1',
    hasLocalIssue: true
  })
  assert.equal(warning.healthStatus, 'incompatible-upgrade-available')
  assert.equal(warning.unconfirmed, true)

  const terminal = evaluatePluginUpgrade({
    metadata: metadata({ '1.0.0': {} }, '1.0.0'),
    installedVersion: '1.0.0',
    runtimeVersion: '0.1.5-rc.1',
    hasLocalIssue: true
  })
  assert.equal(terminal.healthStatus, 'incompatible-no-fix')
  assert.equal(terminal.removalRecommended, true)
})

test('the no-compatible terminal case offers only uninstall and re-check', () => {
  const view = describeNoCompatibleUpdate({ locale: 'en' })
  assert.equal(view.canUninstall, true)
  assert.equal(view.canCheckAgain, true)
  assert.equal(view.canDowngrade, false)
  assert.equal(view.canReinstall, false)
  assert.match(view.message, /Uninstall is the recommended action/u)
})

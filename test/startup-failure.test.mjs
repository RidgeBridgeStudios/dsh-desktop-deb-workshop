import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PLUGIN_FAILURE_PREFIX,
  formatPluginStartupFailure,
  isPluginFailureLine,
  parsePluginStartupFailures,
  reportPluginStartupFailure
} from '../usr/share/dsh-desktop/lib/plugin-manager/startup-failure.mjs'

test('a structured failure round-trips without any plugin config', () => {
  const line = formatPluginStartupFailure({
    stage: 'import',
    packageName: 'leaf-module',
    entryId: 'leaf-0',
    owner: { packageName: 'example-plugin', version: '1.2.3', packageDir: '/w/example-plugin' },
    chain: [{ entryId: 'group-0', packageName: 'group' }, { packageName: 'leaf-module' }],
    message: 'boom',
    config: { apiKey: 'must-not-leak' }
  })

  assert.equal(line.split('\n').length, 1)
  assert.equal(line.startsWith(PLUGIN_FAILURE_PREFIX), true)
  assert.equal(line.includes('must-not-leak'), false)
  assert.equal(line.includes('"config"'), false)
  assert.equal(isPluginFailureLine(line), true)

  const failures = parsePluginStartupFailures(line)
  assert.equal(failures.length, 1)
  assert.deepEqual(failures[0], {
    stage: 'import',
    packageName: 'leaf-module',
    entryId: 'leaf-0',
    owner: { packageName: 'example-plugin', version: '1.2.3', packageDir: '/w/example-plugin' },
    chain: [{ entryId: 'group-0', packageName: 'group' }, { packageName: 'leaf-module' }],
    message: 'boom'
  })
})

test('parsing is a no-op for runner markers and unrelated logs', () => {
  assert.equal(parsePluginStartupFailures('dsh-desktop pnpm runner: excluded 1 generation projection'), undefined)
  assert.equal(parsePluginStartupFailures('ordinary harness log line'), undefined)
})

test('parsing rejects malformed or unsupported reports', () => {
  assert.equal(parsePluginStartupFailures(`${PLUGIN_FAILURE_PREFIX}{`), undefined)
  assert.equal(parsePluginStartupFailures(`${PLUGIN_FAILURE_PREFIX}${JSON.stringify({ v: 2, failures: [] })}`), undefined)
  assert.equal(parsePluginStartupFailures(`${PLUGIN_FAILURE_PREFIX}${JSON.stringify({ v: 1, failures: [{}] })}`), undefined)
})

test('reporting writes exactly one prefixed line', () => {
  const written = []
  reportPluginStartupFailure(
    { stage: 'activate', packageName: 'p', message: 'm' },
    (line) => written.push(line)
  )
  assert.equal(written.length, 1)
  assert.equal(written[0].endsWith('\n'), true)
  assert.equal(isPluginFailureLine(written[0].trimEnd()), true)
})

test('formatPluginStartupFailure with packageName containing HTML tags throws', () => {
  assert.throws(
    () => formatPluginStartupFailure({ stage: 'import', packageName: '<img src=x>', message: 'err' }),
    /Plugin startup failure is not well formed\./
  )
})

test('parsePluginStartupFailures on a line whose failures[0].packageName is malicious returns undefined', () => {
  const line = `${PLUGIN_FAILURE_PREFIX}${JSON.stringify({
    v: 1,
    failures: [{ stage: 'import', packageName: '<script>', message: 'err' }]
  })}`
  assert.equal(parsePluginStartupFailures(line), undefined)
})

test('formatPluginStartupFailure with a legitimate scoped name round-trips unchanged', () => {
  const line = formatPluginStartupFailure({
    stage: 'activate',
    packageName: '@scope/plugin',
    message: 'all good'
  })
  const parsed = parsePluginStartupFailures(line)
  assert.ok(parsed)
  assert.equal(parsed[0].packageName, '@scope/plugin')
})


import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleStartupFailureText } from '../usr/share/dsh-desktop/app/main.js'
import {
  PLUGIN_FAILURE_PREFIX,
  formatPluginStartupFailure
} from '../usr/share/dsh-desktop/lib/plugin-manager/startup-failure.mjs'

test('supervisor failure detection: parses structured plugin failure lines', () => {
  const line = formatPluginStartupFailure({
    stage: 'import',
    packageName: 'problematic-plugin',
    message: 'SyntaxError: Unexpected token'
  })

  assert.ok(line.startsWith(PLUGIN_FAILURE_PREFIX))

  const model = handleStartupFailureText(line)
  assert.ok(model !== null, 'Must produce recovery model')
  assert.equal(model.structured, true)
  assert.deepEqual(model.plugins, ['problematic-plugin'])
  assert.match(model.rawError, /problematic-plugin/)
  assert.match(model.rawError, /SyntaxError/)
})

test('supervisor failure detection: ignores non-prefixed log output', () => {
  const normalLog = '[info] server listening on 127.0.0.1:3080\n[warn] slow response\n'
  const model = handleStartupFailureText(normalLog)
  assert.equal(model, null)
})

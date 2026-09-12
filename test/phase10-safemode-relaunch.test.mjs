import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDaemonArgs,
  registerIpcHandlers
} from '../usr/share/dsh-desktop/app/main.js'
import { SAFE_MODE_PROFILE } from '../usr/share/dsh-desktop/lib/plugin-manager/safe-mode.mjs'

test('safe mode args: builds profile arguments and strips patch overlay', () => {
  const safeArgs = buildDaemonArgs({ safeMode: true })
  assert.ok(safeArgs.includes('--profile'))
  assert.equal(safeArgs[safeArgs.indexOf('--profile') + 1], SAFE_MODE_PROFILE)
  assert.equal(safeArgs.includes('--patch'), false)

  const normalArgs = buildDaemonArgs({ safeMode: false, patchPath: '/path/to/patch.yml' })
  assert.equal(normalArgs.includes('--profile'), false)
})

test('safe mode IPC: registers action handler and invokes relaunch', async () => {
  const handlers = {}
  const mockIpc = {
    handle(channel, fn) {
      handlers[channel] = fn
    }
  }

  let relaunched = false
  let exited = false
  const supervisor = {
    relaunchSafeMode: () => { relaunched = true },
    exitSafeMode: () => { exited = true }
  }

  registerIpcHandlers(mockIpc, supervisor)

  assert.ok(typeof handlers['safe-mode:action'] === 'function')

  await handlers['safe-mode:action']({}, 'launch', ['p1'])
  assert.equal(relaunched, true)

  await handlers['safe-mode:action']({}, 'exit')
  assert.equal(exited, true)
})

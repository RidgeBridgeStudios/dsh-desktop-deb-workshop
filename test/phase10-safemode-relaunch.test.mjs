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
  let safeModeEnsured = false
  let uninstalledPkg = null
  let upgradedPkg = null

  const supervisor = {
    relaunchSafeMode: () => { relaunched = true },
    exitSafeMode: () => { exited = true },
    ensureSafeModeProfile: () => { safeModeEnsured = true },
    uninstallPlugin: ({ packageName }) => { uninstalledPkg = packageName; return { ok: true } },
    upgradePlugin: ({ pluginName }) => { upgradedPkg = pluginName; return { ok: true } },
    withDaemonStopped: (action) => action()
  }

  registerIpcHandlers(mockIpc, supervisor)

  assert.ok(typeof handlers['safe-mode:action'] === 'function')
  assert.ok(typeof handlers['recovery:action'] === 'function')
  assert.ok(typeof handlers['safe-mode:model'] === 'function')

  const trustedEvent = { senderFrame: { url: 'http://127.0.0.1:3080' } }

  await handlers['safe-mode:action'](trustedEvent, 'launch', ['p1'])
  assert.equal(safeModeEnsured, true)
  assert.equal(relaunched, true)

  await handlers['safe-mode:action'](trustedEvent, 'exit')
  assert.equal(exited, true)

  await handlers['recovery:action'](trustedEvent, 'uninstall:bad-plugin')
  assert.equal(uninstalledPkg, 'bad-plugin')

  await handlers['recovery:action'](trustedEvent, 'upgrade:nice-plugin@2.0.0')
  assert.equal(upgradedPkg, 'nice-plugin')
})

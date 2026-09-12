import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerPreloadBridges } from '../usr/share/dsh-desktop/app/preload.cjs'

test('preload bridges expose reconciled namespaces and correct IPC channels', async () => {
  const exposed = {}
  const mockBridge = {
    exposeInMainWorld(key, api) {
      exposed[key] = api
    }
  }

  const calls = []
  const mockIpc = {
    invoke(channel, ...args) {
      calls.push({ channel, args })
      return Promise.resolve({ ok: true, channel, args })
    }
  }

  const mockWindow = {}
  registerPreloadBridges(mockBridge, mockIpc, mockWindow)

  assert.equal(mockWindow.__DSH_DESKTOP__, true)
  assert.ok(exposed.dshDesktop, 'Must expose dshDesktop')
  assert.ok(exposed.dshRecovery, 'Must expose dshRecovery')
  assert.ok(exposed.dshSafeMode, 'Must expose dshSafeMode')

  // Deleted/forbidden surface assertions
  assert.equal(exposed.dshDesktop.openInFinder, undefined, 'openInFinder must be deleted')
  assert.equal(exposed.dshDesktop.onStartupFailure, undefined, 'onStartupFailure must be deleted')

  // dshDesktop channel assertions
  await exposed.dshDesktop.restartHarness()
  assert.equal(calls[calls.length - 1].channel, 'harness:restart')

  await exposed.dshDesktop.uninstallMarket()
  assert.equal(calls[calls.length - 1].channel, 'market:uninstall')

  await exposed.dshDesktop.installMarket()
  assert.equal(calls[calls.length - 1].channel, 'market:install')

  // dshRecovery channel assertions
  await exposed.dshRecovery.action('ignore')
  assert.equal(calls[calls.length - 1].channel, 'recovery:action')
  assert.deepEqual(calls[calls.length - 1].args, ['ignore'])

  // dshSafeMode channel assertions
  await exposed.dshSafeMode.action('disable', ['plugin-1', 'plugin-2'])
  assert.equal(calls[calls.length - 1].channel, 'safe-mode:action')
  assert.deepEqual(calls[calls.length - 1].args, ['disable', ['plugin-1', 'plugin-2']])
})

test('preload bridges handle invocation when renderer supplies options', async () => {
  const exposed = {}
  const mockBridge = {
    exposeInMainWorld(key, api) {
      exposed[key] = api
    }
  }

  const calls = []
  const mockIpc = {
    invoke(channel, ...args) {
      calls.push({ channel, args })
      return Promise.resolve({ ok: true, channel, args })
    }
  }

  registerPreloadBridges(mockBridge, mockIpc)

  // Invoke market installation with hostile options from renderer
  await exposed.dshDesktop.installMarket({ dshHome: '/tmp/evil' })
  assert.equal(calls[calls.length - 1].channel, 'market:install')

  await exposed.dshDesktop.uninstallMarket({ dshHome: '/tmp/evil' })
  assert.equal(calls[calls.length - 1].channel, 'market:uninstall')
})

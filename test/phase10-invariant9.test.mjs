import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  withDaemonStopped,
  registerIpcHandlers
} from '../usr/share/dsh-desktop/app/main.js'

test('invariant 9: mutations stop the daemon before running and restart it afterward', async () => {
  const events = []
  let daemonRunning = true

  const context = {
    checkStatus: async () => ({ active: daemonRunning }),
    stopBackend: async () => {
      events.push('stop')
      daemonRunning = false
    },
    restartBackend: async () => {
      events.push('restart')
      daemonRunning = true
    }
  }

  const result = await withDaemonStopped(async () => {
    events.push(`mutate:daemon_is_${daemonRunning ? 'running' : 'stopped'}`)
    return 'success'
  }, context)

  assert.equal(result, 'success')
  assert.deepEqual(events, [
    'stop',
    'mutate:daemon_is_stopped',
    'restart'
  ])
  assert.equal(daemonRunning, true)
})

test('invariant 9: failed mutations still restore the runtime daemon', async () => {
  const events = []
  let daemonRunning = true

  const context = {
    checkStatus: async () => ({ active: daemonRunning }),
    stopBackend: async () => {
      events.push('stop')
      daemonRunning = false
    },
    restartBackend: async () => {
      events.push('restart')
      daemonRunning = true
    }
  }

  await assert.rejects(
    () => withDaemonStopped(async () => {
      events.push('mutate_failure')
      throw new Error('pnpm failed')
    }, context),
    /pnpm failed/
  )

  assert.deepEqual(events, [
    'stop',
    'mutate_failure',
    'restart'
  ])
  assert.equal(daemonRunning, true)
})

test('invariant 9: IPC market install/uninstall routes use withDaemonStopped', async () => {
  const handlers = {}
  const mockIpc = {
    handle(channel, fn) {
      handlers[channel] = fn
    }
  }

  const stoppedMutations = []
  const supervisor = {
    withDaemonStopped: async (action) => {
      stoppedMutations.push('wrapped')
      return action()
    },
    installMarketShared: async () => {
      stoppedMutations.push('installMarketShared')
      return { ok: true }
    },
    uninstallMarketShared: async () => {
      stoppedMutations.push('uninstallMarketShared')
      return { ok: true }
    }
  }

  registerIpcHandlers(mockIpc, supervisor)

  await handlers['market:install']({})
  assert.deepEqual(stoppedMutations, ['wrapped', 'installMarketShared'])

  stoppedMutations.length = 0
  await handlers['market:uninstall']({})
  assert.deepEqual(stoppedMutations, ['wrapped', 'uninstallMarketShared'])
})

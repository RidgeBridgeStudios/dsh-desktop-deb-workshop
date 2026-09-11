import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  beginRemoval,
  cleanupVerifiedRemovalBackup,
  confirmPluginRemovalsBooted,
  enforcePendingPluginRemovals,
  isProtectedPlugin,
  listPendingPluginRemovals,
  readLedger,
  removePluginSafely,
  shouldDeferProfileMaintenance,
  uniqueOrphans
} from '../usr/share/dsh-desktop/lib/plugin-manager/plugin-removal.mjs'

async function scratch(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-removal-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

test('core packages, the market and the in-box bundles are protected', () => {
  assert.equal(isProtectedPlugin('@deepseek-ai/dsh-base'), true)
  assert.equal(isProtectedPlugin('@deepseek-ai/anything'), true)
  assert.equal(isProtectedPlugin('dshmarket'), true)
  assert.equal(isProtectedPlugin('example-plugin'), false)
})

test('beginRemoval writes the durable ledger before anything else', async (t) => {
  const home = await scratch(t)
  await assert.rejects(() => beginRemoval({ dshHome: home, pluginName: '@deepseek-ai/dsh-base' }))

  const entry = await beginRemoval({ dshHome: home, pluginName: 'example-plugin' })
  assert.equal(entry.status, 'disabled')
  const ledger = await readLedger(home)
  assert.equal(Object.values(ledger.removals).length, 1)
  assert.equal(Object.values(ledger.removals)[0].pluginName, 'example-plugin')
  assert.equal(listPendingPluginRemovals(ledger).includes('example-plugin'), true)
  assert.equal(shouldDeferProfileMaintenance(ledger), true)
})

test('a successful removal records removed and clears failures', async (t) => {
  const home = await scratch(t)
  const statusAtDisable = []
  const result = await removePluginSafely({
    dshHome: home,
    pluginName: 'example-plugin',
    operations: {
      backup: async () => undefined,
      disable: async () => {
        const ledger = await readLedger(home)
        statusAtDisable.push(Object.values(ledger.removals)[0].status)
      },
      detach: async () => undefined
    }
  })

  assert.deepEqual(result, {
    pluginName: 'example-plugin',
    removalId: result.removalId,
    disabled: true,
    removed: true,
    pending: false,
    failures: []
  })
  assert.deepEqual(statusAtDisable, ['disabled'])
  const entry = Object.values((await readLedger(home)).removals)[0]
  assert.equal(entry.status, 'removed')
  assert.equal(entry.failures.length, 0)
})

test('a backup failure stays disabled and never detaches', async (t) => {
  const home = await scratch(t)
  let detached = false
  const result = await removePluginSafely({
    dshHome: home,
    pluginName: 'example-plugin',
    operations: {
      backup: async () => { throw new Error('disk full') },
      disable: async () => undefined,
      detach: async () => { detached = true }
    }
  })

  assert.equal(result.disabled, false)
  assert.equal(result.removed, false)
  assert.equal(detached, false)
  assert.equal(Object.values((await readLedger(home)).removals)[0].status, 'disabled')
})

test('a detach failure becomes cleanup-pending and stays disabled', async (t) => {
  const home = await scratch(t)
  const result = await removePluginSafely({
    dshHome: home,
    pluginName: 'example-plugin',
    operations: {
      backup: async () => undefined,
      disable: async () => undefined,
      detach: async () => { throw new Error('EPERM') }
    }
  })

  assert.equal(result.disabled, true)
  assert.equal(result.removed, false)
  assert.equal(Object.values((await readLedger(home)).removals)[0].status, 'cleanup-pending')
})

test('boot verification keeps the backup for one cycle, then deletes it', async (t) => {
  const home = await scratch(t)
  await removePluginSafely({
    dshHome: home,
    pluginName: 'example-plugin',
    operations: { backup: async () => undefined, disable: async () => undefined, detach: async () => undefined }
  })

  const deleted = []
  const first = await confirmPluginRemovalsBooted({
    dshHome: home,
    removeBackup: async (dir) => { deleted.push(dir) }
  })
  assert.deepEqual(first, [{ removalId: first[0].removalId, deleted: false }])
  assert.equal(deleted.length, 0)
  assert.equal(Object.values((await readLedger(home)).removals)[0].bootVerifiedAt !== undefined, true)

  const second = await confirmPluginRemovalsBooted({
    dshHome: home,
    removeBackup: async (dir) => { deleted.push(dir) }
  })
  assert.equal(second[0].deleted, true)
  assert.equal(deleted.length, 1)
  assert.equal(Object.values((await readLedger(home)).removals)[0].backupDeletedAt !== undefined, true)
  assert.equal(shouldDeferProfileMaintenance(await readLedger(home)), false)
})

test('cleanup requires boot verification first', async (t) => {
  const home = await scratch(t)
  await removePluginSafely({
    dshHome: home,
    pluginName: 'example-plugin',
    operations: { backup: async () => undefined, disable: async () => undefined, detach: async () => undefined }
  })
  const removalId = Object.values((await readLedger(home)).removals)[0].removalId
  assert.equal((await cleanupVerifiedRemovalBackup({ dshHome: home, removalId })).ok, false)

  await confirmPluginRemovalsBooted({ dshHome: home, removeBackup: async () => undefined })
  assert.equal((await cleanupVerifiedRemovalBackup({ dshHome: home, removalId })).ok, true)
})

test('tombstone clears a generation pointer and removes the bundle entry', async (t) => {
  const home = await scratch(t)
  await beginRemoval({ dshHome: home, pluginName: 'example-plugin' })
  let bundles = ['@deepseek-ai/dsh-base', 'example-plugin']
  const calls = { generation: [], removed: [] }
  const names = await enforcePendingPluginRemovals({
    dshHome: home,
    disableGeneration: async (name) => { calls.generation.push(name) },
    readBundles: async () => bundles,
    removeFromBundles: async (targets) => {
      calls.removed.push(targets)
      bundles = bundles.filter((name) => !targets.includes(name))
    }
  })
  assert.deepEqual(names, ['example-plugin'])
  assert.deepEqual(calls.generation, ['example-plugin'])
  assert.deepEqual(bundles, ['@deepseek-ai/dsh-base'])
})

test('tombstone throws if the plugin is still composed', async (t) => {
  const home = await scratch(t)
  await beginRemoval({ dshHome: home, pluginName: 'example-plugin' })
  await assert.rejects(
    () => enforcePendingPluginRemovals({
      dshHome: home,
      disableGeneration: async () => undefined,
      readBundles: async () => ['@deepseek-ai/dsh-base', 'example-plugin'],
      removeFromBundles: async () => undefined
    }),
    /still composed/u
  )
})

test('uniqueOrphans removes anything another root still reaches', () => {
  assert.deepEqual(
    uniqueOrphans(['target', 'shared', 'only-target'], [['shared'], ['other']]),
    ['only-target', 'target']
  )
})

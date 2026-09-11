import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const REMOVAL_PROTOCOL = 2
const CORE_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
const BLOCKING_STATUSES = new Set(['disabled', 'cleanup-pending'])

export function isProtectedPlugin(pluginName) {
  return typeof pluginName === 'string' &&
    (pluginName.startsWith('@deepseek-ai/') || pluginName === 'dshmarket' || CORE_BUNDLES.has(pluginName))
}

export function ledgerPath(home) {
  return join(home, 'recovery', 'plugin-removals.json')
}

export function removalBackupRoot(home) {
  return join(home, 'recovery', 'plugin-removals')
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function readLedger(home) {
  const ledger = await readJson(ledgerPath(home), { protocol: REMOVAL_PROTOCOL, removals: {} })
  if (typeof ledger !== 'object' || ledger === null || typeof ledger.removals !== 'object' || ledger.removals === null) {
    return { protocol: REMOVAL_PROTOCOL, removals: {} }
  }
  return ledger
}

async function writeLedger(home, ledger) {
  await writeJsonAtomic(ledgerPath(home), ledger)
}

export function listPendingPluginRemovals(ledger) {
  return Object.values(ledger.removals)
    .filter((entry) => entry.status !== 'removed' || entry.bootVerifiedAt === undefined)
    .map((entry) => entry.pluginName)
    .sort()
}

export function shouldDeferProfileMaintenance(ledger) {
  return Object.values(ledger.removals).some(
    (entry) => entry.status !== 'removed' || entry.bootVerifiedAt === undefined
  )
}

export async function beginRemoval({ dshHome, pluginName, now = new Date() }) {
  if (isProtectedPlugin(pluginName)) {
    throw new Error(`Refusing to remove core package ${pluginName}`)
  }
  const ledger = await readLedger(dshHome)
  const existing = Object.values(ledger.removals).find(
    (entry) => entry.pluginName === pluginName && entry.status !== 'removed'
  )
  if (existing !== undefined) return existing

  const removalId = `${now.toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`
  const safeName = pluginName.replace(/^@/u, '').replace(/[/\\]/gu, '__')
  const entry = {
    removalId,
    pluginName,
    status: 'disabled',
    disabledAt: now.toISOString(),
    updatedAt: now.toISOString(),
    backupDirectory: join(removalBackupRoot(dshHome), removalId, safeName),
    failures: []
  }
  ledger.removals[removalId] = entry
  await writeLedger(dshHome, ledger)
  return entry
}

async function updateEntry(home, removalId, mutate) {
  const ledger = await readLedger(home)
  const entry = ledger.removals[removalId]
  if (entry === undefined) return undefined
  mutate(entry)
  entry.updatedAt = new Date().toISOString()
  await writeLedger(home, ledger)
  return entry
}

export async function markFailure(home, removalId, message, status = 'cleanup-pending') {
  return updateEntry(home, removalId, (entry) => {
    entry.status = status
    entry.failures = [...(entry.failures ?? []), message]
  })
}

export async function removePluginSafely(options) {
  const { dshHome, pluginName, now, operations } = options
  const entry = await beginRemoval({ dshHome, pluginName, now })
  const removalId = entry.removalId
  const failures = []

  try {
    if (entry.backedUpAt === undefined) {
      await operations.backup({ entry, removalId })
      await updateEntry(dshHome, removalId, (value) => { value.backedUpAt = new Date().toISOString() })
    }
  } catch (error) {
    const detail = `backup failed: ${errorText(error)}`
    failures.push(detail)
    await markFailure(dshHome, removalId, detail, 'disabled')
    return { pluginName, removalId, disabled: false, removed: false, pending: true, failures }
  }

  try {
    await operations.disable({ entry, removalId })
  } catch (error) {
    const detail = `disable failed: ${errorText(error)}`
    failures.push(detail)
    await markFailure(dshHome, removalId, detail, 'disabled')
    return { pluginName, removalId, disabled: false, removed: false, pending: true, failures }
  }

  try {
    await operations.detach({ entry, removalId })
  } catch (error) {
    const detail = `cleanup failed: ${errorText(error)}`
    failures.push(detail)
    await markFailure(dshHome, removalId, detail, 'cleanup-pending')
    return { pluginName, removalId, disabled: true, removed: false, pending: true, failures }
  }

  await updateEntry(dshHome, removalId, (value) => {
    value.status = 'removed'
    value.failures = []
  })
  return { pluginName, removalId, disabled: true, removed: true, pending: false, failures: [] }
}

export function uniqueOrphans(targetClosure, otherClosures) {
  const shared = new Set()
  for (const closure of otherClosures) {
    for (const name of closure) shared.add(name)
  }
  return targetClosure.filter((name) => !shared.has(name)).sort()
}

/**
 * Tombstone enforcement: a plugin mid-removal must not be composed even if a
 * projection or shared-tree repair would otherwise resurrect it.
 */
export async function enforcePendingPluginRemovals(options) {
  const {
    dshHome,
    disableGeneration,
    readBundles,
    removeFromBundles
  } = options
  const ledger = await readLedger(dshHome)
  const blocking = Object.values(ledger.removals).filter((entry) => BLOCKING_STATUSES.has(entry.status))
  if (blocking.length === 0) return []

  const names = [...new Set(blocking.map((entry) => entry.pluginName))].sort()
  for (const name of names) {
    if (disableGeneration !== undefined) await disableGeneration(name)
  }

  const bundles = await readBundles()
  const composed = names.filter((name) => bundles.includes(name))
  if (composed.length > 0) {
    await removeFromBundles(composed)
    const after = await readBundles()
    const remaining = names.filter((name) => after.includes(name))
    if (remaining.length > 0) {
      throw new Error(`removal tombstone is still composed: ${remaining.join(', ')}`)
    }
  }
  return names
}

/**
 * A successful NORMAL-profile start: first call records bootVerifiedAt (backup
 * kept for one full cycle), the next normal boot deletes the backup. Safe Mode
 * must never call this.
 */
export async function confirmPluginRemovalsBooted(options) {
  const { dshHome, now = new Date(), removeBackup = (dir) => rm(dir, { recursive: true, force: true }) } = options
  const ledger = await readLedger(dshHome)
  const advanced = []
  for (const entry of Object.values(ledger.removals)) {
    if (entry.status !== 'removed') continue
    if (entry.bootVerifiedAt === undefined) {
      entry.bootVerifiedAt = now.toISOString()
      advanced.push({ removalId: entry.removalId, deleted: false })
      continue
    }
    if (entry.backupDeletedAt === undefined) {
      try {
        await removeBackup(entry.backupDirectory)
        entry.backupDeletedAt = now.toISOString()
        advanced.push({ removalId: entry.removalId, deleted: true })
      } catch (error) {
        entry.failures = [...(entry.failures ?? []), `backup cleanup failed: ${errorText(error)}`]
      }
    }
  }
  await writeLedger(dshHome, ledger)
  return advanced
}

export async function cleanupVerifiedRemovalBackup(options) {
  const { dshHome, removalId, now = new Date(), removeBackup = (dir) => rm(dir, { recursive: true, force: true }) } = options
  const entry = await updateEntry(dshHome, removalId, () => {})
  if (entry === undefined) return { ok: false, reason: 'unknown removal' }
  if (entry.status !== 'removed') return { ok: false, reason: 'removal is not complete' }
  if (entry.bootVerifiedAt === undefined) return { ok: false, reason: 'removal is not boot verified' }
  try {
    await removeBackup(entry.backupDirectory)
  } catch (error) {
    await markFailure(dshHome, removalId, `backup cleanup failed: ${errorText(error)}`)
    return { ok: false, reason: errorText(error) }
  }
  await updateEntry(dshHome, removalId, (value) => { value.backupDeletedAt = now.toISOString() })
  return { ok: true }
}

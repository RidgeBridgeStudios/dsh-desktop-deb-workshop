import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  collectUnreferencedGenerations,
  disableGeneration,
  ensureRegistryDirectories,
  generationId,
  isGenerationPlugin,
  listGenerations,
  readDesired,
  registryLayout,
  resolveEnabledGenerations,
  sweepRegistry,
  withRegistryLock,
  writeDesired,
  writeGenerationMeta
} from '../usr/share/dsh-desktop/lib/plugin-manager/registry.mjs'

const MASTER = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?\+[0-9a-z][0-9a-z._+-]*\+[0-9a-f]{12}$/u

async function scratch(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-registry-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

async function promote(home, { name, version, lock = 'lock-a', id } = {}) {
  const layout = await ensureRegistryDirectories(home)
  const generation = id ?? generationId(name, version, lock)
  const directory = join(layout.generations, generation)
  await mkdir(directory, { recursive: true })
  await writeGenerationMeta(directory, { pluginName: name, version })
  return { id: generation, directory }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('registry layout nests under profiles/.generations', () => {
  const layout = registryLayout('/h', 'default')
  assert.equal(layout.root, join('/h', 'profiles', '.generations'))
  assert.equal(layout.generations, join('/h', 'profiles', '.generations', 'live'))
  assert.equal(layout.staging, join('/h', 'profiles', '.generations', 'staging'))
  assert.equal(layout.trash, join('/h', 'profiles', '.generations', 'trash'))
  assert.equal(layout.desiredPointer, join('/h', 'profiles', '.generations', 'desired', 'default.json'))
  assert.equal(layout.lockFile, join('/h', 'profiles', '.generations', '.lock'))
})

test('generation id is stable for identical lockfiles', () => {
  const a = generationId('example-plugin', '1.2.3', 'lock contents')
  const b = generationId('example-plugin', '1.2.3', 'lock contents')
  assert.equal(a, b)
  assert.match(a, MASTER)
})

test('generation id changes when the resolved tree changes', () => {
  const a = generationId('example-plugin', '1.2.3', 'lock contents')
  const b = generationId('example-plugin', '1.2.3', 'different lock contents')
  assert.notEqual(a, b)
})

test('generation id sanitizes scoped package names', () => {
  const id = generationId('@scope/name', '1.2.3', 'lock')
  assert.match(id, /^scope\+name\+1\.2\.3\+[0-9a-f]{12}$/u)
  assert.equal(id.includes('/'), false)
})

test('generation id rejects unsafe names and versions', () => {
  assert.throws(() => generationId('../evil', '1.0.0', 'lock'))
  assert.throws(() => generationId('@scope', '1.0.0', 'lock'))
  assert.throws(() => generationId('ok', '.', 'lock'))
  assert.throws(() => generationId('ok', '..', 'lock'))
  assert.throws(() => generationId('ok', 'has spaces', 'lock'))
})

test('desired round-trips sorted and creates its directory', async (t) => {
  const home = await scratch(t)
  await writeDesired(home, 'default', ['b+2.0.0+bbbbbbbbbbbb', 'a+1.0.0+aaaaaaaaaaaa'])
  const onDisk = JSON.parse(await readFile(registryLayout(home, 'default').desiredPointer, 'utf8'))
  assert.deepEqual(onDisk, ['a+1.0.0+aaaaaaaaaaaa', 'b+2.0.0+bbbbbbbbbbbb'])
  assert.deepEqual(await readDesired(home, 'default'), ['a+1.0.0+aaaaaaaaaaaa', 'b+2.0.0+bbbbbbbbbbbb'])
})

test('reading a missing desired pointer yields an empty list', async (t) => {
  const home = await scratch(t)
  assert.deepEqual(await readDesired(home, 'default'), [])
})

test('a corrupt desired pointer is rejected, never treated as empty', async (t) => {
  const home = await scratch(t)
  const layout = registryLayout(home, 'default')
  await mkdir(layout.desiredDir, { recursive: true })
  await writeFile(layout.desiredPointer, '{ not json', 'utf8')
  await assert.rejects(() => readDesired(home, 'default'), /invalid JSON/u)

  await writeFile(layout.desiredPointer, JSON.stringify({ plugins: [] }), 'utf8')
  await assert.rejects(() => readDesired(home, 'default'), /array of generation ids/u)
})

test('the registry lock serializes concurrent operations', async (t) => {
  const home = await scratch(t)
  const events = []
  const first = withRegistryLock(home, async () => {
    events.push('first-start')
    await delay(120)
    events.push('first-end')
  })
  await delay(20)
  const second = withRegistryLock(home, async () => {
    events.push('second-start')
    events.push('second-end')
  })
  await Promise.all([first, second])
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end'])
  const lock = await stat(registryLayout(home, 'default').lockFile).then(() => true, () => false)
  assert.equal(lock, false)
})

test('a stale lock from a crashed run is broken', async (t) => {
  const home = await scratch(t)
  const layout = await ensureRegistryDirectories(home)
  await writeFile(layout.lockFile, '999999 2000-01-01T00:00:00.000Z\n', 'utf8')
  const past = new Date(Date.now() - 60_000)
  await utimes(layout.lockFile, past, past)

  const ran = await withRegistryLock(
    home,
    async () => 'ran',
    { staleAfterMs: 5_000, retryMs: 10, timeoutMs: 2_000 }
  )
  assert.equal(ran, 'ran')
})

test('waiting on a live lock times out rather than hanging', async (t) => {
  const home = await scratch(t)
  const layout = await ensureRegistryDirectories(home)
  await writeFile(layout.lockFile, '1234 now\n', 'utf8')

  await assert.rejects(
    () => withRegistryLock(
      home,
      async () => 'never',
      { staleAfterMs: 60_000, retryMs: 10, timeoutMs: 60 }
    ),
    /holding the registry lock/u
  )
})

test('release happens even when the locked operation throws', async (t) => {
  const home = await scratch(t)
  await assert.rejects(
    () => withRegistryLock(home, async () => {
      throw new Error('boom')
    })
  )
  const lock = await stat(registryLayout(home, 'default').lockFile).then(() => true, () => false)
  assert.equal(lock, false)
})

test('listGenerations reads promoted metadata', async (t) => {
  const home = await scratch(t)
  const { id } = await promote(home, { name: 'example-plugin', version: '1.2.3' })
  const found = await listGenerations(home)
  assert.equal(found.length, 1)
  assert.equal(found[0].id, id)
  assert.equal(found[0].pluginName, 'example-plugin')
  assert.equal(found[0].version, '1.2.3')
})

test('isGenerationPlugin sees promoted generations regardless of desired', async (t) => {
  const home = await scratch(t)
  await promote(home, { name: 'example-plugin', version: '1.2.3' })
  assert.equal(await isGenerationPlugin(home, 'example-plugin'), true)
  assert.equal(await isGenerationPlugin(home, 'other-plugin'), false)
})

test('disableGeneration drops every generation of one plugin only', async (t) => {
  const home = await scratch(t)
  const first = await promote(home, { name: 'example-plugin', version: '1.0.0', lock: 'a' })
  const second = await promote(home, { name: 'example-plugin', version: '2.0.0', lock: 'b' })
  const keeper = await promote(home, { name: 'other-plugin', version: '1.0.0', lock: 'c' })
  await writeDesired(home, 'default', [first.id, second.id, keeper.id])

  assert.equal(await disableGeneration(home, 'default', 'example-plugin'), true)
  assert.deepEqual(await readDesired(home, 'default'), [keeper.id])
  assert.equal(await disableGeneration(home, 'default', 'example-plugin'), false)
})

test('resolveEnabledGenerations maps desired ids to names and skips shared-tree packages', async (t) => {
  const home = await scratch(t)
  const plugin = await promote(home, { name: 'example-plugin', version: '1.0.0' })
  const market = await promote(home, { name: 'dshmarket', version: '9.9.9' })
  await writeDesired(home, 'default', [plugin.id, market.id])

  const enabled = await resolveEnabledGenerations(home, 'default')
  assert.deepEqual([...enabled.keys()], ['example-plugin'])
  assert.equal(enabled.get('example-plugin').id, plugin.id)
})

test('resolveEnabledGenerations fails closed on a missing desired generation', async (t) => {
  const home = await scratch(t)
  await writeDesired(home, 'default', ['ghost+1.0.0+deadbeefdead'])
  await assert.rejects(() => resolveEnabledGenerations(home, 'default'), /missing or unreadable/u)
})

test('collectUnreferencedGenerations reports only unpointed generations', async (t) => {
  const home = await scratch(t)
  const kept = await promote(home, { name: 'kept', version: '1.0.0' })
  const orphan = await promote(home, { name: 'orphan', version: '1.0.0' })
  await writeDesired(home, 'default', [kept.id])
  assert.deepEqual(await collectUnreferencedGenerations(home, 'default'), [orphan.id])
})

test('collectUnreferencedGenerations fails closed when desired points at a missing generation', async (t) => {
  const home = await scratch(t)
  await writeDesired(home, 'default', ['ghost+1.0.0+deadbeefdead'])
  await assert.rejects(() => collectUnreferencedGenerations(home, 'default'), /missing or unreadable/u)
})

test('sweepRegistry removes staging leftovers and unreferenced generations', async (t) => {
  const home = await scratch(t)
  const layout = await ensureRegistryDirectories(home)
  const kept = await promote(home, { name: 'kept', version: '1.0.0' })
  await promote(home, { name: 'orphan', version: '1.0.0' })
  await writeDesired(home, 'default', [kept.id])

  await mkdir(join(layout.staging, 'leftover'), { recursive: true })
  await mkdir(join(layout.trash, 'old'), { recursive: true })

  const result = await sweepRegistry(home)
  assert.equal(result.failed.length, 0)
  assert.equal((await listGenerations(home)).length, 1)
  const staging = await stat(layout.staging).then(() => true, () => false)
  assert.equal(staging, true)
  const keptDir = await stat(kept.directory).then(() => true, () => false)
  assert.equal(keptDir, true)
})

test('arity guards reject calls missing profile parameter', async (t) => {
  const home = await scratch(t)
  assert.throws(() => registryLayout(home), /profile is required/u)
  await assert.rejects(() => readDesired(home), /profile is required/u)
  await assert.rejects(() => writeDesired(home, []), /profile is required/u)
  await assert.rejects(() => resolveEnabledGenerations(home), /profile is required/u)
  await assert.rejects(() => disableGeneration(home), /profile is required/u)
  await assert.rejects(() => collectUnreferencedGenerations(home), /profile is required/u)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  writeDesired,
  readDesired,
  disableGeneration,
  sweepRegistry,
  ensureRegistryDirectories,
  generationId,
  writeGenerationMeta
} from '../usr/share/dsh-desktop/lib/plugin-manager/registry.mjs'
import {
  beginRemoval,
  enforcePendingPluginRemovals
} from '../usr/share/dsh-desktop/lib/plugin-manager/plugin-removal.mjs'
import { projectGenerations } from '../usr/share/dsh-desktop/lib/plugin-manager/projection.mjs'
import { profileDirectory } from '../usr/share/dsh-desktop/lib/plugin-manager/paths.mjs'

async function scratch(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-isolation-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

async function promote(home, name, version) {
  const layout = await ensureRegistryDirectories(home)
  const id = generationId(name, version, `${name}@${version}`)
  const directory = join(layout.generations, id)
  const pkg = join(directory, 'node_modules', name)
  await mkdir(pkg, { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, version }, undefined, 2))
  await writeGenerationMeta(directory, { pluginName: name, version })
  return { id, directory, pkg }
}

async function writeProfileManifest(home, profile, manifest = {}) {
  const dir = profileDirectory(home, profile)
  await mkdir(dir, { recursive: true })
  const content = {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    ...manifest
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify(content, undefined, 2))
  return dir
}

async function readProfileManifest(home, profile) {
  const dir = profileDirectory(home, profile)
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
}

test('Two profiles, install widget@1.0.0 in A only', async (t) => {
  const home = await scratch(t)
  const widget = await promote(home, 'widget', '1.0.0')

  await writeProfileManifest(home, 'profile-a')
  await writeProfileManifest(home, 'profile-b')

  await writeDesired(home, 'profile-a', [widget.id])
  await writeDesired(home, 'profile-b', [])

  await projectGenerations(home, 'profile-a')
  await projectGenerations(home, 'profile-b')

  const manifestA = await readProfileManifest(home, 'profile-a')
  const manifestB = await readProfileManifest(home, 'profile-b')

  assert.ok(manifestA.dependencies.widget)
  assert.equal(manifestB.dependencies?.widget, undefined)

  const desiredA = await readDesired(home, 'profile-a')
  const desiredB = await readDesired(home, 'profile-b')
  assert.ok(desiredA.includes(widget.id))
  assert.equal(desiredB.includes(widget.id), false)
})

test('Same plugin, widget@1.0.0 in A and widget@2.0.0 in B', async (t) => {
  const home = await scratch(t)
  const w1 = await promote(home, 'widget', '1.0.0')
  const w2 = await promote(home, 'widget', '2.0.0')

  await writeProfileManifest(home, 'profile-a')
  await writeProfileManifest(home, 'profile-b')

  await writeDesired(home, 'profile-a', [w1.id])
  await writeDesired(home, 'profile-b', [w2.id])

  await projectGenerations(home, 'profile-a')
  await projectGenerations(home, 'profile-b')

  const linkA = join(profileDirectory(home, 'profile-a'), 'node_modules', 'widget')
  const linkB = join(profileDirectory(home, 'profile-b'), 'node_modules', 'widget')

  const realA = await realpath(linkA)
  const realB = await realpath(linkB)

  assert.notEqual(realA, realB)
  assert.equal(realA, await realpath(w1.pkg))
  assert.equal(realB, await realpath(w2.pkg))
})

test('disableGeneration(home, A, widget) removes from A only', async (t) => {
  const home = await scratch(t)
  const widget = await promote(home, 'widget', '1.0.0')

  await writeDesired(home, 'profile-a', [widget.id])
  await writeDesired(home, 'profile-b', [widget.id])

  const disabled = await disableGeneration(home, 'profile-a', 'widget')
  assert.equal(disabled, true)

  assert.deepEqual(await readDesired(home, 'profile-a'), [])
  assert.deepEqual(await readDesired(home, 'profile-b'), [widget.id])
})

test('Tombstone foo for A only, boot B with foo in bundles', async (t) => {
  const home = await scratch(t)

  await writeProfileManifest(home, 'profile-b', {
    dsh: { profile: { bundles: ['foo'] } }
  })

  await beginRemoval({ dshHome: home, profile: 'profile-a', pluginName: 'foo' })

  await enforcePendingPluginRemovals({
    dshHome: home,
    profile: 'profile-b',
    readBundles: async () => (await readProfileManifest(home, 'profile-b')).dsh.profile.bundles,
    removeFromBundles: async () => {
      throw new Error('removeFromBundles should not be called for profile-b')
    }
  })

  const manifestB = await readProfileManifest(home, 'profile-b')
  assert.deepEqual(manifestB.dsh.profile.bundles, ['foo'])
})

test('sweepRegistry(home) with a generation referenced only by desired/B.json does not remove it', async (t) => {
  const home = await scratch(t)
  const widget = await promote(home, 'widget', '1.0.0')

  await writeDesired(home, 'profile-a', [])
  await writeDesired(home, 'profile-b', [widget.id])

  await sweepRegistry(home)
  assert.equal(existsSync(widget.directory), true)
})

test('sweepRegistry(home) with a generation referenced by neither profile removes it', async (t) => {
  const home = await scratch(t)
  const orphan = await promote(home, 'orphan', '1.0.0')

  await writeDesired(home, 'profile-a', [])
  await writeDesired(home, 'profile-b', [])

  await sweepRegistry(home)
  assert.equal(existsSync(orphan.directory), false)
})

test('readDesired(home, A) and readDesired(home, B) return independent arrays after concurrent writes', async (t) => {
  const home = await scratch(t)

  await Promise.all([
    writeDesired(home, 'profile-a', ['gen-a-1', 'gen-a-2']),
    writeDesired(home, 'profile-b', ['gen-b-1'])
  ])

  const [desiredA, desiredB] = await Promise.all([
    readDesired(home, 'profile-a'),
    readDesired(home, 'profile-b')
  ])

  assert.deepEqual(desiredA, ['gen-a-1', 'gen-a-2'])
  assert.deepEqual(desiredB, ['gen-b-1'])
})

test('Concurrent writeDesired(home, A, ...) and writeDesired(home, B, ...) serialize under the registry lock', async (t) => {
  const home = await scratch(t)

  await Promise.all([
    writeDesired(home, 'profile-a', ['final-a']),
    writeDesired(home, 'profile-b', ['final-b'])
  ])

  assert.deepEqual(await readDesired(home, 'profile-a'), ['final-a'])
  assert.deepEqual(await readDesired(home, 'profile-b'), ['final-b'])
})

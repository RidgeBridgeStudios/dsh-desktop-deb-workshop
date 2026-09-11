import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  exposeMissingGenerationLinks,
  projectGenerations,
  publishGenerationManifest,
  publishInstalledGeneration
} from '../usr/share/dsh-desktop/lib/plugin-manager/projection.mjs'
import {
  ensureRegistryDirectories,
  generationId,
  writeDesired,
  writeGenerationMeta
} from '../usr/share/dsh-desktop/lib/plugin-manager/registry.mjs'
import { LIVE_PROFILE, profileDirectory } from '../usr/share/dsh-desktop/lib/plugin-manager/paths.mjs'

const IN_BOX = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

async function scratch(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-projection-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

async function promote(home, name, version, { bundle = false } = {}) {
  const layout = await ensureRegistryDirectories(home)
  const id = generationId(name, version, `${name}@${version}`)
  const directory = join(layout.generations, id)
  const pkg = join(directory, 'node_modules', name)
  await mkdir(pkg, { recursive: true })
  const manifest = { name, version }
  if (bundle) manifest.dsh = { bundle: { patch: './cordis.patch.yml' } }
  await writeFile(join(pkg, 'package.json'), JSON.stringify(manifest, undefined, 2))
  await writeGenerationMeta(directory, { pluginName: name, version })
  return { id, directory, pkg }
}

function profileManifest() {
  return {
    name: 'dsh-profile-default',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...IN_BOX] } }
  }
}

async function writeProfile(home, manifest = profileManifest()) {
  const dir = profileDirectory(home, LIVE_PROFILE)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2))
  return dir
}

async function readProfile(home) {
  return JSON.parse(await readFile(join(profileDirectory(home, LIVE_PROFILE), 'package.json'), 'utf8'))
}

function moduleLink(home, name) {
  return join(profileDirectory(home, LIVE_PROFILE), 'node_modules', name)
}

test('projects an enabled generation into a link, dependency, bundle and override', async (t) => {
  const home = await scratch(t)
  const { id, pkg } = await promote(home, 'widget', '1.0.0')
  await writeProfile(home)
  await writeDesired(home, [id])

  const result = await projectGenerations(home)
  assert.deepEqual(result.linked, ['widget'])
  assert.equal(await readlink(moduleLink(home, 'widget')), pkg)

  const manifest = await readProfile(home)
  assert.equal(manifest.dependencies.widget, '1.0.0')
  assert.deepEqual(manifest.dsh.profile.bundles, [...IN_BOX, 'widget'])
  assert.deepEqual(manifest.dsh.desktop.generationProjection, {
    version: 1,
    plugins: {
      widget: { generationId: id, visibleVersion: '1.0.0', previousOverride: { present: false } }
    }
  })
  assert.match(manifest.pnpm.overrides.widget, /^link:/u)
  assert.match(manifest.pnpm.overrides.widget, /node_modules[/\\]widget$/u)
})

test('prunes a stale generation symlink when it leaves desired', async (t) => {
  const home = await scratch(t)
  const { id } = await promote(home, 'widget', '1.0.0')
  await writeProfile(home)
  await writeDesired(home, [id])
  await projectGenerations(home)
  assert.equal(existsSync(moduleLink(home, 'widget')), true)

  await writeDesired(home, [])
  const result = await projectGenerations(home)
  assert.equal(result.unlinked.includes('widget'), true)
  assert.equal(existsSync(moduleLink(home, 'widget')), false)
})

test('never prunes a foreign symlink or a real directory', async (t) => {
  const home = await scratch(t)
  const { id } = await promote(home, 'widget', '1.0.0')
  const dir = await writeProfile(home)
  const modules = join(dir, 'node_modules')
  await mkdir(modules, { recursive: true })
  const foreign = await mkdtemp(join(tmpdir(), 'dsh-foreign-'))
  t.after(() => rm(foreign, { recursive: true, force: true }))
  await symlink(foreign, join(modules, 'foreign'))
  await mkdir(join(modules, 'real-dir'))

  await writeDesired(home, [id])
  await projectGenerations(home)

  assert.equal((await lstat(join(modules, 'foreign'))).isSymbolicLink(), true)
  assert.equal(await readlink(join(modules, 'foreign')), foreign)
  assert.equal((await lstat(join(modules, 'real-dir'))).isDirectory(), true)
})

test('the prune rule recognises absolute targets only (relative links are left alone)', async (t) => {
  const home = await scratch(t)
  const { id } = await promote(home, 'widget', '1.0.0')
  const dir = await writeProfile(home)
  const modules = join(dir, 'node_modules')
  await mkdir(modules, { recursive: true })
  const layout = await ensureRegistryDirectories(home)
  const relativeTarget = join('..', '..', '.generations', 'live', id, 'node_modules', 'widget')
  await symlink(relativeTarget, join(modules, 'widget'))

  await writeDesired(home, [])
  await projectGenerations(home)

  assert.equal((await lstat(join(modules, 'widget'))).isSymbolicLink(), true)
  assert.equal(await readlink(join(modules, 'widget')), relativeTarget)
  assert.equal(existsSync(join(layout.generations, id)), true)
})

test('skips the manifest write when nothing changed (mtime is preserved)', async (t) => {
  const home = await scratch(t)
  const { id } = await promote(home, 'widget', '1.0.0')
  const dir = await writeProfile(home)
  await writeDesired(home, [id])
  await projectGenerations(home)

  const manifestPath = join(dir, 'package.json')
  const past = new Date(Date.now() - 120_000)
  await utimes(manifestPath, past, past)
  const before = await stat(manifestPath)

  await projectGenerations(home)
  const after = await stat(manifestPath)
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.ok(after.mtimeMs < Date.now() - 60_000, 'manifest mtime must not churn')
})

test('cold projection rebuilds the bundle list exactly from desired', async (t) => {
  const home = await scratch(t)
  const { id } = await promote(home, 'widget', '1.0.0')
  const manifest = profileManifest()
  manifest.dsh.profile.bundles = [...IN_BOX, 'stray-bundle']
  await writeProfile(home, manifest)
  await writeDesired(home, [id])

  await projectGenerations(home)
  const after = await readProfile(home)
  assert.deepEqual(after.dsh.profile.bundles, [...IN_BOX, 'widget'])
})

test('live publish with syncBundles false leaves other bundle entries alone', async (t) => {
  const home = await scratch(t)
  const { id } = await promote(home, 'widget', '1.0.0')
  const manifest = profileManifest()
  manifest.dsh.profile.bundles = [...IN_BOX, 'stray-bundle']
  await writeProfile(home, manifest)
  await writeDesired(home, [id])

  await publishGenerationManifest(home)
  const after = await readProfile(home)
  assert.deepEqual(after.dsh.profile.bundles, [...IN_BOX, 'stray-bundle'])
  assert.equal(after.dependencies.widget, '1.0.0')
})

test('live publish with syncBundles true reconciles the bundle list', async (t) => {
  const home = await scratch(t)
  const { id } = await promote(home, 'widget', '1.0.0')
  const manifest = profileManifest()
  manifest.dsh.profile.bundles = [...IN_BOX, 'stray-bundle']
  await writeProfile(home, manifest)
  await writeDesired(home, [id])

  await publishInstalledGeneration(home, 'widget', LIVE_PROFILE, { syncBundles: true })
  const after = await readProfile(home)
  assert.deepEqual(after.dsh.profile.bundles, [...IN_BOX, 'widget'])
})

test('recovers a crash between writing the link and the ownership marker', async (t) => {
  const home = await scratch(t)
  const { pkg } = await promote(home, 'widget', '1.0.0')
  const dir = await writeProfile(home)
  const modules = join(dir, 'node_modules')
  await mkdir(modules, { recursive: true })
  const spec = 'link:../../.generations/live/widget+1.0.0+deadbeefdead/node_modules/widget'
  const manifest = profileManifest()
  manifest.dependencies = { widget: spec }
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2))
  await symlink(pkg, join(modules, 'widget'))

  await projectGenerations(home)

  const after = await readProfile(home)
  assert.equal(Object.hasOwn(after.dependencies, 'widget'), false)
  assert.equal(after.dsh.desktop?.generationProjection, undefined)
  assert.equal(existsSync(join(modules, 'widget')), false)
})

test('rejects a generation package root that is a symlink out of tree', async (t) => {
  const home = await scratch(t)
  const layout = await ensureRegistryDirectories(home)
  const id = generationId('widget', '1.0.0', 'widget@1.0.0')
  const directory = join(layout.generations, id)
  await mkdir(join(directory, 'node_modules'), { recursive: true })
  const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'package.json'), JSON.stringify({ name: 'widget', version: '1.0.0' }))
  await symlink(outside, join(directory, 'node_modules', 'widget'))
  await writeGenerationMeta(directory, { pluginName: 'widget', version: '1.0.0' })
  await writeProfile(home)
  await writeDesired(home, [id])

  await assert.rejects(() => projectGenerations(home), /not a real directory/u)
})

test('rejects a generation manifest that is a symlink out of tree', async (t) => {
  const home = await scratch(t)
  const { id, pkg } = await promote(home, 'widget', '1.0.0')
  const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await rm(join(pkg, 'package.json'), { force: true })
  await writeFile(join(outside, 'package.json'), JSON.stringify({ name: 'widget', version: '1.0.0' }))
  await symlink(join(outside, 'package.json'), join(pkg, 'package.json'))
  await writeProfile(home)
  await writeDesired(home, [id])

  await assert.rejects(() => projectGenerations(home), /not a real file|outside its package/u)
})

test('a failed link switch restores the previous link and rethrows', async (t) => {
  const home = await scratch(t)
  const older = await promote(home, 'widget', '1.0.0')
  const newer = await promote(home, 'widget', '2.0.0')
  const dir = await writeProfile(home)
  await writeDesired(home, [older.id])
  await projectGenerations(home)
  await writeDesired(home, [newer.id])

  const link = moduleLink(home, 'widget')
  const oldTarget = await readlink(link)
  const fault = {
    rename: async (from, to) => {
      if (String(from).includes('.dsh-next-')) {
        throw Object.assign(new Error('EPERM: simulated occupied path'), { code: 'EPERM' })
      }
      return rename(from, to)
    }
  }

  await assert.rejects(
    () => publishInstalledGeneration(home, 'widget', LIVE_PROFILE, { fileSystem: fault }),
    /EPERM/u
  )

  assert.equal(await readlink(link), oldTarget)
  const entries = await readdir(join(dir, 'node_modules'))
  assert.equal(entries.some((entry) => entry.includes('.dsh-next-')), false)
  assert.equal(JSON.parse(await readFile(join(link, 'package.json'), 'utf8')).version, '1.0.0')
})

test('publishes an installed generation through the profile path', async (t) => {
  const home = await scratch(t)
  const { id, pkg } = await promote(home, 'widget', '1.0.0')
  await writeProfile(home)
  await writeDesired(home, [id])

  const result = await publishInstalledGeneration(home, 'widget')
  assert.deepEqual(result.plugins, ['widget'])
  assert.equal(await readlink(moduleLink(home, 'widget')), pkg)
})

test('exposes only missing generation links and is a no-op once linked', async (t) => {
  const home = await scratch(t)
  const { id, pkg } = await promote(home, 'widget', '1.0.0')
  await writeProfile(home)
  await writeDesired(home, [id])

  assert.deepEqual(await exposeMissingGenerationLinks(home), ['widget'])
  assert.equal(await readlink(moduleLink(home, 'widget')), pkg)
  assert.deepEqual(await exposeMissingGenerationLinks(home), [])
})



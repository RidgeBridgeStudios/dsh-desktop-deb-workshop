import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  generationBuildApprovals,
  generationInstallEnvironment,
  installGeneration
} from '../usr/share/dsh-desktop/lib/plugin-manager/installer.mjs'
import {
  generationId,
  listGenerations,
  registryLayout
} from '../usr/share/dsh-desktop/lib/plugin-manager/registry.mjs'

test('generationInstallEnvironment sets ELECTRON_RUN_AS_NODE for electron executable', () => {
  const env = generationInstallEnvironment({}, '/usr/bin/electron')
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(env.CI, 'true')
  assert.equal(env.NO_COLOR, '1')
  assert.equal(env.npm_config_side_effects_cache, 'false')
})

test('generationInstallEnvironment does not set ELECTRON_RUN_AS_NODE for node executable', () => {
  const env = generationInstallEnvironment({}, '/usr/bin/node')
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(env.CI, 'true')
  assert.equal(env.NO_COLOR, '1')
})

test('generationInstallEnvironment preserves existing ELECTRON_RUN_AS_NODE', () => {
  const env = generationInstallEnvironment({ ELECTRON_RUN_AS_NODE: 'custom' }, '/usr/bin/node')
  assert.equal(env.ELECTRON_RUN_AS_NODE, 'custom')
})

test('isElectronBinary correctly identifies electron binaries', async () => {
  const { isElectronBinary } = await import('../usr/share/dsh-desktop/lib/plugin-manager/installer.mjs')
  assert.equal(isElectronBinary('/usr/bin/electron'), true)
  assert.equal(isElectronBinary('/opt/Electron/electron'), true)
  assert.equal(isElectronBinary('/usr/bin/node'), false)
  assert.equal(isElectronBinary(undefined), false)
})


async function scratch(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-installer-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

async function writePackage(root, name, version) {
  const dir = join(root, 'node_modules', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version }, undefined, 2))
  return dir
}

function install(home, overrides = {}) {
  return installGeneration({
    dshHome: home,
    pluginSpec: 'example-plugin@1.2.3',
    expectedVersion: '1.2.3',
    nodeExecutablePath: process.execPath,
    pnpmEntryPath: '/packaged/pnpm/bin/pnpm.cjs',
    ...overrides
  })
}

test('installs into a new immutable generation and promotes it', async (t) => {
  const home = await scratch(t)
  const result = await install(home, {
    runInstall: async (staging) => {
      await writePackage(staging, 'example-plugin', '1.2.3')
      await writeFile(join(staging, 'pnpm-lock.yaml'), 'lock-a')
      return { code: 0, output: '' }
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.generation.pluginName, 'example-plugin')
  assert.equal(result.generation.version, '1.2.3')
  assert.equal(result.generation.id, generationId('example-plugin', '1.2.3', 'lock-a'))
  assert.equal(existsSync(result.generation.directory), true)
  const meta = JSON.parse(await readFile(join(result.generation.directory, 'generation.json'), 'utf8'))
  assert.deepEqual(meta, { pluginName: 'example-plugin', version: '1.2.3' })
  const staging = await import('node:fs/promises').then((fs) => fs.readdir(registryLayout(home).staging))
  assert.deepEqual(staging, [])
})

test('rejects an installed manifest whose name does not match the request', async (t) => {
  const home = await scratch(t)
  const result = await install(home, {
    runInstall: async (staging) => {
      await writePackage(staging, 'example-plugin', '1.2.3')
      await writeFile(
        join(staging, 'node_modules', 'example-plugin', 'package.json'),
        JSON.stringify({ name: 'something-else', version: '1.2.3' })
      )
      await writeFile(join(staging, 'pnpm-lock.yaml'), 'lock-a')
      return { code: 0, output: '' }
    }
  })
  assert.equal(result.ok, false)
  assert.match(result.detail, /name/u)
  assert.deepEqual(await listGenerations(home), [])
})

test('rejects an installed version that does not match the request', async (t) => {
  const home = await scratch(t)
  const result = await install(home, {
    runInstall: async (staging) => {
      await writePackage(staging, 'example-plugin', '9.9.9')
      await writeFile(join(staging, 'pnpm-lock.yaml'), 'lock-a')
      return { code: 0, output: '' }
    }
  })
  assert.equal(result.ok, false)
  assert.match(result.detail, /ERR_RESOLVED_VERSION_MISMATCH/u)
  assert.deepEqual(await listGenerations(home), [])
})

test('strips private host singletons before promotion, including nested copies', async (t) => {
  const home = await scratch(t)
  let nestedReact
  const result = await install(home, {
    runInstall: async (staging) => {
      await writePackage(staging, 'example-plugin', '1.2.3')
      await writePackage(staging, 'react', '18.3.1')
      await writePackage(staging, 'react-dom', '18.3.1')
      await writePackage(staging, '@deepseek-ai/dsh-base', '0.1.5-rc.1')
      await writePackage(staging, 'keepme', '1.0.0')
      nestedReact = await writePackage(join(staging, 'node_modules', 'example-plugin'), 'react', '18.3.1')
      await writeFile(join(staging, 'pnpm-lock.yaml'), 'lock-a')
      return { code: 0, output: '' }
    }
  })

  assert.equal(result.ok, true)
  assert.ok(result.hoisted.includes('react'))
  assert.ok(result.hoisted.includes('react-dom'))
  assert.ok(result.hoisted.includes('@deepseek-ai/dsh-base'))
  const root = result.generation.directory
  assert.equal(existsSync(join(root, 'node_modules', 'react')), false)
  assert.equal(existsSync(join(root, 'node_modules', 'react-dom')), false)
  assert.equal(existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-base')), false)
  assert.equal(existsSync(nestedReact), false)
  assert.equal(existsSync(join(root, 'node_modules', 'keepme', 'package.json')), true)
})

test('reuses an identical generation instead of creating a second one', async (t) => {
  const home = await scratch(t)
  const runInstall = async (staging) => {
    await writePackage(staging, 'example-plugin', '1.2.3')
    await writeFile(join(staging, 'pnpm-lock.yaml'), 'lock-a')
    return { code: 0, output: '' }
  }
  const first = await install(home, { runInstall })
  const second = await install(home, { runInstall })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.generation.id, first.generation.id)
  assert.equal(second.generation.directory, first.generation.directory)
  assert.equal((await listGenerations(home)).length, 1)
})

test('rejects an unsafe non-singleton symlink before promotion', async (t) => {
  const home = await scratch(t)
  const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))

  const result = await install(home, {
    runInstall: async (staging) => {
      await writePackage(staging, 'example-plugin', '1.2.3')
      await mkdir(join(staging, 'node_modules'), { recursive: true })
      await symlink(outside, join(staging, 'node_modules', 'evil-package'))
      await writeFile(join(staging, 'pnpm-lock.yaml'), 'lock-a')
      return { code: 0, output: '' }
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.detail, /not self-contained/u)
  assert.deepEqual(await listGenerations(home), [])
})

test('removes a host-singleton symlink without following its target', async (t) => {
  const home = await scratch(t)
  const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'marker.txt'), 'intact', 'utf8')

  const result = await install(home, {
    runInstall: async (staging) => {
      await writePackage(staging, 'example-plugin', '1.2.3')
      await mkdir(join(staging, 'node_modules'), { recursive: true })
      await symlink(outside, join(staging, 'node_modules', 'react'))
      await writeFile(join(staging, 'pnpm-lock.yaml'), 'lock-a')
      return { code: 0, output: '' }
    }
  })

  assert.equal(result.ok, true)
  assert.ok(result.hoisted.includes('react'))
  assert.equal(existsSync(join(result.generation.directory, 'node_modules', 'react')), false)
  assert.equal(existsSync(join(outside, 'marker.txt')), true)
})

test('generationBuildApprovals keeps only explicit safe allowBuild keys', () => {
  const yaml = [
    'packages:',
    '  - .',
    '',
    'allowBuilds:',
    '  "sharp": true',
    '  esbuild: true',
    '  not a package: true',
    '  denied: false',
    ''
  ].join('\n')
  assert.deepEqual(generationBuildApprovals(yaml).sort(), ['esbuild', 'sharp'])
  assert.deepEqual(generationBuildApprovals(''), [])
})

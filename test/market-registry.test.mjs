import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_NPM_REGISTRY,
  REGION_REGISTRY,
  resolveMarketRegistry,
  registryFromArguments
} from '../usr/share/dsh-desktop/lib/plugin-manager/market-registry.mjs'

async function profileWithRegion(t, region) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-region-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, '.dsh-market'), { recursive: true })
  await writeFile(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ region }))
  return dir
}

test('the default registry is npmjs and china is the Tencent mirror', () => {
  assert.equal(DEFAULT_NPM_REGISTRY, 'https://registry.npmjs.org')
  assert.deepEqual(REGION_REGISTRY, {
    global: 'https://registry.npmjs.org',
    china: 'https://mirrors.cloud.tencent.com/npm'
  })
})

test('reads a registry named on the command line in every spelling', () => {
  assert.equal(registryFromArguments(['--registry=https://example.test/npm/']), 'https://example.test/npm')
  assert.equal(registryFromArguments(['--registry', 'https://example.test/npm']), 'https://example.test/npm')
  assert.equal(registryFromArguments(['--config.registry=https://example.test/npm']), 'https://example.test/npm')
  assert.equal(registryFromArguments([]), null)
})

test('an explicit argument beats everything, including the environment', async (t) => {
  const profileDir = await profileWithRegion(t, 'china')
  const resolved = await resolveMarketRegistry({
    profileDir,
    args: ['--registry=https://private.test/npm'],
    environment: { npm_config_registry: 'https://env.test', DSHM_NPM_MIRROR: 'https://mirror.test' }
  })
  assert.equal(resolved, 'https://private.test/npm')
})

test('a caller-provided registry in the environment is left alone', async (t) => {
  const profileDir = await profileWithRegion(t, 'china')
  assert.equal(
    await resolveMarketRegistry({ profileDir, environment: { npm_config_registry: 'https://private.test' } }),
    null
  )
})

test('no persisted region means do not pin anything', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-noregion-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  assert.equal(await resolveMarketRegistry({ profileDir: dir, environment: {} }), null)
})

test('a global region leaves a private registry unmolested', async (t) => {
  const profileDir = await profileWithRegion(t, 'global')
  assert.equal(await resolveMarketRegistry({ profileDir, environment: {} }), null)
})

test('a china region pins the Tencent mirror', async (t) => {
  const profileDir = await profileWithRegion(t, 'china')
  assert.equal(
    await resolveMarketRegistry({ profileDir, environment: {} }),
    'https://mirrors.cloud.tencent.com/npm'
  )
})

test('the market mirror override is normalized', async (t) => {
  const profileDir = await profileWithRegion(t, 'global')
  assert.equal(
    await resolveMarketRegistry({ profileDir, environment: { DSHM_NPM_MIRROR: 'https://mirror.test/npm/' } }),
    'https://mirror.test/npm'
  )
})

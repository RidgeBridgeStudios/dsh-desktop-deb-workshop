import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SUPPORTED_DSH_RANGE,
  SUPPORTED_DSH_VERSION,
  assertSupportedDsh,
  isSupportedDsh,
  resolveRunningDshVersion
} from '../usr/share/dsh-desktop/lib/plugin-manager/dsh-version.mjs'
import { createMarketService } from '../usr/share/dsh-desktop/packages/dsh-desktop-market-installer/index.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('dsh-version exports expected range and pinned version', () => {
  assert.equal(SUPPORTED_DSH_RANGE, '~0.1.5-0')
  assert.equal(SUPPORTED_DSH_VERSION, '0.1.5-rc.1')
})

test('assertSupportedDsh accepts supported DSH versions', () => {
  assert.equal(isSupportedDsh('0.1.5-rc.1'), true)
  assert.equal(isSupportedDsh('0.1.5'), true)
  assert.equal(isSupportedDsh('0.1.5-beta.2'), true)

  assert.doesNotThrow(() => assertSupportedDsh('0.1.5-rc.1'))
  assert.doesNotThrow(() => assertSupportedDsh('0.1.5'))
})

test('assertSupportedDsh rejects older and newer majors and minors with descriptive error', () => {
  const rejected = ['0.1.4', '0.1.0', '0.0.1', '0.2.0', '0.3.0', '1.0.0', '2.0.0']

  for (const version of rejected) {
    assert.equal(isSupportedDsh(version), false)
    assert.throws(
      () => assertSupportedDsh(version),
      (err) => {
        assert.ok(err instanceof Error)
        assert.ok(err.message.includes(version), `Error must contain actual version ${version}`)
        assert.ok(
          err.message.includes(SUPPORTED_DSH_RANGE),
          `Error must contain range ${SUPPORTED_DSH_RANGE}`
        )
        return true
      }
    )
  }
})

test('assertSupportedDsh rejects invalid or empty version inputs', () => {
  for (const input of [null, undefined, '', 'not-a-version', 'vInvalid']) {
    assert.equal(isSupportedDsh(input), false)
    assert.throws(() => assertSupportedDsh(input))
  }
})

test('market installer refuses installation when DSH version is outside supported range', async () => {
  let installCalled = false
  const service = createMarketService({
    home: '/tmp/ignored',
    dshVersion: '0.2.0',
    readState: async () => ({ dependency: undefined, installedVersion: undefined }),
    installShared: async () => {
      installCalled = true
    }
  })

  const outcome = await service.install()
  assert.equal(outcome.kind, 'error')
  assert.equal(installCalled, false)

  const status = await service.status()
  assert.equal(status.phase, 'error')
  assert.ok(status.detail.includes('0.2.0'))
  assert.ok(status.detail.includes(SUPPORTED_DSH_RANGE))
})

test('market installer allows installation when DSH version is supported', async () => {
  let installCalled = false
  const service = createMarketService({
    home: '/tmp/ignored',
    dshVersion: '0.1.5-rc.1',
    readState: async () => ({ dependency: undefined, installedVersion: undefined }),
    installShared: async () => {
      installCalled = true
    }
  })

  const outcome = await service.install()
  assert.equal(outcome.kind, 'started')
})

test('market installer refuses installation when DSH version cannot be resolved', async () => {
  let installCalled = false
  const service = createMarketService({
    home: '/tmp/nonexistent-home-12345',
    resolveDshVersion: () => null,
    readState: async () => ({ dependency: undefined, installedVersion: undefined }),
    installShared: async () => {
      installCalled = true
    }
  })

  const outcome = await service.install()
  assert.equal(outcome.kind, 'error')
  assert.equal(installCalled, false)
  assert.match(outcome.detail, /Could not resolve the running DSH version; refusing to install\./)
})

test('resolveRunningDshVersion does not consult <home>/package.json', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-version-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }))
  const version = resolveRunningDshVersion({ home: dir })
  assert.notEqual(version, '9.9.9')
})

test('installMarketShared with dshVersion 0.2.0 rejects before invoking the spawn function', async () => {
  let runPluginCalled = false
  const runPluginSpy = async () => {
    runPluginCalled = true
    return { code: 0, output: '' }
  }

  const { installMarketShared } = await import('../usr/share/dsh-desktop/lib/plugin-manager/market-backend.mjs')
  await assert.rejects(
    () => installMarketShared({
      dshHome: '/tmp/ignored',
      dshVersion: '0.2.0',
      runPlugin: runPluginSpy
    }),
    /Unsupported DSH version "0.2.0"/
  )
  assert.equal(runPluginCalled, false)
})

test('installMarketShared with dshVersion 0.1.5-rc.1 proceeds and calls runPlugin', async () => {
  let runPluginCalled = false
  const runPluginSpy = async () => {
    runPluginCalled = true
    return { code: 0, output: '' }
  }

  const { installMarketShared } = await import('../usr/share/dsh-desktop/lib/plugin-manager/market-backend.mjs')
  await installMarketShared({
    dshHome: '/tmp/ignored',
    dshVersion: '0.1.5-rc.1',
    runPlugin: runPluginSpy,
    dshEntryPath: '/dev/null'
  })
  assert.equal(runPluginCalled, true)
})

test('installMarketShared with resolveRunningDshVersion returning null rejects with /Could not resolve/', async () => {
  let runPluginCalled = false
  const runPluginSpy = async () => {
    runPluginCalled = true
    return { code: 0, output: '' }
  }

  const { installMarketShared } = await import('../usr/share/dsh-desktop/lib/plugin-manager/market-backend.mjs')
  await assert.rejects(
    () => installMarketShared({
      dshHome: '/tmp/nonexistent-home-12345',
      resolveDshVersion: () => null,
      runPlugin: runPluginSpy
    }),
    /Could not resolve the running DSH version; refusing to install\./
  )
  assert.equal(runPluginCalled, false)
})

test('runDshPlugin with nodeExecutablePath=/usr/bin/electron sets ELECTRON_RUN_AS_NODE=1', async () => {
  const { runDshPlugin } = await import('../usr/share/dsh-desktop/lib/plugin-manager/market-backend.mjs')
  let capturedEnv
  const fakeSpawn = (execPath, args, opts) => {
    capturedEnv = opts.env
    return {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      once: (event, cb) => {
        if (event === 'close') setTimeout(() => cb(0), 1)
      },
      kill: () => {}
    }
  }

  await runDshPlugin({
    dshEntryPath: '/entry.js',
    nodeExecutablePath: '/usr/bin/electron',
    args: [],
    spawnProcess: fakeSpawn
  })
  assert.equal(capturedEnv.ELECTRON_RUN_AS_NODE, '1')
})

test('runDshPlugin with pre-existing ELECTRON_RUN_AS_NODE="" still sets it to 1', async () => {
  const { runDshPlugin } = await import('../usr/share/dsh-desktop/lib/plugin-manager/market-backend.mjs')
  let capturedEnv
  const fakeSpawn = (execPath, args, opts) => {
    capturedEnv = opts.env
    return {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      once: (event, cb) => {
        if (event === 'close') setTimeout(() => cb(0), 1)
      },
      kill: () => {}
    }
  }

  await runDshPlugin({
    dshEntryPath: '/entry.js',
    nodeExecutablePath: '/usr/bin/electron',
    environment: { ELECTRON_RUN_AS_NODE: '' },
    args: [],
    spawnProcess: fakeSpawn
  })
  assert.equal(capturedEnv.ELECTRON_RUN_AS_NODE, '1')
})



import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

import {
  apply,
  createMarketRequestHandler,
  createMarketService,
  hasForwardedAddress,
  isLoopback,
  isTrustedRequest,
  name as pluginName,
  inject as pluginInject
} from '../usr/share/dsh-desktop/packages/dsh-desktop-market-installer/index.js'
import {
  INSTALL_PATH,
  MARKET_PACKAGE,
  STATUS_PATH,
  UNINSTALL_PATH
} from '../usr/share/dsh-desktop/lib/plugin-manager/market-constants.mjs'
import {
  PRESET_EXPORT_PATH,
  PRESET_IMPORT_PATH
} from '../usr/share/dsh-desktop/lib/plugin-manager/preset-routes.mjs'
import { routePluginSpec } from '../usr/share/dsh-desktop/lib/plugin-manager/market-backend.mjs'
import { SHARED_TREE_ONLY } from '../usr/share/dsh-desktop/lib/plugin-manager/registry.mjs'
import { LOCALES, SUPPORTED_LOCALES, translate } from '../usr/share/dsh-desktop/lib/plugin-manager/locales.mjs'

function fakeRequest({ address = '127.0.0.1', headers = {} } = {}) {
  return { socket: { remoteAddress: address }, headers }
}

function request(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        let json
        try { json = JSON.parse(body) } catch { json = undefined }
        resolve({ status: res.statusCode, body, json, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function controlledService(initial = {}) {
  let state = { dependency: undefined, installedVersion: undefined, ...initial }
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const calls = { installShared: 0, uninstallShared: 0 }
  const service = createMarketService({
    home: '/tmp/ignored',
    readState: async () => state,
    installShared: () => { calls.installShared += 1; return pending },
    uninstallShared: () => { calls.uninstallShared += 1; return pending },
    recommendedVersion: '^1.5.0'
  })
  return {
    service,
    calls,
    setState: (next) => { state = next },
    release: () => release()
  }
}

test('loopback detection covers IPv4, IPv6 and mapped addresses only', () => {
  assert.equal(isLoopback('127.0.0.1'), true)
  assert.equal(isLoopback('::1'), true)
  assert.equal(isLoopback('::ffff:127.0.0.1'), true)
  assert.equal(isLoopback('[::1]'), true)
  assert.equal(isLoopback('10.0.0.5'), false)
  assert.equal(isLoopback(undefined), false)
})

test('forwarded headers disqualify a request', () => {
  assert.equal(hasForwardedAddress({ 'x-forwarded-for': '1.2.3.4' }), true)
  assert.equal(hasForwardedAddress({ forwarded: 'for=1.2.3.4' }), true)
  assert.equal(hasForwardedAddress({}), false)
})

test('read requests trust loopback only', () => {
  assert.equal(isTrustedRequest(fakeRequest(), false), true)
  assert.equal(isTrustedRequest(fakeRequest({ address: '10.0.0.5' }), false), false)
  assert.equal(isTrustedRequest(fakeRequest({ headers: { 'x-real-ip': '10.0.0.5' } }), false), false)
})

test('mutations additionally require a matching same-origin', () => {
  const yes = fakeRequest({ headers: { origin: 'http://127.0.0.1:8123', host: '127.0.0.1:8123' } })
  assert.equal(isTrustedRequest(yes, true), true)

  assert.equal(isTrustedRequest(fakeRequest({ headers: { host: '127.0.0.1:8123' } }), true), false)
  assert.equal(isTrustedRequest(fakeRequest({ headers: { origin: 'http://127.0.0.1:8123', host: '127.0.0.1:8123' } }), true), true)
  assert.equal(isTrustedRequest(fakeRequest({ headers: { origin: 'http://evil.test', host: '127.0.0.1:8123' } }), true), false)
  assert.equal(isTrustedRequest(fakeRequest({ headers: { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:8123' } }), true), false)
  assert.equal(isTrustedRequest(fakeRequest({ headers: { origin: 'https://127.0.0.1:8123', host: '127.0.0.1:8123' } }), true), false)
  assert.equal(isTrustedRequest(yes, false), true)
})

test('the market package is pinned to the shared tree', () => {
  assert.equal(SHARED_TREE_ONLY.has(MARKET_PACKAGE), true)
  assert.equal(routePluginSpec(`${MARKET_PACKAGE}@1.2.3`), 'shared')
  assert.equal(routePluginSpec('@scope/community@1.0.0'), 'generation')
  assert.equal(routePluginSpec('community@1.0.0'), 'generation')
})

test('service installs status transitions and concurrency', async () => {
  const { service, calls, setState, release } = controlledService()

  assert.deepEqual(
    await service.status().then((s) => [s.phase, s.recommendedVersion, s.restartRequired]),
    ['absent', '^1.5.0', false]
  )

  assert.deepEqual(await service.install(), { kind: 'started' })
  assert.equal((await service.status()).phase, 'installing')
  assert.deepEqual(await service.install(), { kind: 'busy' })

  setState({ dependency: '^1.5.0', installedVersion: '1.5.0' })
  release()
  await service.dispose()

  const installed = await service.status()
  assert.equal(installed.phase, 'installed')
  assert.equal(installed.installedVersion, '1.5.0')
  assert.equal(installed.restartRequired, true)
  assert.equal(calls.installShared, 1)
})

test('installing an already-installed market is a no-op', async () => {
  const { service, calls } = controlledService({ dependency: '^1.5.0', installedVersion: '1.5.0' })
  assert.deepEqual(await service.install(), { kind: 'already' })
  assert.equal(calls.installShared, 0)
})

test('uninstalling an absent market records an uninstalled status', async () => {
  const { service } = controlledService()
  assert.deepEqual(await service.uninstall(), { kind: 'already' })
  const status = await service.status()
  assert.equal(status.phase, 'uninstalled')
  assert.equal(status.restartRequired, true)
})

test('Cordis market installer HTTP routes enforce method, trust and concurrency', async (t) => {
  const { service, setState, release } = controlledService()
  const handler = createMarketRequestHandler(service)
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(() => new Promise((resolve) => server.close(resolve)))

  // Status check
  const status = await request(port, 'GET', STATUS_PATH)
  assert.equal(status.status, 200)
  assert.equal(status.json.phase, 'absent')

  // Method guards
  assert.equal((await request(port, 'POST', STATUS_PATH)).status, 405)
  assert.equal((await request(port, 'POST', STATUS_PATH)).json.error, 'Request rejected.')

  // HTTP install route was deleted per Decision B (returns 404)
  assert.equal((await request(port, 'POST', INSTALL_PATH)).status, 404)
  assert.equal((await request(port, 'GET', INSTALL_PATH)).status, 404)

  // Trust checks on uninstall
  const forwarded = await request(port, 'POST', UNINSTALL_PATH, { 'x-forwarded-for': '203.0.113.7' })
  assert.equal(forwarded.status, 403)

  const missingOrigin = await request(port, 'POST', UNINSTALL_PATH, { host: `127.0.0.1:${port}` })
  assert.equal(missingOrigin.status, 403)

  const badOrigin = await request(port, 'POST', UNINSTALL_PATH, {
    origin: 'http://evil.test',
    host: `127.0.0.1:${port}`
  })
  assert.equal(badOrigin.status, 403)

  // Valid uninstall start
  setState({ dependency: '^1.5.0', installedVersion: '1.5.0' })
  const good = await request(port, 'POST', UNINSTALL_PATH, {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`
  })
  assert.equal(good.status, 202)
  assert.equal(good.json.phase, 'uninstalling')

  // Concurrency collision during active uninstall
  const concurrent = await request(port, 'POST', UNINSTALL_PATH, {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`
  })
  assert.equal(concurrent.status, 409)
  assert.equal(concurrent.json.phase, 'uninstalling')

  setState({ dependency: undefined, installedVersion: undefined })
  release()
  await service.dispose()

  // Uninstalled status reflects restartRequired
  const after = await request(port, 'GET', STATUS_PATH)
  assert.equal(after.json.phase, 'uninstalled')
  assert.equal(after.json.restartRequired, true)

  assert.equal((await request(port, 'GET', UNINSTALL_PATH)).status, 405)
  assert.equal((await request(port, 'GET', '/nope')).status, 404)
})

test('Cordis plugin registration attaches routes to webServer', () => {
  assert.equal(pluginName, 'dsh-desktop-market-installer')
  assert.deepEqual(pluginInject, ['webServer'])

  const registeredRoutes = {}
  const mockWebServer = {
    register: ({ kind, path, handler }) => {
      registeredRoutes[path] = { kind, handler }
    }
  }
  const mockCtx = {
    inject: (deps, callback) => {
      callback({
        webServer: mockWebServer,
        effect: (fn) => fn()
      })
    }
  }

  const { service, handler } = apply(mockCtx)
  assert.ok(typeof registeredRoutes[STATUS_PATH]?.handler === 'function')
  assert.ok(typeof registeredRoutes[UNINSTALL_PATH]?.handler === 'function')
  assert.ok(typeof registeredRoutes[PRESET_EXPORT_PATH]?.handler === 'function')
  assert.ok(typeof registeredRoutes[PRESET_IMPORT_PATH]?.handler === 'function')
  assert.equal(registeredRoutes[INSTALL_PATH], undefined)
})

test('Cordis plugin registers exact routes for STATUS and UNINSTALL without registering INSTALL', () => {
  const registered = []
  const mockWebServer = {
    register: (entry) => { registered.push(entry) }
  }
  const mockCtx = {
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['webServer'])
      callback({
        webServer: mockWebServer,
        effect: (fn) => fn()
      })
    }
  }

  apply(mockCtx)

  const statusRegistration = registered.find((r) => r.path === STATUS_PATH)
  const uninstallRegistration = registered.find((r) => r.path === UNINSTALL_PATH)
  const exportRegistration = registered.find((r) => r.path === PRESET_EXPORT_PATH)
  const importRegistration = registered.find((r) => r.path === PRESET_IMPORT_PATH)
  const installRegistration = registered.find((r) => r.path === INSTALL_PATH)

  assert.ok(statusRegistration, 'STATUS route must be registered')
  assert.equal(statusRegistration.kind, 'exact')
  assert.equal(typeof statusRegistration.handler, 'function')

  assert.ok(uninstallRegistration, 'UNINSTALL route must be registered')
  assert.equal(uninstallRegistration.kind, 'exact')
  assert.equal(typeof uninstallRegistration.handler, 'function')

  assert.ok(exportRegistration, 'PRESET_EXPORT route must be registered')
  assert.equal(exportRegistration.kind, 'exact')
  assert.equal(typeof exportRegistration.handler, 'function')

  assert.ok(importRegistration, 'PRESET_IMPORT route must be registered')
  assert.equal(importRegistration.kind, 'exact')
  assert.equal(typeof importRegistration.handler, 'function')

  assert.equal(installRegistration, undefined, 'INSTALL route must not be registered')
})

test('Cordis client module registers settings slots', async () => {
  const clientPath = path.resolve(__dirname, '../usr/share/dsh-desktop/packages/dsh-desktop-market-installer/client.js')
  const clientCode = fs.readFileSync(clientPath, 'utf8')

  assert.match(clientCode, /id:\s*['"]dsh-desktop-market-installer\/client['"]/, 'loader id must be dsh-desktop-market-installer/client')
  const loaderCalls = (clientCode.match(/__ModuleLoader__\.load\(/g) || []).length
  assert.equal(loaderCalls, 1, 'must contain exactly ONE occurrence of __ModuleLoader__.load')
  assert.doesNotMatch(clientCode, /export\s+const\s+name\b/, 'must not export name')
  assert.doesNotMatch(clientCode, /export\s+function\s+apply\b/, 'must not export apply')
})


test('every locale defines every key', () => {
  const reference = Object.keys(LOCALES.en).sort()
  for (const locale of SUPPORTED_LOCALES) {
    assert.deepEqual(Object.keys(LOCALES[locale]).sort(), reference)
    for (const key of reference) {
      assert.equal(typeof LOCALES[locale][key], 'string')
      assert.ok(LOCALES[locale][key].length > 0, `${locale}.${key} must not be empty`)
    }
  }
  assert.equal(translate('en', 'install'), LOCALES.en.install)
  assert.equal(translate('zh-Hans', 'install'), LOCALES.zh.install)
  assert.equal(translate('fr', 'install'), LOCALES.en.install)
})

test('installCommunityPluginAsGeneration rejects before calling installGeneration when DSH version is unsupported', async () => {
  const { installCommunityPluginAsGeneration } = await import('../usr/share/dsh-desktop/lib/plugin-manager/market-backend.mjs')
  let mockedInstallGenerationCalled = false
  const mockInstallGeneration = async () => {
    mockedInstallGenerationCalled = true
    throw new Error('mocked installGeneration should not be called')
  }

  await assert.rejects(
    () => installCommunityPluginAsGeneration('community-pkg@1.0.0', {
      dshHome: '/tmp/ignored',
      profile: 'default',
      dshVersion: '0.2.0',
      installGeneration: mockInstallGeneration
    }),
    (err) => {
      assert.ok(err instanceof Error)
      assert.ok(err.message.includes('0.2.0'), 'Error must mention unsupported version 0.2.0')
      assert.ok(!err.message.includes('mocked installGeneration'), 'Error must not come from mockInstallGeneration')
      return true
    }
  )
  assert.equal(mockedInstallGenerationCalled, false)
})

test('loopback-guard standalone module exports helpers and breaks cycle with preset-routes', async () => {
  const guard = await import('../usr/share/dsh-desktop/lib/plugin-manager/loopback-guard.mjs')
  assert.equal(typeof guard.isLoopback, 'function')
  assert.equal(typeof guard.hasForwardedAddress, 'function')
  assert.equal(typeof guard.isTrustedRequest, 'function')
  assert.equal(typeof guard.sendJson, 'function')
  assert.ok(Array.isArray(guard.FORWARDED_HEADERS))

  const presetRoutesContent = fs.readFileSync(
    path.join(__dirname, '../usr/share/dsh-desktop/lib/plugin-manager/preset-routes.mjs'),
    'utf8'
  )
  assert.ok(!presetRoutesContent.includes('packages/dsh-desktop-market-installer'))
})


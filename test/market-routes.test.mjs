import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import {
  createMarketRequestHandler,
  createMarketService,
  hasForwardedAddress,
  isLoopback,
  isTrustedRequest
} from '../usr/share/dsh-desktop/lib/plugin-manager/market-routes.mjs'
import {
  CLIENT_PATH,
  INSTALL_PATH,
  LOCALES_PATH,
  MARKET_PACKAGE,
  STATUS_PATH,
  UNINSTALL_PATH
} from '../usr/share/dsh-desktop/lib/plugin-manager/market-constants.mjs'
import {
  createMarketServer,
  listenMarketServer
} from '../usr/share/dsh-desktop/lib/plugin-manager/market-server.mjs'
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

test('HTTP routes enforce method, trust and concurrency', async (t) => {
  const { service, setState, release } = controlledService()
  const server = createMarketServer(service)
  const address = await listenMarketServer(server)
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = address.port

  const status = await request(port, 'GET', STATUS_PATH)
  assert.equal(status.status, 200)
  assert.equal(status.json.phase, 'absent')

  assert.equal((await request(port, 'POST', STATUS_PATH)).status, 405)
  assert.equal((await request(port, 'GET', INSTALL_PATH)).status, 405)
  assert.equal((await request(port, 'POST', STATUS_PATH)).json.error, 'Request rejected.')

  const forwarded = await request(port, 'POST', INSTALL_PATH, { 'x-forwarded-for': '203.0.113.7' })
  assert.equal(forwarded.status, 403)

  const missingOrigin = await request(port, 'POST', INSTALL_PATH, { host: `127.0.0.1:${port}` })
  assert.equal(missingOrigin.status, 403)

  const badOrigin = await request(port, 'POST', INSTALL_PATH, {
    origin: 'http://evil.test',
    host: `127.0.0.1:${port}`
  })
  assert.equal(badOrigin.status, 403)

  const good = await request(port, 'POST', INSTALL_PATH, {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`
  })
  assert.equal(good.status, 202)
  assert.equal(good.json.phase, 'installing')

  const concurrent = await request(port, 'POST', INSTALL_PATH, {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`
  })
  assert.equal(concurrent.status, 409)
  assert.equal(concurrent.json.phase, 'installing')

  setState({ dependency: '^1.5.0', installedVersion: '1.5.0' })
  release()
  await service.dispose()

  const after = await request(port, 'GET', STATUS_PATH)
  assert.equal(after.json.phase, 'installed')
  assert.equal(after.json.installedVersion, '1.5.0')
  assert.equal(after.json.restartRequired, true)

  assert.equal((await request(port, 'GET', UNINSTALL_PATH)).status, 405)
  assert.equal((await request(port, 'GET', '/nope')).status, 404)
})

test('serves the localized market surface assets', async (t) => {
  const { service } = controlledService()
  const server = createMarketServer(service)
  const address = await listenMarketServer(server)
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = address.port

  const html = await request(port, 'GET', '/')
  assert.equal(html.status, 200)
  assert.match(html.body, /dsh-market-root/u)

  const script = await request(port, 'GET', CLIENT_PATH)
  assert.equal(script.status, 200)
  assert.match(script.headers['content-type'], /javascript/u)
  assert.match(script.body, /restartHarness/u)
  assert.match(script.body, /850/u)

  const locales = await request(port, 'GET', LOCALES_PATH)
  assert.equal(locales.status, 200)
  assert.deepEqual(Object.keys(locales.json).sort(), [...SUPPORTED_LOCALES].sort())
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

test('a request handler can be invoked directly', async () => {
  const { service } = controlledService()
  const handler = createMarketRequestHandler(service)
  const response = {
    code: undefined,
    body: '',
    writeHead(code) { this.code = code },
    end(body) { this.body = body }
  }
  await handler({ method: 'GET', url: STATUS_PATH, socket: { remoteAddress: '127.0.0.1' }, headers: {} }, response)
  assert.equal(response.code, 200)
  assert.equal(JSON.parse(response.body).phase, 'absent')
})

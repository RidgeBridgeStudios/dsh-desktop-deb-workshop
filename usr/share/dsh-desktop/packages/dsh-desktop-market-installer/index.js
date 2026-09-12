import { join } from 'node:path'
import { dshHome as defaultDshHome, LIVE_PROFILE } from '../../lib/plugin-manager/paths.mjs'
import {
  MARKET_PACKAGE,
  RECOMMENDED_MARKET_VERSION,
  STATUS_PATH,
  UNINSTALL_PATH
} from '../../lib/plugin-manager/market-constants.mjs'
import {
  installMarketShared,
  readMarketState,
  uninstallMarketShared
} from '../../lib/plugin-manager/market-backend.mjs'
import { SHARED_TREE_ONLY } from '../../lib/plugin-manager/registry.mjs'
import {
  assertSupportedDsh,
  resolveRunningDshVersion
} from '../../lib/plugin-manager/dsh-version.mjs'
import {
  createPresetRequestHandler,
  PRESET_EXPORT_PATH,
  PRESET_IMPORT_PATH
} from '../../lib/plugin-manager/preset-routes.mjs'

if (!SHARED_TREE_ONLY.has(MARKET_PACKAGE)) {
  throw new Error(`The market package ${MARKET_PACKAGE} must stay in the shared tree.`)
}

export const name = 'dsh-desktop-market-installer'
export const inject = ['webServer']

const FORWARDED_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-host']

export function isLoopback(address) {
  if (typeof address !== 'string') return false
  const normalized = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1'
}

export function hasForwardedAddress(headers = {}) {
  return FORWARDED_HEADERS.some((header) => headers[header] !== undefined)
}

export function isTrustedRequest(req, mutation = false) {
  const address = req?.socket?.remoteAddress
  if (!isLoopback(address)) return false
  if (hasForwardedAddress(req?.headers)) return false
  if (!mutation) return true
  const origin = req.headers?.origin
  const host = req.headers?.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' && parsed.host === host && isLoopback(parsed.hostname)
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

export function createMarketService(options = {}) {
  const {
    home = defaultDshHome(),
    profile = LIVE_PROFILE,
    recommendedVersion = RECOMMENDED_MARKET_VERSION,
    resolveDshVersion = () => resolveRunningDshVersion({ home, dshVersion: options.dshVersion }),
    readState = () => readMarketState(home, profile),
    installShared = (context) => installMarketShared({
      dshHome: home,
      profile,
      recommendedVersion,
      ...context
    }),
    uninstallShared = (context) => uninstallMarketShared({
      dshHome: home,
      profile,
      ...context
    }),
    log = () => undefined
  } = options

  let operation = null
  let error
  let removed = false
  let restartRequired = false
  const logLines = []

  async function status() {
    const base = { recommendedVersion, restartRequired }
    const withLog = (value) => ({ ...base, ...value, log: logLines.join('\n') })
    if (operation !== null) {
      return withLog({
        phase: operation.kind === 'install' ? 'installing' : 'uninstalling',
        detail: operation.detail
      })
    }
    if (error !== undefined) return withLog({ phase: 'error', detail: error })
    let state
    try {
      state = await readState()
    } catch (failure) {
      return withLog({ phase: 'error', detail: failure instanceof Error ? failure.message : String(failure) })
    }
    if (state.installedVersion !== undefined) {
      return withLog({ phase: 'installed', installedVersion: state.installedVersion })
    }
    if (removed) return withLog({ phase: 'uninstalled' })
    if (state.dependency !== undefined) return withLog({ phase: 'incomplete' })
    return withLog({ phase: 'absent' })
  }

  function begin(kind, run) {
    const record = { kind, detail: undefined }
    operation = record
    record.promise = Promise.resolve()
      .then(() => run({
        reportDetail: (message) => {
          record.detail = message
          logLines.push(message)
          log(message)
        }
      }))
      .then(() => {
        if (kind === 'uninstall') removed = true
        restartRequired = true
      })
      .catch((failure) => {
        error = failure instanceof Error ? failure.message : String(failure)
      })
      .finally(() => {
        if (operation === record) operation = null
      })
    return record.promise
  }

  async function install() {
    if (operation !== null) return { kind: 'busy' }
    const currentVersion = resolveDshVersion()
    if (currentVersion !== null && currentVersion !== undefined) {
      try {
        assertSupportedDsh(currentVersion)
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure)
        return { kind: 'error', detail: error }
      }
    }
    let state
    try {
      state = await readState()
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
      return { kind: 'error' }
    }
    if (operation !== null) return { kind: 'busy' }
    if (state.installedVersion !== undefined) return { kind: 'already' }
    error = undefined
    removed = false
    begin('install', installShared)
    return { kind: 'started' }
  }

  async function uninstall() {
    if (operation !== null) return { kind: 'busy' }
    let state
    try {
      state = await readState()
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
      return { kind: 'error' }
    }
    if (operation !== null) return { kind: 'busy' }
    if (state.dependency === undefined && state.installedVersion === undefined) {
      removed = true
      restartRequired = true
      return { kind: 'already' }
    }
    error = undefined
    removed = false
    begin('uninstall', uninstallShared)
    return { kind: 'started' }
  }

  async function dispose() {
    await operation?.promise?.catch(() => undefined)
  }

  return { status, install, uninstall, dispose }
}

export function createMarketRequestHandler(service) {
  return async function handleMarketRequest(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      return sendJson(res, 404, { error: 'Not found.' })
    }

    if (url.pathname === STATUS_PATH) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Request rejected.' })
      if (!isTrustedRequest(req, false)) return sendJson(res, 403, { error: 'Request rejected.' })
      return sendJson(res, 200, await service.status())
    }

    if (url.pathname === UNINSTALL_PATH) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' })
      if (!isTrustedRequest(req, true)) return sendJson(res, 403, { error: 'Request rejected.' })
      const outcome = await service.uninstall()
      if (outcome.kind === 'busy') return sendJson(res, 409, await service.status())
      if (outcome.kind === 'already') return sendJson(res, 200, await service.status())
      if (outcome.kind === 'error') return sendJson(res, 500, await service.status())
      return sendJson(res, 202, await service.status())
    }

    return sendJson(res, 404, { error: 'Not found.' })
  }
}

export function apply(ctx, options = {}) {
  const service = options.service ?? createMarketService(options)
  const handler = createMarketRequestHandler(service)

  const home = options.home ?? options.dshHome ?? defaultDshHome()
  const roots = options.roots ?? options.presetRoots ?? [{ path: join(home, '.dsh/agent-presets'), trust: 'user' }]
  const presetHandler = options.presetHandler ?? createPresetRequestHandler({
    dshHome: home,
    roots,
    ...options
  })

  const registerRoutes = (webServer) => {
    webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Request rejected.' })
        if (!isTrustedRequest(req, false)) return sendJson(res, 403, { error: 'Request rejected.' })
        return sendJson(res, 200, await service.status())
      }
    })
    webServer.register({
      kind: 'exact',
      path: UNINSTALL_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' })
        if (!isTrustedRequest(req, true)) return sendJson(res, 403, { error: 'Request rejected.' })
        const outcome = await service.uninstall()
        if (outcome.kind === 'busy') return sendJson(res, 409, await service.status())
        if (outcome.kind === 'already') return sendJson(res, 200, await service.status())
        if (outcome.kind === 'error') return sendJson(res, 500, await service.status())
        return sendJson(res, 202, await service.status())
      }
    })
    webServer.register({
      kind: 'exact',
      path: PRESET_EXPORT_PATH,
      handler: presetHandler
    })
    webServer.register({
      kind: 'exact',
      path: PRESET_IMPORT_PATH,
      handler: presetHandler
    })
  }

  if (ctx) {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => {
        const effectFn = typeof webCtx.effect === 'function' ? webCtx.effect.bind(webCtx) : (fn) => fn()
        effectFn(() => {
          if (webCtx.webServer && typeof webCtx.webServer.register === 'function') {
            registerRoutes(webCtx.webServer)
          }
        }, 'dsh-desktop-market-installer: webServer routes')
      })
    } else if (ctx.webServer && typeof ctx.webServer.register === 'function') {
      registerRoutes(ctx.webServer)
    } else if (ctx.webServer && typeof ctx.webServer.use === 'function') {
      ctx.webServer.use(handler)
      ctx.webServer.use(presetHandler)
    }
  }

  return { service, handler, presetHandler }
}

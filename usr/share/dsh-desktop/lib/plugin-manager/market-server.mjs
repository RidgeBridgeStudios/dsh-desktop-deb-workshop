import { createServer } from 'node:http'

import {
  CLIENT_PATH,
  LOCALES_PATH,
  STATUS_PATH,
  INSTALL_PATH,
  UNINSTALL_PATH
} from './market-constants.mjs'
import { CLIENT_HTML, CLIENT_SCRIPT } from './market-client.mjs'
import { createMarketRequestHandler, sendJson } from './market-routes.mjs'
import { createPresetRequestHandler, PRESET_EXPORT_PATH, PRESET_IMPORT_PATH } from './preset-routes.mjs'
import { LOCALES } from './locales.mjs'

export const MARKET_ROUTE_PATHS = [STATUS_PATH, INSTALL_PATH, UNINSTALL_PATH]
export const PRESET_ROUTE_PATHS = [PRESET_EXPORT_PATH, PRESET_IMPORT_PATH]

function sendText(res, status, contentType, body) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

export function createMarketServer(service, options = {}) {
  const handleRoute = createMarketRequestHandler(service)
  const handlePreset = options.presetHandler ?? (options.presetOptions ? createPresetRequestHandler(options.presetOptions) : null)
  const html = options.html ?? CLIENT_HTML
  const script = options.script ?? CLIENT_SCRIPT
  return createServer(async (req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      return sendJson(res, 404, { error: 'Not found.' })
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return sendText(res, 200, 'text/html; charset=utf-8', html)
    }
    if (req.method === 'GET' && url.pathname === CLIENT_PATH) {
      return sendText(res, 200, 'text/javascript; charset=utf-8', script)
    }
    if (req.method === 'GET' && url.pathname === LOCALES_PATH) {
      return sendJson(res, 200, LOCALES)
    }
    if (handlePreset && (url.pathname === PRESET_EXPORT_PATH || url.pathname === PRESET_IMPORT_PATH)) {
      return handlePreset(req, res)
    }
    return handleRoute(req, res)
  })
}

export function listenMarketServer(server, options = {}) {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve(server.address())
    })
  })
}

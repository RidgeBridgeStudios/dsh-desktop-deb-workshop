export const FORWARDED_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-host']

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

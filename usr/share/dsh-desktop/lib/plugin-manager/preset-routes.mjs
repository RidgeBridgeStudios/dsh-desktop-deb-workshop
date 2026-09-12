import { existsSync } from 'node:fs'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  createPresetArchive,
  inspectPresetArchive,
  isOsMetadataPath,
  MAX_COMPRESSED_BYTES,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_UNCOMPRESSED_BYTES,
  PRESET_ID_PATTERN
} from './preset-archive.mjs'
import { dshHome as defaultDshHome, LIVE_PROFILE, profileDirectory } from './paths.mjs'
import { sendJson } from './market-routes.mjs'

export const PRESET_EXPORT_PATH = '/api/agent-preset.export'
export const PRESET_IMPORT_PATH = '/api/agent-preset.import'

export class AbortError extends Error {
  constructor(message = 'Request aborted by client') {
    super(message)
    this.name = 'AbortError'
    this.code = 'ABORT_ERR'
  }
}

export function defaultHarnessBase(home = defaultDshHome(), profile = LIVE_PROFILE) {
  return pathToFileURL(profileDirectory(home, profile) + '/').href
}

export async function collectPresetFiles(presetDir, signal) {
  const files = {}
  let totalFiles = 0
  let totalBytes = 0

  async function walk(currentDir, relativePrefix = '') {
    if (signal?.aborted) throw new AbortError()
    const entries = await readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (signal?.aborted) throw new AbortError()
      const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name
      if (isOsMetadataPath(relPath)) continue

      const fullPath = join(currentDir, entry.name)
      const entryStat = await lstat(fullPath)

      if (entryStat.isSymbolicLink()) {
        throw new Error(`Symlinks are not allowed in preset directory: ${relPath}`)
      }
      if (entryStat.isDirectory()) {
        await walk(fullPath, relPath)
      } else if (entryStat.isFile()) {
        totalFiles += 1
        if (totalFiles > MAX_FILES) {
          throw new Error(`Preset exceeds maximum allowed files limit (${MAX_FILES})`)
        }
        if (entryStat.size > MAX_FILE_BYTES) {
          throw new Error(`File exceeds maximum size of ${MAX_FILE_BYTES} bytes: ${relPath}`)
        }
        totalBytes += entryStat.size
        if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
          throw new Error(`Preset exceeds maximum uncompressed size of ${MAX_UNCOMPRESSED_BYTES} bytes`)
        }
        files[relPath] = await readFile(fullPath)
      } else {
        throw new Error(`Non-file entry rejected in preset directory: ${relPath}`)
      }
    }
  }

  await walk(presetDir)
  return files
}

export async function handlePresetExport(req, res, options = {}) {
  const {
    roots,
    harnessBase = defaultHarnessBase(),
    signal = req.signal,
    sourceDshVersion = '0.1.5-rc.1',
    scanRootFn
  } = options

  if (signal?.aborted) {
    return sendJson(res, 499, { error: 'Client closed request.' })
  }

  let url
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1')
  } catch {
    return sendJson(res, 400, { error: 'Invalid URL.' })
  }

  const presetId = url.searchParams.get('agentPreset')
  if (!presetId || typeof presetId !== 'string' || presetId.trim() === '') {
    return sendJson(res, 400, { error: 'Missing required agentPreset parameter.' })
  }

  let scanFn = scanRootFn
  if (!scanFn) {
    try {
      const presetsPkg = await import('@deepseek-ai/dsh-agent-presets')
      scanFn = presetsPkg.scanRoot
    } catch {
      return sendJson(res, 500, { error: 'Preset subsystem is not available.' })
    }
  }

  let targetPreset
  for (const root of roots) {
    try {
      const found = await scanFn(root, harnessBase)
      const match = found.find((p) => p.id === presetId)
      if (match) {
        targetPreset = match
        break
      }
    } catch (err) {
      if (signal?.aborted) return sendJson(res, 499, { error: 'Client closed request.' })
      return sendJson(res, 500, { error: `Failed scanning preset root: ${err.message}` })
    }
  }

  if (!targetPreset) {
    return sendJson(res, 404, { error: `Preset not found: ${presetId}` })
  }

  if (targetPreset.trust !== 'user') {
    return sendJson(res, 403, { error: 'duplicate the preset first, then export the copy.' })
  }

  if (targetPreset.broken !== undefined) {
    return sendJson(res, 400, { error: `Cannot export broken preset: ${targetPreset.broken}` })
  }

  const presetDir = dirname(targetPreset.path)

  let files
  try {
    files = await collectPresetFiles(presetDir, signal)
  } catch (err) {
    if (err instanceof AbortError || signal?.aborted) {
      return sendJson(res, 499, { error: 'Client closed request.' })
    }
    return sendJson(res, 400, { error: err.message })
  }

  const manifest = {
    format: 'dsh-preset',
    version: 1,
    id: targetPreset.id,
    name: targetPreset.name,
    description: targetPreset.description,
    icon: targetPreset.icon,
    sourceDshVersion,
    exportedAt: new Date().toISOString()
  }

  let archiveBuffer
  try {
    archiveBuffer = createPresetArchive({ manifest, files })
  } catch (err) {
    if (signal?.aborted) return sendJson(res, 499, { error: 'Client closed request.' })
    return sendJson(res, 400, { error: err.message })
  }

  if (signal?.aborted) {
    return sendJson(res, 499, { error: 'Client closed request.' })
  }

  res.writeHead(200, {
    'content-type': 'application/vnd.dsh.preset+zip',
    'content-disposition': `attachment; filename="${targetPreset.id}.dshpreset"`,
    'content-length': archiveBuffer.byteLength,
    'cache-control': 'no-store'
  })
  res.end(Buffer.from(archiveBuffer))
}

export function readBodyBuffer(req, signal, maxBytes = MAX_COMPRESSED_BYTES) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError())
    const chunks = []
    let totalBytes = 0

    function onAbort() {
      cleanup()
      reject(new AbortError())
    }

    function onData(chunk) {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        cleanup()
        reject(new Error(`Payload exceeds maximum size of ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    }

    function onEnd() {
      cleanup()
      resolve(Buffer.concat(chunks))
    }

    function onError(err) {
      cleanup()
      reject(err)
    }

    function cleanup() {
      signal?.removeEventListener('abort', onAbort)
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
    }

    signal?.addEventListener('abort', onAbort)
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

export function findUserWritableRoot(roots) {
  const root = roots.find((candidate) => candidate.trust === 'user')
  if (!root) throw new Error('No user-writable preset root is configured')
  return root.path
}

export async function handlePresetImportPreview(req, res, options = {}) {
  const {
    roots,
    harnessBase = defaultHarnessBase(),
    signal = req.signal,
    scanRootFn,
    bodyBuffer: injectedBuffer
  } = options

  if (signal?.aborted) {
    return sendJson(res, 499, { error: 'Client closed request.' })
  }

  let bodyBuffer = injectedBuffer
  if (!bodyBuffer) {
    try {
      bodyBuffer = await readBodyBuffer(req, signal, MAX_COMPRESSED_BYTES)
    } catch (err) {
      if (err instanceof AbortError || signal?.aborted) {
        return sendJson(res, 499, { error: 'Client closed request.' })
      }
      return sendJson(res, 400, { error: err.message })
    }
  }

  let parsed
  try {
    parsed = inspectPresetArchive(bodyBuffer)
  } catch (err) {
    return sendJson(res, 400, { error: err.message })
  }

  let url
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1')
  } catch {
    return sendJson(res, 400, { error: 'Invalid URL.' })
  }

  const queryTargetId = url.searchParams.get('agentPreset')
  const targetId = queryTargetId && queryTargetId.trim() !== '' ? queryTargetId.trim() : parsed.manifest.id

  if (!PRESET_ID_PATTERN.test(targetId)) {
    return sendJson(res, 400, { error: `Invalid preset target id: ${targetId}` })
  }

  let scanFn = scanRootFn
  if (!scanFn) {
    try {
      const presetsPkg = await import('@deepseek-ai/dsh-agent-presets')
      scanFn = presetsPkg.scanRoot
    } catch {
      return sendJson(res, 500, { error: 'Preset subsystem is not available.' })
    }
  }

  let conflict = false
  for (const root of roots) {
    try {
      const found = await scanFn(root, harnessBase)
      if (found.some((p) => p.id === targetId)) {
        conflict = true
        break
      }
    } catch {
      // Continue checking
    }
  }

  if (!conflict) {
    try {
      const userPath = findUserWritableRoot(roots)
      if (existsSync(join(userPath, targetId))) {
        conflict = true
      }
    } catch {}
  }

  const { manifest } = parsed
  const responseData = {
    ok: true,
    agentPreset: targetId,
    sourceAgentPreset: manifest.id,
    name: manifest.name,
    description: manifest.description,
    ...(manifest.sourceDshVersion ? { sourceDshVersion: manifest.sourceDshVersion } : {}),
    fileCount: parsed.fileCount,
    totalSize: parsed.totalSize,
    conflict,
    warnings: parsed.warnings,
    installed: false,
    manifest: {
      id: targetId,
      originalId: manifest.id,
      name: manifest.name,
      description: manifest.description,
      icon: manifest.icon,
      ...(manifest.sourceDshVersion ? { sourceDshVersion: manifest.sourceDshVersion } : {}),
      ...(manifest.exportedAt ? { exportedAt: manifest.exportedAt } : {})
    }
  }

  return sendJson(res, 200, responseData)
}

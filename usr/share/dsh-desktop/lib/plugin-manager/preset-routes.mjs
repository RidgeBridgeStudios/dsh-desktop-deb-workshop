import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  createPresetArchive,
  isOsMetadataPath,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_UNCOMPRESSED_BYTES
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

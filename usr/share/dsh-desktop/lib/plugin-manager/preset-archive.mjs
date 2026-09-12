import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

export const MAX_FILES = 512
export const MAX_FILE_BYTES = 12 * 1024 * 1024
export const MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
export const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024

export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u
const OS_METADATA_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

export const WARNING_SECRETS_PATTERN =
  /(?:sk-[a-zA-Z0-9_-]{20,}|(?:api[_-]?key|apikey)[\s:=]+['"]?[a-zA-Z0-9._-]{8,}|ghp_[a-zA-Z0-9]{30,}|bearer\s+[a-zA-Z0-9._-]{20,})/iu

export const WARNING_ABSOLUTE_PATHS_PATTERN =
  /(?:\/(?:Users|home|root|var|etc)\/|[A-Za-z]:\\(?:Users|Documents|Program))/u

export function isOsMetadataPath(relativePath) {
  if (typeof relativePath !== 'string') return true
  const segments = relativePath.split('/')
  const leaf = segments[segments.length - 1]
  if (OS_METADATA_NAMES.has(leaf)) return true
  if (leaf.startsWith('._')) return true
  if (segments.includes('__MACOSX')) return true
  return false
}

export function isSafePresetArchivePath(entryPath) {
  if (typeof entryPath !== 'string' || entryPath.trim() === '') return false
  if (entryPath.includes('\\')) return false
  if (entryPath.startsWith('/')) return false
  if (/^[a-zA-Z]:/u.test(entryPath)) return false
  const segments = entryPath.split('/')
  for (const segment of segments) {
    if (segment === '..' || segment === '.') return false
  }
  return true
}

export function scanArchiveWarnings(entries) {
  const warnings = []
  for (const [path, data] of Object.entries(entries)) {
    if (!path.startsWith('preset/')) continue
    const text = strFromU8(data)
    if (WARNING_SECRETS_PATTERN.test(text)) {
      warnings.push(`possible-secrets in ${path}`)
    }
    if (WARNING_ABSOLUTE_PATHS_PATTERN.test(text)) {
      warnings.push(`absolute-paths in ${path}`)
    }
  }
  return warnings
}

export function createPresetArchive(options = {}) {
  const { manifest, files = {} } = options
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('manifest is required')
  }

  const entries = {}
  const manifestBytes = strToU8(JSON.stringify(manifest, undefined, 2))
  entries['manifest.json'] = manifestBytes

  let totalUncompressed = manifestBytes.byteLength
  let fileCount = 0

  for (const [relativePath, content] of Object.entries(files)) {
    if (isOsMetadataPath(relativePath)) continue
    if (!isSafePresetArchivePath(relativePath)) {
      throw new Error(`Invalid preset file path: ${relativePath}`)
    }
    fileCount += 1
    if (fileCount > MAX_FILES) {
      throw new Error(`File count exceeds maximum allowed (${MAX_FILES})`)
    }
    const bytes = typeof content === 'string' ? strToU8(content) : content
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error(`File exceeds maximum size of ${MAX_FILE_BYTES} bytes: ${relativePath}`)
    }
    totalUncompressed += bytes.byteLength
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`Total uncompressed size exceeds ${MAX_UNCOMPRESSED_BYTES} bytes`)
    }
    const archivePath = relativePath.startsWith('preset/') ? relativePath : `preset/${relativePath}`
    entries[archivePath] = bytes
  }

  const compressed = zipSync(entries)
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error(`Compressed archive exceeds ${MAX_COMPRESSED_BYTES} bytes`)
  }
  return compressed
}

export function inspectPresetArchive(archiveBuffer) {
  const bytes = archiveBuffer instanceof Uint8Array ? archiveBuffer : new Uint8Array(archiveBuffer)
  if (bytes.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error(`Compressed archive exceeds ${MAX_COMPRESSED_BYTES} bytes`)
  }

  let unzipped
  try {
    unzipped = unzipSync(bytes)
  } catch (error) {
    throw new Error(`Failed to extract zip archive: ${error instanceof Error ? error.message : String(error)}`)
  }

  const paths = Object.keys(unzipped)
  if (paths.length > MAX_FILES) {
    throw new Error(`Archive contains ${paths.length} files, exceeding limit of ${MAX_FILES}`)
  }

  let manifestBytes
  const presetEntries = {}
  let totalUncompressed = 0
  let fileCount = 0

  for (const path of paths) {
    if (path === '' || path.endsWith('/')) continue
    if (isOsMetadataPath(path)) continue
    if (!isSafePresetArchivePath(path)) {
      throw new Error(`Path traversal or invalid path rejected: ${path}`)
    }

    const data = unzipped[path]
    if (data.byteLength > MAX_FILE_BYTES) {
      throw new Error(`Entry exceeds maximum file size limit: ${path}`)
    }
    totalUncompressed += data.byteLength
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`Total uncompressed size exceeds limit: ${totalUncompressed} bytes`)
    }

    if (path === 'manifest.json') {
      manifestBytes = data
    } else if (path.startsWith('preset/')) {
      const relPath = path.slice('preset/'.length)
      if (relPath.trim() !== '') {
        presetEntries[path] = data
        fileCount += 1
      }
    } else {
      throw new Error(`Unexpected root entry in archive: ${path}`)
    }
  }

  if (manifestBytes === undefined) {
    throw new Error('Archive missing required manifest.json')
  }

  let manifest
  try {
    manifest = JSON.parse(strFromU8(manifestBytes))
  } catch {
    throw new Error('manifest.json is not valid JSON')
  }

  if (manifest?.format !== 'dsh-preset') {
    throw new Error(`Invalid archive format: ${manifest?.format}`)
  }
  if (typeof manifest?.version !== 'number' || manifest.version > 1) {
    throw new Error(`Unsupported archive version: ${manifest?.version}`)
  }
  if (typeof manifest?.id !== 'string' || !PRESET_ID_PATTERN.test(manifest.id)) {
    throw new Error(`Invalid preset id in manifest: ${manifest?.id}`)
  }
  if (!Object.hasOwn(presetEntries, 'preset/agent.cordis.yml')) {
    throw new Error('Archive missing required preset/agent.cordis.yml')
  }

  const warnings = scanArchiveWarnings(presetEntries)

  return {
    manifest,
    entries: presetEntries,
    fileCount,
    totalSize: totalUncompressed,
    warnings
  }
}

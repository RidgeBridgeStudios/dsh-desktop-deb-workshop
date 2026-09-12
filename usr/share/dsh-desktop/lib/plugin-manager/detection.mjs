import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { LIVE_PROFILE, profileDirectory } from './paths.mjs'

export const CORE_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'])
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu
const PLUGIN_SOURCE_FILES = [
  'cordis.patch.yml',
  'index.js',
  'lib/index.js',
  'dist/index.js',
  'client.js',
  'lib/client.js',
  'dist/client.js'
]

export function isThirdPartyPackageName(packageName) {
  return typeof packageName === 'string' &&
    PACKAGE_NAME_PATTERN.test(packageName) &&
    !packageName.startsWith('@deepseek-ai/') &&
    !CORE_BUNDLES.has(packageName)
}

export function configuredProfilePlugins(manifest) {
  const dependencies = Object.keys(manifest?.dependencies ?? {})
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  return dependencies.filter((name) => bundles.includes(name) && isThirdPartyPackageName(name))
}

export function ownsPackage(candidate, packageName) {
  if (Object.hasOwn(candidate.dependencies ?? {}, packageName)) return true
  if (Object.hasOwn(candidate.optionalDependencies ?? {}, packageName)) return true
  return (candidate.bundlePatch ?? '').includes(packageName)
}

export function declaresLoaderEntry(candidate, entryId) {
  if (typeof entryId !== 'string' || entryId === '') return false
  const escaped = entryId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`^\\s*-\\s+id:\\s*["']?${escaped}["']?\\s*(?:#.*)?$`, 'mu')
  return pattern.test(candidate.bundlePatch ?? '')
}

export function referencesText(candidate, text) {
  if (typeof text !== 'string' || text === '') return false
  if ((candidate.bundlePatch ?? '').includes(text)) return true
  return Object.values(candidate.sources ?? {}).some((content) => content.includes(text))
}

function uniqueOwner(candidates, predicate) {
  const matches = candidates.filter(predicate)
  if (matches.length > 1) return { ambiguous: true, owner: undefined }
  return { ambiguous: false, owner: matches[0] }
}

export function resolveAttribution(candidates, detected, options = {}) {
  const { duplicateLoaderEntryId, slotConflictName, slotProviders = [] } = options
  const configured = new Set(candidates.map((candidate) => candidate.name))

  const direct = [...new Set(detected.filter((name) => configured.has(name)))].sort()
  if (direct.length > 0) return direct

  const owners = new Set()
  for (const leaf of detected) {
    if (configured.has(leaf)) continue
    const result = uniqueOwner(candidates, (candidate) => ownsPackage(candidate, leaf))
    if (result.ambiguous) return []
    if (result.owner !== undefined) owners.add(result.owner.name)
  }
  if (owners.size > 0) return [...owners].sort()

  if (duplicateLoaderEntryId !== undefined) {
    const result = uniqueOwner(candidates, (candidate) => declaresLoaderEntry(candidate, duplicateLoaderEntryId))
    if (result.ambiguous) return []
    if (result.owner !== undefined) return [result.owner.name]
  }

  if (slotConflictName !== undefined) {
    const result = uniqueOwner(candidates, (candidate) => referencesText(candidate, slotConflictName))
    if (result.ambiguous) return []
    if (result.owner !== undefined) return [result.owner.name]
  }

  for (const provider of slotProviders) {
    const result = uniqueOwner(candidates, (candidate) => referencesText(candidate, provider))
    if (result.ambiguous) return []
    if (result.owner !== undefined) return [result.owner.name]
  }

  return []
}

export function resolveStartupFailureOwners(candidates, failures, excludedPlugins = []) {
  const configured = new Set(candidates.map((candidate) => candidate.name))
  const owners = new Set()
  for (const failure of failures) {
    const name = failure?.owner?.packageName
    if (typeof name !== 'string') continue
    if (!configured.has(name)) continue
    if (excludedPlugins.includes(name)) continue
    owners.add(name)
  }
  return [...owners].sort()
}

/**
 * Prefer the versioned structured report; fall back to log correlation only
 * when no report is present. Never offer every installed plugin.
 */
export function detectPluginRecovery(options = {}) {
  const {
    candidates = [],
    startupFailures = [],
    logs = [],
    excludedPlugins = []
  } = options

  if (startupFailures.length > 0) {
    const provenance = startupFailures.some(
      (failure) => failure?.owner !== undefined || (Array.isArray(failure?.chain) && failure.chain.length > 0)
    )
    return {
      source: 'structured',
      provenance,
      plugins: resolveStartupFailureOwners(candidates, startupFailures, excludedPlugins),
      logs
    }
  }

  const text = logs.join('\n')
  const found = new Set()
  for (const candidate of candidates) {
    if (excludedPlugins.includes(candidate.name)) continue
    if (text.includes(candidate.name)) found.add(candidate.name)
  }
  return { source: 'logs', provenance: false, plugins: [...found].sort(), logs }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export async function loadRecoveryCandidates(dshHome, profile = LIVE_PROFILE) {
  const dir = profileDirectory(dshHome, profile)
  const manifest = (await readJson(join(dir, 'package.json'))) ?? {}
  const roots = configuredProfilePlugins(manifest)
  const candidates = []
  for (const name of roots) {
    const rootDir = join(dir, 'node_modules', name)
    const packageManifest = (await readJson(join(rootDir, 'package.json'))) ?? {}
    const patchRelative = packageManifest.dsh?.bundle?.patch
    const bundlePatch = typeof patchRelative === 'string'
      ? ((await readText(join(rootDir, patchRelative))) ?? '')
      : ''
    const sources = {}
    for (const relative of PLUGIN_SOURCE_FILES) {
      const content = await readText(join(rootDir, relative))
      if (content !== undefined) sources[relative] = content
    }
    candidates.push({
      name,
      directory: rootDir,
      version: typeof packageManifest.version === 'string' ? packageManifest.version : undefined,
      dependencies: packageManifest.dependencies ?? {},
      optionalDependencies: packageManifest.optionalDependencies ?? {},
      bundlePatch,
      sources
    })
  }
  return candidates
}

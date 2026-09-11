import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { LIVE_PROFILE, profileDirectory } from './paths.mjs'
import { resolveEnabledGenerations } from './registry.mjs'

const IN_BOX_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
const GENERATION_LINK_MARKER = join('profiles', '.generations', 'live')
const PROJECTION_VERSION = 1

const defaultFileSystem = { lstat, symlink, rename, readlink, unlink, rm, mkdir, realpath }

function isInsideDirectory(parent, candidate) {
  const nested = relative(parent, candidate)
  return nested === '' || (!nested.startsWith('..') && !isAbsolute(nested))
}

async function validateEnabledGenerationTarget(pluginName, generation) {
  const generationDirectory = resolve(generation.directory)
  const target = resolve(generation.directory, 'node_modules', pluginName)
  if (!isInsideDirectory(generationDirectory, target)) {
    throw new Error(`Enabled generation package path escapes its generation: ${pluginName}`)
  }

  let targetInfo
  try {
    targetInfo = await lstat(target)
  } catch (error) {
    throw new Error(
      `Enabled generation package root is missing or unreadable for ${pluginName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }
  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
    throw new Error(`Enabled generation package root is not a real directory for ${pluginName}`)
  }
  const canonicalTarget = await realpath(target)
  const canonicalGeneration = await realpath(generationDirectory)
  if (!isInsideDirectory(canonicalGeneration, canonicalTarget)) {
    throw new Error(`Enabled generation package root resolves outside its generation: ${pluginName}`)
  }

  const manifestPath = join(target, 'package.json')
  let manifestInfo
  try {
    manifestInfo = await lstat(manifestPath)
  } catch (error) {
    throw new Error(
      `Enabled generation package manifest is missing or unreadable for ${pluginName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
    throw new Error(`Enabled generation package manifest is not a real file for ${pluginName}`)
  }
  const canonicalManifest = await realpath(manifestPath)
  if (!isInsideDirectory(canonicalTarget, canonicalManifest)) {
    throw new Error(`Enabled generation package manifest resolves outside its package: ${pluginName}`)
  }
  return target
}

async function declaresBundle(packageDir) {
  const path = join(packageDir, 'package.json')
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw new Error(
      `Profile dependency manifest could not be read at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }
  try {
    const manifest = JSON.parse(text)
    return typeof manifest.dsh?.bundle?.patch === 'string'
  } catch (error) {
    throw new Error(
      `Profile dependency manifest is invalid JSON at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertProfileManifest(manifest, path) {
  if (!isRecord(manifest)) throw new Error(`Profile manifest root is invalid at ${path}.`)
  if (
    manifest.dependencies !== undefined &&
    (
      !isRecord(manifest.dependencies) ||
      !Object.values(manifest.dependencies).every((spec) => typeof spec === 'string')
    )
  ) {
    throw new Error(`Profile manifest dependencies are invalid at ${path}.`)
  }
  if (manifest.dsh !== undefined && !isRecord(manifest.dsh)) {
    throw new Error(`Profile manifest dsh configuration is invalid at ${path}.`)
  }
  if (manifest.dsh?.profile !== undefined && !isRecord(manifest.dsh.profile)) {
    throw new Error(`Profile manifest dsh.profile configuration is invalid at ${path}.`)
  }
  if (
    manifest.dsh?.profile?.bundles !== undefined &&
    (
      !Array.isArray(manifest.dsh.profile.bundles) ||
      !manifest.dsh.profile.bundles.every((name) => typeof name === 'string')
    )
  ) {
    throw new Error(`Profile manifest bundle list is invalid at ${path}.`)
  }
  return manifest
}

async function readProfileManifest(dir) {
  const path = join(dir, 'package.json')
  let current
  try {
    current = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        current: undefined,
        manifest: { name: `dsh-profile-${LIVE_PROFILE}`, private: true }
      }
    }
    throw new Error(
      `Profile manifest could not be read at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }

  let parsed
  try {
    parsed = JSON.parse(current)
  } catch (error) {
    throw new Error(
      `Profile manifest is invalid JSON at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }
  return { current, manifest: assertProfileManifest(parsed, path) }
}

async function ensureDirLink(linkPath, target) {
  try {
    const info = await lstat(linkPath)
    if (info.isSymbolicLink()) {
      const resolved = await readlink(linkPath).catch(() => '')
      if (resolved === target) return
    }
    await rm(linkPath, { recursive: true, force: true })
  } catch {
    // linkPath does not exist yet
  }
  await mkdir(dirname(linkPath), { recursive: true })
  await symlink(target, linkPath, 'dir')
}

export async function projectGenerations(dshHome, profile = LIVE_PROFILE) {
  const { dir, manifestState, enabled, targets, linkSpecs } =
    await prepareGenerationProjection(dshHome, profile)
  const modulesDir = join(dir, 'node_modules')
  await mkdir(modulesDir, { recursive: true })

  const linked = []
  const projected = new Map()
  for (const [pluginName, generation] of enabled) {
    const target = targets.get(pluginName)
    if (target === undefined) throw new Error(`Enabled generation target was not prevalidated: ${pluginName}`)
    await ensureDirLink(join(modulesDir, pluginName), target)
    linked.push(pluginName)
    projected.set(pluginName, generation)
  }

  const unlinked = await pruneStaleGenerationLinks(modulesDir, projected)
  const bundles = await syncProfileManifest(dir, projected, linkSpecs, manifestState)

  return { linked, unlinked, bundles }
}

export async function publishInstalledGeneration(
  dshHome,
  pluginName,
  profile = LIVE_PROFILE,
  options = {}
) {
  const { allowRealDirectory = false, syncBundles = false } = options
  const fs = { ...defaultFileSystem, ...(options.fileSystem ?? {}) }
  const { dir, manifestState, enabled, targets, linkSpecs } =
    await prepareGenerationProjection(dshHome, profile)
  const target = targets.get(pluginName)
  if (target === undefined) throw new Error(`No enabled generation for ${pluginName}`)
  const link = join(dir, 'node_modules', pluginName)
  const suffix = randomUUID()
  const nextLink = `${link}.dsh-next-${suffix}`
  const oldLink = `${link}.dsh-previous-${suffix}`
  let previousIsDirectory = false
  let movedOld = false
  let installedNew = false
  await fs.mkdir(dirname(link), { recursive: true })
  try {
    try {
      const info = await fs.lstat(link)
      previousIsDirectory = !info.isSymbolicLink()
      if (previousIsDirectory && (!allowRealDirectory || !info.isDirectory())) {
        throw new Error(`Cannot switch a non-link plugin directory: ${link}`)
      }
      if (await fs.realpath(link) === await fs.realpath(target)) {
        const bundles = await syncProfileManifest(dir, enabled, linkSpecs, manifestState, { syncBundles })
        return { plugins: [pluginName], bundles }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await fs.symlink(target, nextLink, 'dir')
    try {
      await fs.rename(link, oldLink)
      movedOld = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await fs.rename(nextLink, link)
    installedNew = true
    if (await fs.realpath(link) !== await fs.realpath(target)) {
      throw new Error(`Plugin link switch did not select ${pluginName}`)
    }
    const bundles = await syncProfileManifest(dir, enabled, linkSpecs, manifestState, { syncBundles })
    await fs.rm(oldLink, { force: true, recursive: previousIsDirectory }).catch(() => {})
    return { plugins: [pluginName], bundles }
  } catch (error) {
    try {
      if (installedNew) await fs.rm(link, { force: true })
      if (movedOld) await fs.rename(oldLink, link)
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `Plugin switch failed; previous link retained at ${oldLink}`)
    }
    throw error
  } finally {
    await fs.rm(nextLink, { force: true }).catch(() => undefined)
  }
}

export async function publishGenerationManifest(dshHome, profile = LIVE_PROFILE, { syncBundles = false } = {}) {
  const { dir, manifestState, enabled, linkSpecs } =
    await prepareGenerationProjection(dshHome, profile)
  const bundles = await syncProfileManifest(dir, enabled, linkSpecs, manifestState, { syncBundles })
  return { plugins: [...enabled.keys()], bundles }
}

export async function exposeMissingGenerationLinks(dshHome, profile = LIVE_PROFILE) {
  const { dir, manifestState, enabled, targets } = await prepareGenerationProjection(dshHome, profile)
  const modulesDir = join(dir, 'node_modules')
  const linked = []
  for (const [pluginName] of enabled) {
    const linkPath = join(modulesDir, pluginName)
    const target = targets.get(pluginName)
    if (target === undefined) throw new Error(`Enabled generation target was not prevalidated: ${pluginName}`)
    try {
      const info = await lstat(linkPath)
      if (!info.isSymbolicLink()) continue
      const current = await readlink(linkPath).catch(() => '')
      const currentTarget = current === '' ? '' : resolve(dirname(linkPath), current)
      if (currentTarget === target) continue
      const activeBundles = manifestState.manifest.dsh?.profile?.bundles ?? []
      if (activeBundles.includes(pluginName) || !currentTarget.includes(GENERATION_LINK_MARKER)) {
        continue
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await ensureDirLink(linkPath, target)
    linked.push(pluginName)
  }
  return linked
}

async function prepareGenerationProjection(dshHome, profile) {
  const dir = profileDirectory(dshHome, profile)
  const manifestState = await readProfileManifest(dir)
  const enabled = await resolveEnabledGenerations(dshHome)
  const targets = new Map()
  for (const [pluginName, generation] of enabled) {
    targets.set(pluginName, await validateEnabledGenerationTarget(pluginName, generation))
  }
  const linkSpecs = new Map()
  for (const [pluginName, generation] of enabled) {
    const target = targets.get(pluginName)
    if (target === undefined) throw new Error(`Enabled generation target was not prevalidated: ${pluginName}`)
    linkSpecs.set(pluginName, `link:${relative(dir, target).split('\\').join('/')}`)
  }
  return { dir, manifestState, enabled, targets, linkSpecs }
}

async function pruneStaleGenerationLinks(modulesDir, enabled) {
  const removed = []

  const scan = async (base, prefix) => {
    let entries
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(base, entry.name)
      if (entry.name.startsWith('@') && !prefix) {
        await scan(full, entry.name)
        continue
      }
      if (!entry.isSymbolicLink()) continue
      const target = await readlink(full).catch(() => '')
      if (!target.includes(GENERATION_LINK_MARKER)) continue
      if (!enabled.has(name)) {
        await rm(full, { recursive: true, force: true }).catch(() => undefined)
        removed.push(name)
      }
    }
  }

  await scan(modulesDir, '')
  return removed
}

async function syncProfileManifest(
  dir,
  enabled,
  linkSpecs,
  manifestState,
  { syncBundles = true } = {}
) {
  const manifestPath = join(dir, 'package.json')
  const { current, manifest } = manifestState

  const previousProjection = manifest.dsh?.desktop?.generationProjection
  const previousPlugins = previousProjection?.version === PROJECTION_VERSION &&
      typeof previousProjection.plugins === 'object' && previousProjection.plugins !== null
    ? previousProjection.plugins
    : {}

  const currentDeps = manifest.dependencies ?? {}
  const dependencies = { ...currentDeps }
  for (const name of Object.keys(previousPlugins)) {
    delete dependencies[name]
  }
  // Migrate the pre-version-projection shape even when it predates the marker.
  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec === 'string' && spec.includes('.generations/live/')) delete dependencies[name]
  }

  const currentOverrides = manifest.pnpm?.overrides ?? {}
  const overrides = { ...currentOverrides }
  for (const [name, state] of Object.entries(previousPlugins)) {
    if (state?.previousOverride?.present && typeof state.previousOverride.value === 'string') {
      overrides[name] = state.previousOverride.value
    } else {
      delete overrides[name]
    }
  }
  // Clean up an old managed override even if the marker was lost.
  for (const [name, spec] of Object.entries(overrides)) {
    if (typeof spec === 'string' && spec.includes('.generations/live/')) delete overrides[name]
  }

  const projectedPlugins = {}
  for (const [name, generation] of enabled) {
    const previous = previousPlugins[name]
    const currentOverride = currentOverrides[name]
    const previousOverride = previous?.previousOverride ?? (
      typeof currentOverride === 'string' && !currentOverride.includes('.generations/live/')
        ? { present: true, value: currentOverride }
        : { present: false }
    )
    dependencies[name] = generation.version
    overrides[name] = linkSpecs.get(name)
    projectedPlugins[name] = {
      generationId: generation.id,
      visibleVersion: generation.version,
      previousOverride
    }
  }

  let bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  if (syncBundles) {
    const declaredBundles = bundles.filter((name) => IN_BOX_BUNDLES.has(name))
    for (const name of Object.keys(dependencies)) {
      if (declaredBundles.includes(name) || enabled.has(name)) continue
      if (await declaresBundle(join(dir, 'node_modules', name))) declaredBundles.push(name)
    }
    const pluginNames = [...enabled.keys()].sort()
    bundles = [...declaredBundles, ...pluginNames]
  }

  const desktop = {
    ...(manifest.dsh?.desktop ?? {})
  }
  if (Object.keys(projectedPlugins).length > 0) {
    desktop.generationProjection = {
      version: PROJECTION_VERSION,
      plugins: projectedPlugins
    }
  } else {
    delete desktop.generationProjection
  }
  const pnpm = {
    ...(manifest.pnpm ?? {})
  }
  if (Object.keys(overrides).length > 0) pnpm.overrides = overrides
  else delete pnpm.overrides
  const dsh = {
    ...manifest.dsh,
    profile: {
      ...(manifest.dsh?.profile ?? {}),
      bundles
    }
  }
  if (Object.keys(desktop).length > 0) dsh.desktop = desktop
  else delete dsh.desktop
  const next = {
    ...manifest,
    dependencies,
    dsh
  }
  if (Object.keys(pnpm).length > 0) next.pnpm = pnpm
  else delete next.pnpm

  const body = `${JSON.stringify(next, undefined, 2)}\n`
  if (current !== body) {
    const temporary = `${manifestPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, body, 'utf8')
    await rename(temporary, manifestPath)
  }

  return bundles
}

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { dshHome as defaultDshHome, profileDirectory, profilesRoot } from './paths.mjs'
import { ensureProfile } from './bootstrap.mjs'
import { withRegistryLock } from './registry.mjs'

export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/u
export const RESERVED_PROFILE_NAMES = Object.freeze([
  'desktop-safe-mode',
  'safe-mode',
  'node_modules',
  '.generations'
])
export const PROFILE_COLORS = Object.freeze([
  '#38bdf8',
  '#f472b6',
  '#fb923c',
  '#34d399',
  '#a78bfa',
  '#f87171'
])

const migratedHomes = new Set()

function synthesizedDefault() {
  const epoch = new Date().toISOString()
  return {
    version: 1,
    active: 'default',
    profiles: {
      default: {
        displayName: 'Default',
        color: '#38bdf8',
        createdAt: epoch,
        lastUsedAt: epoch
      }
    }
  }
}

function registryFilePath(home) {
  return join(profilesRoot(home), '.desktop.json')
}

export async function writeProfileRegistry(home, registry) {
  const filePath = registryFilePath(home)
  await mkdir(profilesRoot(home), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const body = `${JSON.stringify(registry, undefined, 2)}\n`
  try {
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, filePath)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

export async function readProfileRegistry(home = defaultDshHome()) {
  const filePath = registryFilePath(home)
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return synthesizedDefault()
    }
    throw error
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    process.stderr.write(`dsh-desktop: registry at ${filePath} is corrupt JSON\n`)
    return synthesizedDefault()
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return synthesizedDefault()
  }

  if (typeof parsed.profiles !== 'object' || parsed.profiles === null || Array.isArray(parsed.profiles)) {
    parsed.profiles = {}
  }

  if (!parsed.profiles.default) {
    parsed.profiles.default = synthesizedDefault().profiles.default
  }

  for (const [name, prof] of Object.entries(parsed.profiles)) {
    if (!prof || typeof prof !== 'object') {
      parsed.profiles[name] = {
        displayName: name,
        color: '#38bdf8',
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString()
      }
    } else {
      if (!prof.color || !/^#[0-9a-f]{6}$/iu.test(prof.color)) {
        prof.color = '#38bdf8'
      }
      if (typeof prof.displayName !== 'string' || !prof.displayName.trim()) {
        prof.displayName = name
      }
    }
  }

  if (typeof parsed.active !== 'string' || !parsed.active) {
    parsed.active = 'default'
    await writeProfileRegistry(home, parsed)
    return parsed
  }

  if (!Object.hasOwn(parsed.profiles, parsed.active)) {
    const dir = profileDirectory(home, parsed.active)
    if (existsSync(dir)) {
      parsed.profiles[parsed.active] = {
        displayName: parsed.active.charAt(0).toUpperCase() + parsed.active.slice(1),
        color: '#38bdf8',
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString()
      }
      await writeProfileRegistry(home, parsed)
      return parsed
    }

    parsed.active = 'default'
    await writeProfileRegistry(home, parsed)
    return parsed
  }

  return parsed
}

export async function activeProfileName(home = defaultDshHome()) {
  const registry = await readProfileRegistry(home)
  return registry.active
}

export async function listProfiles(home = defaultDshHome()) {
  const registry = await readProfileRegistry(home)
  const backupsDir = join(home, 'backups')
  let backupFiles = []
  try {
    backupFiles = await readdir(backupsDir)
  } catch {}

  const results = []
  for (const [name, profile] of Object.entries(registry.profiles)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const regex = new RegExp(`^.*-${escaped}\\.tar\\.(zst|gz)$`)
    const snapshotCount = backupFiles.filter((f) => regex.test(f)).length

    results.push({
      name,
      displayName: profile.displayName ?? name,
      color: profile.color ?? '#38bdf8',
      createdAt: profile.createdAt,
      lastUsedAt: profile.lastUsedAt,
      isActive: name === registry.active,
      active: name === registry.active,
      snapshotCount
    })
  }

  return results
}

export async function createProfile(home = defaultDshHome(), { name, displayName, color }) {
  if (RESERVED_PROFILE_NAMES.includes(name)) {
    throw new Error(`Profile name is reserved: ${name}`)
  }
  if (typeof name !== 'string' || !PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid profile name: ${name}`)
  }

  const registry = await readProfileRegistry(home)
  if (Object.hasOwn(registry.profiles, name) || name === 'default') {
    throw new Error(`Profile already exists: ${name}`)
  }
  const dir = profileDirectory(home, name)
  if (existsSync(dir)) {
    throw new Error(`Profile directory already exists on disk: ${dir}`)
  }

  const validatedColor = (typeof color === 'string' && /^#[0-9a-f]{6}$/iu.test(color))
    ? color.toLowerCase()
    : '#38bdf8'

  const disp = (typeof displayName === 'string' && displayName.trim() !== '')
    ? displayName.trim()
    : name

  const ensureResult = await ensureProfile(home, name)
  if (!ensureResult.ok) {
    throw new Error(`Failed to create profile directory: ${ensureResult.detail}`)
  }

  const now = new Date().toISOString()
  const entry = {
    displayName: disp,
    color: validatedColor,
    createdAt: now,
    lastUsedAt: now
  }

  registry.profiles[name] = entry
  await writeProfileRegistry(home, registry)

  return { name, ...entry }
}

export async function renameProfile(home = defaultDshHome(), nameOrPayload, maybeOptions) {
  let name
  let options
  if (typeof nameOrPayload === 'object' && nameOrPayload !== null) {
    name = nameOrPayload.name
    options = nameOrPayload
  } else {
    name = nameOrPayload
    options = maybeOptions ?? {}
  }

  if (typeof name !== 'string' || !PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid profile name: ${name}`)
  }

  const registry = await readProfileRegistry(home)
  if (!Object.hasOwn(registry.profiles, name)) {
    throw new Error(`Profile not found: ${name}`)
  }

  const prof = registry.profiles[name]
  const { displayName, color } = options

  if (displayName !== undefined) {
    if (typeof displayName !== 'string' || !displayName.trim()) {
      throw new Error('displayName must be a non-empty string')
    }
    prof.displayName = displayName.trim()
  }

  if (color !== undefined) {
    prof.color = (typeof color === 'string' && /^#[0-9a-f]{6}$/iu.test(color))
      ? color.toLowerCase()
      : '#38bdf8'
  }

  await writeProfileRegistry(home, registry)
  return { name, ...prof }
}

export async function deleteProfile(home = defaultDshHome(), name, { createSnapshot = true, snapshotFn } = {}) {
  if (RESERVED_PROFILE_NAMES.includes(name)) {
    throw new Error(`Cannot delete reserved profile: ${name}`)
  }
  if (typeof name !== 'string' || !PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid profile name: ${name}`)
  }

  const registry = await readProfileRegistry(home)
  if (name === registry.active) {
    throw new Error('Cannot delete the active profile')
  }
  if (name === 'default') {
    throw new Error('Cannot delete default profile')
  }
  if (!Object.hasOwn(registry.profiles, name)) {
    throw new Error(`Profile not found: ${name}`)
  }

  if (createSnapshot) {
    if (typeof snapshotFn === 'function') {
      await snapshotFn({ dshHome: home, reason: 'pre-profile-delete', profile: name })
    } else {
      const { createSnapshot: runSnapshot } = await import('./snapshot.mjs')
      await runSnapshot({ dshHome: home, reason: 'pre-profile-delete', profile: name })
    }
  }

  const dir = profileDirectory(home, name)
  await rm(dir, { recursive: true, force: true })
  await rm(join(home, 'profiles', '.generations', 'desired', `${name}.json`), { force: true })
  await rm(join(home, 'recovery', 'plugin-removals', `${name}.json`), { force: true })

  delete registry.profiles[name]
  await writeProfileRegistry(home, registry)

  return true
}

export async function setActiveProfile(home = defaultDshHome(), name) {
  if (typeof name !== 'string' || !PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid profile name: ${name}`)
  }

  const registry = await readProfileRegistry(home)
  if (!Object.hasOwn(registry.profiles, name)) {
    throw new Error(`Profile not found: ${name}`)
  }

  registry.active = name
  registry.profiles[name].lastUsedAt = new Date().toISOString()
  await writeProfileRegistry(home, registry)

  return { ok: true, active: name }
}

export async function ensureActiveProfileDirectory(home = defaultDshHome()) {
  const active = await activeProfileName(home)
  return ensureProfile(home, active)
}

export async function migrateLegacyLayout(home = defaultDshHome()) {
  if (migratedHomes.has(home)) return true
  await withRegistryLock(home, async () => {
    if (migratedHomes.has(home)) return

    // 0. Root package.json / node_modules migration if present and default profile not populated
    const rootPkg = join(home, 'package.json')
    const defaultDir = profileDirectory(home, 'default')
    const defaultPkg = join(defaultDir, 'package.json')
    if (existsSync(rootPkg) && !existsSync(defaultPkg)) {
      await mkdir(defaultDir, { recursive: true, mode: 0o755 })
      await rename(rootPkg, defaultPkg)
      const rootModules = join(home, 'node_modules')
      const defaultModules = join(defaultDir, 'node_modules')
      if (existsSync(rootModules) && !existsSync(defaultModules)) {
        await rename(rootModules, defaultModules)
      }
    }

    // 1. Desired pointer migration
    const desiredLegacy = join(home, 'profiles', '.generations', 'desired.json')
    const desiredDir = join(home, 'profiles', '.generations', 'desired')
    const desiredDefault = join(desiredDir, 'default.json')

    if (existsSync(desiredLegacy)) {
      if (existsSync(desiredDefault)) {
        process.stderr.write('legacy desired.json and desired/default.json both present; leaving legacy file untouched for manual resolution.\n')
      } else {
        await mkdir(desiredDir, { recursive: true, mode: 0o755 })
        await rename(desiredLegacy, desiredDefault)
      }
    }

    // 2. Removal ledger migration
    const ledgerLegacy = join(home, 'recovery', 'plugin-removals.json')
    const ledgerDir = join(home, 'recovery', 'plugin-removals')
    const ledgerDefault = join(ledgerDir, 'default.json')

    let legacyStat
    try {
      legacyStat = await stat(ledgerLegacy)
    } catch {}

    if (legacyStat && legacyStat.isFile()) {
      if (existsSync(ledgerDefault)) {
        process.stderr.write('legacy plugin-removals.json and plugin-removals/default.json both present; leaving legacy file untouched for manual resolution.\n')
      } else {
        await mkdir(ledgerDir, { recursive: true, mode: 0o755 })
        await rename(ledgerLegacy, ledgerDefault)
      }
    }

    migratedHomes.add(home)
  })
  return true
}

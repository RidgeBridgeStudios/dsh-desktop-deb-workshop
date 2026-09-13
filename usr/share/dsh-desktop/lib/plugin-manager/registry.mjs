import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PROFILE_NAME_PATTERN } from './paths.mjs'

function assertValidProfile(profile) {
  if (typeof profile !== 'string' || !PROFILE_NAME_PATTERN.test(profile)) {
    throw new TypeError('profile is required')
  }
}

export function registryLayout(dshHome, profile) {
  assertValidProfile(profile)
  const root = join(dshHome, 'profiles', '.generations')
  return {
    root,
    generations: join(root, 'live'),
    staging: join(root, 'staging'),
    trash: join(root, 'trash'),
    desiredDir: join(root, 'desired'),
    desiredPointer: join(root, 'desired', `${profile}.json`),
    lockFile: join(root, '.lock')
  }
}

const SAFE_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu
const SAFE_VERSION_PATTERN = /^[0-9a-z][0-9a-z._+-]*$/iu

export const SHARED_TREE_ONLY = new Set(['dshmarket'])

export function assertSafePackageName(pluginName, context = 'Generation plugin name') {
  if (typeof pluginName !== 'string' || !SAFE_PACKAGE_NAME_PATTERN.test(pluginName)) {
    throw new Error(`${context} is not a safe npm package name: ${String(pluginName)}`)
  }
}

export function assertSafeVersion(version, context = 'Generation version') {
  if (
    typeof version !== 'string' ||
    !SAFE_VERSION_PATTERN.test(version) ||
    version === '.' ||
    version === '..'
  ) {
    throw new Error(`${context} is not safe for a generation id: ${String(version)}`)
  }
}

export async function ensureRegistryDirectories(dshHome) {
  const root = join(dshHome, 'profiles', '.generations')
  const layout = {
    root,
    generations: join(root, 'live'),
    staging: join(root, 'staging'),
    trash: join(root, 'trash'),
    desiredDir: join(root, 'desired'),
    desiredPointer: join(root, 'desired.json'),
    lockFile: join(root, '.lock')
  }
  for (const dir of [layout.generations, layout.staging, layout.trash, layout.desiredDir]) {
    await mkdir(dir, { recursive: true })
  }
  return layout
}

export function generationId(pluginName, version, lockfileText) {
  assertSafePackageName(pluginName)
  assertSafeVersion(version)
  const safeName = pluginName.replace(/^@/u, '').replace(/[/\\]/gu, '+')
  const digest = createHash('sha256').update(lockfileText).digest('hex').slice(0, 12)
  return `${safeName}+${version}+${digest}`
}

async function lockAgeMs(path) {
  try {
    const stats = await stat(path)
    return Date.now() - stats.mtimeMs
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function readPointer(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new Error(
      `Generation pointer could not be read at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `Generation pointer is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error('Generation pointer must be an array of generation ids.')
  }
  return parsed
}

async function writePointerAtomically(path, ids) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  const body = `${JSON.stringify([...ids].sort(), undefined, 2)}\n`
  try {
    await writeFile(temporary, body, 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function withRegistryLock(dshHome, run, options = {}) {
  const { staleAfterMs = 20 * 60 * 1000, retryMs = 500, timeoutMs = 15 * 60 * 1000 } = options
  const root = join(dshHome, 'profiles', '.generations')
  const lockFile = join(root, '.lock')
  await mkdir(root, { recursive: true })

  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      const handle = await open(lockFile, 'wx')
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`)
      await handle.close()
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const age = await lockAgeMs(lockFile)
      if (age !== undefined && age > staleAfterMs) {
        await rm(lockFile, { force: true }).catch(() => undefined)
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for another process holding the registry lock at ${lockFile}.`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs))
    }
  }

  try {
    return await run()
  } finally {
    await rm(lockFile, { force: true }).catch(() => undefined)
  }
}


const META_NAME = 'generation.json'

async function readGenerationMeta(directory) {
  const path = join(directory, META_NAME)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(
      `Generation metadata could not be read at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `Generation metadata is invalid JSON at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Generation metadata root is invalid at ${path}.`)
  }
  assertSafePackageName(parsed.pluginName, `Generation metadata plugin name at ${path}`)
  assertSafeVersion(parsed.version, `Generation metadata version at ${path}`)
  if (parsed.sourceSpec !== undefined && typeof parsed.sourceSpec !== 'string') {
    throw new Error(`Generation metadata source spec is invalid at ${path}.`)
  }
  return {
    pluginName: parsed.pluginName,
    version: parsed.version,
    ...(typeof parsed.sourceSpec === 'string' ? { sourceSpec: parsed.sourceSpec } : {})
  }
}

export async function writeGenerationMeta(directory, meta) {
  await writeFile(join(directory, META_NAME), `${JSON.stringify(meta, undefined, 2)}\n`, 'utf8')
}

async function listGenerationDirectoryIds(dshHome) {
  const generations = join(dshHome, 'profiles', '.generations', 'live')
  let entries
  try {
    entries = await readdir(generations, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new Error(
      `Generation registry could not be read at ${generations}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

export async function listGenerations(dshHome) {
  const generations = join(dshHome, 'profiles', '.generations', 'live')
  const ids = await listGenerationDirectoryIds(dshHome)
  const found = []
  for (const id of ids) {
    const directory = join(generations, id)
    let meta
    try {
      meta = await readGenerationMeta(directory)
    } catch (error) {
      if (error?.cause?.code === 'ENOENT') continue
      throw error
    }
    found.push({ id, directory, ...meta })
  }
  return found
}

export async function readDesired(dshHome, profile) {
  assertValidProfile(profile)
  const layout = registryLayout(dshHome, profile)
  return readPointer(layout.desiredPointer)
}

export async function writeDesired(dshHome, profile, generationIds) {
  assertValidProfile(profile)
  const layout = registryLayout(dshHome, profile)
  await mkdir(layout.desiredDir, { recursive: true })
  await writePointerAtomically(layout.desiredPointer, generationIds)
}

export async function disableGeneration(dshHome, profile, pluginName) {
  assertValidProfile(profile)
  const [desired, generations] = await Promise.all([readDesired(dshHome, profile), listGenerations(dshHome)])
  const byId = new Map(generations.map((generation) => [generation.id, generation]))
  const next = desired.filter((id) => byId.get(id)?.pluginName !== pluginName)
  if (next.length === desired.length) return false
  await writeDesired(dshHome, profile, next)
  return true
}

export async function isGenerationPlugin(dshHome, pluginName) {
  const generations = await listGenerations(dshHome)
  return generations.some((generation) => generation.pluginName === pluginName)
}

export async function resolveEnabledGenerations(dshHome, profile) {
  assertValidProfile(profile)
  const [desired, all] = await Promise.all([readDesired(dshHome, profile), listGenerations(dshHome)])
  const byId = new Map(all.map((generation) => [generation.id, generation]))
  const enabled = new Map()
  for (const id of desired) {
    const generation = byId.get(id)
    if (generation !== undefined && SHARED_TREE_ONLY.has(generation.pluginName)) continue
    if (generation === undefined || !existsSync(generation.directory)) {
      throw new Error(`Desired generation is missing or unreadable: ${id}`)
    }
    enabled.set(generation.pluginName, generation)
  }
  return enabled
}

export async function collectUnreferencedGenerations(dshHome, profile) {
  assertValidProfile(profile)
  const layout = registryLayout(dshHome, profile)
  const [desired, directoryIds] = await Promise.all([
    readDesired(dshHome, profile),
    listGenerationDirectoryIds(dshHome)
  ])
  const known = new Set(directoryIds)
  for (const id of desired) {
    if (!known.has(id)) throw new Error(`Desired generation is missing or unreadable: ${id}`)
    try {
      await readGenerationMeta(join(layout.generations, id))
    } catch (error) {
      if (error?.cause?.code !== 'ENOENT') throw error
      throw new Error(`Desired generation is missing or unreadable: ${id}`, { cause: error })
    }
  }
  const referenced = new Set(desired)
  return directoryIds.filter((id) => !referenced.has(id))
}

export async function sweepRegistry(dshHome) {
  return withRegistryLock(dshHome, async () => {
    const root = join(dshHome, 'profiles', '.generations')
    const desiredDir = join(root, 'desired')
    const staging = join(root, 'staging')
    const trash = join(root, 'trash')
    const generations = join(root, 'live')
    const removed = []
    const failed = []

    let desiredFiles = []
    try {
      desiredFiles = await readdir(desiredDir)
    } catch {}

    const allReferenced = new Set()
    for (const file of desiredFiles) {
      if (!file.endsWith('.json')) continue
      try {
        const ids = await readPointer(join(desiredDir, file))
        for (const id of ids) {
          allReferenced.add(id)
        }
      } catch {}
    }
    const legacyDesired = join(root, 'desired.json')
    if (existsSync(legacyDesired)) {
      try {
        const ids = await readPointer(legacyDesired)
        for (const id of ids) {
          allReferenced.add(id)
        }
      } catch {}
    }

    const directoryIds = await listGenerationDirectoryIds(dshHome)
    const unreferenced = directoryIds.filter((id) => !allReferenced.has(id))

    for (const dir of [staging, trash]) {
      const label = dir === staging ? 'staging' : 'trash'
      let entries = []
      try {
        entries = await readdir(dir)
      } catch {
        continue
      }
      for (const name of entries) {
        try {
          await rm(join(dir, name), { recursive: true, force: true })
          removed.push(`${label}/${name}`)
        } catch {
          failed.push(`${label}/${name}`)
        }
      }
    }

    await mkdir(trash, { recursive: true })
    for (const id of unreferenced) {
      const directory = join(generations, id)
      const trashed = join(trash, `${id}.${randomUUID()}`)
      try {
        await rename(directory, trashed)
        await rm(trashed, { recursive: true, force: true })
        removed.push(id)
      } catch {
        failed.push(id)
      }
    }

    return { removed, failed }
  })
}

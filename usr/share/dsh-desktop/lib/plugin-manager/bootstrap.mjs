import { mkdir, access, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { dshHome as defaultDshHome, profilesRoot, profileDirectory, PROFILE_NAME_PATTERN } from './paths.mjs'
import { installMarketShared, readMarketState } from './market-backend.mjs'
import { MARKET_PACKAGE, RECOMMENDED_MARKET_VERSION } from './market-constants.mjs'

const WORKSPACE_BODY = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

export async function ensureDataDirs(options = {}) {
  const dshRoot = options.dshRoot ?? defaultDshHome()
  const userHome = options.userHome ?? homedir()
  try {
    await mkdir(profilesRoot(dshRoot), { recursive: true })
    await mkdir(join(profilesRoot(dshRoot), '.generations', 'desired'), { recursive: true })
    await mkdir(join(userHome, '.local', 'share', 'dsh-desktop'), { recursive: true })
    await mkdir(join(dshRoot, '.agent-presets'), { recursive: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: error.message }
  }
}

export async function ensureProfile(home, name = 'default') {
  let dshRoot
  let profileName
  if (typeof home === 'object' && home !== null) {
    dshRoot = home.dshRoot ?? defaultDshHome()
    profileName = home.profile ?? name
  } else {
    dshRoot = home ?? defaultDshHome()
    profileName = name
  }

  if (typeof profileName !== 'string' || !PROFILE_NAME_PATTERN.test(profileName)) {
    return { ok: false, detail: `Invalid profile name: ${profileName}` }
  }
  if (profileName === 'desktop-safe-mode') {
    return { ok: false, detail: `Cannot ensure reserved profile: ${profileName}` }
  }

  const manifestBody = `${JSON.stringify({
    name: `dsh-profile-${profileName}`,
    version: '1.0.0',
    private: true,
    type: 'module',
    dependencies: {},
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        patchReload: 'live'
      }
    }
  }, undefined, 2)}\n`

  const profileDir = profileDirectory(dshRoot, profileName)
  const manifestPath = join(profileDir, 'package.json')
  try {
    try {
      await access(manifestPath)
      return { ok: true }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await mkdir(profileDir, { recursive: true })
    const tmp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`
    try {
      await writeFile(tmp, manifestBody, { mode: 0o644 })
      await rename(tmp, manifestPath)
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined)
    }
    const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
    try {
      await access(workspacePath)
    } catch {
      await writeFile(workspacePath, WORKSPACE_BODY, { mode: 0o644 }).catch(() => undefined)
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: error.message }
  }
}

export async function ensureDefaultProfile(home) {
  return ensureProfile(home, 'default')
}

export async function ensureMarketSeeded(options = {}) {
  const dshRoot = options.dshRoot ?? defaultDshHome()
  const profile = options.profile
  if (typeof profile !== 'string' || !PROFILE_NAME_PATTERN.test(profile)) {
    return { ok: false, detail: 'profile is required' }
  }
  const readState = options.readMarketState ?? readMarketState
  const installMarket = options.installMarketShared ?? installMarketShared
  try {
    const state = await readState(dshRoot, profile)
    if (state?.installedVersion !== undefined || state?.dependency !== undefined) {
      return { ok: true, alreadySeeded: true }
    }
    const profileDir = profileDirectory(dshRoot, profile)
    const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
    try {
      const existing = await readFile(workspacePath, 'utf8')
      if (!existing.includes('- .')) {
        await writeFile(workspacePath, WORKSPACE_BODY, { mode: 0o644 })
      }
    } catch {
      await writeFile(workspacePath, WORKSPACE_BODY, { mode: 0o644 }).catch(() => undefined)
    }
    await installMarket({
      ...options,
      dshHome: options.dshHome ?? dshRoot,
      profile,
      recommendedVersion: options.recommendedVersion ?? RECOMMENDED_MARKET_VERSION
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: error?.message ?? String(error) }
  }
}

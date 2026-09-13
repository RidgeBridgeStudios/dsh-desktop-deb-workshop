import { mkdir, access, writeFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { dshHome as defaultDshHome, profilesRoot, profileDirectory } from './paths.mjs'

const MANIFEST_BODY = `${JSON.stringify({
  name: 'dsh-profile-default',
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

export async function ensureDataDirs(options = {}) {
  const dshRoot = options.dshRoot ?? defaultDshHome()
  const userHome = options.userHome ?? homedir()
  try {
    await mkdir(profilesRoot(dshRoot), { recursive: true })
    await mkdir(join(userHome, '.local', 'share', 'dsh-desktop'), { recursive: true })
    await mkdir(join(dshRoot, '.agent-presets'), { recursive: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: error.message }
  }
}

export async function ensureDefaultProfile(options = {}) {
  const dshRoot = options.dshRoot ?? defaultDshHome()
  const profileDir = profileDirectory(dshRoot, 'default')
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
      await writeFile(tmp, MANIFEST_BODY, { mode: 0o644 })
      await rename(tmp, manifestPath)
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined)
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: error.message }
  }
}

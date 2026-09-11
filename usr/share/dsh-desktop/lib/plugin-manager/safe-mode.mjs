import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { formatMessage, translate } from './locales.mjs'
import { profilesRoot } from './paths.mjs'

export const SAFE_MODE_PROFILE = 'desktop-safe-mode'
export const SAFE_MODE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

const SAFE_MODE_MANIFEST = {
  name: `dsh-profile-${SAFE_MODE_PROFILE}`,
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: [...SAFE_MODE_BUNDLES] } }
}
const SAFE_MODE_PATCH = '# dsh-desktop safe mode — third-party plugins are not composed here.\n[]\n'
const SAFE_MODE_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

async function writeIfChanged(path, body) {
  let current
  try {
    current = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (current === body) return false
  await writeFile(path, body, 'utf8')
  return true
}

/**
 * Safe Mode shares DSH_HOME (sessions, settings, credentials, workspaces) but
 * is a separate profile that never reads the normal profile's bundle list or
 * user patch layer. Re-running repairs any tampering.
 */
export async function ensureSafeModeProfile(dshHome) {
  const dir = join(profilesRoot(dshHome), SAFE_MODE_PROFILE)
  await mkdir(dir, { recursive: true })
  await writeIfChanged(join(dir, 'package.json'), `${JSON.stringify(SAFE_MODE_MANIFEST, undefined, 2)}\n`)
  await writeIfChanged(join(dir, 'cordis.patch.yml'), SAFE_MODE_PATCH)
  await writeIfChanged(join(dir, 'pnpm-workspace.yaml'), SAFE_MODE_WORKSPACE)
  return dir
}

export function shouldStartInSafeMode(argv = process.argv) {
  return Array.isArray(argv) && argv.includes('--safe-mode')
}

export function buildSafeModeViewModel(options = {}) {
  const {
    locale = 'en',
    plugins = [],
    blockingCount = 0,
    recoveryLocked = false,
    removable = true
  } = options
  const items = plugins.map((plugin) => {
    const name = typeof plugin === 'string' ? plugin : plugin.name
    return {
      name,
      label: name,
      selected: false,
      removable: removable && !name.startsWith('@deepseek-ai/') && name !== 'dshmarket'
    }
  })
  return {
    badge: translate(locale, 'safeMode'),
    summary: translate(locale, 'safeModeSummary'),
    safetyNote: translate(locale, 'safeModeSafetyNote'),
    noPlugins: items.length === 0 ? translate(locale, 'safeModeNoPlugins') : undefined,
    selectAllLabel: translate(locale, 'safeModeSelectAll'),
    removeLabel: translate(locale, 'safeModeRemoveSelected'),
    removeBusyLabel: translate(locale, 'safeModeRemoving'),
    exitLabel: translate(locale, 'safeModeExit'),
    quitLabel: translate(locale, 'safeModeQuit'),
    items,
    selectedCount: items.filter((item) => item.selected).length,
    restartConfirm: blockingCount > 0
      ? formatMessage(locale, 'safeModeRestart', { count: blockingCount })
      : undefined,
    recoveryLocked
  }
}

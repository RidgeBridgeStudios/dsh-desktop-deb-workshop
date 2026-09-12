import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

import { parseSemver, satisfiesRange } from './compatibility.mjs'
import { dshHome as defaultDshHome, installationClosureDir } from './paths.mjs'

export const SUPPORTED_DSH_RANGE = '~0.1.5-0'
export const SUPPORTED_DSH_VERSION = '0.1.5-rc.1'

export function isSupportedDsh(version) {
  if (typeof version !== 'string') return false
  if (parseSemver(version) === null) return false
  return satisfiesRange(version, SUPPORTED_DSH_RANGE)
}

export function assertSupportedDsh(version) {
  if (!isSupportedDsh(version)) {
    throw new Error(
      `Unsupported DSH version "${version}". Supported DSH range is "${SUPPORTED_DSH_RANGE}".`
    )
  }
}

export function resolveRunningDshVersion(options = {}) {
  if (typeof options.dshVersion === 'string') {
    return options.dshVersion
  }

  const home = options.home ?? options.dshHome ?? defaultDshHome()
  const candidates = [
    join(installationClosureDir(home), '@deepseek-ai/dsh/package.json'),
    join(home, 'node_modules/@deepseek-ai/dsh/package.json'),
    join(home, 'package.json'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/usr/lib/node_modules/@deepseek-ai/dsh/package.json'
  ]

  if (typeof options.dshEntryPath === 'string') {
    candidates.unshift(join(dirname(dirname(options.dshEntryPath)), 'package.json'))
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const content = JSON.parse(readFileSync(candidate, 'utf8'))
        if (typeof content?.version === 'string') {
          return content.version
        }
      } catch {}
    }
  }

  try {
    const req = createRequire(join(installationClosureDir(home), 'dummy.js'))
    const manifest = req('@deepseek-ai/dsh/package.json')
    if (typeof manifest?.version === 'string') return manifest.version
  } catch {}

  try {
    const req = createRequire(import.meta.url)
    const manifest = req('@deepseek-ai/dsh/package.json')
    if (typeof manifest?.version === 'string') return manifest.version
  } catch {}

  return null
}

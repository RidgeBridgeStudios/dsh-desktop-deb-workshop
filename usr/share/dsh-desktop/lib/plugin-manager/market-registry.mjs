import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'
export const REGION_REGISTRY = {
  global: DEFAULT_NPM_REGISTRY,
  china: 'https://mirrors.cloud.tencent.com/npm'
}

export function asRegistry(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\/+$/u, '')
  return trimmed === '' ? null : trimmed
}

export function registryFromArguments(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (typeof argument !== 'string') continue
    const inline = /^--(?:config\.)?registry=(.+)$/u.exec(argument)
    if (inline !== null) return asRegistry(inline[1])
    if (argument === '--registry' || argument === '--config.registry') {
      return asRegistry(args[index + 1])
    }
  }
  return null
}

export async function readMarketRegion(profileDir) {
  let state
  try {
    state = JSON.parse(await readFile(join(profileDir, '.dsh-market', 'state.json'), 'utf8'))
  } catch {
    return null
  }
  const region = state?.region
  return region === 'global' || region === 'china' ? region : null
}

/**
 * Mirror of the reference's precedence. Never invert it and never add a
 * fallback chain:
 *   1. explicit --registry/--config.registry argument;
 *   2. npm_config_registry set -> leave the caller's choice alone (null);
 *   3. DSHM_NPM_MIRROR override;
 *   4. persisted market region: china -> Tencent; global/absent -> do not pin.
 */
export async function resolveMarketRegistry(options = {}) {
  const { profileDir, args = [], environment = process.env } = options

  const explicit = registryFromArguments(args)
  if (explicit !== null) return explicit

  if (typeof environment.npm_config_registry === 'string' && environment.npm_config_registry.trim() !== '') {
    return null
  }

  if (typeof environment.DSHM_NPM_MIRROR === 'string' && environment.DSHM_NPM_MIRROR.trim() !== '') {
    return asRegistry(environment.DSHM_NPM_MIRROR)
  }

  const region = profileDir === undefined ? null : await readMarketRegion(profileDir)
  if (region === 'china') return REGION_REGISTRY.china
  return null
}

import { homedir } from 'node:os'
import { join } from 'node:path'

export const LIVE_PROFILE = 'default'

export function dshHome(environment = process.env) {
  const configured = environment.DSH_HOME
  return typeof configured === 'string' && configured.trim() !== ''
    ? configured
    : join(homedir(), '.dsh')
}

export function profilesRoot(home = dshHome()) {
  return join(home, 'profiles')
}

export function profileDirectory(home = dshHome(), profile = LIVE_PROFILE) {
  return join(profilesRoot(home), profile)
}

export function installationClosureDir(home = dshHome()) {
  return join(profilesRoot(home), 'node_modules')
}

export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/u

export function resolveProfileName(options = {}) {
  const env = options.environment ?? process.env
  if (options.explicit !== undefined) {
    if (typeof options.explicit !== 'string' || !PROFILE_NAME_PATTERN.test(options.explicit)) {
      throw new Error(`Invalid profile name: ${options.explicit}`)
    }
    return options.explicit
  }

  const envProfile = env.DSH_PROFILE
  if (typeof envProfile === 'string' && envProfile.trim() !== '') {
    if (!PROFILE_NAME_PATTERN.test(envProfile)) {
      throw new Error(`Invalid profile name in DSH_PROFILE: ${envProfile}`)
    }
    return envProfile
  }

  return options.fallback !== undefined ? options.fallback : LIVE_PROFILE
}

export async function activeProfile(home = dshHome()) {
  try {
    const { activeProfileName } = await import('./profiles.mjs')
    return await activeProfileName(home)
  } catch (error) {
    if (error?.message?.includes('profile name') || error?.code === 'ERR_INVALID_PROFILE_NAME') {
      throw error
    }
    return LIVE_PROFILE
  }
}


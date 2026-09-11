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

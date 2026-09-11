import { translate } from './locales.mjs'

/**
 * Linux fail-closed policy: DSH Desktop does not manage systemd units, XDG
 * autostart entries, cron jobs, or anything outside <dshHome> and the app's
 * user-data directory. Ownership cannot be proven without root, so recovery
 * documents the possibility and takes no action.
 */
export const EXTERNAL_COMPONENT_POLICY = 'document-only'

export function inspectExternalComponents() {
  return { managed: false, policy: EXTERNAL_COMPONENT_POLICY, components: [] }
}

export async function cleanupExternalComponents() {
  return { ok: true, managed: false, matched: 0, quarantined: [], failures: [] }
}

export function buildExternalComponentNotice(locale = 'en') {
  return {
    managed: false,
    policy: EXTERNAL_COMPONENT_POLICY,
    message: translate(locale, 'externalComponentsNotice')
  }
}

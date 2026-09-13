import { detectPluginRecovery, resolveAttribution } from './detection.mjs'
import { planPluginRecovery } from './recovery-market.mjs'

/**
 * Turn collected evidence into a recovery plan. Attribution is unique-only:
 * with no unique owner the plan names no plugin, so the UI can only offer
 * retry, Safe Mode, or exit.
 */
export function buildRecoveryPlan(options = {}) {
  const {
    candidates = [],
    startupFailures = [],
    logs = [],
    duplicateLoaderEntryId,
    slotConflictName,
    slotProviders = [],
    checks = [],
    excludedPlugins = [],
    profile
  } = options

  const detection = detectPluginRecovery({ candidates, startupFailures, logs, excludedPlugins })
  let plugins = detection.plugins
  // A structured report is never mixed with log guesses: paths 2 and 3 depend
  // on the entry chain and root package the report carries. Without provenance
  // the report yields no candidate rather than a guess.
  if (
    plugins.length === 0 &&
    detection.source !== 'structured' &&
    (duplicateLoaderEntryId !== undefined || slotConflictName !== undefined || slotProviders.length > 0)
  ) {
    plugins = resolveAttribution(candidates, [], {
      duplicateLoaderEntryId,
      slotConflictName,
      slotProviders
    }).filter((name) => !excludedPlugins.includes(name))
  }

  const relevantChecks = checks.filter((check) => plugins.includes(check.packageName))
  const plan = planPluginRecovery(relevantChecks)

  return {
    source: detection.source,
    plugins: [...plugins].sort(),
    checks: relevantChecks,
    plan,
    logs: detection.logs
  }
}

/** Batch auto-fix only ever acts on the uniquely attributed plugins. */
export async function applyRecoveryPlan(recoveryPlan, handlers) {
  const upgraded = []
  const removed = []
  for (const upgrade of recoveryPlan.plan.upgrades) {
    await handlers.upgrade(upgrade)
    upgraded.push(upgrade.packageName)
  }
  for (const packageName of recoveryPlan.plan.removals) {
    await handlers.remove(packageName)
    removed.push(packageName)
  }
  return { upgraded, removed, plugins: recoveryPlan.plugins }
}

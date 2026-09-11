const REMOVAL_RECOMMENDED_HEALTH = new Set(['incompatible-no-fix'])

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

export function planPluginRecovery(checks = []) {
  const upgrades = []
  const removals = []
  const skipped = []
  for (const check of checks) {
    const packageName = check?.packageName
    if (typeof packageName !== 'string') continue
    if (check.checkFailed === true) {
      skipped.push(packageName)
      continue
    }
    if (check.upgradeReady === true && typeof check.upgradeVersion === 'string') {
      upgrades.push({ packageName, targetVersion: check.upgradeVersion, installedVersion: check.installedVersion })
      continue
    }
    if (check.removalRecommended === true || REMOVAL_RECOMMENDED_HEALTH.has(check.healthStatus)) {
      removals.push(packageName)
      continue
    }
    skipped.push(packageName)
  }
  return { upgrades, removals, skipped }
}

export async function runPluginRecoveryPlan(plan, handlers) {
  const upgraded = []
  const removed = []
  const failures = []
  for (const upgrade of plan?.upgrades ?? []) {
    try {
      await handlers.upgrade(upgrade)
      upgraded.push(upgrade.packageName)
    } catch (error) {
      failures.push({ action: 'upgrade', packageName: upgrade.packageName, detail: errorText(error) })
    }
  }
  for (const packageName of plan?.removals ?? []) {
    try {
      await handlers.remove(packageName)
      removed.push(packageName)
    } catch (error) {
      failures.push({ action: 'remove', packageName, detail: errorText(error) })
    }
  }
  return { upgraded, removed, failures }
}

export function checkBlockingPluginUpdates(options = {}) {
  const { plugins = [], check, attemptedUpgrades = [] } = options
  return plugins.map((packageName) => {
    const report = check(packageName) ?? {}
    const attempted = attemptedUpgrades.includes(packageName)
    const removalRecommended = attempted || report.healthStatus === 'incompatible-no-fix'
    const upgradeCandidate =
      report.upgradeReady === true &&
      typeof report.upgradeVersion === 'string' &&
      !attempted
        ? {
            packageName,
            targetVersion: report.upgradeVersion,
            installedVersion: report.installedVersion
          }
        : undefined
    return { packageName, report, upgradeCandidate, removalRecommended, attempted }
  })
}

export function selectPluginRecoveryTarget(action, allowlist = []) {
  const match = /^(upgrade|uninstall):(.+)$/u.exec(String(action))
  if (match === null) return undefined
  const [, kind, packageName] = match
  if (!allowlist.includes(packageName)) return undefined
  return { kind, packageName }
}

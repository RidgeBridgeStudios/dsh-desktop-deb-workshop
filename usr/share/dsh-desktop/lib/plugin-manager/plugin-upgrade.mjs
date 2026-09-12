function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A successful install only proves pnpm ran. Every upgrade terminates in a
 * NORMAL-profile start that reaches the ready signal; Safe Mode never counts.
 */
export async function upgradePlugin(options) {
  const { pluginName, targetVersion, install, publish, verifyNormalBoot } = options
  try {
    await install({ pluginName, targetVersion })
    if (publish !== undefined) await publish({ pluginName, targetVersion })
  } catch (error) {
    return { ok: false, status: 'install-failed', pluginName, detail: errorText(error) }
  }

  let verified = false
  try {
    verified = await verifyNormalBoot()
  } catch (error) {
    return { ok: false, status: 'unverified', pluginName, targetVersion, detail: errorText(error), offeredAgain: true }
  }

  if (verified !== true) {
    // Reference behavior (a): do not auto-revert the projection.
    // The installed version remains in place, marked unverified and offered
    // again in recovery on next launch.
    return { ok: false, status: 'unverified', pluginName, targetVersion, offeredAgain: true }
  }

  return { ok: true, status: 'verified', pluginName, targetVersion }
}

/**
 * One batch operation: upgrade compatibles, uninstall confirmed blockers, then
 * a single normal-profile verification. No restart between the two sets.
 * Unknown/failed checks are skipped, partial success is preserved, and
 * successes are never rolled back.
 */
export async function upgradePluginsBatch(options) {
  const { checks = [], applyUpgrade, applyRemoval, verifyNormalBoot } = options

  const upgrades = []
  const removals = []
  const skipped = []
  for (const check of checks) {
    if (check.checkFailed === true || (check.upgradeReady !== true && check.removalRecommended !== true)) {
      skipped.push(check.packageName)
      continue
    }
    if (check.upgradeReady === true && typeof check.upgradeVersion === 'string') {
      upgrades.push({ packageName: check.packageName, targetVersion: check.upgradeVersion })
      continue
    }
    if (check.removalRecommended === true) removals.push(check.packageName)
  }

  const upgraded = []
  const removed = []
  const failures = []
  for (const upgrade of upgrades) {
    try {
      await applyUpgrade(upgrade)
      upgraded.push(upgrade.packageName)
    } catch (error) {
      failures.push({ action: 'upgrade', packageName: upgrade.packageName, detail: errorText(error) })
    }
  }
  for (const packageName of removals) {
    try {
      await applyRemoval(packageName)
      removed.push(packageName)
    } catch (error) {
      failures.push({ action: 'remove', packageName, detail: errorText(error) })
    }
  }

  const changed = upgraded.length > 0 || removed.length > 0
  let verified = true
  if (changed) {
    try {
      verified = await verifyNormalBoot()
    } catch {
      verified = false
    }
  }

  const stillBlocked = verified
    ? []
    : checks.filter((check) => upgraded.includes(check.packageName)).map((check) => check.packageName)

  return {
    upgraded,
    removed,
    skipped,
    failures,
    verified,
    stillBlocked,
    invalidated: verified ? [...upgraded] : []
  }
}

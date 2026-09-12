import { formatMessage, translate } from './locales.mjs'
import { planPluginRecovery } from './recovery-market.mjs'

/**
 * Pure view model for the recovery surface. It has no Harness dependency: it
 * is built in the app process from evidence and market checks.
 */
export function buildRecoveryViewModel(options = {}) {
  const {
    locale = 'en',
    plugins = [],
    checks = [],
    rawError,
    progress,
    structured = false
  } = options
  const t = (key) => translate(locale, key)
  const plan = planPluginRecovery(checks)
  const hasActions = plan.upgrades.length > 0 || plan.removals.length > 0

  return {
    title: t('recoveryTitle'),
    structured,
    plugins: [...plugins],
    canUninstall: plugins.length > 0,
    primaryLabel: plugins.length === 0
      ? t('recoveryEnterSafeMode')
      : plugins.length === 1
        ? t('recoveryRemove')
        : formatMessage(locale, 'recoveryRemoveMany', { count: plugins.length }),
    safeModeLabel: t('recoveryEnterSafeMode'),
    autoProcessLabel: hasActions
      ? formatMessage(locale, 'recoveryAutoProcess', {
          upgrades: plan.upgrades.length,
          removals: plan.removals.length
        })
      : undefined,
    retryCheckLabel: checks.length > 0 && !hasActions ? t('recoveryRetryChecks') : undefined,
    retryLabel: t('recoveryRetry'),
    upgradeLabel: t('recoveryUpgrade'),
    upgradeBusyLabel: t('recoveryUpgrading'),
    uninstallLabel: t('recoveryUninstall'),
    logLabel: t('recoveryLog'),
    technicalLabel: t('recoveryTechnical'),
    safetyNote: t('recoverySafetyNote'),
    noCandidate: plugins.length === 0 ? t('recoveryNoCandidate') : undefined,
    plan,
    rawError,
    progress
  }
}

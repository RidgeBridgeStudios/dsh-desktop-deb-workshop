export const SUPPORTED_LOCALES = ['en', 'zh']

export const LOCALES = {
  en: {
    nav: 'Plugin market',
    title: 'Plugin market',
    intro: 'Install dsh-market to browse, search, install, and manage community plugins inside DSH Desktop.',
    community: 'dsh-market is maintained by its community. Installing and using community plugins requires network access, and those plugins are not reviewed by DSH Desktop.',
    version: 'Recommended version',
    install: 'Install plugin market',
    installing: 'Installing plugin market…',
    installingHint: 'This can take a few minutes. Keep DSH Desktop open while pnpm downloads and configures the plugin.',
    installed: 'Plugin market installed',
    installedHint: 'Restart Harness once to load the complete market interface.',
    restart: 'Restart Harness',
    restarting: 'Restarting…',
    restartRequired: 'Restart required',
    restartRequiredHint: 'Restart Harness from the DSH Desktop menu to finish applying the change.',
    retry: 'Try again',
    incomplete: 'The previous installation is incomplete. Run the installer again to repair it.',
    failed: 'Plugin market could not be installed.',
    statusFailed: 'Could not read installation status.',
    repository: 'View dsh-market on GitHub',
    futureUpdates: 'After installation, dsh-market will notify you when its own updates are available.',
    managementTab: 'Plugin market',
    managementIntro: 'Manage the optional dsh-market integration installed by DSH Desktop.',
    installedVersion: 'Installed version',
    uninstall: 'Uninstall plugin market',
    uninstalling: 'Uninstalling plugin market…',
    uninstallingHint: 'Removing dsh-market from the profile. Other plugins are not affected.',
    uninstallConfirmTitle: 'Uninstall plugin market?',
    uninstallConfirmDesc: 'Only dsh-market will be removed. Other plugins installed through the market will remain installed.',
    uninstallConfirmNote: 'Restart Harness after removal to finish unloading the market interface.',
    cancel: 'Cancel',
    removed: 'Plugin market uninstalled',
    removedHint: 'dsh-market has been removed. Restart Harness to finish.',
    uninstallFailed: 'Plugin market could not be uninstalled.'
  },
  zh: {
    nav: '插件市场',
    title: '插件市场',
    intro: '安装 dsh-market，在 DSH Desktop 内浏览、搜索、安装并管理社区插件。',
    community: 'dsh-market 由社区维护。安装和使用社区插件需要联网，这些插件不由 DSH Desktop 审核。',
    version: '推荐版本',
    install: '安装插件市场',
    installing: '正在安装插件市场…',
    installingHint: '下载和配置可能需要几分钟，请保持 DSH Desktop 处于打开状态。',
    installed: '插件市场已安装',
    installedHint: '重启一次 Harness，即可加载完整的插件市场界面。',
    restart: '重启 Harness',
    restarting: '正在重启…',
    restartRequired: '需要重启',
    restartRequiredHint: '请从 DSH Desktop 菜单重启 Harness 以完成更改。',
    retry: '重试',
    incomplete: '上一次安装没有完成，请重新运行安装以修复。',
    failed: '插件市场安装失败。',
    statusFailed: '无法读取安装状态。',
    repository: '在 GitHub 查看 dsh-market',
    futureUpdates: '安装后，dsh-market 会在有新版本时提示并提供升级。',
    managementTab: '插件市场',
    managementIntro: '管理由 DSH Desktop 安装的可选 dsh-market 集成。',
    installedVersion: '当前版本',
    uninstall: '卸载插件市场',
    uninstalling: '正在卸载插件市场…',
    uninstallingHint: '正在从 profile 中移除 dsh-market，其他插件不会受到影响。',
    uninstallConfirmTitle: '卸载插件市场？',
    uninstallConfirmDesc: '只会移除 dsh-market。通过插件市场安装的其他插件将继续保留。',
    uninstallConfirmNote: '移除完成后需要重启 Harness，插件市场界面才会完全退出。',
    cancel: '取消',
    removed: '插件市场已卸载',
    removedHint: 'dsh-market 已移除，请重启 Harness 完成卸载。',
    uninstallFailed: '插件市场卸载失败。'
  }
}

export function resolveLocale(preference) {
  if (preference === 'zh' || preference === 'en') return preference
  if (typeof preference === 'string' && preference.toLowerCase().startsWith('zh')) return 'zh'
  return 'en'
}

export function translate(locale, key) {
  const language = resolveLocale(locale)
  return LOCALES[language][key] ?? LOCALES.en[key] ?? key
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAppMenuTemplate,
  buildTrayMenuTemplate,
  detectLocale,
  getSafeModeViewModel,
  handleStartupFailureText
} from '../usr/share/dsh-desktop/app/main.js'
import {
  PLUGIN_FAILURE_PREFIX,
  formatPluginStartupFailure
} from '../usr/share/dsh-desktop/lib/plugin-manager/startup-failure.mjs'

test('supervisor failure detection: parses structured plugin failure lines', () => {
  const line = formatPluginStartupFailure({
    stage: 'import',
    packageName: 'problematic-plugin',
    message: 'SyntaxError: Unexpected token'
  })

  assert.ok(line.startsWith(PLUGIN_FAILURE_PREFIX))

  const model = handleStartupFailureText(line)
  assert.ok(model !== null, 'Must produce recovery model')
  assert.equal(model.structured, true)
  assert.deepEqual(model.plugins, ['problematic-plugin'])
  assert.deepEqual(model.plan.removals, ['problematic-plugin'])
  assert.deepEqual(model.plan.upgrades, [])
  assert.match(model.rawError, /problematic-plugin/)
  assert.match(model.rawError, /SyntaxError/)
})

test('supervisor failure detection: ignores non-prefixed log output', () => {
  const normalLog = '[info] server listening on 127.0.0.1:3080\n[warn] slow response\n'
  const model = handleStartupFailureText(normalLog)
  assert.equal(model, null)
})

test('locale detection: detects zh from electron app getLocale', () => {
  const mockAppZh = { getLocale: () => 'zh-CN' }
  assert.equal(detectLocale(mockAppZh), 'zh')

  const mockAppEn = { getLocale: () => 'en-US' }
  assert.equal(detectLocale(mockAppEn), 'en')
})

test('recovery and safe mode view models respect localized preference', () => {
  const line = formatPluginStartupFailure({
    stage: 'import',
    packageName: 'bad-plugin',
    message: 'Crash'
  })
  const modelZh = handleStartupFailureText(line, { locale: 'zh' })
  assert.equal(modelZh.title, '有插件导致启动失败')
  assert.equal(modelZh.safeModeLabel, '进入安全模式')

  const safeModelZh = getSafeModeViewModel({ locale: 'zh', plugins: ['test-p'] })
  assert.equal(safeModelZh.badge, '安全模式')
  assert.equal(safeModelZh.exitLabel, '退出安全模式并重启')
})

test('tray menu and app menu templates show Chinese labels on zh locale', () => {
  const trayItems = buildTrayMenuTemplate({ locale: 'zh', active: true, isWindowVisible: false })
  assert.equal(trayItems[1].label, '● DSH 状态：运行中')
  assert.equal(trayItems[3].label, '打开 DSH Desktop')
  assert.equal(trayItems[5].label, '重启 DeepSeek Harness (DSH)')
  assert.equal(trayItems[6].label, '重启桌面应用')
  assert.equal(trayItems[7].label, '同时重启（桌面应用与 DSH）')
  assert.equal(trayItems[9].label, '退出桌面应用')
  assert.equal(trayItems[10].label, '完全退出（桌面应用与 DSH）')

  const appMenu = buildAppMenuTemplate({ locale: 'zh' })
  assert.equal(appMenu[0].label, '文件')
  assert.equal(appMenu[0].submenu[0].label, '重新加载')
  assert.equal(appMenu[0].submenu[1].label, '强制重新加载')
  assert.equal(appMenu[3].label, '帮助')
})

test('handleStartupFailureText: filtered checks only include plugins named in recovery plan', () => {
  const line = formatPluginStartupFailure({
    stage: 'import',
    packageName: 'plugin-a',
    message: 'Crash'
  })
  const checks = [
    { packageName: 'plugin-a', removable: true, removalRecommended: true, upgradeAvailable: false },
    { packageName: 'plugin-b', removable: true, removalRecommended: true, upgradeAvailable: true }
  ]
  const viewModel = handleStartupFailureText(line, {
    checks,
    candidates: [{ name: 'plugin-a', directory: '/dir/a', dependencies: {}, optionalDependencies: {}, bundlePatch: '', sources: {} }]
  })
  assert.ok(viewModel)
  assert.deepEqual(viewModel.plan.removals, ['plugin-a'])
  assert.deepEqual(viewModel.plan.upgrades, [])
})


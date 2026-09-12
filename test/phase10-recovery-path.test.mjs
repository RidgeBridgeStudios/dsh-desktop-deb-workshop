import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRecoveryViewModel } from '../usr/share/dsh-desktop/lib/plugin-manager/recovery-view.mjs'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const recoveryHtmlPath = join(__dirname, '../usr/share/dsh-desktop/app/recovery.html')

test('recovery.html artifact exists and defines required DOM hooks', () => {
  const html = readFileSync(recoveryHtmlPath, 'utf8')
  assert.ok(html.includes('id="recovery-title"'))
  assert.ok(html.includes('id="plugin-list"'))
  assert.ok(html.includes('id="btn-primary"'))
  assert.ok(html.includes('id="btn-safe"'))
  assert.ok(html.includes('id="btn-retry"'))
  assert.ok(html.includes('setRecoveryModel'))
  assert.ok(html.includes('dispatchAction'))
  assert.ok(html.includes('window.dshRecovery.action'))
})

test('recovery view model formats actions for single and multiple candidates', () => {
  const single = buildRecoveryViewModel({
    locale: 'en',
    plugins: ['broken-plugin'],
    checks: [{ packageName: 'broken-plugin', removalRecommended: true, upgradeAvailable: false, removable: true }]
  })
  assert.equal(single.canUninstall, true)
  assert.equal(single.primaryLabel, 'Remove this plugin and continue')
  assert.equal(single.safeModeLabel, 'Enter Safe Mode')
  assert.equal(single.plan.removals.length, 1)

  const multi = buildRecoveryViewModel({
    locale: 'en',
    plugins: ['plugin-1', 'plugin-2'],
    checks: []
  })
  assert.equal(multi.canUninstall, true)
  assert.equal(multi.primaryLabel, 'Remove these 2 plugins and continue')
})

test('recovery view dispatches appropriate recovery action payload', () => {
  const actionsDispatched = []
  const mockDshRecovery = {
    action(action) {
      actionsDispatched.push(action)
    }
  }

  // Simulate recovery.html script dispatch logic
  function dispatchAction(actionKey, currentModel) {
    let action = actionKey
    if (actionKey === 'primary' && currentModel) {
      if (currentModel.plan?.removals?.length > 0) {
        action = `uninstall:${currentModel.plan.removals[0]}`
      } else if (currentModel.plan?.upgrades?.length > 0) {
        action = `upgrade:${currentModel.plan.upgrades[0].packageName}`
      } else if (currentModel.canUninstall && currentModel.plugins?.length > 0) {
        action = `uninstall:${typeof currentModel.plugins[0] === 'string' ? currentModel.plugins[0] : currentModel.plugins[0].name}`
      } else {
        action = 'safe-mode'
      }
    }
    mockDshRecovery.action(action)
  }

  const model = buildRecoveryViewModel({
    locale: 'en',
    plugins: ['bad-pkg'],
    checks: [{ packageName: 'bad-pkg', upgradeAvailable: false, removable: true }]
  })

  dispatchAction('primary', model)
  assert.equal(actionsDispatched[actionsDispatched.length - 1], 'uninstall:bad-pkg')

  dispatchAction('safe-mode', model)
  assert.equal(actionsDispatched[actionsDispatched.length - 1], 'safe-mode')

  dispatchAction('retry', model)
  assert.equal(actionsDispatched[actionsDispatched.length - 1], 'retry')
})

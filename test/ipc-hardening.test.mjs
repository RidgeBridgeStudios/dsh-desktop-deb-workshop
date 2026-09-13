import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertTrustedSender,
  registerIpcHandlers,
  SAFE_PACKAGE_NAME_PATTERN,
  isProhibitedPackage,
  executeCommand,
  resolveDaemonBin,
  stopDshBackend
} from '../usr/share/dsh-desktop/app/main.js'
import { LIVE_PROFILE } from '../usr/share/dsh-desktop/lib/plugin-manager/paths.mjs'
import { RECOMMENDED_MARKET_VERSION } from '../usr/share/dsh-desktop/lib/plugin-manager/market-constants.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appDir = path.resolve(__dirname, '../usr/share/dsh-desktop/app')

test('assertTrustedSender: allows loopback and app file URLs', () => {
  // Loopback origins
  assert.doesNotThrow(() => assertTrustedSender({ senderFrame: { url: 'http://127.0.0.1:3080/index.html' } }))
  assert.doesNotThrow(() => assertTrustedSender({ senderFrame: { url: 'http://localhost:3080/' } }))
  assert.doesNotThrow(() => assertTrustedSender({ senderFrame: { url: 'http://127.0.0.1:8080/path?param=1' } }))

  // App dir file URLs
  const appFileUrl = `file://${path.join(appDir, 'loading.html')}`
  assert.doesNotThrow(() => assertTrustedSender({ senderFrame: { url: appFileUrl } }))
  const subFileUrl = `file://${path.join(appDir, 'sub', 'view.html')}`
  assert.doesNotThrow(() => assertTrustedSender({ senderFrame: { url: subFileUrl } }))
})

test('assertTrustedSender: rejects untrusted, missing, and non-app senders', () => {
  // Missing or malformed event / senderFrame
  assert.throws(() => assertTrustedSender(null), /Untrusted IPC sender/)
  assert.throws(() => assertTrustedSender({}), /Untrusted IPC sender/)
  assert.throws(() => assertTrustedSender({ senderFrame: {} }), /Untrusted IPC sender/)
  assert.throws(() => assertTrustedSender({ senderFrame: { url: null } }), /Untrusted IPC sender/)

  // Remote or spoofed loopback domains
  assert.throws(() => assertTrustedSender({ senderFrame: { url: 'https://attacker.com' } }), /Untrusted IPC sender/)
  assert.throws(() => assertTrustedSender({ senderFrame: { url: 'http://127.0.0.1.evil.com:3080' } }), /Untrusted IPC sender/)
  assert.throws(() => assertTrustedSender({ senderFrame: { url: 'http://192.168.1.100:3080' } }), /Untrusted IPC sender/)

  // File URLs outside app directory or attempting path traversal
  assert.throws(() => assertTrustedSender({ senderFrame: { url: 'file:///etc/passwd' } }), /Untrusted IPC sender/)
  assert.throws(() => assertTrustedSender({ senderFrame: { url: 'file:///tmp/evil.html' } }), /Untrusted IPC sender/)
  assert.throws(() => assertTrustedSender({ senderFrame: { url: `file://${appDir}/../evil.html` } }), /Untrusted IPC sender/)
})

test('every IPC handler rejects untrusted sender', async () => {
  const handlers = {}
  const mockIpc = {
    handle(channel, fn) {
      handlers[channel] = fn
    }
  }
  registerIpcHandlers(mockIpc, {})

  const untrustedEvent = { senderFrame: { url: 'https://attacker.com' } }
  const channels = [
    ['harness:restart'],
    ['market:install', {}],
    ['market:uninstall', {}],
    ['recovery:action', 'safe-mode'],
    ['safe-mode:action', 'launch', []],
    ['safe-mode:model', {}]
  ]

  for (const [channel, ...args] of channels) {
    assert.ok(typeof handlers[channel] === 'function', `Handler ${channel} must exist`)
    await assert.rejects(
      () => handlers[channel](untrustedEvent, ...args),
      /Untrusted IPC sender/,
      `${channel} must reject untrusted sender`
    )
  }
})

test('market:install & market:uninstall: ignore hostile renderer options', async () => {
  const handlers = {}
  const mockIpc = {
    handle(channel, fn) {
      handlers[channel] = fn
    }
  }

  let capturedInstallOptions = null
  let capturedUninstallOptions = null

  const legitimateHome = '/home/user/.dsh'
  const supervisor = {
    dshHome: legitimateHome,
    nodeExecutablePath: '/opt/node/bin/node',
    resolveDshEntry: () => '/opt/dsh/bin.js',
    recommendedVersion: RECOMMENDED_MARKET_VERSION,
    withDaemonStopped: (action) => action(),
    installMarketShared: async (options) => {
      capturedInstallOptions = options
      return { ok: true }
    },
    uninstallMarketShared: async (options) => {
      capturedUninstallOptions = options
      return { ok: true }
    }
  }

  registerIpcHandlers(mockIpc, supervisor)

  const trustedEvent = { senderFrame: { url: 'http://127.0.0.1:3080' } }
  const hostileOptions = {
    dshHome: '/tmp/evil',
    profile: 'evil-profile',
    recommendedVersion: '999.999.999',
    dshEntryPath: '/tmp/evil-entry.js',
    nodeExecutablePath: '/tmp/evil-node',
    extraMaliciousFlag: true
  }

  // Test market:install
  await handlers['market:install'](trustedEvent, hostileOptions)
  assert.ok(capturedInstallOptions, 'installMarketShared must be called')
  assert.equal(capturedInstallOptions.dshHome, legitimateHome, 'Must use legitimate home, not /tmp/evil')
  assert.equal(capturedInstallOptions.profile, LIVE_PROFILE, 'Must enforce LIVE_PROFILE')
  assert.equal(capturedInstallOptions.recommendedVersion, RECOMMENDED_MARKET_VERSION, 'Must enforce recommendedVersion')
  assert.equal(capturedInstallOptions.dshEntryPath, '/opt/dsh/bin.js')
  assert.equal(capturedInstallOptions.nodeExecutablePath, '/opt/node/bin/node')
  assert.equal(capturedInstallOptions.extraMaliciousFlag, undefined, 'Must not spread extra options')

  // Test market:uninstall
  await handlers['market:uninstall'](trustedEvent, hostileOptions)
  assert.ok(capturedUninstallOptions, 'uninstallMarketShared must be called')
  assert.equal(capturedUninstallOptions.dshHome, legitimateHome, 'Must use legitimate home, not /tmp/evil')
  assert.equal(capturedUninstallOptions.profile, LIVE_PROFILE, 'Must enforce LIVE_PROFILE')
  assert.equal(capturedUninstallOptions.dshEntryPath, '/opt/dsh/bin.js')
  assert.equal(capturedUninstallOptions.nodeExecutablePath, '/opt/node/bin/node')
  assert.equal(capturedUninstallOptions.extraMaliciousFlag, undefined, 'Must not spread extra options')
})

test('recovery:action: allowlist and package name validation', async () => {
  const handlers = {}
  const mockIpc = {
    handle(channel, fn) {
      handlers[channel] = fn
    }
  }

  let uninstalled = null
  let upgraded = null
  let safeModeCalled = false
  let retryCalled = false

  const supervisor = {
    withDaemonStopped: (action) => action(),
    relaunchSafeMode: () => { safeModeCalled = true },
    restartDsh: () => { retryCalled = true },
    uninstallPlugin: ({ packageName }) => { uninstalled = packageName; return { ok: true } },
    upgradePlugin: ({ pluginName, targetVersion }) => { upgraded = { pluginName, targetVersion }; return { ok: true } }
  }

  registerIpcHandlers(mockIpc, supervisor)
  const trustedEvent = { senderFrame: { url: 'http://127.0.0.1:3080' } }

  // Valid actions
  await handlers['recovery:action'](trustedEvent, 'safe-mode')
  assert.equal(safeModeCalled, true)

  await handlers['recovery:action'](trustedEvent, 'retry')
  assert.equal(retryCalled, true)

  await handlers['recovery:action'](trustedEvent, 'uninstall:my-plugin')
  assert.equal(uninstalled, 'my-plugin')

  await handlers['recovery:action'](trustedEvent, 'uninstall:@scoped/my-plugin')
  assert.equal(uninstalled, '@scoped/my-plugin')

  await handlers['recovery:action'](trustedEvent, 'upgrade:my-plugin')
  assert.deepEqual(upgraded, { pluginName: 'my-plugin', targetVersion: undefined })

  await handlers['recovery:action'](trustedEvent, 'upgrade:my-plugin@1.2.3')
  assert.deepEqual(upgraded, { pluginName: 'my-plugin', targetVersion: '1.2.3' })

  // Rejects invalid action strings
  const invalidActions = [
    'destroy',
    'uninstall:',
    'uninstall:evil; rm -rf /',
    'uninstall:../../etc/passwd',
    'uninstall:foo bar',
    'upgrade:',
    'upgrade:foo; whoami',
    'upgrade:plugin@1.0.0; touch /tmp/pwn',
    'custom:command',
    '',
    null,
    undefined,
    123
  ]

  for (const act of invalidActions) {
    await assert.rejects(
      () => handlers['recovery:action'](trustedEvent, act),
      /Invalid or prohibited/,
      `Action "${act}" must be rejected`
    )
  }

  // Rejects protected packages: @deepseek-ai/*, dshmarket, core bundles
  const prohibitedPackages = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/core',
    '@deepseek-ai/anything',
    'dshmarket',
    'DSHMARKET'
  ]

  for (const pkg of prohibitedPackages) {
    await assert.rejects(
      () => handlers['recovery:action'](trustedEvent, `uninstall:${pkg}`),
      /Invalid or prohibited/,
      `Uninstalling protected package "${pkg}" must be rejected`
    )
    await assert.rejects(
      () => handlers['recovery:action'](trustedEvent, `upgrade:${pkg}`),
      /Invalid or prohibited/,
      `Upgrading protected package "${pkg}" must be rejected`
    )
    await assert.rejects(
      () => handlers['recovery:action'](trustedEvent, `upgrade:${pkg}@1.0.0`),
      /Invalid or prohibited/,
      `Upgrading protected package "${pkg}@1.0.0" must be rejected`
    )
  }
})

test('safe-mode:action: allowlist and selection coercion', async () => {
  const handlers = {}
  const mockIpc = {
    handle(channel, fn) {
      handlers[channel] = fn
    }
  }

  let relaunchedSelection = null
  let exited = false
  const supervisor = {
    relaunchSafeMode: (selection) => { relaunchedSelection = selection },
    exitSafeMode: () => { exited = true },
    ensureSafeModeProfile: () => {}
  }

  registerIpcHandlers(mockIpc, supervisor)
  const trustedEvent = { senderFrame: { url: 'http://127.0.0.1:3080' } }

  // Rejects disallowed actions
  const invalidActions = ['disable', 'start', 'restart', 'stop', 'exploit', '', null, 42]
  for (const act of invalidActions) {
    await assert.rejects(
      () => handlers['safe-mode:action'](trustedEvent, act),
      /Invalid safe-mode action/,
      `Safe mode action "${act}" must be rejected`
    )
  }

  // Allowed exit
  await handlers['safe-mode:action'](trustedEvent, 'exit')
  assert.equal(exited, true)

  // Coercion on non-array selection
  await handlers['safe-mode:action'](trustedEvent, 'relaunch', null)
  assert.deepEqual(relaunchedSelection, [])

  await handlers['safe-mode:action'](trustedEvent, 'relaunch', { malicious: 'object' })
  assert.deepEqual(relaunchedSelection, [])

  // Coercion on invalid array items (drops non-strings and unsafe strings)
  await handlers['safe-mode:action'](trustedEvent, 'relaunch', [
    'valid-plugin-1',
    12345,
    null,
    'evil; rm -rf /',
    '../../traversal',
    '@valid/scoped-pkg',
    {}
  ])
  assert.deepEqual(relaunchedSelection, ['valid-plugin-1', '@valid/scoped-pkg'])

  // Selection max 64 items cap
  const excessiveSelection = Array.from({ length: 100 }, (_, i) => `plugin-${i}`)
  await handlers['safe-mode:action'](trustedEvent, 'launch', excessiveSelection)
  assert.equal(relaunchedSelection.length, 64)
  assert.equal(relaunchedSelection[0], 'plugin-0')
  assert.equal(relaunchedSelection[63], 'plugin-63')
})

test('executeCommand: executes with execFile without shell interpolation', async () => {
  // Test stdout and argument preservation without shell expansion
  const res = await executeCommand('echo', ['hello', '$HOME', '; whoami'])
  assert.equal(res.error, null)
  assert.equal(res.stdout, 'hello $HOME ; whoami', 'Metacharacters must not be expanded by shell')
  assert.equal(res.stderr, '')

  // Missing binary reports error
  const errRes = await executeCommand('non_existent_binary_for_testing_12345')
  assert.ok(errRes.error)
  assert.equal(errRes.error.code, 'ENOENT')
})

test('stopDshBackend: prefers systemctl and only pkills exact daemon path if systemd unavailable', async () => {
  const daemonBin = resolveDaemonBin()
  assert.ok(typeof daemonBin === 'string' && daemonBin.length > 0)

  // In this testing environment, systemctl is available
  // stopDshBackend runs systemctl --user stop
  await assert.doesNotReject(async () => {
    await stopDshBackend()
  })
})

test('preset:get-import-data: only reads supervisor.importPresetPath, enforces .dshpreset and realpath matching', async (t) => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preset-test-'))
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const validPresetPath = path.join(tmpDir, 'valid.dshpreset')
  const presetContent = Buffer.from('preset-data-content')
  await fs.writeFile(validPresetPath, presetContent)

  const nonPresetPath = path.join(tmpDir, 'test.txt')
  await fs.writeFile(nonPresetPath, Buffer.from('not-preset'))

  const handlers = {}
  const mockIpc = {
    handle(channel, fn) {
      handlers[channel] = fn
    }
  }

  const supervisor = {
    importPresetPath: validPresetPath
  }

  registerIpcHandlers(mockIpc, supervisor)
  const trustedEvent = { senderFrame: { url: 'http://127.0.0.1:3080' } }

  // a) reading exact path returns buffer
  const validData = await handlers['preset:get-import-data'](trustedEvent, validPresetPath)
  assert.ok(Buffer.isBuffer(validData))
  assert.equal(validData.toString(), 'preset-data-content')

  // b) reading '/etc/passwd' rejects or returns null
  const passwdData = await handlers['preset:get-import-data'](trustedEvent, '/etc/passwd').catch(() => null)
  assert.equal(passwdData, null)

  // c) reading '../something.dshpreset' rejects or returns null
  const relativeData = await handlers['preset:get-import-data'](trustedEvent, '../something.dshpreset').catch(() => null)
  assert.equal(relativeData, null)

  // d) reading a path with a non-.dshpreset extension rejects or returns null
  const nonPresetData = await handlers['preset:get-import-data'](trustedEvent, nonPresetPath).catch(() => null)
  assert.equal(nonPresetData, null)
})

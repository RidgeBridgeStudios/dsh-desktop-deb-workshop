// Main process for DSH Desktop Electron wrapper.
// Runs the DeepSeek Harness UI in a strictly sandboxed Chromium window
// with system tray icon support, DSH service management, and recovery supervisor.

import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PLUGIN_FAILURE_PREFIX,
  parsePluginStartupFailures
} from '../lib/plugin-manager/startup-failure.mjs';
import {
  SAFE_MODE_PROFILE,
  shouldStartInSafeMode,
  ensureSafeModeProfile,
  buildSafeModeViewModel
} from '../lib/plugin-manager/safe-mode.mjs';
import {
  buildRecoveryViewModel
} from '../lib/plugin-manager/recovery-view.mjs';
import {
  installMarketShared,
  uninstallMarketShared,
  resolveDshEntry
} from '../lib/plugin-manager/market-backend.mjs';
import {
  RECOMMENDED_MARKET_VERSION
} from '../lib/plugin-manager/market-constants.mjs';
import {
  dshHome as defaultDshHome,
  LIVE_PROFILE,
  profileDirectory
} from '../lib/plugin-manager/paths.mjs';
import {
  uninstallPlugin,
  upgradePlugin
} from '../lib/plugin-manager/orchestrator.mjs';
import {
  buildRecoveryPlan
} from '../lib/plugin-manager/recovery.mjs';
import {
  configuredProfilePlugins
} from '../lib/plugin-manager/detection.mjs';
import {
  resolveLocale,
  translate,
  formatMessage
} from '../lib/plugin-manager/locales.mjs';
import {
  checkForUpdates,
  getAvailableUpdate,
  setAvailableUpdate,
  formatUpdateLabel
} from './update-check.mjs';
import {
  isSystemCircuitOpen,
  markReady,
  resetCircuitState,
  resetCircuit
} from '../lib/plugin-manager/circuit-breaker.mjs';

export { resetCircuit, resetCircuitState };

export const VERSION = '1.0.0';

export function detectLocale(electronApp = electron?.app) {
  if (electronApp && typeof electronApp.getLocale === 'function') {
    try {
      const loc = electronApp.getLocale();
      if (loc) return resolveLocale(loc);
    } catch {}
  }
  return resolveLocale(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || 'en');
}

export function getSafeModeViewModel(options = {}) {
  const locale = options.locale || detectLocale();
  return buildSafeModeViewModel({
    locale,
    ...options
  });
}

let electron = null;
try {
  electron = await import('electron');
} catch {
  // Running in standard Node.js test environment without Electron
}

const {
  app,
  BrowserWindow,
  shell,
  Menu,
  ipcMain,
  Tray,
  nativeImage,
  Notification
} = electron || {};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SAFE_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const CORE_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

export function isProhibitedPackage(name) {
  if (typeof name !== 'string') return true;
  const lower = name.toLowerCase();
  return lower.startsWith('@deepseek-ai/') || lower === 'dshmarket' || CORE_BUNDLES.has(lower);
}

export function assertTrustedSender(event) {
  const url = event?.senderFrame?.url;
  if (typeof url !== 'string') {
    throw new Error('Untrusted IPC sender: missing senderFrame URL');
  }
  if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
    return;
  }
  if (url.startsWith('file://')) {
    try {
      const filePath = path.resolve(fileURLToPath(url));
      const appDir = path.resolve(__dirname);
      const relative = path.relative(appDir, filePath);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        return;
      }
    } catch {}
  }
  throw new Error(`Untrusted IPC sender: ${url}`);
}

export function resolveDaemonBin() {
  const daemonCandidates = [
    '/usr/bin/dsh-desktop-daemon',
    '/usr/lib/dsh-desktop/bin/dsh-desktop-daemon',
    path.resolve(__dirname, '../../../lib/dsh-desktop/bin/dsh-desktop-daemon'),
    path.resolve(__dirname, '../../lib/dsh-desktop/bin/dsh-desktop-daemon')
  ];
  return daemonCandidates.find((p) => fs.existsSync(p)) ?? null;
}

if (app) {
  app.setName('DSH Desktop');
  if (process.platform === 'linux') {
    app.setAppUserModelId('dsh-desktop');
  }
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let isPolling = false;
let dshStatus = {
  active: false,
  detail: 'Checking...'
};

export function resolveImportPresetPath(argv = process.argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv.slice(1)) {
    if (typeof arg === 'string') {
      if (arg.startsWith('--import-preset=')) {
        return arg.slice('--import-preset='.length);
      }
    }
  }
  const idx = argv.indexOf('--import-preset');
  if (idx !== -1 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  return null;
}

export function resolveTargetUrl(argv = process.argv) {
  if (!Array.isArray(argv)) return process.env.DSH_URL || 'http://127.0.0.1:3080';
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url' && argv[i + 1]) {
      return argv[i + 1];
    }
    if (typeof arg === 'string') {
      if (arg.startsWith('--url=')) {
        return arg.slice(6);
      }
      if (arg.startsWith('http://') || arg.startsWith('https://')) {
        return arg;
      }
    }
  }
  return process.env.DSH_URL || 'http://127.0.0.1:3080';
}

const targetUrl = resolveTargetUrl();
const importPresetPath = resolveImportPresetPath();

export function resolveIconPath() {
  const candidates = [
    '/usr/share/icons/hicolor/128x128/apps/dsh-desktop.png',
    path.resolve(__dirname, '../../icons/hicolor/128x128/apps/dsh-desktop.png'),
    path.resolve(__dirname, '../icons/hicolor/128x128/apps/dsh-desktop.png'),
    path.resolve(__dirname, '../logo.svg')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

export function resolveTrayIconPath() {
  const candidates = [
    '/usr/share/dsh-desktop/tray-icon.png',
    path.resolve(__dirname, '../tray-icon.png'),
    '/usr/share/icons/hicolor/24x24/apps/dsh-desktop.png',
    path.resolve(__dirname, '../../icons/hicolor/24x24/apps/dsh-desktop.png'),
    resolveIconPath()
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return resolveIconPath();
}

export function resolvePatchPath() {
  const candidates = [
    '/usr/share/dsh-desktop/dsh-desktop.patch.yml',
    path.resolve(__dirname, '../dsh-desktop.patch.yml'),
    path.resolve(__dirname, '../../dsh-desktop.patch.yml')
  ];
  return candidates.find((c) => fs.existsSync(c));
}

export function buildDaemonArgs(options = {}) {
  const isSafeMode = options.safeMode ?? shouldStartInSafeMode(process.argv);
  const patchPath = options.patchPath ?? resolvePatchPath();
  const args = [];
  if (isSafeMode) {
    args.push('--profile', SAFE_MODE_PROFILE);
  } else if (patchPath && fs.existsSync(patchPath)) {
    args.push('--patch', patchPath);
  }
  return args;
}

export function checkServerReady(urlStr, callback) {
  try {
    const parsed = new URL(urlStr);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(urlStr, { timeout: 1500 }, (res) => {
      res.resume();
      callback(true);
    });
    req.on('error', () => callback(false));
    req.on('timeout', () => {
      req.destroy();
      callback(false);
    });
  } catch {
    callback(false);
  }
}

export function executeCommand(file, args = []) {
  let bin = file;
  let binArgs = args;
  if (!Array.isArray(args) || args.length === 0) {
    if (typeof file === 'string' && file.includes(' ')) {
      const parts = file.trim().split(/\s+/);
      bin = parts[0];
      binArgs = parts.slice(1);
    } else {
      binArgs = [];
    }
  }
  return new Promise((resolve) => {
    execFile(bin, binArgs, (error, stdout, stderr) => {
      resolve({
        error: error || null,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim()
      });
    });
  });
}

export async function checkDshStatus(options = {}) {
  const execCmd = options.executeCommand || executeCommand;
  const systemctlRes = await execCmd('systemctl', ['--user', 'is-active', 'dsh-desktop.service']);
  if (systemctlRes.stdout === 'active') {
    dshStatus = { active: true, detail: 'systemd service active' };
    return dshStatus;
  }

  const daemonBin = resolveDaemonBin();
  if (daemonBin === null) return { active: false, detail: 'offline' };
  const pgrepRes = await execCmd('pgrep', ['-f', daemonBin]);
  if (pgrepRes.stdout.length > 0) {
    dshStatus = { active: true, detail: 'daemon process active' };
    return dshStatus;
  }

  dshStatus = { active: false, detail: 'offline' };
  return dshStatus;
}

export async function stopDshBackend(options = {}) {
  const execCmd = options.executeCommand || executeCommand;
  const res = await execCmd('systemctl', ['--user', 'stop', 'dsh-desktop.service']);
  const isSystemdUnavailable = Boolean(
    res.error && (
      res.error.code === 'ENOENT' ||
      (typeof res.stderr === 'string' && (
        res.stderr.includes('Failed to connect to bus') ||
        res.stderr.includes('not been booted with systemd') ||
        res.stderr.includes('systemd not found')
      ))
    )
  );

  if (isSystemdUnavailable) {
    const daemonBin = resolveDaemonBin();
    if (daemonBin !== null) {
      await execCmd('pkill', ['-f', daemonBin]);
    }
  }
}

export async function restartDshBackend(options = {}) {
  const execCmd = options.executeCommand || executeCommand;
  const { stdout } = await execCmd('systemctl', ['--user', 'is-active', 'dsh-desktop.service']);
  if (stdout === 'active' || stdout === 'activating' || stdout === 'failed') {
    const restartRes = await execCmd('systemctl', ['--user', 'restart', 'dsh-desktop.service']);
    if (!restartRes.error) {
      return true;
    }
  }

  await stopDshBackend(options);
  await new Promise((resolve) => setTimeout(resolve, 600));

  const daemonBin = resolveDaemonBin();
  if (daemonBin === null) return false;

  if (daemonBin) {
    const isSafeMode = options.safeMode ?? shouldStartInSafeMode(process.argv);
    if (isSafeMode) {
      const ensureSafeModeProfileFn = options.ensureSafeModeProfile || ensureSafeModeProfile;
      await ensureSafeModeProfileFn(options.dshHome || defaultDshHome());
    }
    const daemonArgs = buildDaemonArgs(options);
    const logDir = path.join(process.env.HOME || '/tmp', '.local/share/dsh-desktop');
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch {}
    const logFile = path.join(logDir, 'dsh.log');
    let outFd;
    try {
      outFd = fs.openSync(logFile, 'a');
    } catch {
      outFd = 'ignore';
    }
    if (!fs.existsSync(daemonBin)) return false;
    const child = spawn(daemonBin, daemonArgs, {
      detached: true,
      stdio: ['ignore', outFd, outFd]
    });
    child.unref();
    child.once('error', (err) => {
      process.stderr.write(`dsh-desktop: failed to spawn daemon: ${err.message}\n`);
    });
    return true;
  }

  return false;
}

function loadRecoveryCandidatesSync(dshHome, profile = LIVE_PROFILE) {
  try {
    const dir = profileDirectory(dshHome, profile);
    const manifestPath = path.join(dir, 'package.json');
    if (!fs.existsSync(manifestPath)) return [];
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) || {};
    const roots = configuredProfilePlugins(manifest);
    const candidates = [];
    for (const name of roots) {
      const rootDir = path.join(dir, 'node_modules', name);
      let packageManifest = {};
      try {
        packageManifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) || {};
      } catch {}
      const patchRelative = packageManifest.dsh?.bundle?.patch;
      let bundlePatch = '';
      if (typeof patchRelative === 'string') {
        try {
          bundlePatch = fs.readFileSync(path.join(rootDir, patchRelative), 'utf8');
        } catch {}
      }
      const sources = {};
      const sourceFiles = [
        'cordis.patch.yml',
        'index.js',
        'lib/index.js',
        'dist/index.js',
        'client.js',
        'lib/client.js',
        'dist/client.js'
      ];
      for (const relative of sourceFiles) {
        try {
          const filePath = path.join(rootDir, relative);
          if (fs.existsSync(filePath)) {
            sources[relative] = fs.readFileSync(filePath, 'utf8');
          }
        } catch {}
      }
      candidates.push({
        name,
        directory: rootDir,
        version: typeof packageManifest.version === 'string' ? packageManifest.version : undefined,
        dependencies: packageManifest.dependencies ?? {},
        optionalDependencies: packageManifest.optionalDependencies ?? {},
        bundlePatch,
        sources
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

export function handleStartupFailureText(text, options = {}) {
  const failures = parsePluginStartupFailures(text);
  if (!failures || failures.length === 0) return null;
  const pluginNames = failures.map((f) => f.packageName).filter(Boolean);

  const home = options.dshHome || defaultDshHome();
  const profile = options.profile || LIVE_PROFILE;

  let candidates = options.candidates;
  if (!candidates) {
    candidates = loadRecoveryCandidatesSync(home, profile);
  }

  const configuredNames = new Set(candidates.map((c) => c.name));
  for (const f of failures) {
    if (f.packageName && !configuredNames.has(f.packageName)) {
      candidates.push({
        name: f.packageName,
        directory: path.join(profileDirectory(home, profile), 'node_modules', f.packageName),
        dependencies: {},
        optionalDependencies: {},
        bundlePatch: '',
        sources: {}
      });
      configuredNames.add(f.packageName);
    }
  }

  const logTail = options.logTail || (typeof text === 'string' ? text.trim().split(/\r?\n/) : []);
  const recoveryPlan = buildRecoveryPlan({
    candidates,
    startupFailures: failures,
    logs: logTail,
    checks: options.checks || []
  });

  const viewModel = buildRecoveryViewModel({
    locale: options.locale || detectLocale(),
    plugins: recoveryPlan.plugins.length > 0 ? recoveryPlan.plugins : pluginNames,
    structured: recoveryPlan.source === 'structured',
    rawError: failures.map((f) => `${f.packageName}: ${f.message}`).join('\n'),
    checks: options.checks || []
  });

  const planRemovals = recoveryPlan.plan?.removals?.length > 0
    ? recoveryPlan.plan.removals
    : [...viewModel.plugins];
  const planUpgrades = recoveryPlan.plan?.upgrades ?? [];

  viewModel.plan = {
    ...viewModel.plan,
    removals: planRemovals,
    upgrades: planUpgrades
  };
  viewModel.recoveryPlan = recoveryPlan;

  return viewModel;
}

export function checkRecentLogFailures() {
  const logDir = path.join(process.env.HOME || '/tmp', '.local/share/dsh-desktop');
  const logFile = path.join(logDir, 'dsh.log');
  if (!fs.existsSync(logFile)) return null;
  let fd = null;
  try {
    const stat = fs.statSync(logFile);
    const maxBytes = 64 * 1024;
    const length = Math.min(stat.size, maxBytes);
    const position = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(logFile, 'r');
    fs.readSync(fd, buffer, 0, length, position);
    const content = buffer.toString('utf8');
    const lines = content.trim().split('\n');
    const recent = lines.slice(-50).join('\n');
    return handleStartupFailureText(recent, { logTail: lines.slice(-50) });
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

export function loadRecoveryPage(options = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const locale = options.locale || detectLocale();
  const failureModel = options.failureModel || {
    locale,
    plugins: [],
    structured: false,
    rawError: options.rawError || 'Circuit breaker open: 3 startup failures detected within 60s.'
  };

  const onFailLoad = () => {
    if (!shouldStartInSafeMode(process.argv)) {
      relaunchSafeMode();
    }
  };

  if (mainWindow.webContents) {
    mainWindow.webContents.once('did-fail-load', onFailLoad);
  }

  const loadPromise = mainWindow.loadFile(path.join(__dirname, 'recovery.html'));
  if (loadPromise && typeof loadPromise.then === 'function') {
    loadPromise.then(() => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.removeListener('did-fail-load', onFailLoad);
        mainWindow.webContents.executeJavaScript(
          `window.__DSH_LOCALE__ = ${JSON.stringify(locale)}; if (typeof window.applyLocale === 'function') window.applyLocale(${JSON.stringify(locale)}); window.setRecoveryModel && window.setRecoveryModel(${JSON.stringify(failureModel)});`
        ).catch(() => {});
      }
    }).catch(() => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.removeListener('did-fail-load', onFailLoad);
      }
      onFailLoad();
    });
  }
}

export function pollAndLoad() {
  if (isPolling) return;
  isPolling = true;
  let attempts = 0;
  const maxAttempts = 30;

  function attemptPoll() {
    attempts++;
    checkServerReady(targetUrl, (ready) => {
      if (ready) {
        markReady();
        isPolling = false;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(targetUrl);
          if (importPresetPath) {
            mainWindow.webContents.once('did-finish-load', () => {
              triggerPresetImportPreview(mainWindow, importPresetPath);
            });
          }
        }
        checkDshStatus().then(() => updateTrayMenu());
      } else {
        if (isSystemCircuitOpen()) {
          isPolling = false;
          loadRecoveryPage();
          checkDshStatus().then(() => updateTrayMenu());
          return;
        }

        const failureModel = checkRecentLogFailures();
        if (failureModel) {
          isPolling = false;
          loadRecoveryPage({ failureModel });
          checkDshStatus().then(() => updateTrayMenu());
          return;
        }

        if (attempts < maxAttempts) {
          setTimeout(attemptPoll, 500);
        } else {
          isPolling = false;
          if (mainWindow && !mainWindow.isDestroyed()) {
            const locale = detectLocale();
            const timeoutMsg = translate(locale, 'connectionTimeout');
            mainWindow.webContents.executeJavaScript(
              `window.updateStatus && window.updateStatus(${JSON.stringify(timeoutMsg)}, true);`
            ).catch(() => {});
            if (importPresetPath) {
              showImportPresetMessage('Preset import flow is not ready (backend connection timed out).', mainWindow);
            }
          }
          checkDshStatus().then(() => updateTrayMenu());
        }
      }
    });
  }

  attemptPoll();
}

export function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    if (mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.focus();
    }
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
  updateTrayMenu();
}

export function restartDesktopApp() {
  isQuitting = true;
  if (app) {
    app.relaunch();
    app.exit(0);
  }
}

export async function restartDsh() {
  const locale = detectLocale();
  const t = (key) => translate(locale, key);
  if (Notification && Notification.isSupported()) {
    try {
      new Notification({
        title: 'DSH Desktop',
        body: t('restartingBackend')
      }).show();
    } catch {}
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, 'loading.html'));
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.executeJavaScript(
        `window.__DSH_LOCALE__ = ${JSON.stringify(locale)}; if (typeof window.applyLocale === 'function') window.applyLocale(${JSON.stringify(locale)});`
      ).catch(() => {});
    });
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
  }

  await restartDshBackend();
  await checkDshStatus();
  updateTrayMenu();
  pollAndLoad();
}

export async function restartBoth() {
  const locale = detectLocale();
  const t = (key) => translate(locale, key);
  if (Notification && Notification.isSupported()) {
    try {
      new Notification({
        title: 'DSH Desktop',
        body: t('restartingBoth')
      }).show();
    } catch {}
  }
  await restartDshBackend();
  restartDesktopApp();
}

export function quitDesktopApp() {
  isQuitting = true;
  if (app) app.quit();
}

export async function quitEverything() {
  isQuitting = true;
  await stopDshBackend();
  if (app) app.quit();
}

export function relaunchSafeMode(selection = []) {
  if (!app) return;
  const currentArgs = process.argv.slice(1).filter((arg) => arg !== '--safe-mode');
  currentArgs.push('--safe-mode');
  isQuitting = true;
  app.relaunch({ args: currentArgs });
  app.exit(0);
}

export function exitSafeMode() {
  if (!app) return;
  const currentArgs = process.argv.slice(1).filter((arg) => arg !== '--safe-mode');
  isQuitting = true;
  app.relaunch({ args: currentArgs });
  app.exit(0);
}

/**
 * Invariant 9 Runtime Stop Wrapper:
 * Guarantees that all package mutations execute strictly while the runtime daemon is stopped.
 */
export async function withDaemonStopped(action, context = {}) {
  const checker = context.checkStatus || checkDshStatus;
  const stopper = context.stopBackend || stopDshBackend;
  const restarter = context.restartBackend || restartDshBackend;

  const status = await checker();
  const wasRunning = status.active;
  if (wasRunning) {
    await stopper();
    const { waitForStop = true, stopTimeoutMs = 5000, stopPollMs = 100 } = context;
    if (waitForStop) {
      const deadline = Date.now() + stopTimeoutMs;
      let stopped = false;
      while (Date.now() < deadline) {
        const s = await checker();
        if (!s.active) {
          stopped = true;
          break;
        }
        await new Promise((r) => setTimeout(r, stopPollMs));
      }
      if (!stopped) {
        process.stderr.write('dsh-desktop: daemon did not stop within timeout; proceeding anyway\n');
      }
    }
  }
  let actionError = null;
  try {
    return await action();
  } catch (err) {
    actionError = err;
    throw err;
  } finally {
    if (wasRunning) {
      try {
        await restarter();
      } catch (restartErr) {
        process.stderr.write(`Failed to restart DSH backend: ${restartErr?.message || restartErr}\n`);
        if (!actionError) {
          throw restartErr;
        }
      }
    }
  }
}

export function registerIpcHandlers(ipc = ipcMain, supervisor = {}) {
  if (!ipc || typeof ipc.handle !== 'function') return;

  const restartDshFn = supervisor.restartDsh || restartDsh;
  const withStoppedFn = supervisor.withDaemonStopped || withDaemonStopped;
  const installMarketFn = supervisor.installMarketShared || installMarketShared;
  const uninstallMarketFn = supervisor.uninstallMarketShared || uninstallMarketShared;
  const uninstallPluginFn = supervisor.uninstallPlugin || uninstallPlugin;
  const upgradePluginFn = supervisor.upgradePlugin || upgradePlugin;
  const relaunchSafeModeFn = supervisor.relaunchSafeMode || relaunchSafeMode;
  const exitSafeModeFn = supervisor.exitSafeMode || exitSafeMode;
  const ensureSafeModeProfileFn = supervisor.ensureSafeModeProfile || ensureSafeModeProfile;
  const resolveDshEntryFn = supervisor.resolveDshEntry || resolveDshEntry;
  const nodeExecutablePath = supervisor.nodeExecutablePath || process.execPath;
  const recommendedVersion = supervisor.recommendedVersion || RECOMMENDED_MARKET_VERSION;
  const home = supervisor.dshHome || defaultDshHome();
  const resetCircuitFn = supervisor.resetCircuitState || resetCircuitState;

  ipc.handle('harness:restart', async (event) => {
    assertTrustedSender(event);
    return restartDshFn();
  });

  ipc.handle('market:install', async (event) => {
    assertTrustedSender(event);
    return withStoppedFn(async () => {
      let dshEntryPath;
      try {
        dshEntryPath = resolveDshEntryFn();
      } catch {}
      return installMarketFn({
        dshHome: home,
        profile: LIVE_PROFILE,
        recommendedVersion,
        dshEntryPath,
        nodeExecutablePath
      });
    }, supervisor);
  });

  ipc.handle('market:uninstall', async (event) => {
    assertTrustedSender(event);
    return withStoppedFn(async () => {
      let dshEntryPath;
      try {
        dshEntryPath = resolveDshEntryFn();
      } catch {}
      return uninstallMarketFn({
        dshHome: home,
        profile: LIVE_PROFILE,
        dshEntryPath,
        nodeExecutablePath
      });
    }, supervisor);
  });

  ipc.handle('recovery:action', async (event, action) => {
    assertTrustedSender(event);

    if (action === 'safe-mode') {
      return relaunchSafeModeFn();
    }
    if (action === 'retry') {
      await resetCircuitFn();
      return restartDshFn();
    }
    if (typeof action === 'string') {
      if (action.startsWith('uninstall:')) {
        const pkg = action.slice('uninstall:'.length);
        if (!SAFE_PACKAGE_NAME_PATTERN.test(pkg) || isProhibitedPackage(pkg)) {
          throw new Error(`Invalid or prohibited package: ${pkg}`);
        }
        return withStoppedFn(async () => {
          let dshEntryPath;
          try {
            dshEntryPath = resolveDshEntryFn();
          } catch {}
          return uninstallPluginFn({
            dshHome: home,
            packageName: pkg,
            profile: LIVE_PROFILE,
            dshEntryPath,
            nodeExecutablePath
          });
        }, supervisor);
      }

      if (action.startsWith('upgrade:')) {
        const spec = action.slice('upgrade:'.length);
        const atIdx = spec.lastIndexOf('@');
        const pkg = atIdx > 0 ? spec.slice(0, atIdx) : spec;
        const targetVersion = atIdx > 0 ? spec.slice(atIdx + 1) : undefined;
        if (!SAFE_PACKAGE_NAME_PATTERN.test(pkg) || isProhibitedPackage(pkg)) {
          throw new Error(`Invalid or prohibited package: ${pkg}`);
        }
        if (targetVersion !== undefined && !/^[a-z0-9._+-]+$/i.test(targetVersion)) {
          throw new Error(`Invalid or prohibited target version: ${targetVersion}`);
        }
        return withStoppedFn(async () => {
          let dshEntryPath;
          try {
            dshEntryPath = resolveDshEntryFn();
          } catch {}
          return upgradePluginFn({
            dshHome: home,
            pluginName: pkg,
            targetVersion,
            profile: LIVE_PROFILE,
            dshEntryPath,
            nodeExecutablePath,
            restartDaemon: restartDshFn
          });
        }, supervisor);
      }
    }

    throw new Error(`Invalid or prohibited recovery action: ${action}`);
  });

  ipc.handle('safe-mode:action', async (event, action, selection) => {
    assertTrustedSender(event);

    if (action !== 'launch' && action !== 'relaunch' && action !== 'exit') {
      throw new Error(`Invalid safe-mode action: ${action}`);
    }

    const safeSelection = (Array.isArray(selection) ? selection : (typeof selection === 'string' ? [selection] : []))
      .filter((pkg) => typeof pkg === 'string' && SAFE_PACKAGE_NAME_PATTERN.test(pkg))
      .slice(0, 64);

    if (action === 'launch' || action === 'relaunch') {
      if (action === 'launch') {
        await ensureSafeModeProfileFn(home);
      }
      return relaunchSafeModeFn(safeSelection);
    }
    if (action === 'exit') {
      return exitSafeModeFn();
    }
  });

  ipc.handle('safe-mode:model', async (event, options = {}) => {
    assertTrustedSender(event);
    return getSafeModeViewModel(options);
  });

  ipc.handle('preset:get-import-path', async (event) => {
    assertTrustedSender(event);
    return supervisor.importPresetPath !== undefined ? supervisor.importPresetPath : importPresetPath;
  });

  ipc.handle('preset:get-import-data', async (event, requestedPath) => {
    assertTrustedSender(event);
    if (!supervisor.importPresetPath) return null;
    if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath) || !requestedPath.endsWith('.dshpreset')) {
      return null;
    }
    const targetPath = supervisor.importPresetPath;
    try {
      const [targetReal, presetReal] = await Promise.all([
        fs.promises.realpath(targetPath),
        fs.promises.realpath(supervisor.importPresetPath)
      ]);
      if (targetReal !== presetReal) return null;
      const requestedReal = await fs.promises.realpath(requestedPath);
      if (requestedReal !== presetReal) return null;
      return await fs.promises.readFile(targetReal);
    } catch {
      return null;
    }
  });

  ipc.handle('preset:show-message', async (event, message) => {
    assertTrustedSender(event);
    if (typeof message === 'string') {
      showImportPresetMessage(message);
    }
    return { ok: true };
  });

  ipc.handle('update:available', async (event) => {
    assertTrustedSender(event);
    const update = supervisor.getAvailableUpdate ? supervisor.getAvailableUpdate() : getAvailableUpdate();
    if (!update) return { available: false };
    return {
      available: Boolean(update.available),
      version: update.version
    };
  });
}

export function showImportPresetMessage(message, win = mainWindow) {
  if (Notification && Notification.isSupported()) {
    try {
      new Notification({
        title: 'DSH Desktop - Agent Preset',
        body: message
      }).show();
    } catch {}
  }
  if (win && !win.isDestroyed() && win.webContents) {
    win.webContents.executeJavaScript(`
      (function() {
        const bannerId = 'dsh-preset-message-banner';
        const existing = document.getElementById(bannerId);
        if (existing) existing.remove();
        const banner = document.createElement('div');
        banner.id = bannerId;
        banner.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#1e293b;color:#f8fafc;padding:14px 20px;border-radius:8px;border:1px solid #38bdf8;box-shadow:0 8px 24px rgba(0,0,0,0.4);z-index:999999;font-family:sans-serif;max-width:360px;font-size:14px;';
        banner.innerHTML = '<div style="font-weight:600;margin-bottom:4px;color:#38bdf8;">Agent Preset</div><div>' + ${JSON.stringify(message)}.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>';
        document.body.appendChild(banner);
        setTimeout(() => banner.remove(), 7000);
      })();
    `).catch(() => {});
  }
}

export async function triggerPresetImportPreview(win = mainWindow, presetPath = importPresetPath) {
  if (!win || win.isDestroyed() || !presetPath) return;
  if (!fs.existsSync(presetPath)) {
    showImportPresetMessage(`Preset file not found: ${presetPath}`, win);
    return;
  }
  try {
    await win.webContents.executeJavaScript(`
      (async function() {
        window.__DSH_IMPORT_PRESET_PATH__ = ${JSON.stringify(presetPath)};
        if (typeof window.__dshHandlePresetImport === 'function') {
          return window.__dshHandlePresetImport(${JSON.stringify(presetPath)});
        }
        try {
          const data = await window.dshDesktop?.getImportPresetData?.(${JSON.stringify(presetPath)});
          if (!data) {
            window.dshDesktop?.showImportPresetMessage?.('Failed to read preset file');
            return;
          }
          const res = await fetch('/api/agent-preset.import', {
            method: 'POST',
            body: data
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            window.dshDesktop?.showImportPresetMessage?.(err.error || 'Preset import flow is not ready');
            return;
          }
          const preview = await res.json();
          window.dispatchEvent(new CustomEvent('dsh:preset-preview', { detail: preview }));
          if (typeof window.__dshShowPresetPreview === 'function') {
            window.__dshShowPresetPreview(preview);
          } else {
            const existing = document.getElementById('dsh-preset-import-preview-modal');
            if (existing) existing.remove();
            const modal = document.createElement('div');
            modal.id = 'dsh-preset-import-preview-modal';
            modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';
            const card = document.createElement('div');
            card.style.cssText = 'background:#1e293b;color:#f8fafc;padding:24px;border-radius:12px;max-width:480px;width:90%;box-shadow:0 12px 32px rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.1);display:flex;flex-direction:column;gap:12px;';
            const escape = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            card.innerHTML = \`
              <h2 style="margin:0;font-size:18px;font-weight:600;color:#f8fafc;">Agent Preset Import Preview</h2>
              <div style="font-size:14px;color:#94a3b8;">\${escape(preview.description || 'No description provided.')}</div>
              <div style="background:rgba(255,255,255,0.05);padding:12px;border-radius:8px;font-size:13px;display:flex;flex-direction:column;gap:6px;">
                <div><strong>Preset ID:</strong> \${escape(preview.agentPreset || preview.manifest?.id || 'Unknown')}</div>
                <div><strong>Name:</strong> \${escape(preview.name || preview.manifest?.name || 'Unnamed')}</div>
                <div><strong>Files:</strong> \${escape(preview.fileCount || 0)}</div>
                <div><strong>Size:</strong> \${Math.round((preview.totalSize || 0) / 1024)} KB</div>
                \${preview.conflict ? '<div style="color:#f87171;font-weight:500;">⚠ Conflict: a preset with this ID already exists.</div>' : ''}
              </div>
              <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:8px;">
                <button id="dsh-preset-preview-close" style="padding:6px 14px;border-radius:6px;background:#334155;color:#fff;border:none;cursor:pointer;font-size:13px;">Close</button>
              </div>
            \`;
            modal.appendChild(card);
            document.body.appendChild(modal);
            document.getElementById('dsh-preset-preview-close')?.addEventListener('click', () => modal.remove());
          }
        } catch (err) {
          window.dshDesktop?.showImportPresetMessage?.('Preset import flow is not ready: ' + (err.message || 'connection error'));
        }
      })();
    `);
  } catch {}
}

export function createWindow() {
  if (!BrowserWindow) return;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: 'DeepSeek Harness Desktop',
    icon: resolveIconPath(),
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('mailto:')) {
      if (shell) shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, navUrl) => {
    try {
      const parsedNav = new URL(navUrl);
      const parsedTarget = new URL(targetUrl);
      const isLoopback = parsedNav.hostname === '127.0.0.1' || parsedNav.hostname === 'localhost';
      const isSamePort = parsedNav.port === parsedTarget.port;

      if (!isLoopback || !isSamePort) {
        event.preventDefault();
        if (shell) shell.openExternal(navUrl);
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  const locale = detectLocale();
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(
      `window.__DSH_LOCALE__ = ${JSON.stringify(locale)}; if (typeof window.applyLocale === 'function') window.applyLocale(${JSON.stringify(locale)});`
    ).catch(() => {});
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      updateTrayMenu();
    }
  });

  mainWindow.on('show', () => updateTrayMenu());
  mainWindow.on('hide', () => updateTrayMenu());

  mainWindow.on('closed', () => {
    mainWindow = null;
    updateTrayMenu();
  });

  pollAndLoad();
  setupMenu();
}

export function runUpgradeHelper(options = {}) {
  const helperPath = options.helperPath || '/usr/lib/dsh-desktop/bin/dsh-desktop-upgrade-helper';
  const spawnFn = options.spawn || spawn;
  const appInstance = options.app || (typeof app !== 'undefined' ? app : null);

  const child = spawnFn('pkexec', [helperPath], { stdio: 'inherit' });
  if (child && typeof child.on === 'function') {
    child.on('close', (code) => {
      if (code === 0) {
        if (appInstance && typeof appInstance.relaunch === 'function' && typeof appInstance.exit === 'function') {
          appInstance.relaunch();
          appInstance.exit(0);
        }
      } else {
        console.error(`Upgrade helper failed with exit code ${code}`);
      }
    });
  }
  return child;
}

export function buildTrayMenuTemplate(options = {}) {
  const locale = options.locale || detectLocale();
  const t = (key) => translate(locale, key);
  const isWindowVisible = options.isWindowVisible ?? (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  const active = options.active ?? dshStatus.active;
  const statusText = active ? t('trayStatusRunning') : t('trayStatusOffline');
  const availableUpdate = options.availableUpdate ?? getAvailableUpdate();
  const upgradeHelper = options.runUpgradeHelper || runUpgradeHelper;
  const hasUpdate = availableUpdate && (availableUpdate.available ?? availableUpdate.hasUpdate);
  const updateVersion = availableUpdate?.version || (availableUpdate?.tag ? String(availableUpdate.tag).replace(/^v/, '') : '');
  const updateLabel = formatUpdateLabel(updateVersion);

  return [
    {
      label: t('trayDesktop'),
      enabled: false
    },
    {
      label: statusText,
      enabled: false
    },
    ...(hasUpdate ? [
      { type: 'separator' },
      {
        label: updateLabel,
        click: async () => {
          await upgradeHelper(options);
        }
      }
    ] : []),
    { type: 'separator' },
    {
      label: isWindowVisible ? t('trayHide') : t('trayOpen'),
      click: () => toggleWindow()
    },
    { type: 'separator' },
    {
      label: t('restartDshAction'),
      click: () => restartDsh()
    },
    {
      label: t('restartDesktopApp'),
      click: () => restartDesktopApp()
    },
    {
      label: t('restartBoth'),
      click: () => restartBoth()
    },
    { type: 'separator' },
    {
      label: t('quitDesktopApp'),
      click: () => quitDesktopApp()
    },
    {
      label: t('quitEverything'),
      click: () => quitEverything()
    }
  ];
}

export function updateTrayMenu() {
  if (!tray || !Menu) return;

  const locale = detectLocale();
  const t = (key) => translate(locale, key);

  const contextMenu = Menu.buildFromTemplate(buildTrayMenuTemplate({ locale }));

  tray.setContextMenu(contextMenu);
  const statusLabel = dshStatus.active ? t('trayRunning') : t('trayOffline');
  tray.setToolTip(formatMessage(locale, 'trayTooltip', { status: statusLabel }));
}

export function createTray() {
  if (!Tray || !nativeImage) return;
  const iconPath = resolveTrayIconPath();
  let icon;
  try {
    const raw = nativeImage.createFromPath(iconPath);
    icon = raw.isEmpty() ? iconPath : raw.resize({ width: 22, height: 22 });
  } catch {
    icon = iconPath;
  }

  tray = new Tray(icon);
  tray.setToolTip('DSH Desktop - DeepSeek Harness');

  tray.on('click', () => toggleWindow());
  tray.on('double-click', () => toggleWindow());

  updateTrayMenu();

  setInterval(async () => {
    await checkDshStatus();
    updateTrayMenu();
  }, 5000);
}

export function buildAppMenuTemplate(options = {}) {
  const locale = options.locale || detectLocale();
  const t = (key) => translate(locale, key);
  const availableUpdate = options.availableUpdate ?? getAvailableUpdate();
  const upgradeHelper = options.runUpgradeHelper || runUpgradeHelper;
  const shellOpener = options.shell || shell;
  const hasUpdate = availableUpdate && (availableUpdate.available ?? availableUpdate.hasUpdate);
  const updateVersion = availableUpdate?.version || (availableUpdate?.tag ? String(availableUpdate.tag).replace(/^v/, '') : '');
  const updateLabel = formatUpdateLabel(updateVersion);

  const helpSubmenu = [];
  if (hasUpdate) {
    helpSubmenu.push({
      label: updateLabel,
      click: async () => {
        await upgradeHelper(options);
      }
    });
    helpSubmenu.push({ type: 'separator' });
  }
  helpSubmenu.push(
    {
      label: t('menuDocumentation'),
      click: async () => {
        if (shellOpener) await shellOpener.openExternal('https://github.com/deepseek-ai/deepseek-harness');
      }
    },
    {
      label: t('menuWorkshop'),
      click: async () => {
        if (shellOpener) await shellOpener.openExternal('https://github.com/RidgeBridgeStudios/dsh-desktop-deb-workshop');
      }
    }
  );

  return [
    {
      label: t('menuFile'),
      submenu: [
        {
          label: t('menuReload'),
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow && mainWindow.webContents.reload()
        },
        {
          label: t('menuForceReload'),
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => mainWindow && mainWindow.webContents.reloadIgnoringCache()
        },
        { type: 'separator' },
        {
          label: t('restartDshAction'),
          click: () => restartDsh()
        },
        {
          label: t('restartDesktopApp'),
          click: () => restartDesktopApp()
        },
        {
          label: t('restartBoth'),
          click: () => restartBoth()
        },
        { type: 'separator' },
        {
          label: t('trayHide'),
          accelerator: 'CmdOrCtrl+W',
          click: () => mainWindow && mainWindow.hide()
        },
        {
          label: t('quitDesktopApp'),
          accelerator: 'CmdOrCtrl+Q',
          click: () => quitDesktopApp()
        },
        {
          label: t('quitEverything'),
          click: () => quitEverything()
        }
      ]
    },
    {
      label: t('menuEdit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: t('menuView'),
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: t('menuHelp'),
      submenu: helpSubmenu
    }
  ];
}

export function setupMenu() {
  if (!Menu) return;
  const menu = Menu.buildFromTemplate(buildAppMenuTemplate());
  Menu.setApplicationMenu(menu);
}

if (app) {
  app.whenReady().then(async () => {
    if (shouldStartInSafeMode(process.argv)) {
      await ensureSafeModeProfile(defaultDshHome());
    }
    registerIpcHandlers(ipcMain);
    await checkDshStatus();
    createWindow();
    createTray();

    checkForUpdates({ currentVersion: VERSION }).then((result) => {
      if (result?.available || result?.hasUpdate) {
        setAvailableUpdate(result);
        setupMenu();
        updateTrayMenu();
        if (tray && typeof tray.displayBalloon === 'function') {
          tray.displayBalloon({
            title: 'DSH Desktop',
            content: formatUpdateLabel(result.version || result.tag)
          });
        }
      }
    }).catch(() => {});

    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('window-all-closed', () => {
    if (isQuitting) {
      app.quit();
    }
  });
}

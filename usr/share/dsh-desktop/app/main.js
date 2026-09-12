// Main process for DSH Desktop Electron wrapper.
// Runs the DeepSeek Harness UI in a strictly sandboxed Chromium window
// with system tray icon support, DSH service management, and recovery supervisor.

import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { exec, spawn } from 'node:child_process';
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
  LIVE_PROFILE
} from '../lib/plugin-manager/paths.mjs';

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

export function resolveTargetUrl(argv = process.argv) {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('--url=')) {
      return arg.slice(6);
    }
    if (arg.startsWith('http://') || arg.startsWith('https://')) {
      return arg;
    }
  }
  return process.env.DSH_URL || 'http://127.0.0.1:3080';
}

const targetUrl = resolveTargetUrl();

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

export function executeCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (error, stdout, stderr) => {
      resolve({ error, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

export async function checkDshStatus() {
  const systemctlRes = await executeCommand('systemctl --user is-active dsh-desktop.service');
  if (systemctlRes.stdout === 'active') {
    dshStatus = { active: true, detail: 'systemd service active' };
    return dshStatus;
  }

  const pgrepRes = await executeCommand("pgrep -f '@deepseek-ai/dsh|dsh-desktop-daemon'");
  if (pgrepRes.stdout.length > 0) {
    dshStatus = { active: true, detail: 'daemon process active' };
    return dshStatus;
  }

  dshStatus = { active: false, detail: 'offline' };
  return dshStatus;
}

export async function stopDshBackend() {
  await executeCommand('systemctl --user stop dsh-desktop.service');
  await executeCommand("pkill -f '@deepseek-ai/dsh|dsh-desktop-daemon'");
}

export async function restartDshBackend(options = {}) {
  const { stdout } = await executeCommand('systemctl --user is-active dsh-desktop.service');
  if (stdout === 'active' || stdout === 'activating' || stdout === 'failed') {
    const restartRes = await executeCommand('systemctl --user restart dsh-desktop.service');
    if (!restartRes.error) {
      return true;
    }
  }

  await stopDshBackend();
  await new Promise((resolve) => setTimeout(resolve, 600));

  const daemonCandidates = [
    '/usr/local/bin/dsh-desktop-daemon',
    path.resolve(__dirname, '../../../usr/local/bin/dsh-desktop-daemon')
  ];
  const daemonBin = daemonCandidates.find((p) => fs.existsSync(p));

  if (daemonBin) {
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
    const child = spawn(daemonBin, daemonArgs, {
      detached: true,
      stdio: ['ignore', outFd, outFd]
    });
    child.unref();
    return true;
  }

  return false;
}

export function handleStartupFailureText(text) {
  const failures = parsePluginStartupFailures(text);
  if (!failures || failures.length === 0) return null;
  const pluginNames = failures.map((f) => f.packageName).filter(Boolean);
  return buildRecoveryViewModel({
    locale: 'en',
    plugins: pluginNames,
    structured: true,
    rawError: failures.map((f) => `${f.packageName}: ${f.message}`).join('\n')
  });
}

export function checkRecentLogFailures() {
  const logDir = path.join(process.env.HOME || '/tmp', '.local/share/dsh-desktop');
  const logFile = path.join(logDir, 'dsh.log');
  if (!fs.existsSync(logFile)) return null;
  try {
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n');
    const recent = lines.slice(-50).join('\n');
    return handleStartupFailureText(recent);
  } catch {
    return null;
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
        isPolling = false;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(targetUrl);
        }
        checkDshStatus().then(() => updateTrayMenu());
      } else {
        const failureModel = checkRecentLogFailures();
        if (failureModel) {
          isPolling = false;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadFile(path.join(__dirname, 'recovery.html'));
            mainWindow.webContents.once('did-finish-load', () => {
              mainWindow.webContents.executeJavaScript(
                `window.setRecoveryModel && window.setRecoveryModel(${JSON.stringify(failureModel)});`
              ).catch(() => {});
            });
          }
          checkDshStatus().then(() => updateTrayMenu());
          return;
        }

        if (attempts < maxAttempts) {
          setTimeout(attemptPoll, 500);
        } else {
          isPolling = false;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.executeJavaScript(
              `window.updateStatus && window.updateStatus("Failed to connect to DeepSeek Harness daemon after 15s. Ensure 'dsh-desktop-daemon' is running.", true);`
            ).catch(() => {});
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
  if (Notification && Notification.isSupported()) {
    try {
      new Notification({
        title: 'DSH Desktop',
        body: 'Restarting DeepSeek Harness backend...'
      }).show();
    } catch {}
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, 'loading.html'));
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
  if (Notification && Notification.isSupported()) {
    try {
      new Notification({
        title: 'DSH Desktop',
        body: 'Restarting DeepSeek Harness & Desktop App...'
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
  }
  try {
    return await action();
  } finally {
    if (wasRunning) {
      await restarter();
    }
  }
}

export function registerIpcHandlers(ipc = ipcMain, supervisor = {}) {
  if (!ipc || typeof ipc.handle !== 'function') return;

  const restartDshFn = supervisor.restartDsh || restartDsh;
  const withStoppedFn = supervisor.withDaemonStopped || withDaemonStopped;
  const installMarketFn = supervisor.installMarketShared || installMarketShared;
  const uninstallMarketFn = supervisor.uninstallMarketShared || uninstallMarketShared;
  const relaunchSafeModeFn = supervisor.relaunchSafeMode || relaunchSafeMode;
  const exitSafeModeFn = supervisor.exitSafeMode || exitSafeMode;
  const resolveDshEntryFn = supervisor.resolveDshEntry || resolveDshEntry;
  const nodeExecutablePath = supervisor.nodeExecutablePath || process.execPath;
  const recommendedVersion = supervisor.recommendedVersion || RECOMMENDED_MARKET_VERSION;
  const home = supervisor.dshHome || defaultDshHome();

  ipc.handle('harness:restart', async () => {
    return restartDshFn();
  });

  ipc.handle('market:install', async (event, options = {}) => {
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
        nodeExecutablePath,
        ...options
      });
    }, supervisor);
  });

  ipc.handle('market:uninstall', async (event, options = {}) => {
    return withStoppedFn(async () => {
      let dshEntryPath;
      try {
        dshEntryPath = resolveDshEntryFn();
      } catch {}
      return uninstallMarketFn({
        dshHome: home,
        profile: LIVE_PROFILE,
        dshEntryPath,
        nodeExecutablePath,
        ...options
      });
    }, supervisor);
  });

  ipc.handle('recovery:action', async (event, action) => {
    if (action === 'safe-mode') {
      return relaunchSafeModeFn();
    }
    if (action === 'retry') {
      return restartDshFn();
    }
    if (typeof action === 'string' && action.startsWith('uninstall:')) {
      const pkg = action.slice('uninstall:'.length);
      return withStoppedFn(async () => {
        const { uninstallPlugin } = await import('../lib/plugin-manager/plugin-removal.mjs');
        return uninstallPlugin({ dshHome: home, packageName: pkg });
      }, supervisor);
    }
    if (typeof action === 'string' && action.startsWith('upgrade:')) {
      const pkg = action.slice('upgrade:'.length);
      return withStoppedFn(async () => {
        const { upgradePlugin } = await import('../lib/plugin-manager/plugin-upgrade.mjs');
        return upgradePlugin({ dshHome: home, packageName: pkg });
      }, supervisor);
    }
    return { error: 'Unknown recovery action' };
  });

  ipc.handle('safe-mode:action', async (event, action, selection) => {
    if (action === 'launch' || action === 'relaunch') {
      return relaunchSafeModeFn(selection);
    }
    if (action === 'exit') {
      return exitSafeModeFn();
    }
    return { ok: true };
  });
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

export function updateTrayMenu() {
  if (!tray || !Menu) return;

  const isWindowVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  const statusText = dshStatus.active ? '● DSH Status: Running' : '○ DSH Status: Offline';

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'DSH Desktop',
      enabled: false
    },
    {
      label: statusText,
      enabled: false
    },
    { type: 'separator' },
    {
      label: isWindowVisible ? 'Hide to System Tray' : 'Open DSH Desktop',
      click: () => toggleWindow()
    },
    { type: 'separator' },
    {
      label: 'Restart DeepSeek Harness (DSH)',
      click: () => restartDsh()
    },
    {
      label: 'Restart Desktop App',
      click: () => restartDesktopApp()
    },
    {
      label: 'Restart Both (Desktop & DSH)',
      click: () => restartBoth()
    },
    { type: 'separator' },
    {
      label: 'Quit Desktop App',
      click: () => quitDesktopApp()
    },
    {
      label: 'Quit Everything (Desktop & DSH)',
      click: () => quitEverything()
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip(`DSH Desktop (${dshStatus.active ? 'Running' : 'Offline'})`);
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

export function setupMenu() {
  if (!Menu) return;
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow && mainWindow.webContents.reload()
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => mainWindow && mainWindow.webContents.reloadIgnoringCache()
        },
        { type: 'separator' },
        {
          label: 'Restart DeepSeek Harness (DSH)',
          click: () => restartDsh()
        },
        {
          label: 'Restart Desktop App',
          click: () => restartDesktopApp()
        },
        {
          label: 'Restart Both (Desktop & DSH)',
          click: () => restartBoth()
        },
        { type: 'separator' },
        {
          label: 'Hide to System Tray',
          accelerator: 'CmdOrCtrl+W',
          click: () => mainWindow && mainWindow.hide()
        },
        {
          label: 'Quit Desktop App',
          accelerator: 'CmdOrCtrl+Q',
          click: () => quitDesktopApp()
        },
        {
          label: 'Quit Everything (Desktop & DSH)',
          click: () => quitEverything()
        }
      ]
    },
    {
      label: 'Edit',
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
      label: 'View',
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
      label: 'Help',
      submenu: [
        {
          label: 'DeepSeek Harness Documentation',
          click: async () => {
            if (shell) await shell.openExternal('https://github.com/deepseek-ai/deepseek-harness');
          }
        },
        {
          label: 'DSH Desktop Workshop',
          click: async () => {
            if (shell) await shell.openExternal('https://github.com/RidgeBridgeStudios/dsh-desktop-deb-workshop');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

if (app) {
  app.whenReady().then(async () => {
    registerIpcHandlers(ipcMain);
    await checkDshStatus();
    createWindow();
    createTray();

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

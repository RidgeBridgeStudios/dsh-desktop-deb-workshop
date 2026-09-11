// Main process for DSH Desktop Electron wrapper.
// Runs the DeepSeek Harness UI in a strictly sandboxed Chromium window
// with system tray icon support and DSH service management.

import { app, BrowserWindow, shell, Menu, ipcMain, Tray, nativeImage, Notification } from 'electron';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { exec, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure proper app identity
app.setName('DSH Desktop');
if (process.platform === 'linux') {
  app.setAppUserModelId('dsh-desktop');
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let isPolling = false;
let dshStatus = {
  active: false,
  detail: 'Checking...'
};

// Parse target URL from arguments or environment
function resolveTargetUrl() {
  for (const arg of process.argv.slice(1)) {
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

// Find best app window icon
function resolveIconPath() {
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

// Find best tray icon
function resolveTrayIconPath() {
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

// Check whether local server is reachable
function checkServerReady(urlStr, callback) {
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

// Helper to execute shell commands as promises
function executeCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (error, stdout, stderr) => {
      resolve({ error, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

// Query whether DSH backend service or process is currently active
async function checkDshStatus() {
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

// Restart DSH backend service or fallback process
async function restartDshBackend() {
  const { stdout } = await executeCommand('systemctl --user is-active dsh-desktop.service');
  if (stdout === 'active' || stdout === 'activating' || stdout === 'failed') {
    const restartRes = await executeCommand('systemctl --user restart dsh-desktop.service');
    if (!restartRes.error) {
      return true;
    }
  }

  // Fallback: kill existing process and launch daemon
  await executeCommand("pkill -f '@deepseek-ai/dsh|dsh-desktop-daemon'");
  await new Promise((resolve) => setTimeout(resolve, 600));

  const daemonCandidates = [
    '/usr/local/bin/dsh-desktop-daemon',
    path.resolve(__dirname, '../../../usr/local/bin/dsh-desktop-daemon')
  ];
  const daemonBin = daemonCandidates.find((p) => fs.existsSync(p));

  if (daemonBin) {
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
    const child = spawn(daemonBin, [], {
      detached: true,
      stdio: ['ignore', outFd, outFd]
    });
    child.unref();
    return true;
  }

  return false;
}

// Stop DSH backend service or fallback process
async function stopDshBackend() {
  await executeCommand('systemctl --user stop dsh-desktop.service');
  await executeCommand("pkill -f '@deepseek-ai/dsh|dsh-desktop-daemon'");
}

// Poll server readiness then navigate to target URL
function pollAndLoad() {
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
      } else if (attempts < maxAttempts) {
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
    });
  }

  attemptPoll();
}

// Toggle window visibility (bring to focus if backgrounded or restore if hidden)
function toggleWindow() {
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

// Restart Electron desktop application
function restartDesktopApp() {
  isQuitting = true;
  app.relaunch();
  app.exit(0);
}

// Restart DeepSeek Harness backend and reconnect UI
async function restartDsh() {
  if (Notification.isSupported()) {
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

// Restart both backend DSH and desktop application
async function restartBoth() {
  if (Notification.isSupported()) {
    try {
      new Notification({
        title: 'DSH Desktop',
        body: 'Restarting DeepSeek Harness & Desktop App...'
      }).show();
    } catch {}
  }
  await restartDshBackend();
  isQuitting = true;
  app.relaunch();
  app.exit(0);
}

// Quit desktop application only
function quitDesktopApp() {
  isQuitting = true;
  app.quit();
}

// Quit both desktop application and underlying DSH backend
async function quitEverything() {
  isQuitting = true;
  await stopDshBackend();
  app.quit();
}

function createWindow() {
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
      // 1. Mandatory security sandbox isolation
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // 2. Intercept new windows (target="_blank", window.open) and open in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('mailto:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 3. Prevent in-app navigation to non-loopback URLs
  mainWindow.webContents.on('will-navigate', (event, navUrl) => {
    try {
      const parsedNav = new URL(navUrl);
      const parsedTarget = new URL(targetUrl);
      const isLoopback = parsedNav.hostname === '127.0.0.1' || parsedNav.hostname === 'localhost';
      const isSamePort = parsedNav.port === parsedTarget.port;

      if (!isLoopback || !isSamePort) {
        event.preventDefault();
        shell.openExternal(navUrl);
      }
    } catch {
      event.preventDefault();
    }
  });

  // Load loading splash screen first
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Intercept window close to hide to tray rather than exiting
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

function updateTrayMenu() {
  if (!tray) return;

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

function createTray() {
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

  // Periodically refresh tray status
  setInterval(async () => {
    await checkDshStatus();
    updateTrayMenu();
  }, 5000);
}

function setupMenu() {
  const isMac = process.platform === 'darwin';
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
            await shell.openExternal('https://github.com/deepseek-ai/deepseek-harness');
          }
        },
        {
          label: 'DSH Desktop Workshop',
          click: async () => {
            await shell.openExternal('https://github.com/businessgaberino-commits/dsh-desktop-deb-workshop');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(async () => {
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
  // Keep app running in tray unless explicit quit is triggered
  if (isQuitting) {
    app.quit();
  }
});

// Main process for DSH Desktop Electron wrapper.
// Runs the DeepSeek Harness UI in a strictly sandboxed Chromium window.

import { app, BrowserWindow, shell, Menu, ipcMain } from 'electron';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure proper app identity
app.setName('DSH Desktop');
if (process.platform === 'linux') {
  app.setAppUserModelId('dsh-desktop');
}

let mainWindow = null;

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

// Find best app icon
function resolveIconPath() {
  const systemIcon = '/usr/share/icons/hicolor/128x128/apps/dsh-desktop.png';
  const localIcon = path.join(__dirname, '../icons/hicolor/128x128/apps/dsh-desktop.png');
  return path.resolve(localIcon);
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

  // Poll server readiness then navigate to target URL
  let attempts = 0;
  const maxAttempts = 30;

  function pollAndLoad() {
    attempts++;
    checkServerReady(targetUrl, (ready) => {
      if (ready) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(targetUrl);
        }
      } else if (attempts < maxAttempts) {
        setTimeout(pollAndLoad, 500);
      } else {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.executeJavaScript(
            `window.updateStatus && window.updateStatus("Failed to connect to DeepSeek Harness daemon after 15s. Ensure 'dsh-desktop-daemon' is running.", true);`
          ).catch(() => {});
        }
      }
    });
  }

  pollAndLoad();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  setupMenu();
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
        isMac ? { role: 'close' } : { role: 'quit' }
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

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

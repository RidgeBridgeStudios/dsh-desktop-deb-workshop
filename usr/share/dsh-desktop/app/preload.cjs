// Preload script for DSH Desktop Electron wrapper.
// Strictly sandboxed: sandbox: true, contextIsolation: true, nodeIntegration: false.

function registerPreloadBridges(bridge, ipc, target = (typeof window !== 'undefined' ? window : null)) {
  if (bridge && typeof bridge.exposeInMainWorld === 'function') {
    bridge.exposeInMainWorld('dshDesktop', {
      restartHarness: () => ipc?.invoke('harness:restart'),
      uninstallMarket: () => ipc?.invoke('market:uninstall'),
      installMarket: () => ipc?.invoke('market:install'),
      getImportPresetPath: () => ipc?.invoke('preset:get-import-path'),
      getImportPresetData: (presetPath) => ipc?.invoke('preset:get-import-data', presetPath),
      showImportPresetMessage: (msg) => ipc?.invoke('preset:show-message', msg),
      updateAvailable: () => ipc?.invoke('update:available')
    });

    bridge.exposeInMainWorld('dshRecovery', {
      action: (action) => ipc?.invoke('recovery:action', action)
    });

    bridge.exposeInMainWorld('dshSafeMode', {
      action: (action, selection) => ipc?.invoke('safe-mode:action', action, selection)
    });
  }

  if (target) {
    try {
      target.__DSH_DESKTOP__ = true;
    } catch {
      // Ignore strict mode freezes
    }
  }
}

// When loaded inside Electron renderer preload context
if (typeof require === 'function') {
  try {
    const { contextBridge, ipcRenderer } = require('electron');
    if (contextBridge && ipcRenderer) {
      registerPreloadBridges(contextBridge, ipcRenderer);
    }
  } catch {
    // Non-Electron execution (e.g. testing)
  }
}

module.exports = {
  registerPreloadBridges
};

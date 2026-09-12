// Preload script for DSH Desktop Electron wrapper.
// Strictly sandboxed: sandbox: true, contextIsolation: true, nodeIntegration: false.

export function registerPreloadBridges(bridge, ipc, target = (typeof window !== 'undefined' ? window : null)) {
  if (bridge && typeof bridge.exposeInMainWorld === 'function') {
    bridge.exposeInMainWorld('dshDesktop', {
      restartHarness: () => ipc?.invoke('harness:restart'),
      uninstallMarket: () => ipc?.invoke('market:uninstall'),
      installMarket: () => ipc?.invoke('market:install')
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
try {
  const electron = await import('electron');
  if (electron?.contextBridge && electron?.ipcRenderer) {
    registerPreloadBridges(electron.contextBridge, electron.ipcRenderer);
  }
} catch {
  // Non-Electron execution (e.g. testing)
}

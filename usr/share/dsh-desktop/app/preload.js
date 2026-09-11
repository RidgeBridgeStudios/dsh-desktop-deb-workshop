// Preload script for DSH Desktop Electron wrapper.
// Strictly sandboxed: sandbox: true, contextIsolation: true, nodeIntegration: false.

window.addEventListener('DOMContentLoaded', () => {
  // Flag indicating running inside DSH Desktop wrapper
  try {
    window.__DSH_DESKTOP__ = true;
  } catch {
    // Ignore any strict mode freezes
  }
});

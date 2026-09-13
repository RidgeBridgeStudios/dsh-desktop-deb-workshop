# Context Index

## Modules
| Path | Purpose | Key exports | Depends on |
| --- | --- | --- | --- |
| `usr/share/dsh-desktop/lib/plugin-manager/registry.mjs` | Plugin generation lifecycle, locking & staging | `install()`, `promote()`, `sweepRegistry()`, `disableGeneration()` | `paths.mjs`, `pnpm-runner.mjs` |
| `usr/share/dsh-desktop/lib/plugin-manager/projection.mjs` | Reconciles active profile symlinks & bundles | `moduleLink()`, `readProfile()`, `writeProfile()`, `resolveEnabledGenerations()` | `paths.mjs`, `market-constants.mjs` |
| `usr/share/dsh-desktop/lib/plugin-manager/recovery.mjs` | Crash diagnosis, batch recovery planning & repairs | `buildRecoveryPlan()`, `applyRecoveryPlan()` | `registry.mjs`, `projection.mjs`, `startup-failure.mjs` |
| `usr/share/dsh-desktop/lib/plugin-manager/safe-mode.mjs` | Isolated safe-mode profile bootstrap & server | `ensureSafeModeProfile()`, `shouldStartInSafeMode()`, `buildSafeModeViewModel()` | `paths.mjs`, `recovery-view.mjs` |
| `usr/share/dsh-desktop/lib/plugin-manager/preset-routes.mjs` | Preset archive HTTP endpoints (export / import / preview) | `handlePresetExport()`, `handlePresetImportInstall()`, `handlePresetPreview()` | `preset-archive.mjs`, `paths.mjs` |
| `usr/share/dsh-desktop/lib/plugin-manager/preset-archive.mjs` | Archive validation, path sanitization & compression | `createPresetArchive()`, `inspectPresetArchive()`, `extractPresetArchive()` | `fflate` |
| `usr/share/dsh-desktop/lib/plugin-manager/pnpm-runner.mjs` | Sandboxed execution of vendored pnpm binary | `runPnpm()`, `buildPnpmEnvironment()`, `resolvePnpmEntry()` | `paths.mjs` |
| `usr/share/dsh-desktop/lib/plugin-manager/paths.mjs` | DSH filesystem path calculation & directory layouts | `dshHome()`, `profileDirectory()`, `registryLayout()`, `LIVE_PROFILE` | Node.js `node:path`, `node:os` |
| `usr/share/dsh-desktop/lib/plugin-manager/startup-failure.mjs` | Log parsing, failure classification & provenance | `parsePluginStartupFailures()`, `reportPluginStartupFailure()`, `formatPluginStartupFailure()` | `paths.mjs` |
| `usr/share/dsh-desktop/app/main.js` | Electron desktop window, system tray & status poller | Electron app bootstrap, `createWindow()`, `createTray()`, `checkServerReady()` | `preload.js`, Electron framework |
| `usr/share/dsh-desktop/packages/dsh-desktop-market-installer/index.js` | Marketplace installation proxy service | `createMarketService()`, HTTP route handlers | `registry.mjs`, `installer.mjs` |

## Entry points
- `usr/lib/dsh-desktop/bin/dsh-desktop`: User desktop GUI launcher (Wayland/X11 detection, Electron launch wrapper).
- `usr/lib/dsh-desktop/bin/dsh-desktop-daemon`: Background harness service supervisor (launches Node with `--expose-internals`).
- `usr/share/dsh-desktop/app/main.js`: Electron desktop application entry point.
- `usr/share/dsh-desktop/lib/plugin-manager/registry.mjs`: Plugin generation lifecycle & package installation core.
- `build.sh`: Debian package compilation and staging entry point.

## Data flow
- **App Startup**: `dsh-desktop` starts daemon/service → Electron `main.js` launches → polls harness port until healthy → transitions splash to web UI or recovery screen.
- **Plugin Installation**: Market client requests install → `installer.mjs` stages archive → `registry.mjs` isolates into generation slot → `projection.mjs` updates symlinks and bundle list.
- **Preset Import/Export**: Client posts/gets archive → `preset-routes.mjs` verifies loopback origin → `preset-archive.mjs` validates entries via fflate → writes to profile presets.
- **Safe Mode Fallback**: Daemon fails to start → `startup-failure.mjs` detects failure logs → `main.js` triggers `safe-mode.mjs` with isolated core profile → user repairs via `recovery.html`.

## Risky areas
- `usr/share/dsh-desktop/lib/plugin-manager/projection.mjs`: Mutates live symlinks and package manifests in user profile (`~/.dsh`); atomic writes and rollbacks must be maintained.
- `usr/share/dsh-desktop/lib/plugin-manager/pnpm-runner.mjs`: Manages child processes, process trees, and timeouts; failure to kill subtrees can leak node/pnpm processes.
- `usr/share/dsh-desktop/lib/plugin-manager/preset-archive.mjs`: Unzips user archives; path traversal (`..`), absolute paths, and zip bomb limits (`MAX_FILE_BYTES`, `MAX_FILES`) must never be bypassed.
- `build.sh` & `debian/postinst`: System permission management and Debian packaging; changing staging paths or ownership affects target system security.

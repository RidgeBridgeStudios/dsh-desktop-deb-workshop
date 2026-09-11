# DSH Desktop (`dsh-desktop`)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Ubuntu%20%7C%20Zorin%20OS-E95420.svg)](#requirements)
[![Architecture](https://img.shields.io/badge/Architecture-amd64-green.svg)](#requirements)

A native Debian package (`.deb`) providing a standalone desktop workspace experience for the **DeepSeek Harness** (`@deepseek-ai/dsh`) on **Ubuntu 22.04+** and **Zorin OS 17+**.

Runs the official DeepSeek Harness local web UI in an isolated desktop application window with systemd user session lifecycle management, automated sharp native binary linking, and profile initialization — with **no snap**, **no Flatpak**, and **no manual dependency troubleshooting**.

---

## The 5 Problems This Package Solves

The upstream `dataelement/dsh-desktop` repository does not ship official Linux binaries and relies on the local `@deepseek-ai/dsh` web service. Users attempting manual setups frequently hit five blocking obstacles that this package completely automates:

1. **Node.js Version Requirement (`>= 20.12`)**:
   `@deepseek-ai/dsh@0.1.5-rc.1` utilizes `parseEnv` from `node:util`, requiring at least Node.js 20.12. This package enforces Node 22 LTS, checks runtime versions, and provides clear upgrade instructions.
2. **The `--expose-internals` Flag**:
   The built-in `@deepseek-ai/cordis-plugin-hmr` requires Node to be launched with `--expose-internals`. Node.js **explicitly rejects** `--expose-internals` when set inside `NODE_OPTIONS` for security reasons. `dsh-desktop` and its daemon pass `--expose-internals` directly as a CLI argument to the `node` executable before the script path, completely avoiding startup crashes.
3. **Missing `pnpm` Runtime**:
   The harness profile loader dynamically shells out to `pnpm`. The package declares `pnpm` as a package dependency and verifies its presence at runtime.
4. **Native `sharp` Binaries**:
   Running `npm install` directly inside the `@deepseek-ai/dsh` directory triggers HTTP 404 errors due to the unreleased private `@deepseek-ai/dsh-experimental-code-runtime-python` dependency. Instead, `dsh-desktop` installs `@img/sharp-linux-x64` globally and links the prebuilt binaries directly into the DSH node modules tree.
5. **Profile Initialization Race Condition (`ERR_PNPM_PACKAGE_JSON_EXISTS`)**:
   Fresh installations lack `~/.dsh/profiles/default`. `dsh-desktop` writes a valid minimal `package.json` first, and then executes `pnpm install --silent` as the regular invoking user, preventing initialization races and permission mismatches.

---

## Installation

### One-Line Automated Installer

Run the following command in your terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/businessgaberino-commits/dsh-desktop-deb-workshop/main/install.sh | bash
```

The installer will:
1. Detect your Ubuntu / Zorin OS environment.
2. Install or upgrade Node.js to Node 22 LTS via NodeSource if needed.
3. Install `pnpm`, `@deepseek-ai/dsh@latest`, and prebuilt native `sharp` binaries globally.
4. Download and install the latest `dsh-desktop` Debian package.

---

### Manual Package Installation

If you prefer building or installing manually:

1. **Install Prerequisites**:
   ```bash
   # Add NodeSource Node 22 LTS (if Node < 20.12)
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs jq curl ca-certificates procps iproute2

   # Install global dependencies
   sudo npm install -g pnpm @deepseek-ai/dsh@latest
   sudo npm install -g --os=linux --cpu=x64 sharp @img/sharp-linux-x64
   ```

2. **Install `.deb` Package**:
   ```bash
   sudo apt install ./dsh-desktop_1.0.0_amd64.deb
   ```

---

## Launching DSH Desktop

- **Application Menu**: Search for **DSH Desktop** in your desktop application launcher (GNOME, Zorin Menu, etc.) and click to launch.
- **Command Line**:
  ```bash
  dsh-desktop
  ```

### Sandboxed Electron Wrapper
DSH Desktop ships with a dedicated Electron desktop wrapper located in `/usr/share/dsh-desktop/app`:
- **Chromium Sandboxing (`sandbox: true`)**: The DeepSeek web UI renders inside a fully sandboxed Chromium process with no direct access to Node.js or the local file system.
- **Context Isolation (`contextIsolation: true`)**: Web content scripts cannot tamper with Electron internals.
- **Navigation Protection**: External links (`http`, `https`, `mailto`) are strictly intercepted and opened in your default system browser via `shell.openExternal`.
- **Seamless Loading**: Includes a dark-mode splash screen (`loading.html`) that monitors the local DSH daemon and transitions automatically upon readiness.
- **Browser Fallback**: If the `electron` binary is not present on the host, `dsh-desktop` automatically falls back to standalone browser application window mode (`--app="$URL" --class="dsh-desktop"`) via Brave, Chrome, Chromium, or `xdg-open`.

---

## Why `--expose-internals` Cannot Use `NODE_OPTIONS`

The `@deepseek-ai/cordis-plugin-hmr` plugin hooks into Node internal loaders, requiring the `--expose-internals` flag. A common mistake is attempting to configure this via environment variables like `Environment="NODE_OPTIONS=--expose-internals"` in the systemd service or wrapper scripts.

Node.js intentionally disallows `--expose-internals` in `NODE_OPTIONS` for security reasons and immediately aborts execution with:
```
node: --expose-internals is not allowed in NODE_OPTIONS
```
Therefore, `dsh-desktop` and `dsh-desktop-daemon` strictly invoke Node with the flag directly on the command line:
```bash
exec /usr/bin/node --expose-internals "$DSH_ENTRY" --profile default
```
Never attempt to reintroduce `NODE_OPTIONS` for this flag.

---

## Building from Source

To compile the `.deb` package yourself:

```bash
git clone https://github.com/businessgaberino-commits/dsh-desktop-deb-workshop.git
cd dsh-desktop-deb-workshop
./build.sh
```

The compiled package `dsh-desktop_1.0.0_amd64.deb` will be output in the project root alongside its SHA256 checksum.

---

## Troubleshooting

### Inspect Service Status
Check the status of the user-level systemd service:
```bash
systemctl --user status dsh-desktop.service
```

### View Live Logs
View daemon and harness output:
```bash
tail -f ~/.local/share/dsh-desktop/dsh.log
```
Or view systemd journal output:
```bash
journalctl --user -u dsh-desktop.service -f
```

### Restart Service
```bash
systemctl --user restart dsh-desktop.service
```

---

## Uninstallation

To remove `dsh-desktop`:

```bash
sudo apt remove dsh-desktop
```

> [!NOTE]
> The uninstallation script gracefully disables and stops the systemd user service and updates your desktop menu database. Your user profiles, sessions, and chat history located in `~/.dsh/` are intentionally preserved.

---

## License

This project is licensed under the [MIT License](LICENSE).

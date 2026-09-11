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
   The harness profile loader dynamically shells out to `pnpm`. The installer and package verify its presence at runtime and install it via `npm` (since `pnpm` is an npm-distributed binary rather than a distro APT package).
4. **Native `sharp` Binaries**:
   Running `npm install` directly inside the `@deepseek-ai/dsh` directory triggers HTTP 404 errors due to the unreleased private `@deepseek-ai/dsh-experimental-code-runtime-python` dependency. Instead, `dsh-desktop` installs `@img/sharp-linux-x64` globally and links the prebuilt binaries directly into the DSH node modules tree.
5. **Profile Initialization Race Condition (`ERR_PNPM_PACKAGE_JSON_EXISTS`)**:
   Fresh installations lack `~/.dsh/profiles/default`. `dsh-desktop` writes a valid minimal `package.json` first, and then executes `pnpm install --silent` as the regular invoking user, preventing initialization races and permission mismatches.

---

## 🐣 Install Guide for Dummies (Simple Step-by-Step)

If you're not a Linux developer or terminal wizard, **don't worry!** Follow these 3 easy steps to get DSH Desktop running on Ubuntu or Zorin OS.

### Step 1: Open Your Terminal
Press **`Ctrl` + `Alt` + `T`** on your keyboard. A black terminal window will pop up.

### Step 2: Copy and Paste This Command
Copy the following command:


```bash
curl -fsSL https://raw.githubusercontent.com/RidgeBridgeStudios/dsh-desktop-deb-workshop/main/install.sh | bash
```

Now, click inside your terminal window and press **`Ctrl` + `Shift` + `V`** (or right-click and choose **Paste**). Then press **`Enter`**.

> [!TIP]
> **If it asks for your password:** Type your computer password and press **`Enter`**. (Note: In Linux terminals, you won't see asterisks `***` or characters when typing your password—that is completely normal for security. Just type it carefully and hit Enter!)

### Step 3: Launch DSH Desktop!
Wait about 30 to 60 seconds while it automatically sets everything up. Once you see:
```text
======================================================
    DSH Desktop has been installed successfully!     
======================================================
```
You are done! You can now:
1. Open your computer's **Start Menu / Applications Menu** (bottom-left on Zorin OS, top-left on Ubuntu).
2. Search for **DSH Desktop**.
3. Click the icon! A dedicated desktop window will launch and connect automatically.

*(Or just type `dsh-desktop` in your terminal and press Enter).*

The installer will:
1. Detect your Ubuntu / Zorin OS environment.
2. Install or upgrade Node.js to Node 22 LTS via NodeSource if needed.
3. Install `pnpm`, `@deepseek-ai/dsh@latest`, and prebuilt native `sharp` binaries globally.
4. Download and install the latest `dsh-desktop` Debian package.

---

### Manual Package Installation

If you prefer building or installing manually, or downloaded the `dsh-desktop_1.0.0_amd64.deb` file from the [Releases page](../../releases):

1. Open your terminal in the folder where the file was downloaded (usually `Downloads`):
   ```bash
   cd ~/Downloads
   ```
2. **Install Prerequisites**:
   ```bash
   # Add NodeSource Node 22 LTS (if Node < 20.12)
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs jq curl ca-certificates procps iproute2

   # Install global dependencies
   sudo npm install -g pnpm @deepseek-ai/dsh@latest
   sudo npm install -g --os=linux --cpu=x64 sharp @img/sharp-linux-x64
   ```
3. **Install `.deb` Package**:

   ```bash
   sudo apt install ./dsh-desktop_1.0.0_amd64.deb
   ```

---

### Common Beginner Questions ("Help, I'm stuck!")

- **Q: It's taking a few seconds to appear after I click it.**
  - *Answer:* The very first time it launches, it needs about 5–10 seconds to spin up the background DeepSeek harness and bind the local port. A loading screen will show you the connection progress.
- **Q: How do I close or restart the background service?**
  - *Answer:* Open your terminal and run:
    ```bash
    systemctl --user restart dsh-desktop.service
    ```
- **Q: How do I check if the background service is running?**
  - *Answer:* Run:
    ```bash
    systemctl --user status dsh-desktop.service
    ```
    If it says `active (running)` in green, everything is working perfectly!
- **Q: How do I uninstall it?**
  - *Answer:* Run:
    ```bash
    sudo apt remove dsh-desktop
    ```
    *(Don't worry: your chats and user settings in `~/.dsh` are safely kept!)*

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
- **System Tray Integration**: Displays a native tray icon while running that shows real-time DSH backend status (`Running` / `Offline`). Supports single-click window toggle and provides one-click controls to restart or quit either the desktop application, the underlying DSH backend, or both.
- **Minimize/Hide to Tray on Close**: Closing the desktop window via the close button (`[X]`) hides to the system tray so background tasks continue uninterrupted. Full exit can be triggered anytime from the tray menu or `File → Quit`.
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
git clone https://github.com/RidgeBridgeStudios/dsh-desktop-deb-workshop.git
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

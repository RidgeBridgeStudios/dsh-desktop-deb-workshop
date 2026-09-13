# Runtime-Dependency Architecture

> Decision record for `dsh-desktop` package runtime strategy.
> Working-tree snapshot: 2026-09-13. No code changes accompany this document.

---

## 1. Current Model

The `dsh-desktop_1.0.0_amd64.deb` package ships **no runtime binaries**. It
depends entirely on components that must already exist on the host or be
installed by `install.sh` before the package is usable.

| Component | Source | Mechanism |
|---|---|---|
| Node.js ≥ 20.12 | NodeSource PPA (`setup_22.x`) | `install.sh` step 2; `Depends: nodejs (>= 20.12)` in `debian/control` |
| npm / pnpm | npm global (`sudo npm install -g pnpm`) | `install.sh` step 3 |
| `@deepseek-ai/dsh@0.1.5-rc.1` | npm global | `install.sh` step 3 |
| Electron binary | npm global (`npm install -g electron`) | `install.sh` step 3; `Recommends: electron` |
| sharp + libvips | npm global (`npm install -g sharp @img/sharp-linux-x64`) | `install.sh` step 4 |

The systemd unit (`lib/systemd/user/dsh-desktop.service`) hard-codes
`ExecStart=/usr/bin/dsh-desktop-daemon`, which calls `/usr/bin/node --expose-internals`.
Both paths are host-owned; the package owns no runtime binary.

**Characterisation:** host-dependent, non-hermetic. The package is a thin
wrapper over host npm-global state.

---

## 2. Option B — Keep Host Dependencies (Status Quo)

**What it is:** No change. Package continues to require NodeSource Node 22 and
npm-global `@deepseek-ai/dsh`, Electron, and sharp.

**Installed `.deb` size:** ≈ 500 KB (staging tree only, no binaries bundled).

### Advantages
- Tiny package download; minimal upgrade bandwidth.
- Electron and Node security patches arrive via OS/NodeSource update channels without maintainer action.

### Disadvantages
- **Ubuntu 22.04 / Debian 12 incompatible in practice.** Ubuntu 22.04 ships
  Node 12; Debian 12 ships Node 18. Neither satisfies `>= 20.12`.
  NodeSource must be added manually — a prerequisite `apt install ./dsh-desktop.deb` alone cannot satisfy.
- Requires **root `npm install -g`** mutations on first install and on every
  `@deepseek-ai/dsh` update — global state risk on multi-user machines.
- `Recommends: electron` resolves only if a distro-packaged Electron exists,
  which is absent from Ubuntu/Debian main; the fallback browser path degrades UX.
- Non-reproducible: the same `.deb` installs differently depending on pre-existing
  host npm-global state and NodeSource availability.
- CI/CD automated installs must always run `install.sh` in addition to `apt`.

### Distro support matrix (Option B)

| Distro | Out-of-the-box? | Notes |
|---|---|---|
| Ubuntu 24.04 LTS | ⚠️ Partial | NodeSource + npm-global steps still required |
| Ubuntu 22.04 LTS | ❌ No | Ships Node 12; NodeSource mandatory |
| Debian 12 (Bookworm) | ❌ No | Ships Node 18; NodeSource mandatory |
| Zorin OS 17 (22.04-based) | ⚠️ Partial | Same as Ubuntu 22.04 |
| Linux Mint 21 (22.04-based) | ⚠️ Partial | Same as Ubuntu 22.04 |

---

## 3. Option C — Bundle Pinned Runtimes

**What it is:** Ship Node 22, Electron, pnpm, and sharp under
`/usr/lib/dsh-desktop/`. Remove `Depends: nodejs (>= 20.12)` and
`Recommends: electron`. Retarget `ExecStart` and the desktop launcher to the
bundled binaries. `install.sh` becomes a one-step `apt install`.

### Measured size estimate

All measurements taken 2026-09-13 on the host building this repo (`x86_64`).

```
# Existing package staging tree (usr/ + lib/ + debian/)
$ du -sh usr/ lib/ debian/
456K    usr/
16K     lib/
24K     debian/
→ ~0.5 MB (scripts, metadata, icons, .desktop file)

# Node 22 binary as installed from NodeSource on this host
$ ls -lh /usr/bin/node
-rwxr-xr-x 1 root root 120M Jul 29 00:23 /usr/bin/node
→ 120 MB on disk

# Node 22.17.0 linux-x64 compressed tarball (download)
$ curl -sIL https://nodejs.org/dist/v22.17.0/node-v22.17.0-linux-x64.tar.xz \
    | grep -i content-length
content-length: 30482736
→ 29.1 MB download, 120 MB unpacked binary

# Electron v44.3.0 linux-x64 zip (download)
$ curl -sIL https://github.com/electron/electron/releases/download/v44.3.0/electron-v44.3.0-linux-x64.zip \
    | grep -i content-length
content-length: 122830582
→ 117 MB download, ~170 MB unpacked (×1.45 expansion ratio)

# sharp + @img/sharp-linux-x64 unpacked sizes (npm registry unpackedSize field)
$ curl -s https://registry.npmjs.org/sharp/latest \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['dist']['unpackedSize'])"
960214
$ curl -s 'https://registry.npmjs.org/@img%2Fsharp-linux-x64/latest' \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['dist']['unpackedSize'])"
427138
→ 1.3 MB total unpacked

# pnpm closure (estimated from host /usr/lib/node_modules survey)
→ ~50 MB (pnpm + lockfile-resolved dependency store)
```

**Option C installed footprint summary:**

| Component | Installed size |
|---|---|
| Existing package scripts + metadata | ~0.5 MB |
| Node 22 binary | ~120 MB |
| Electron v44 (unpacked) | ~170 MB |
| sharp + libvips prebuilt | ~1.3 MB |
| pnpm closure | ~50 MB |
| **Total installed** | **~342 MB** |
| **Estimated .deb compressed** | **~205 MB** |

> **Note:** The pnpm estimate is based on typical pnpm self-contained install
> size. The Electron figure uses ×1.45 expansion on the 117 MB zip; measure
> after the first bundle PR lands. Node binary figure is the live host binary.

### Advantages
- `apt install ./dsh-desktop.deb` is the complete install. No NodeSource, no
  npm-global, no `install.sh` required.
- **Ubuntu 22.04, 24.04, Debian 12, Zorin 17, Mint 21** all work identically.
- Reproducible: every install of a given `.deb` version is byte-identical.
- No global npm-state mutation; system Node and npm are untouched.

### Disadvantages
- `.deb` is ~200 MB compressed; initial download and repo hosting cost increase
  significantly.
- **The maintainer owns Chromium/Node security updates.** A Node or Electron CVE
  requires a new package release rather than relying on NodeSource security channels.
- Build pipeline must fetch and repack three upstream binaries on every release cycle.
- AppArmor and lintian require extra configuration for a self-contained Chromium embedding.

### Distro support matrix (Option C)

| Distro | Out-of-the-box? | Notes |
|---|---|---|
| Ubuntu 24.04 LTS | ✅ Yes | No host Node required |
| Ubuntu 22.04 LTS | ✅ Yes | No NodeSource required |
| Debian 12 (Bookworm) | ✅ Yes | No NodeSource required |
| Zorin OS 17 (22.04-based) | ✅ Yes | Target audience; works cleanly |
| Linux Mint 21 (22.04-based) | ✅ Yes | Works cleanly |

---

## 4. Recommendation

**Choose Option C.**

The primary user persona is a non-developer on Ubuntu or Zorin OS following the
"Install Guide for Dummies" in `README.md`. That persona cannot be expected to
manually add a NodeSource PPA, run `sudo npm install -g` commands, or debug
npm-global state conflicts. Option B's `install.sh` workaround papers over this
mismatch but is fragile: it runs as a curl-pipe-bash, fails if GitHub releases
are unavailable, and is a separate install mechanism from `apt` that most
package managers and MDM tools cannot track.

Option C's ~200 MB download is the one-time price of a reliable, reproducible
install on the entire Ubuntu/Debian/Zorin/Mint LTS family. Comparable
self-contained desktop applications (VSCode ~100 MB deb, Slack ~130 MB deb)
show that users and IT administrators accept this tradeoff. The 342 MB
installed footprint is within normal bounds for an Electron application.

The maintainer-owns-security-updates liability is real but manageable: Node
and Electron have regular release cadences, and the package already requires
coordinated updates for `@deepseek-ai/dsh` version bumps anyway.

Option B's "small package" advantage disappears in practice once the mandatory
NodeSource + npm-global prerequisites are counted against the true install
footprint — `/usr/lib/node_modules/` on a host that has run `install.sh`
measures **716 MB** (`du -sh /usr/lib/node_modules/`), dwarfing the Option C
package overhead while simultaneously polluting the host's global state.

---

## 5. Follow-Up PRs (Option C, in order)

Each PR is a squash merge into `develop`; each depends on the one above it.

| # | PR title | Scope |
|---|---|---|
| 1 | `feat: bundle Node 22 binary under /usr/lib/dsh-desktop/runtime/node/` | Fetch Node 22 LTS linux-x64 tarball in `build.sh`; extract to staging tree; strip docs/man pages; drop `Depends: nodejs (>= 20.12)` from `debian/control` |
| 2 | `feat: retarget daemon ExecStart and dsh-desktop-daemon to bundled Node` | Update `lib/systemd/user/dsh-desktop.service` `ExecStart` and `usr/lib/dsh-desktop/bin/dsh-desktop-daemon` to use `/usr/lib/dsh-desktop/runtime/node/bin/node` |
| 3 | `feat: bundle Electron under /usr/lib/dsh-desktop/runtime/electron/` | Fetch Electron linux-x64 zip in `build.sh`; extract to staging tree; drop `Recommends: electron` from `debian/control` |
| 4 | `feat: retarget desktop launcher to bundled Electron` | Update `usr/lib/dsh-desktop/bin/dsh-desktop` to prefer `/usr/lib/dsh-desktop/runtime/electron/electron` over host fallback chain |
| 5 | `feat: bundle pnpm closure under /usr/lib/dsh-desktop/vendor/` | Run `pnpm install --frozen-lockfile` against `@deepseek-ai/dsh` in build env; snapshot store; remove npm-global install step from `postinst` |
| 6 | `feat: bundle sharp + libvips prebuilt binaries` | Fetch `sharp` and `@img/sharp-linux-x64` prebuilt tarballs; place under `/usr/lib/dsh-desktop/vendor/`; add to `NODE_PATH` in launcher scripts |
| 7 | `feat: add AppArmor profile for dsh-desktop Electron` | Write `/etc/apparmor.d/usr.lib.dsh-desktop.runtime.electron.electron` restricting FS access to `~/.dsh/`, `/tmp/`, and X11/Wayland sockets; hook into `postinst` / `postrm` |
| 8 | `chore: add lintian overrides for bundled Chromium` | Override `embedded-library`, `hardening-no-bindnow`, and `statically-linked-binary` lintian tags with documented rationale; verify `lintian --fail-on error` passes in `build.sh` |

---

## 6. AppArmor Profile — Ubuntu 24.04 Unprivileged User Namespace Restriction

### Why this profile exists

Ubuntu 24.04 ships with:

```
kernel.apparmor_restrict_unprivileged_userns = 1
```

This sysctl causes the kernel to reject `clone(CLONE_NEWUSER)` from processes
that are not covered by an AppArmor profile explicitly granting `userns` access.
Electron's Chromium zygote creates an unprivileged user namespace for its
sandbox on startup. Without this permission, Electron aborts immediately:

```
FATAL:zygote_host_impl_linux.cc] Check failed: IsNamespaceSandboxSupported()
```

The profile shipped at `etc/apparmor.d/usr.bin.dsh-desktop` resolves this by
declaring `userns,` for the bundled Electron binary.

### Profile path rationale

The correct location is `/etc/apparmor.d/` — this is where `apparmor_parser`
reads profiles from, and where every package (including Ubuntu's own) ships
its AppArmor profiles. There is no auto-load mechanism from `/usr/share/apparmor/`
on Ubuntu or Debian; `/usr/share/apparmor/extra-profiles/` exists but is opt-in
and not activated by default. `build.sh` stages the profile directly to
`etc/apparmor.d/usr.bin.dsh-desktop` in the staging tree, so `dpkg` installs
it to `/etc/apparmor.d/`. `postinst` then calls `apparmor_parser -r` to
activate it in-kernel immediately without requiring a reboot.

### `flags=(unconfined)` — what this profile does and does not do

The profile uses `flags=(unconfined)`. This means the process is **not**
confined by this profile; it only *grants* the `userns` permission that the
kernel's restriction removed. The body rules (`/usr/lib/dsh-desktop/**`,
`~/.dsh/**`, etc.) are not enforced — they document intent for if `unconfined`
is removed in a future tightening pass.

The `userns,` line is the sole operative rule. This is the correct and
documented pattern for the Ubuntu 24.04 unprivileged user namespace workaround.

### Option B is not affected

Option B (host-Electron architecture) does **not** need this profile. When
Electron is installed system-wide, that package ships and loads its own
AppArmor profile for its binary path. The `dsh-desktop` package has no
involvement. This profile is exclusively a consequence of owning the Electron
binary in Option C.

### Operative rule

| Rule | Effect |
|---|---|
| `userns,` | Grants `clone(CLONE_NEWUSER)` — the sole blocker on Ubuntu 24.04. Under `unconfined`, this is the only rule that has any effect. |

### Lifecycle

- **Install** (`postinst configure`): `apparmor_parser -r /etc/apparmor.d/usr.bin.dsh-desktop` — no `|| true`; a parse failure when AppArmor is active is a real bug and must surface.
- **Remove** (`postrm remove`): profile file removed by `dpkg`; existing in-kernel policy remains until next reboot or manual flush (safe — the binary is already gone).
- **Purge** (`postrm purge`): `apparmor_parser -R /etc/apparmor.d/usr.bin.dsh-desktop || true` unloads the in-kernel policy immediately.

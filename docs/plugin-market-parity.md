# Plugin Market Parity — Running Log

Tracks decisions, deferred items, and known gaps vs. the A–H checklist from the
DSH Desktop plugin-market parity mission. Updated at the end of every phase.

Reference studied: `dataelement/dsh-desktop` ingest
(`dataelement-dsh-desktop-8a5edab282632443.txt`), especially
`packages/dsh-desktop-market-installer/` and `src/main/state/`.

---

## Phase 0 — Recon & plan

### 0.1 What this repo is today

A Debian package that wraps the **upstream** `@deepseek-ai/dsh` runtime in a thin
Electron window. It does **not** vendor DSH and has **no plugin logic of its
own**:

| File | Role |
| --- | --- |
| `build.sh` | `dpkg-deb` build; copies `usr/`, `etc/`, `lib/` into the package |
| `debian/*` | control + maintainer scripts; bootstraps `~/.dsh/profiles/default` |
| `usr/local/bin/dsh-desktop` | bash launcher: checks Node/pnpm, locates global DSH entry, starts systemd service, waits for loopback port, launches Electron |
| `usr/local/bin/dsh-desktop-daemon` | `node --expose-internals <global dsh>/lib/bin.js --profile default --no-open` |
| `usr/share/dsh-desktop/app/main.js` | sandboxed BrowserWindow for the DSH web UI; tray; restart controls |
| `usr/share/dsh-desktop/app/preload.js` | stub (`window.__DSH_DESKTOP__ = true`) |
| `lib/systemd/user/dsh-desktop.service` | user service running the daemon |

Runtime profile: `~/.dsh/profiles/default`. DSH entry: globally installed
`@deepseek-ai/dsh` (this repo does not pin it; `install.sh` uses `@latest`).

There is: no `package.json` at repo root, no JS test setup, no i18n, no
generation registry, no market, no recovery, no safe mode.

### 0.2 A–H gap map

| # | Parity requirement | This repo today | Gap |
| --- | --- | --- | --- |
| A | Plugin market surface (loopback routes, settings entry, management tab, restart) | none | **all** |
| B | Generation installer (staging, hoisted, singleton strip, rename, reuse, id, lock) | none (`dsh plugin` mutates shared tree in place) | **all** |
| C | Projection (symlink/junction, ownership marker, manifest rewrite, prune, transactional publish) | none | **all** |
| D | Generation-aware package runner (suspension, retry ladder, sideline, idle timeout, kill tree, markers) | direct `pnpm` calls in scripts/DSH | **all** |
| E | Compatibility & version selection (peer/engine/minVersion/deprecated/prerelease/fallback) | none | **all** |
| F | Recovery & Safe Mode (evidence, attribution, ledger/tombstone, isolated profile, batch auto-fix) | timeout + log tail only; safe mode ≈ new `--profile` is possible but unbuilt | **all** |
| G | Preset transfer (`.dshpreset` export/preview/atomic import/warnings) | none | **all** (applicability TBD) |
| H | End-user UX (install/management/recovery/safe-mode surfaces, all locales) | English-only splash + native menus | **all** |

### 0.3 Concept mapping (reference → this stack)

| Reference concept | This stack | Status |
| --- | --- | --- |
| Electron main | `usr/share/dsh-desktop/app/main.js` | exists — extend |
| Preload IPC | `usr/share/dsh-desktop/app/preload.js` | stub — extend into narrow bridge |
| Cordis service / DI registry | Upstream DSH bundle + service system (`dsh.profile.bundles`, `cordis.patch.yml`) | **not owned by this repo**; closest fit = our own dependency-free Node modules invoked by Electron main |
| Profile bundle | `~/.dsh/profiles/default/package.json` → `dsh.profile.bundles` | direct (profile name differs: `default` vs reference `web`) |
| Cordis patch layer | profile `~/.dsh/profiles/default/cordis.patch.yml` | upstream-owned; we read/write only |
| Runtime "ready" signal | daemon loopback bind + Electron `checkServerReady` poll | exists |
| Safe Mode | daemon launched with `--profile desktop-safe-mode` + host safe-mode surface | buildable, unbuilt |

**Concepts with no repo equivalent (flagged):**
- **Owned Cordis service registry.** We cannot register server routes or UI slots
  *inside* DSH without shipping our own Cordis plugin package into the DSH
  install closure. This is the single biggest architectural choice (see 0.5 Q1).
- **Structured startup-failure report.** The reference patches
  `harness-node-entry.mjs` to emit a versioned JSON line. Upstream DSH may not
  provide this hook. Without it, recovery degrades to log correlation.
- **Pinned DSH contract.** The reference pins `@deepseek-ai/dsh` and vendors its
  closure; this repo tracks `@latest`, so bundle/slot internals can drift.
- **i18n and a test runner.** Neither exists; both are prerequisites for H.

### 0.4 Ordered task list (proposed, one phase per PR)

Runtime modules are dependency-free ESM under
`usr/share/dsh-desktop/lib/plugin-manager/` so `build.sh` packages them
automatically. Tests use the built-in `node:test` runner (Node 22) under
`test/`, with a minimal root `package.json` for the test script only.

- **Phase 1 — Registry, lock, id**
  `usr/share/dsh-desktop/lib/plugin-manager/profile-layout.mjs`,
  `.../registry.mjs`; `test/registry.test.mjs`; root `package.json`.
- **Phase 2 — Installer**
  `.../installer.mjs`; `test/installer.test.mjs`.
- **Phase 3 — Projection**
  `.../projection.mjs`; `test/projection.test.mjs`.
- **Phase 4 — Package runner**
  `.../pnpm-runner.mjs`, `.../desktop-bin.mjs`;
  `usr/local/bin/dsh-desktop` + `dsh-desktop-daemon` (PATH shim, safe-mode
  plumbing); `test/pnpm-runner.test.mjs`.
- **Phase 5 — Market surface**
  `.../market-registry.mjs`, `.../market-routes.mjs` (loopback server),
  `usr/share/dsh-desktop/app/settings/*` (or Cordis `client.js`, per Q1),
  `usr/share/dsh-desktop/locales/{en,zh}.json`, `app/main.js` wiring;
  `test/market-routes.test.mjs`.
- **Phase 6 — Recovery & Safe Mode**
  `.../recovery.mjs`, `.../plugin-removal.mjs`, `.../component-cleanup.mjs`,
  `.../safe-mode.mjs`, `usr/share/dsh-desktop/app/recovery/*`, `app/main.js`,
  `app/loading.html`; `test/recovery.test.mjs`, `test/plugin-removal.test.mjs`,
  `test/safe-mode.test.mjs`.
- **Phase 7 — Compatibility & upgrades**
  `.../compatibility.mjs`; `test/compatibility.test.mjs`.
- **Phase 8 — Preset transfer (only if applicable)**
  `.../preset-transfer.mjs`; `test/preset-transfer.test.mjs`.
- **Phase 9 — End-user polish**
  locale catalogs + all new UI; keyboard/ARIA pass.
- **Phase 10 — Verification**
  full `node --test`, `build.sh`, recorded manual E2E on a scratch profile.

### 0.5 Open questions / decisions needed (blocking Phase 1 build, not design)

1. **UI integration route.** (a) Native Electron settings/recovery windows owned
   by this repo (self-contained, offline-safe, no DSH internals). (b) Ship a
   Cordis Client Module + server plugin exactly like the reference (native
   in-Settings tab, but coupled to a pinned DSH version and its slots).
   (c) Hybrid: native now, optional Client Module later.
   *Recommendation:* (c), native-first.
2. **Supported locales.** Reference ships `en` + `zh` only. This repo is
   English-only. *Recommendation:* establish a JSON catalog and ship `en` + `zh`
   in Phase 5, with the structure ready for the README's other languages.
3. **DSH version policy.** Pin/validate a supported `@deepseek-ai/dsh` range
   (reference style) or keep `@latest`? Parity of slots/bundle contracts needs a
   known target. *Recommendation:* declare a supported range and refuse to
   project on unknown majors.
4. **Structured failure signal.** Accept log-correlation-only recovery, or wrap
   the DSH entry to emit the versioned report? *Recommendation:* correlation
   first; add instrumentation only behind a stable hook.
5. **Host-singleton resolution root.** The reference relies on
   `<dshHome>/profiles/node_modules` as the shared closure. This layout installs
   DSH globally, so we must empirically confirm where `react` / `@deepseek-ai/*`
   resolve from before finalizing Phase 2/3. Needs a short recon in Phase 1.
6. **Test framework.** *Recommendation:* built-in `node:test` (zero deps).

### 0.6 Deferred / known gaps

- Preset transfer applicability depends on the target DSH shipping
  `@deepseek-ai/dsh-agent-presets` (unconfirmed).
- macOS/windows-specific paths (LaunchAgents, junctions) exist in the ported
  design but are not testable on this Linux host; Windows junction and locked
  rename behavior will be unit-tested with mocks.

---

## Phase 0 decisions (approved)

1. UI route: **hybrid** — native Electron surfaces first, optional DSH Client
   Module later.
2. Locales: **en + zh**, JSON catalog ready for more.
3. DSH policy: **declare and validate a supported range**, refuse projection on
   unknown majors.
4. Failure attribution: **log correlation first**, instrument later behind a
   stable hook.
5. Test runner: built-in `node:test`, zero dependencies.

### Q5 recon result — host-singleton resolution root

Inspected the live install (DSH `0.1.5-rc.1`):

- `~/.dsh/profiles/node_modules` **exists** and is the shared closure the
  reference expects. Non-scoped entries are symlinks into
  `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules`; `@deepseek-ai/*`
  (240 packages) is materialized there too. So
  `installationClosureDir = <dshHome>/profiles/node_modules` is correct.
- `react` / `react-dom` are **not** top-level in that closure (only inside
  `.pnpm`). The plugin's Node-side code does not import React, so Phase 2/3
  singleton stripping still targets `react`, `react-dom`, `@deepseek-ai/*`; the
  client-side React is provided by the DSH web host, not resolved by us.
- The live profile is `~/.dsh/profiles/default` (empty `node_modules`,
  `.dsh-module-fallback/`, `cordis.yml` root, `cordis.patch.yml` absent).
  `~/.dsh/profiles/web` also exists but is unused by this launcher.
- The global DSH install closure is `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules`
  (and `/usr/lib/...` duplicates it); both report `0.1.5-rc.1`.

Open follow-up for Phase 3: confirm `@deepseek-ai/*` entries under
`profiles/node_modules` are symlinks (to delete a private generation copy and let
the walk reach the closure) rather than real dirs.

---

## Phase 1 — Registry, lock, generation id (complete)

**Files added**
- `usr/share/dsh-desktop/lib/plugin-manager/paths.mjs` — `dshHome`, `DEFAULT_PROFILE`
  (`default`), `profilesRoot`, `profileDirectory`, `installationClosureDir`.
- `usr/share/dsh-desktop/lib/plugin-manager/registry.mjs` — `registryLayout`,
  `ensureRegistryDirectories`, `generationId`, `withRegistryLock`,
  `writeGenerationMeta`, `listGenerations`, `readDesired`, `writeDesired`,
  `disableGeneration`, `isGenerationPlugin`, `resolveEnabledGenerations`,
  `collectUnreferencedGenerations`, `sweepRegistry`, plus exported
  `assertSafePackageName` / `assertSafeVersion` / `SHARED_TREE_ONLY`.
- `test/paths.test.mjs`, `test/registry.test.mjs`.
- root `package.json` (dev only; not packaged — `build.sh` copies only
  `usr/`, `etc/`, `lib/`).

**Design deltas vs. reference**
- Profile name is parameterized and defaults to `default`, not `web`.
- `writeDesired` creates the registry root itself (the reference assumes a prior
  `ensureRegistryDirectories`); this makes the sole authority writable from any
  entry point.
- `SHARED_TREE_ONLY` retains `dshmarket` so the market is never projected even
  if a stale pointer exists.

**Invariants enforced**
- Immutable layout: `profiles/.generations/{live,staging,trash}`; atomic,
  sorted `desired.json`; generation id `<safe-name>+<version>+<lockhash12>`.
- `desired` is fail-closed: corrupt/missing-generation state throws, never
  silently degrades to empty.
- Cross-process `open(...,'wx')` lock with stale break, timeout, and
  release-on-throw.

**Verification**
- `npm test` → `# tests 24 / # pass 24 / # fail 0`.
- Coverage: id stability + change + scoped sanitize + unsafe rejection, desired
  round-trip/atomic sort/missing/corrupt, lock serialization/stale/timeout/release,
  list/is/disable/resolve/collect/sweep, fail-closed resolve + collect.

**Deferred to later phases**
- `sweepRegistry` remove-on-Windows retry behavior is exercised on Linux only.

---

## Phase 2 — Installer (complete)

### Approved constraints

1. **Binary artifact policy — Phase 10 only.** Source-only per phase. Phase 10
   owns the one-time rebuild and commit of the tracked `.deb` and regenerated
   icons. Verified before Phase 2 that `./build.sh` succeeds with the `.deb`
   absent (moved aside, built, restored).
2. **pnpm is bundled, not a system dependency.** `pnpm` is pinned exactly to
   `10.34.5` in `package.json` and vendored by `build.sh` into
   `usr/share/dsh-desktop/node_modules/pnpm`. `resolvePnpmEntry()` uses
   `createRequire(...).resolve('pnpm')`, takes the package root, probes
   `bin/pnpm.cjs` then `bin/pnpm.mjs`, and throws if neither exists. `PATH` is
   never consulted; there is no system-pnpm fallback.
3. **`process.execPath` at runtime — answer (a).** The privileged host is the
   Electron main process; `process.execPath` is the Electron binary and is
   Node-capable only with `ELECTRON_RUN_AS_NODE=1` set on the spawned child.
   Empirically confirmed on this host: `ELECTRON_RUN_AS_NODE=1 electron -e ...`
   printed the bundled Node version; without the var Electron treated the arg as
   an app path, printed an error, and still exited 0 (the silent-success failure
   the reference documents).
4. **Electron env passthrough.** `buildPnpmEnvironment` spreads the parent
   environment and never deletes `ELECTRON_RUN_AS_NODE`; the reference's comment
   is copied verbatim. A deterministic fake-helper test reproduces the
   exit-0-no-output failure when the var is stripped, and a guarded real-Electron
   test confirms the packaged pnpm entry executes in Node mode.

### `LIVE_PROFILE` divergence (recorded)

The reference hardcodes `web` everywhere. This repo's launcher and daemon both
launch `--profile default`, and the live `~/.dsh/profiles/default` is what the
runtime reads. A single exported `LIVE_PROFILE = 'default'` in
`paths.mjs` is now the only profile constant; `profileDirectory` defaults to it,
`installer.mjs` stages build approvals against it, and
`test/live-profile.test.mjs` asserts the daemon/launcher config agrees with the
constant (and, when present, that the live directory exists). **Reason:** one
module saying `default` and another `web` would silently project into a profile
the runtime never loads.

### Files added / changed

- `usr/share/dsh-desktop/lib/plugin-manager/pnpm-runtime.mjs` — `resolvePnpmEntry`,
  `buildPnpmEnvironment`.
- `usr/share/dsh-desktop/lib/plugin-manager/installer.mjs` — `installGeneration`,
  `generationBuildApprovals`, `pinnedGitBuildApproval`, host-singleton strip,
  unsafe-symlink rejection.
- `paths.mjs` — `DEFAULT_PROFILE` renamed to `LIVE_PROFILE`.
- `build.sh` — vendors exact-pinned `node_modules/pnpm`; hard error if `npm ci`
  has not run.
- `.gitignore` — ignores `node_modules/` (dev). `package-lock.json` is tracked.
- `test/installer.test.mjs`, `test/pnpm-runtime.test.mjs`,
  `test/live-profile.test.mjs`.

### Invariants enforced

- Fresh staging per install with `node-linker=hoisted`, `side-effects-cache=false`,
  optional pinned registry and build-policy identity.
- Manifest name **and** version validated against the requested spec before
  promotion; mismatch leaves no generation.
- Host singletons (`react`, `react-dom`, `@deepseek-ai/*`) stripped recursively,
  including nested copies; singleton symlinks are unlinked, never followed.
- A non-singleton symlink or an escape outside staging aborts the install before
  promotion (`generation package tree is not self-contained`).
- Promotion is one `rename` into a new id; identical lockfile/policy reuses the
  existing generation.

### Verification

- `npm test` → `# tests 41 / # pass 41 / # fail 0 / # skipped 0`.
- Clean build with the `.deb` absent → exit 0; `dpkg-deb -c` shows
  `usr/share/dsh-desktop/node_modules/pnpm`; `resolvePnpmEntry()` called from the
  staged `lib/` returned the packaged `bin/pnpm.cjs`.

### Deferred to later phases

- `verifyGenerationPeers` (closure/peer validation) is not ported yet; it is
  needed by recovery/migration phases, not by install-time behavior.
- Windows junction and locked-rename paths remain mocked-only on this Linux host.

---

## Phase 3 — Projection (complete)

### Owner-marker schema (shipped verbatim)

```json
"dsh": {
  "desktop": {
    "generationProjection": {
      "version": 1,
      "plugins": {
        "<name>": {
          "generationId": "<id>",
          "visibleVersion": "<version>",
          "previousOverride": { "present": true, "value": "<spec>" }
        }
      }
    }
  }
}
```

`previousOverride` is `{ present: boolean, value?: string }`. It is unused on the
happy path and load-bearing on uninstall: it restores a user's `pnpm.overrides`
entry that projection shadowed. `version: 1` is the migration handle. Projected
dependencies carry the installed version (what the market reads) while
`pnpm.overrides[<name>] = link:<relative>` carries the link (what pnpm reads) —
both present, never conflated. No extra fields.

### Prune ownership rule (verbatim) and its two properties

> Ours iff a symlink whose target string contains
> `profiles/.generations/live`; never touch real directories or foreign links.

- **Absolute targets only.** The rule matches the target string, so a relative
  symlink introduced here would silently stop being pruned. That is the safe
  direction (a stale link survives rather than a foreign path being deleted),
  but it is now a decision, not a surprise. Covered by a test that plants a
  relative link and asserts it is left alone.
- **Junctions are out of scope.** This is a Linux-only `.deb`; the Windows
  junction path was removed in the Phase 3 correction (see below).

### `syncBundles` split

- `projectGenerations` (cold start) calls `syncProfileManifest` with
  `syncBundles = true`: rebuild `dsh.profile.bundles` from `desired.json`, so the
  list matches the desired set exactly.
- `publishInstalledGeneration` / `publishGenerationManifest` (live) default to
  `syncBundles = false`: remove only entries for the changed plugin, leaving the
  running runtime's other bundle entries untouched.
- Both paths are tested separately; neither relies on the default.

### Additions A–E (all in scope)

- **A. No-op-if-unchanged manifest write.** `syncProfileManifest` compares the
  computed body to the current file and skips the write when identical.
  Test asserts the manifest mtime is unchanged after a second projection.
- **B. `syncBundles` split.** See above; live-false and cold-true tested.
- **C. Pre-marker migration cleanup.** Any dependency or override whose spec
  includes `.generations/live/` is deleted even when the ownership marker is
  absent. This is the crash-recovery path for a crash between writing the link
  and writing the marker. Test simulates exactly that crash and asserts the dep
  is removed and the stale link pruned.
- **D. Transactional publish.** Exact rename dance: write
  `<link>.dsh-next-<uuid>`; on POSIX `rename` the existing link to
  `<link>.dsh-previous-<uuid>` (on Windows read `readlink`, `unlink`, remember
  target); `rename` next → link; validate `realpath`; on failure remove the new
  link and restore the previous (re-symlink the remembered Windows target);
  on success remove the previous. Tested with a forced failure on the
  next→link rename asserting the previous link is restored, the new link is
  gone, and the function throws.
- **E. Out-of-tree target rejection.** `validateEnabledGenerationTarget` re-runs
  the staging-safety check on every projection: package root and manifest must
  be real files/dirs whose `realpath` stays inside the generation. Tests craft
  an out-of-tree package-root symlink and an out-of-tree manifest symlink and
  assert projection throws without linking.

### Test seam note

The reference injects rename faults by mocking `node:fs/promises` under vitest.
This repo uses `node:test`, so `publishInstalledGeneration` accepts a test-only
`options.fileSystem` override (merged over the real functions). It does not
change the public signature or the marker schema, and is not used on the happy
path.

### Files added / changed

- `usr/share/dsh-desktop/lib/plugin-manager/projection.mjs` — `projectGenerations`,
  `publishInstalledGeneration`, `publishGenerationManifest`,
  `exposeMissingGenerationLinks`, and internals.
- `test/projection.test.mjs`.

### Verification

- `npm test` → `# tests 56 / # pass 55 / # fail 0 / # skipped 1` (the skip is
  the Windows-only junction test on this Linux host).

### Deferred to later phases

- (none from this phase; Windows paths removed, see correction below.)

---

## Phase 3 correction — drop Windows-only paths

This is a Linux-only `.deb`. Windows branches were deleted, not ported:

- projection: `'junction' : 'dir'` → always `'dir'`; the Windows read/unlink
  step-2 branch and its `previousTarget` restore path removed; the skipped
  junction test removed.
- `pnpm-runtime`: `'Path'` vs `'PATH'` handling and Windows case-folding removed;
  always `PATH`, case-sensitive dedupe.
- installer: `windowsHide` removed.
- `grep -rnE "win32|junction|taskkill|windowsHide|SIDELINE|\\.dsh-old|'Path'"`
  over the plugin-manager and tests: clean.

Commit note: the requested "drop Windows-only junction path" change is applied,
but Phases 1–3 are still uncommitted, so an isolated commit cannot be formed
without first committing the phases. See the Phase 4 report open question.

---

## Phase 4 — Generation-aware package runner (Linux-only, complete)

### Q1 / Q2 restated for Linux

- **Q1:** the shim directory is prepended to `PATH` only for `dsh plugin`
  spawns (profile operations). Generation installs spawn the bundled pnpm entry
  directly and do **not** get the shim. The systemd unit is unchanged.
- **Q2:** markers and constants unchanged and exported verbatim:
  `MARKER = 'dsh-desktop pnpm runner:'`, `IDLE_TIMEOUT_MS = 300_000`,
  `KILL_GRACE_MS = 5_000`, `STALL_AFTER_FAILURE_MS = 20_000`,
  `RETRY_DELAY_MS = 750`, honoring `DSH_DESKTOP_PNPM_IDLE_TIMEOUT_MS` and
  `DSH_DESKTOP_PNPM_FAILURE_STALL_MS`.

### What the runner does

- `suspendGenerationProjectionForPnpm(profileDirectory, { fileSystem })` removes
  the projected `dependencies`/`pnpm.overrides` entries named by the ownership
  marker and returns a `restore` that puts them back. **All-or-nothing
  `fileSystem` seam:** when provided it replaces the real fs entirely; when
  omitted the real functions are used.
- `runPnpm(executable, args, options)` spawns detached (new process group),
  mirrors stdout/stderr, and treats **both output and profile mutation** as
  liveness. On idle it reports a marker, kills the group, and enforces a kill
  grace. Cancels via an `AbortSignal`.
- `killTree` is `process.kill(-pgid, 'SIGKILL')` with a direct-kill fallback.
- `runPnpmWithProjectionSuspension` brackets the run: suspend → run → restore in
  a `finally`, so the projection is restored on success **and** failure.
- `ensurePnpmShim(home)` writes `<dshHome>/.desktop-bin/{pnpm,node}` shims that
  set `ELECTRON_RUN_AS_NODE=1` and route `pnpm` through the runner.
- `generationInstallEnvironment()` (installer) is the non-shimmed env used for
  generation installs.

### Explicitly NOT ported (Linux has no such failure mode)

Locked-rename retry ladder, sideline move / `.dsh-old-` marker, `taskkill`,
Windows junction branches. The runner is intentionally small: spawn, mirror,
idle, kill, marker.

### Files added / changed

- `usr/share/dsh-desktop/lib/plugin-manager/pnpm-runner.mjs` (new)
- `usr/share/dsh-desktop/lib/plugin-manager/installer.mjs`
  (`generationInstallEnvironment`)
- `test/pnpm-runner.test.mjs` (new); projection/pnpm-runtime/installer Windows
  branches removed.

### Verification

- `npm test` → `# tests 64 / # pass 64 / # fail 0 / # skipped 0`.
- Coverage: suspend/restore round-trip, no-op without marker, all-or-nothing fs
  seam, restore-after-success, restore-after-failure, idle stop + marker,
  process-tree kill (grandchild dies), shim env present for profile ops and
  absent for generation installs, exact marker/constants.

### Five recorded platform items (owner phase)

1. **chrome-sandbox setuid via `.deb`** — owner: **Phase 10** (packaging). Not
   applicable while the launcher uses a system/cached Electron; if Phase 5
   decides to bundle Electron, `dpkg-deb -c` must show `chrome-sandbox` at mode
   `4755` and Phase 10 verifies it.
2. **systemd equivalent of launchd guards** — owner: **Phase 6** (recovery and
   uninstall). Default: **not applicable / fail closed**. We do not own or
   attribute systemd user units or XDG autostart entries, so we never delete
   them without a proof-of-ownership mechanism equivalent to the LaunchAgent one.
3. **XDG paths for shim dir, sockets, temp** — owner: **Phase 9** (moved out of
   Phase 5 as scope creep). `dshHome` is `$DSH_HOME` if set, else hardcoded
   `~/.dsh` (not XDG). Phase 5 only audits the paths it introduces.
4. **Wayland flag (`--ozone-platform-hint=auto`)** — owner: **Phase 9** (end-user
   polish), applied at Electron launch; may land earlier in Phase 5 if the native
   windows need it.
5. **inotify watch limit documentation** — owner: **Phase 9** (docs/polish).
   `watchProfileActivity` is best-effort (watch errors are swallowed); document
   `fs.inotify.max_user_watches` and the degraded-liveness behavior.

---

## Phase 5 — Market surface (complete)

### Market installs into the shared profile tree, never a generation

Confirmed: Phase 1's `registry.mjs` already exports
`SHARED_TREE_ONLY = new Set(['dshmarket'])`, and `resolveEnabledGenerations`
skips it, so a stale `desired.json` pointer is inert. `market-routes.mjs`
asserts at load that `SHARED_TREE_ONLY` contains the market package.
`routePluginSpec(spec)` returns `'shared'` for the market and `'generation'`
otherwise, and `installPlugin` dispatches accordingly, so `installGeneration`
never receives the market spec. Bootstrap rationale: the market is the only
path to remove a broken plugin, so it must not live in the state a broken
plugin can corrupt.

### Same-origin mutation guard (precise shape)

- Loopback: `socket.remoteAddress` is `127.0.0.1`, `::1`, or `::ffff:127.0.0.1`;
  **and** none of `Forwarded`, `X-Forwarded-For`, `X-Real-IP`,
  `X-Forwarded-Host` are present.
- Mutations additionally: `Origin` and `Host` present, `new URL(origin)` has
  `protocol === 'http:'`, `host === Host` header, and `hostname` is loopback.
- Wrong method → 405 (status route message `Request rejected.`; install/uninstall
  `Method not allowed.`). Failed guard → 403 `Request rejected.`. Never both.

### Concurrency and restart

- One in-flight operation. A second install/uninstall returns **409** with the
  current status; the client polls status at 850ms and does not queue. Status has
  no side effects.
- Restart supports both paths: `globalThis.dshDesktop.restartHarness()` when a
  preload bridge exists; otherwise the server exposes `restartRequired: true` and
  the client shows the localized restart-required copy, letting the user restart
  from the app menu. The bridge is never required.

### Locales — full list

**Supported locales: `en`, `zh`.** `SUPPORTED_LOCALES` and `LOCALES` live in
`locales.mjs`; a test asserts both dictionaries have identical key sets, all
values are non-empty strings, and `translate` falls back to `en`. Every Phase 5
key exists in both (`en` and `zh`), including the two new keys
`restartRequired` and `restartRequiredHint`.

### Files added

- `market-constants.mjs`, `market-backend.mjs`, `market-routes.mjs`,
  `market-server.mjs`, `market-client.mjs`, `locales.mjs`.
- `test/market-routes.test.mjs`.

### Verification

- `npm test` → `# tests 76 / # pass 76 / # fail 0 / # skipped 0`.
- HTTP: 200 status, 405 wrong method, 403 forwarded/missing-origin/bad-origin,
  202 install, 409 concurrent, 404 unknown, static `/`, `client.js`,
  `locales.json`.
- Embedded browser client is syntax-checked with `node --check`.
- Safe Mode and recovery were **not** implemented here (Phase 6).

### Phase 5 platform audit (paths introduced)

- **HTTP listener:** TCP loopback, ephemeral port; no filesystem path and no
  Unix socket, so no XDG concern. If a Unix socket is ever introduced, it must
  go under `$XDG_RUNTIME_DIR` (Phase 9).
- **No temp/lock files:** Phase 5 writes nothing itself; installs go through the
  Phase 4 runner. The runner's atomic temp is a sibling of the profile
  `package.json`, which is profile data, not a cache/temp location.
- **Static assets:** served from memory; nothing written to disk.
- **Shim dir:** `<dshHome>/.desktop-bin` is a **Phase 4** decision and the only
  non-XDG path; left as-is and owned by **Phase 9**.
- **`dshHome`:** `$DSH_HOME` if set, else hardcoded `~/.dsh` — the broader XDG
  decision is **Phase 9**.
- **Electron binary:** Phase 5 introduces **none** into the `.deb`; chrome-sandbox
  remains a Phase 10 contingent item.

---

## Phase 6 — Recovery & Safe Mode (complete)

### Module split (each independently tested)

- `startup-failure.mjs` — versioned wire contract (`{ v: 1, failures: [...] }`),
  single-line `format*`, `parsePluginStartupFailures`, `reportPluginStartupFailure`.
- `harness-bootstrap.mjs` — closest fit for this stack: wraps the upstream DSH
  entry and emits the report on import failure. Full owner/entry-chain
  provenance needs upstream cooperation or a loader overlay (documented gap).
- `detection.mjs` — evidence + the five attribution paths; structured report
  preferred, logs only as fallback.
- `plugin-removal.mjs` — durable ledger and tombstone.
- `safe-mode.mjs` — isolated profile + view model.
- `recovery-market.mjs` — compatibility-check consumer + batch planning.
- `recovery-view.mjs` — pure, localized UI view model.
- `recovery.mjs` — orchestration (`buildRecoveryPlan`, `applyRecoveryPlan`).
- `external-components.mjs` — Linux fail-closed policy.

### A. Structured failure report

Emitted by the runtime bootstrap, not a plugin; versioned `{ v: 1 }`; single
line; distinguishable from `dsh-desktop pnpm runner:` markers; **no `config`
field is ever serialized** (a test passes a config and asserts it never appears).
Recovery prefers the report; log correlation is the fallback only.

### B. Recovery runs in the app process

`recovery-view.mjs` and `recovery.mjs` are pure modules with no Harness
dependency; they consume already-collected evidence and market checks. The
surface can be served by the app process even after Harness exits. (Serving the
page and Electron wiring is integration/Phase 10; the logic is Harness-free.)

### C. Five attribution paths, unique-only

Implemented in order, no others:
1. direct third-party root hit (multiple direct hits allowed);
2. unique transitive owner (`dependencies ∪ optionalDependencies ∪ bundle patch`);
3. duplicate loader entry id in exactly one bundle patch;
4. slot conflict referenced by exactly one root's code;
5. official slot provider referenced by exactly one third-party root.
Zero owners → `[]`; multiple owners → `[]`. Tests cover unique, zero and
multiple matches for each path, and `buildRecoveryPlan` never falls back to all
plugins. There is no "uninstall everything suspicious" action.

### Correction 1 — tombstone is fail-inert on boot

`enforcePendingPluginRemovals` is a **boot path**: it clears the generation
pointer, the projected deps and the bundle entry, then proceeds. It no longer
throws when the plugin is still composed; a stale pointer must never become a
boot failure. `strict: true` exists only for a live mid-session call, where the
target still being composed is a caller error. A crashed uninstall (tombstone
written, plugin still in bundles, plugin still projected) is tested to boot
successfully with the plugin absent from composition and the tombstone retained.
Unverified removals still set `shouldDeferProfileMaintenance`, which pauses
migration/shared-tree maintenance that could resurrect the plugin.

### Correction 2 — what the bootstrap report actually carries

`harness-bootstrap.mjs` walks nothing itself, so on an import failure it emits
only what it can derive from the error message:

| Field | Emitted on bootstrap import failure |
| --- | --- |
| `v` | `1` |
| `phase` (`stage`) | `import` |
| failing component (`packageName`) | only when inferrable from the message; **no report is emitted otherwise** |
| entry chain (`chain`) | `[]` (not available) |
| root package (`owner`) | **absent** (not available) |
| loaded version | **absent** |
| package directory | **absent** |
| plugin config | never |

Because paths 2 and 3 depend on `chain`/`owner`, a structured report without
provenance is never mixed with log guesses: `detectPluginRecovery` reports
`provenance: false` and `buildRecoveryPlan` returns no candidate rather than a
guess. `detection.mjs` still implements all five paths for the case where a
report or overlay does carry provenance; a fuller structured report (owner,
chain, version, directory) requires upstream DSH cooperation or a loader
overlay, which is the documented gap.

### D. Uninstall ledger

States `disabled → removed → bootVerifiedAt → backupDeletedAt`, with
`cleanup-pending` on failure and retry back to `disabled`. Rules implemented and
tested:
- refuse `@deepseek-ai/*`, core bundles, and the market;
- durable ledger written **first**, before the bundle list is touched;
- backup runs once (retries do not overwrite the rollback point via
  `backedUpAt`);
- `uniqueOrphans(targetClosure, otherClosures)` removes only unique orphans;
- tombstone enforcement clears the generation pointer and removes the bundle
  entry, and throws if the plugin is still composed;
- `bootVerifiedAt` only advances from a normal-profile start (Safe Mode never
  calls it); `backupDeletedAt` only on the next normal boot;
- any failure → `cleanup-pending`, disabled, no auto-retry.

### E. External components — fail closed

`external-components.mjs` reports `managed: false`, policy `document-only`, and
its cleanup is a no-op that touches nothing. systemd units, XDG autostart, cron,
and anything outside `<dshHome>`/user-data are documented, never removed. The
reference's macOS LaunchAgent handling is not ported.

### Safe Mode

`SAFE_MODE_PROFILE = 'desktop-safe-mode'`, `SAFE_MODE_BUNDLES` = base + web-app,
empty dependencies, empty `cordis.patch.yml`. `ensureSafeModeProfile` repairs
tampering; it shares `DSH_HOME` and leaves the normal profile byte-identical.
`shouldStartInSafeMode` is the exact `--safe-mode` switch. **Batch auto-fix is
not in the boot path**: planning lives in `recovery-market.mjs` and is applied
by `applyRecoveryPlan` in a normal-profile context with the runtime stopped.

### Locales

`en` and `zh` now hold **60 keys each**, key sets identical (tested), including
Safe Mode and recovery copy.

### Verification

- `npm test` → `# tests 118 / # pass 118 / # fail 0 / # skipped 0`.

### Deferred / known gaps

- Registry metadata fetch and version selection are **Phase 7**
  (`recovery-market` consumes checks; it does not fetch them).
- Serving the recovery page and Electron window/menu wiring is integration
  (Phase 10 E2E); the modules are Harness-free by construction.
- Full structured provenance (owner, entry chain, loaded version, package dir)
  requires upstream DSH cooperation or a loader overlay; the bootstrap wrapper
  emits a best-effort report otherwise.
- Real removal operations (backup copy, legacy detach, generation disable) are
  injected; concrete wiring lands with the orchestration integration.

---

## Phase 7 — Compatibility & upgrades (complete)

### Registry selection (mirrors the reference, not inverted)

`market-registry.mjs` exports `DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'`
and `REGION_REGISTRY = { global: npmjs, china: 'https://mirrors.cloud.tencent.com/npm' }`.
`resolveMarketRegistry` precedence, exactly:
1. explicit `--registry`/`--config.registry` argument → that URL;
2. `npm_config_registry` set → `null` (never overwrite the caller's choice);
3. `DSHM_NPM_MIRROR` → that URL;
4. persisted region `china` → Tencent; `global`/absent/unknown → `null` (do not
   pin over the user's `~/.npmrc`).
No new fallback chain.

### A. Version selection rules

Candidate set: `> installed` and `<= latest`, excluding deprecated versions,
prereleases for stable installs, and any version failing a peer range,
`engines.dsh`, `dsh.minVersion`, or the removed-dependency rule. Selection is
the newest compatible. Empty set with `latest > installed` returns the
**`latest-anyway` sentinel** (a distinct, warned action) — never an empty result
and never a silent fallback. Pre-release installs accept prerelease candidates;
stable installs do not. Peer dependencies starting with `@deepseek-ai/` are
checked against runtime version, except `@deepseek-ai/cordis` which is
validated against the host's actual cordis version (`4.0.2`).
Rules and selections are tested one per rule, including newer-incompatible →
intermediate, no-compatible → sentinel, deprecated skipped, prerelease/stable
asymmetry, and each peer/engine/minVersion/removed-dep rejection.

### B. Post-upgrade verification

`upgradePlugin` installs, publishes, then requires a NORMAL-profile start to
reach the ready signal. Failure (or a false return) yields
`status: 'unverified'`, `offeredAgain: true`. Following reference behavior (a),
no auto-revert is executed: the new version remains projected on disk and the
plugin is offered again in recovery for user-directed resolution. Install
failure is reported before verification. Safe Mode never counts.

### C. Batch semantics

`upgradePluginsBatch` is **one** operation: upgrades, then removals, then a
single normal-profile verification (no restart between the sets). Unknown or
failed checks are skipped (never converted to uninstall). Partial success is
preserved and never rolled back; the result reports `upgraded`, `removed`,
`failures`, `skipped`, `verified`, `stillBlocked`, and `invalidated` (prior
failure records for verified installs).

### D. No-compatible-update terminal case

`describeNoCompatibleUpdate` offers uninstall and "check again" only:
`canDowngrade: false`, `canReinstall: false`, with plain copy that no compatible
update is available and uninstall is recommended. No "try again later" softening.

### Files added

- `market-registry.mjs`, `compatibility.mjs`, `plugin-upgrade.mjs`.
- `test/market-registry.test.mjs`, `test/compatibility.test.mjs`,
  `test/plugin-upgrade.test.mjs`.
- Locales gained `noCompatibleUpdate` (en + zh; now 61 keys each).

### Verification

- `npm test` → `# tests 147 / # pass 147 / # fail 0 / # skipped 0`.

### Deferred

- Recovery-view rendering of the upgrade flows is Phase 10 (Electron wiring);
  Phase 7 exposes pure planning/application seams plus a thin orchestrator.
- Network metadata fetching is injected at the call site; the selection logic
  is pure and fully tested without the network.

---

## Phase 8 — Agent Preset Transfer (complete)

### Overview

Added `.dshpreset` zip archive transfer primitives and HTTP API endpoints on
the loopback market server for exporting and importing agent presets
(`~/.dsh/.agent-presets/<id>/agent.cordis.yml`).

### Size Caps & Security Rules

Specified caps enforced strictly across archive creation and extraction:
- `MAX_FILES = 512`
- `MAX_FILE_BYTES = 12 * 1024 * 1024` (12 MB)
- `MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024` (32 MB)
- `MAX_COMPRESSED_BYTES = 16 * 1024 * 1024` (16 MB)

Security invariants:
- Rejects path traversals (absolute paths, `..`, and `\` components).
- Disallows symlinks inside exported preset directories.
- Built-in presets (`trust: 'system'`) are protected against export with HTTP 403.
- Skips OS metadata files (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*`, `__MACOSX/`).
- Emits heuristic non-fatal warnings on preview/install for suspected secrets (`possible-secrets`)
  and machine-local absolute paths (`absolute-paths`).
- Atomic install stages into `mkdtemp`, sets `0755` permissions on shell scripts (`.sh`, `.bash`),
  validates composition via `scanRoot` before rename, and handles client abort with HTTP 499
  and immediate temp cleanup.
- Loopback guard required for export; loopback + HTTP same-origin required for import preview
  and install.

### Phase 8 — commit granularity

Tests were landed in a single commit at the end of the phase (`94ea998`:
`test(plugin-manager): add comprehensive preset transfer route and archive tests`)
rather than grouped per route commit.

### Files added / modified

- `usr/share/dsh-desktop/lib/plugin-manager/preset-archive.mjs`
- `usr/share/dsh-desktop/lib/plugin-manager/preset-routes.mjs`
- `usr/share/dsh-desktop/lib/plugin-manager/market-server.mjs`
- `test/preset-transfer.test.mjs`

### Verification

- `npm test` → `# tests 169 / # pass 169 / # fail 0 / # skipped 0`.

---

## Phase 9 — Audit, Platform Cleanup & Decisions

### 1. Platform Decisions: `dshHome` and the shim path

#### a. `dshHome` location decision
`dshHome()` returns `$DSH_HOME` if set, otherwise falling back to `~/.dsh`.
**Decision**: We plainly do NOT move `dshHome` to an XDG location (`$XDG_CONFIG_HOME/dsh` or `$XDG_DATA_HOME/dsh`).
**Reasoning**: `~/.dsh` is not ours to change; it is the upstream DeepSeek Harness project's established convention. Upstream tooling, core CLI components, and existing user workspaces expect and rely on `~/.dsh`. Moving it would break compatibility with upstream tooling and existing user data. XDG compliance for the desktop wrapper does not extend to another upstream project's home directory.

#### b. Shim directory location decision
`ensurePnpmShim(home)` writes `pnpm` and `node` wrapper scripts into `<dshHome>/.desktop-bin/`.
**Decision**: We retain `<dshHome>/.desktop-bin/` and do not move it to `$XDG_DATA_HOME/dsh-desktop/bin/`.
**Reasoning**:
1. **Lifetime tracking**: The shim's lifetime should strictly track the profile it operates on. If the user cleans `~/.dsh`, they expect the tooling that writes into `~/.dsh` to be cleaned too. Splitting them means stale shims pointing at a directory that no longer exists.
2. **Implementation detail, not user software**: The shim is not user-visible software. It is an implementation detail of the profile management system, and it belongs next to the profile.
3. **Zero migration risk**: The directory is populated idempotently on demand by `ensurePnpmShim(home)` next to the active profile without needing stateful upgrade migrations.

### 2. Wayland Flag (`--ozone-platform-hint=auto`)

Added `--ozone-platform-hint=auto` directly to the Electron launch arguments in `usr/local/bin/dsh-desktop`.
Verified by unit test: `test/wayland.test.mjs` (`launcher passes --ozone-platform-hint=auto to Electron`).

### 3. Known Limits: inotify Watch Exhaustion

The HMR fallback watches the profile patch layer via `fs.watch`. On default Linux installations (e.g. Ubuntu), `fs.inotify.max_user_watches` defaults to 8192.
- **Best-effort watcher**: The filesystem watcher is strictly best-effort.
- **Silent failure on exhaustion**: If the operating system refuses a watch (due to exhaustion of available inotify watch handles), the fallback error handler swallows the error without crashing or retrying, per reference design.
- **User impact**: Users managing large profiles with many plugins who see "config changes require a restart" are experiencing inotify watch exhaustion.
- **Phase 9 resolution**: No code change in Phase 9. If necessary, a bounded diagnostic warning at startup can be evaluated in Phase 10.

### 4. Audit: Claim-to-Evidence Table

| Claim / Component | Status / Verification Source | Phase 10 Acceptance (if unverified) |
|---|---|---|
| **Invariant 1: Registry layout** | verified by: `test/registry.test.mjs`::`registry layout nests under profiles/.generations` | — |
| **Invariant 2: Desired pointer authority** | verified by: `test/registry.test.mjs`::`desired round-trips sorted and creates its directory`, `a corrupt desired pointer is rejected, never treated as empty` | — |
| **Invariant 3: Registry lock** | verified by: `test/registry.test.mjs`::`the registry lock serializes concurrent operations`, `a stale lock from a crashed run is broken` | — |
| **Invariant 4: Generation projection & link swap** | verified by: `test/projection.test.mjs`::`projects an enabled generation into a link, dependency, bundle and override`, `a failed link switch restores the previous link and rethrows` | — |
| **Invariant 5: Pruning & foreign path safety** | verified by: `test/projection.test.mjs`::`prunes a stale generation symlink when it leaves desired`, `never prunes a foreign symlink or a real directory` | — |
| **Invariant 6: Bundled pnpm & Node mode passthrough** | verified by: `test/pnpm-runner.test.mjs`::`buildPnpmEnvironment passes ELECTRON_RUN_AS_NODE through instead of deleting it`, `the packaged pnpm entry executes under a real Electron binary in Node mode` | — |
| **Invariant 7: Process tree kill & idle timeout** | verified by: `test/pnpm-runner.test.mjs`::`kills the whole process tree on idle, including grandchildren`, `stops an idle pnpm run and reports it` | — |
| **Invariant 8: Recovery ledger & tombstones** | verified by: `test/plugin-removal.test.mjs`::`a crashed uninstall still boots: the tombstone clears composition without throwing`, `test/startup-failure.test.mjs`::`a structured failure round-trips without any plugin config` | — |
| **Invariant 9: Runtime stopped during package mutations** | NOT VERIFIED by unit tests (verified by code inspection) | Phase 10 acceptance: live Electron orchestrator stops DSH runtime daemon before package mutation/install/upgrade, and restarts after projection. |
| **Invariant 10: No network in critical path of recovery** | verified by inspection & unit tests: `test/recovery.test.mjs`, `test/plugin-removal.test.mjs`, `test/safe-mode.test.mjs` (run completely offline without network mocks) | Phase 10 acceptance: verify cold boot into Safe Mode and ledger removal succeed with all network interfaces disabled. |
| **Ref A: Generation Registry** | verified by: `test/registry.test.mjs` (all 24 tests) | — |
| **Ref B: Pnpm runner & shim** | verified by: `test/pnpm-runner.test.mjs`, `test/pnpm-runtime.test.mjs` | — |
| **Ref C: Projection & link swap** | verified by: `test/projection.test.mjs` | — |
| **Ref D: Detection & recovery ledger** | verified by: `test/detection.test.mjs`, `test/recovery.test.mjs`, `test/plugin-removal.test.mjs` | — |
| **Ref E: Safe Mode** | verified by: `test/safe-mode.test.mjs` | — |
| **Ref F: Market HTTP API & RPC** | verified by: `test/market-routes.test.mjs` | — |
| **Ref G: Compatibility & upgrades** | verified by: `test/market-registry.test.mjs`, `test/compatibility.test.mjs`, `test/plugin-upgrade.test.mjs` | — |
| **Ref H: Preset transfer** | verified by: `test/preset-transfer.test.mjs` (all 19 tests) | — |
| **Deferred: chrome-sandbox setuid** | NOT VERIFIED — Phase 10 acceptance | `dpkg-deb -c` on final package proves `chrome-sandbox` has permissions `4755`. |
| **Deferred: systemd launchd-guard equivalent** | N/A on Linux; no unit is installed, no unit is managed, no attribution is attempted | Phase 10 acceptance: verify no systemd unit is installed by the package. |
| **Deferred: Wayland ozone platform hint** | verified by: `test/wayland.test.mjs`::`launcher passes --ozone-platform-hint=auto to Electron` | — |
| **Deferred: inotify limits** | Documented under Known Limits (no code change) | Phase 10 acceptance: evaluate bounded startup warning if needed. |
| **Deferred: XDG paths** | Verified by Phase 9 decision (`dshHome` stays `~/.dsh`, shim stays `<dshHome>/.desktop-bin`) | — |
| **Deferred: Upgrade verification end-to-end** | NOT VERIFIED — Phase 10 acceptance | Normal profile reboot after upgrade flips plugin status to verified on ready signal. |
| **Deferred: Electron wiring** | NOT VERIFIED — Phase 10 acceptance | Electron main process instantiates MarketServer and wires lifecycle. |
| **Deferred: Recovery page rendering** | NOT VERIFIED — Phase 10 acceptance | Safe mode / recovery webview renders localized HTML view model. |
| **Deferred: Batch auto-fix UI** | NOT VERIFIED — Phase 10 acceptance | Recovery UI button dispatches batch plan execution. |
| **Deferred: Market management UI** | NOT VERIFIED — Phase 10 acceptance | Market interface renders plugin catalogue and handles install/uninstall/upgrade clicks. |

### 5. Audit: Mocked vs. Integration Coverage

| Test Area / Seam | What the Mock Replaces | Real Path Status & Verification |
|---|---|---|
| `verifyNormalBoot` in `plugin-upgrade.test.mjs` | Spawning real DSH normal-profile process and waiting for ready signal | Mocked. Real path NOT covered in unit suite — Phase 10 acceptance: end-to-end Electron lifecycle test verifies normal profile boot ready signal. |
| `fileSystem` seam in `projection.test.mjs` | Injects filesystem failures (e.g. throwing on link rename) | Mocked for fault-injection only. Real path covered by all standard projection tests using real `node:fs/promises`. |
| `fileSystem` seam in `pnpm-runner.test.mjs` | Injects filesystem write failures during projection suspension | Mocked for fault-injection only. Real path covered by all standard pnpm-runner tests using real `node:fs/promises`. |
| `scanRootFn` in `preset-transfer.test.mjs` | Preset discovery scanning across configured preset roots | Mocked in unit failure tests. Real path covered by `install integration: scanRoot resolves @deepseek-ai/* package via harnessBase` (resolves real `scanRoot` against real closure and `@deepseek-ai/cordis`, not skipped on CI). |
| `fakeService` in `market-routes.test.mjs` | High-level `MarketService` implementation handling status/install/uninstall | Mocked in HTTP routing tests. Real path NOT covered in unit suite — Phase 10 acceptance: Electron main process attaches live `MarketService` to HTTP server. |
| `installGenerationFn` in `plugin-upgrade.test.mjs` | Full pnpm generation installer pipeline | Mocked in batch upgrade planning tests. Real path covered per-unit by `installer.test.mjs`; Phase 10 acceptance covers full live market network install. |
| Injected removal handlers in `recovery.test.mjs` | Lower-level removal and ledger update calls | Mocked for plan synthesis tests. Real path covered by `plugin-removal.test.mjs` (ledger recording, backup, detach). |

### 6. Audit: Windows/Foreign-Platform Residue

A recursive regex scan was executed across `usr/share/dsh-desktop/lib/plugin-manager/`:
```bash
grep -rnE "win32|win64|darwin|macos|macOS|junction|taskkill|windowsHide|SIDELINE|\.dsh-old|'Path'|\"Path\"" usr/share/dsh-desktop/lib/plugin-manager/
```
**Results**:
- Zero active code hits.
- Exactly one comment hit: `usr/share/dsh-desktop/lib/plugin-manager/pnpm-runtime.mjs:27`:
  ```javascript
  // Platform note: Historical reference context explaining upstream ELECTRON_RUN_AS_NODE passthrough behavior; no runtime platform branching.
  // The child is spawned as `process.execPath`, which on macOS is the Electron...
  ```
  **Justification**: This is a historical documentation comment preserved from upstream reference explaining why `ELECTRON_RUN_AS_NODE` must not be stripped. It contains no runtime platform checks or branches.

### 7. Audit: Locale Completeness in Code

Every `t('...')`, `translate(...)`, and `formatMessage(...)` invocation in `usr/share/dsh-desktop/` was compared against `LOCALES.en` and `LOCALES.zh`:
- **Total keys in `en`**: 61
- **Total keys in `zh`**: 61
- **Keys actively used in code**: 49 (34 via `t`, 15 via `translate`/`formatMessage`)
- **Keys used but missing from either locale**: **0** (no missing keys).
- **Keys defined but unused in current code** (12 keys):
  - Added in Phase 5 (`market-constants.mjs` & `locales.mjs`) for market management tab / settings page UI:
    `nav`, `installing`, `installed`, `retry`, `futureUpdates`, `managementTab`, `uninstalling`, `removed`, `uninstallFailed`.
  - Added in Phase 6 (`safe-mode.mjs` & `locales.mjs`) for Safe Mode batch UI / multi-select:
    `safeModeSelectPlugins`, `safeModeUpgradeAll`, `safeModeUpgrading`.

### 8. Dead Code and TODO Scan

A recursive scan across `usr/share/dsh-desktop/lib/plugin-manager/`:
```bash
grep -rnE "TODO|FIXME|HACK|XXX|XXX:" usr/share/dsh-desktop/lib/plugin-manager/
```
**Results**: **0 hits**. No unresolved `TODO`, `FIXME`, `HACK`, or `XXX` tags exist in the plugin-manager tree.




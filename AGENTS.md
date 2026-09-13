# AGENTS.md

> Standalone desktop workspace & Debian package for DeepSeek Harness (@deepseek-ai/dsh).

## Build
```bash
npm ci              # Install/vendor build dependencies (pnpm, fflate)
./build.sh          # Assembles staging tree and packages dsh-desktop_1.0.0_amd64.deb via dpkg-deb
```

## Test
```bash
npm test            # Run full suite via Node test runner: node --test
node --test test/<name>.test.mjs  # Run single test file
```

## Lint / Format
No project-level JS linter configured. `build.sh` runs `lintian` on the output deb if installed.

## Structure
```
debian/                                # Debian control metadata, postinst, prerm, postrm
docs/                                  # Architecture & logging docs (plugin-market-parity.md, logging.md)
lib/systemd/user/                      # Systemd user service definition (dsh-desktop.service)
usr/lib/dsh-desktop/bin/               # CLI and desktop launcher scripts (dsh-desktop, daemon)
usr/share/dsh-desktop/app/             # Electron desktop frontend (main.js, preload.cjs, views)
usr/share/dsh-desktop/lib/plugin-manager/ # Plugin registry, projection, recovery, and runner engines
usr/share/dsh-desktop/packages/        # Market installer service package
test/                                  # Integration & unit test suites (Node.js ESM)
```

## Conventions
- Node.js ESM throughout (`type: "module"` in `package.json`, `.mjs` extensions for plugin manager).
- Never depend on system `pnpm`; package bundles and resolves pinned `pnpm` from `usr/share/dsh-desktop/node_modules`.
- Node must launch with `--expose-internals` directly as CLI arg before script; never via `NODE_OPTIONS`.
- Profile mutations must be atomic and reversible via projection & safe-mode recovery mechanics.

## Session Policy (Enforced)
- **Ponytail (Moderate)**:
  - Enforce Ponytail ladder on all tasks: check YAGNI first before writing code.
  - Prefer standard library and native platform features over dependencies or custom abstractions.
  - Deliver shortest working diff. Boring over clever. No speculative scaffolding or single-implementation abstractions.
  - Never simplify away input validation, error handling, security, or explicit requirements.
- **Caveman (Moderate)**:
  - Terse, high-density technical communication across every response.
  - Drop conversational filler, pleasantries, hedging, and tool-call narration.
  - Keep sentences clear, direct, and grammatically complete so technical ambiguity never occurs.
  - Code blocks, CLI commands, file paths, and exact error strings remain verbatim.

## Task → File Map
| Task | File(s) |
| --- | --- |
| Plugin registry / generation slots | `usr/share/dsh-desktop/lib/plugin-manager/registry.mjs` |
| Symlink projection & bundle state | `usr/share/dsh-desktop/lib/plugin-manager/projection.mjs` |
| Preset archive export / import | `usr/share/dsh-desktop/lib/plugin-manager/preset-routes.mjs`, `preset-archive.mjs` |
| Crash recovery & safe mode | `usr/share/dsh-desktop/lib/plugin-manager/recovery.mjs`, `safe-mode.mjs` |
| Electron window, tray & splash | `usr/share/dsh-desktop/app/main.js`, `preload.cjs` |
| Daemon & desktop launcher scripts | `usr/lib/dsh-desktop/bin/dsh-desktop`, `usr/lib/dsh-desktop/bin/dsh-desktop-daemon` |
| Debian package assembly & metadata | `debian/control`, `debian/postinst`, `build.sh` |

## Boundaries
- Do not edit generated package output (`dsh-desktop_*.deb`, `build/`).
- Do not add direct host npm dependencies that break offline package extraction.
- Do not remove `--expose-internals` from daemon/launcher invocations.

## Gotchas
- `build.sh` fails if `node_modules/pnpm` or `node_modules/fflate` is missing (always run `npm ci` first).
- Electron flags require `--ozone-platform-hint=auto` for Wayland support on Ubuntu/Zorin.

# Never touch

- Bundled production dependencies in `node_modules/`: do not edit directly or delete (they are vendored into the deb at build time).
- Build output archives: `*.deb` and anything under `build/`.
- Knowledge graph artifacts: `graphify-out/`, `.graphify*`.
- Lock files: do not modify `package-lock.json` manually.
- Upstream runtime requirement flags: do not remove `--expose-internals` from daemon/launcher scripts.
- Secrets: `.env`, credentials, tokens.

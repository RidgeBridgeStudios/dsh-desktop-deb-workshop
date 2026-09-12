# Ask before doing

- Modifying `debian/control`, `debian/postinst`, or `debian/prerm` packaging definitions.
- Changing `package.json` dependencies or updating pinned `pnpm` / `fflate` versions.
- Altering user profile path logic or data layout in `usr/share/dsh-desktop/lib/plugin-manager/paths.mjs`.
- Deleting test files or altering test invariants in `test/`.
- Pushing to `main` or modifying git branches/tags directly.

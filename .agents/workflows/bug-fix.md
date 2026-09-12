# Bug fix

1. Reproduce the bug using an explicit test case under `test/<module>.test.mjs`.
2. Trace root cause through `usr/share/dsh-desktop/lib/plugin-manager/` using systematic debugging.
3. Keep the reproduction test as a permanent regression test.
4. Apply the minimal fix directly addressing the cause without modifying unrelated contracts.
5. Run `npm test` to ensure all tests pass.
6. Verify package builds via `./build.sh`.

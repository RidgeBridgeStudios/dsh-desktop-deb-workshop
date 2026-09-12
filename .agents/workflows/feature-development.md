# Feature development

1. Read `AGENTS.md` and `.agents/context-index.md`.
2. Identify target files to modify using the Task → File Map.
3. Formulate an implementation plan before writing or changing any code.
4. Add a test in `test/<module>.test.mjs` reproducing the target behavior (TDD).
5. Implement the minimal change (Ponytail principles: avoid adding dependencies, reuse existing utilities).
6. Run `npm test` to verify all 185+ unit and integration tests pass.
7. Run `./build.sh` to verify package packaging and staging assemble cleanly.
8. Summarize changes and verified behavior.

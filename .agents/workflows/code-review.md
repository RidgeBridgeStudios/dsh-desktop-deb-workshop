# Code review

1. Inspect `git diff` against base branch.
2. Check conformance against:
   - Minimalism / Ponytail: no bloated dependencies, no unnecessary abstractions.
   - Atomicity: ensures profile mutations in `projection.mjs` or `registry.mjs` maintain rollback safety.
   - Security: check preset paths, archive bounds, and subprocess arguments in `pnpm-runner.mjs`.
   - Test coverage: verify corresponding tests added or updated in `test/`.
3. Report findings categorized by severity (Critical, Warning, Suggestion).
4. Do not edit source files during review.

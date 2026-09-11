# Guardian Agent Notes

## Toolchain and Commands

- Use Node.js 20+ and the pinned `pnpm@10.28.1`; run workspace commands from the repository root.
- Full verification is `pnpm typecheck && pnpm test`. There are no repository lint, format, or build scripts.
- Run one test file with `pnpm --filter @guardian/project-scanner exec vitest run tests/scanner.test.ts`; add `-t "test name"` for one test.
- Exercise the CLI from the root with `pnpm guardian scan ./test-projects/sample-typescript-app` or `pnpm guardian inspect ./test-projects/sample-typescript-app axios`. `target` contacts the public npm registry; `scan` and `inspect` must remain offline.

## Repository Boundaries

- The pnpm workspace includes only `apps/*` and `packages/*`. `test-projects/*` are scanner fixtures, not workspace packages; do not install into them or add them to `pnpm-workspace.yaml`.
- `apps/cli/src/index.ts` owns argument validation and text output only. Keep scanning, resolution, and artifact logic in `packages/project-scanner` and expose public APIs through `packages/project-scanner/src/index.ts`.
- The scanner package exports TypeScript source directly and uses ESM with `NodeNext`; relative TypeScript imports must use `.js` specifiers. There is no generated or compiled tree to edit.
- Strict typechecking includes `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; omit absent optional fields instead of assigning `undefined`.

## Behavioral Invariants

- `scanProject` is read-only: never execute target code or package scripts, modify the target, inspect `node_modules`, or make network requests. Source discovery intentionally skips generated/build/cache directories.
- Installed-version resolution supports pnpm lockfile v9. Nested workspace scans locate the workspace lockfile and require an exact importer; do not fall back to the root importer. npm and Yarn resolution intentionally report `unsupported`.
- Outputs and derived contexts are deterministic. Preserve sorted dependencies, files, imports, API summaries, and occurrences.
- Canonical APIs use `default.*`, `namespace.*`, and `package/subpath#API`; constructor-instance evidence keeps observed local paths when no canonical mapping is proven.
- Artifact acquisition is security-sensitive: preserve public-registry URL restrictions, manual redirect rejection, integrity verification before extraction, archive path/type/size preflight, extracted manifest identity checks, and cleanup on every failure.
- Successful artifacts live under OS temp `guardian-artifact-*` roots. Call cleanup with the exact returned artifact object; pair cleanup must handle deduplicated installed/target artifacts.

## Tests

- All tests live in `packages/project-scanner/tests`; CLI integration tests are in `dependency-context.test.ts` rather than under `apps/cli`.
- Tests use injected `fetch`, synthetic tarballs, root fixtures, and OS temp directories; they require no external service or live registry access.
- Scanner or resolution behavior changes often require coordinated updates to `test-projects/sample-typescript-app` or `test-projects/sample-pnpm-workspace` and their assertions.

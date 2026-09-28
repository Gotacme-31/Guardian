# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Guardian is

Guardian is a local, read-only tool for understanding how a Node.js/TypeScript project depends on
external packages, and for statically comparing package declaration surfaces across versions. It
does not install packages, execute target code, classify breaking changes, score risk, use AI, or
integrate with GitHub. It is an experimental prototype (see `README.md` for the full milestone
description, CLI examples, safety model, and current limitations).

## Commands

- Use Node.js 20+ and the pinned `pnpm@10.28.1`; run workspace commands from the repository root.
- Full verification: `pnpm typecheck && pnpm test`. There are no lint, format, or build scripts.
- Run one test file: `pnpm --filter @guardian/project-scanner exec vitest run tests/scanner.test.ts`
  (add `-t "test name"` to run a single test).
- Run the CLI from the root:
  - `pnpm guardian scan ./test-projects/sample-typescript-app`
  - `pnpm guardian inspect ./test-projects/sample-typescript-app axios`
  - `pnpm guardian target ./test-projects/sample-typescript-app axios latest`
  - Equivalent filtered form: `pnpm --filter @guardian/cli dev scan ../../test-projects/sample-typescript-app`
  - `scan` and `inspect` must remain fully offline; `target` is the only command allowed to contact
    the public npm registry.

## Repository boundaries

- The pnpm workspace includes only `apps/*` and `packages/*`. `test-projects/*` are scanner
  fixtures, not workspace packages — never install into them or add them to `pnpm-workspace.yaml`.
- `apps/cli/src/index.ts` owns argument validation and text output only. All scanning, resolution,
  and artifact logic belongs in `packages/project-scanner`, exposed through
  `packages/project-scanner/src/index.ts`.
- The scanner package exports TypeScript source directly and uses ESM with `NodeNext`; relative
  TypeScript imports must use `.js` specifiers. There is no generated or compiled tree to edit.
- Strict typechecking (`tsconfig.base.json`) includes `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`; omit absent optional fields instead of assigning `undefined`.

## Architecture

```
apps/cli                         argument handling and text output only
packages/project-scanner         read-only project inspection and public contracts
  src/dependency-resolution      normalized resolution and pnpm lockfile adapter
  src/dependency-context         pure correlation over ProjectScanResult
  src/target-resolution          npm metadata client and SemVer target resolver
  src/package-artifact           verified download, tar preflight, extraction, cleanup
  src/declaration-surface        static declaration entrypoints, exports, and signatures (M6)
  src/declaration-diff           pure deterministic structural surface comparison (M7)
test-projects/sample-typescript-app     deterministic scanner fixture
test-projects/sample-pnpm-workspace     pnpm workspace/importer fixture
```

Public API surface (`packages/project-scanner/src/index.ts`):

```ts
scanProject(projectPath: string): Promise<ProjectScanResult>
buildDependencyContexts(scan: ProjectScanResult): DependencyContext[]
findDependencyContext(contexts: DependencyContext[], dependency: string)
resolveDependencyTarget(context: DependencyContext, requestedTarget: string)
createPackageArtifactAcquirer(options?: ArtifactAcquisitionOptions): PackageArtifactAcquirer
acquirePackageArtifact(dependency: string, version: string): Promise<AcquiredPackageArtifact>
acquireDependencyArtifactPair(context: DependencyContext, target: ResolvedDependencyTarget): Promise<AcquiredDependencyArtifactPair>
cleanupPackageArtifact(artifact: AcquiredPackageArtifact): Promise<void>
cleanupDependencyArtifactPair(pair: AcquiredDependencyArtifactPair): Promise<void>
DEFAULT_ARTIFACT_LIMITS
extractDeclarationSurface(artifact: AcquiredPackageArtifact, options?: DeclarationSurfaceOptions): Promise<PackageDeclarationSurface>
DEFAULT_DECLARATION_SURFACE_LIMITS
compareDeclarationSurfaces(before: PackageDeclarationSurface, after: PackageDeclarationSurface): PackageDeclarationSurfaceDiff
```

The pipeline flows roughly: `scanProject` (source discovery + imports/usages) →
`buildDependencyContexts` (pure in-memory correlation of declarations, resolutions, imports,
usages) → `resolveDependencyTarget` (npm target resolution) →
`acquirePackageArtifact`/`acquireDependencyArtifactPair` (verified tarball download) →
`extractDeclarationSurface` (M6: static declaration extraction) →
`compareDeclarationSurfaces` (M7: pure structural diff).

Canonical API paths use `default.*` for default imports, `namespace.*` for namespace imports, and
the imported symbol name for named imports; package subpaths are retained as
`package/subpath#API`. Constructor-instance usages keep their observed local paths when no
canonical mapping is proven. M7 identifies entrypoints by `exportPath` plus an ordered condition
path, and identifies exports/referenced declarations by public/local name plus M6 facet, with
`kind` compared as mutable structure (a function-to-class transition is one modification, not an
add+remove).

## Behavioral invariants

These are safety/determinism guarantees the codebase is built around — preserve them in any change:

- `scanProject` is read-only: never execute target code or package scripts, modify the target,
  inspect `node_modules`, or make network requests. Source discovery intentionally skips
  generated/build/cache directories.
- Installed-version resolution supports pnpm lockfile v9 only. Nested workspace scans locate the
  workspace lockfile and require an exact importer match; never fall back to the root importer.
  npm and Yarn resolution intentionally report `unsupported`. If more than one of
  `pnpm-lock.yaml`, `package-lock.json`, and `yarn.lock` exists at the project root, scanning must
  fail with an explicit ambiguity error rather than silently picking one.
- All outputs and derived contexts are deterministic: preserve sorted dependencies, files,
  imports, API summaries, and occurrences.
- Artifact acquisition is security-sensitive: preserve public-registry URL restrictions, manual
  redirect rejection, integrity verification before extraction, archive path/type/size preflight,
  extracted manifest identity checks, and cleanup on every failure path. Artifacts live under OS
  temp `guardian-artifact-*` roots; cleanup must be called with the exact returned artifact object,
  and paired cleanup must handle deduplicated installed/target artifacts.
- Declaration extraction (M6) reads only `package.json` and declaration files selected statically
  by `types`, `typings`, `exports`, or the root `index.d.ts` fallback; it never fetches, imports,
  requires, evaluates, installs, or executes package code, and never owns artifact cleanup.
  Parsing uses a `ts-morph` project backed by an in-memory filesystem so compiler resolution cannot
  reach an external `node_modules`.
- Declaration comparison (M7) is synchronous and pure: no I/O, parsing, network access, usage
  correlation, breaking-change classification, risk scoring, upgrade recommendation, or rename
  inference. It consumes only the supplied in-memory M6 contracts. Blocking extraction issues make
  the affected entrypoint comparison indeterminate rather than turning incomplete output into a
  confirmed addition/removal; duplicate semantic identities are reported explicitly rather than
  overwritten in a map.

See `README.md`'s "Current Limitations" section for the full, precise list of what is intentionally
*not* supported (symbol propagation scope, dynamic-import handling, TypeScript path mappings,
`typesVersions`, recursive type alias expansion, etc.) before assuming a gap is a bug to fix.

## Tests

- All tests live in `packages/project-scanner/tests`; CLI integration tests are in
  `dependency-context.test.ts` rather than under `apps/cli`.
- Tests use injected `fetch`, synthetic tarballs, root fixtures, and OS temp directories — no
  external service or live registry access is required.
- Scanner or resolution behavior changes often require coordinated updates to
  `test-projects/sample-typescript-app` or `test-projects/sample-pnpm-workspace` and their
  assertions.

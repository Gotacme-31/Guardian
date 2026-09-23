# Guardian

Guardian is a local tool for understanding how software projects depend on external packages. Its long-term direction is to assess dependency updates, identify breaking API changes, measure their real impact, verify migrations, and eventually support automated pull requests.

> Guardian is currently an experimental prototype.

## M8 Usage Impact Correlation

Guardian scans a Node.js or TypeScript project without modifying or executing it. It reports:

- whether the target is a Node.js and TypeScript project;
- the package manager indicated by a root lockfile;
- direct and development dependencies declared in `package.json`;
- source files importing each declared dependency;
- default, named, namespace, CommonJS, and dynamic imports;
- package root matching for regular, scoped, and subpath imports;
- calls, member access, constructors, and direct references to imported bindings;
- source file, line, and column for each symbol usage;
- member usage on simple instances created with `new ImportedClass()`;
- exact direct dependency resolutions from pnpm lockfile v9 importers;
- registry, workspace, link, file, Git, and URL resolution kinds;
- unresolved and unsupported resolution states without inspecting `node_modules`;
- deterministic dependency contexts correlating declarations, resolutions, imports, and usages;
- local and safely normalized canonical API paths with their original occurrences;
- npm target resolution for published versions, dist-tags, and SemVer ranges;
- normalized upgrade direction between installed and target versions;
- verified npm tarball acquisition into isolated temporary directories;
- static, normalized TypeScript declaration surfaces from acquired artifacts;
- pure structural comparison of two previously extracted declaration surfaces;
- correlation of each recorded API usage against that structural comparison, reported as affected, unaffected, unresolved, or indeterminate.

Target resolution and explicit artifact acquisition can contact the public npm Registry. Declaration extraction, comparison, and usage correlation are offline and never execute package code. Guardian does not install downloaded packages, classify breaking changes or risk, modify target projects, use AI, or integrate with GitHub.

## Architecture

```text
apps/cli                         argument handling and text output
packages/project-scanner         read-only project inspection and public contracts
  src/dependency-resolution      normalized resolution and pnpm lockfile adapter
  src/dependency-context         pure correlation over ProjectScanResult
  src/target-resolution          npm metadata client and SemVer target resolver
  src/package-artifact           verified download, tar preflight, extraction, cleanup
  src/declaration-surface        static declaration entrypoints, exports, and signatures
  src/declaration-diff           pure deterministic structural surface comparison
  src/usage-impact               pure correlation of recorded usage against a surface diff
test-projects/sample-typescript-app
                                  deterministic scanner fixture
test-projects/sample-pnpm-workspace
                                  pnpm workspace/importer fixture
```

The CLI contains no source-analysis logic. The scanner exposes:

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
correlateUsageImpact(context: DependencyContext, installedSurface: PackageDeclarationSurface, diff: PackageDeclarationSurfaceDiff): DependencyUsageImpact
```

Dependency contexts are derived in memory from a completed scan. Canonical API paths use
`default.*` for default imports, `namespace.*` for namespace imports, and the imported symbol
for named imports. Package subpaths are retained as `package/subpath#API`. Constructor-instance
usages keep their observed local paths when no canonical mapping is proven.

Declaration entrypoints retain `exportPath`, package-relative `declarationFile`, and every
`conditionPaths` route selecting that file. This preserves distinct declaration variants such as
`types/require` and `types/default` without pretending that one runtime condition is universal.
For static `.js`, `.mjs`, and `.cjs` export targets, M6 checks only the adjacent `.d.ts`, `.d.mts`,
or `.d.cts` substitution inside the artifact.
Each public declaration records its exported identity, declaration kind, deterministic facet,
package-relative source file, default/export-equals/type-only state, canonical signatures,
deprecation marker, and normalized members or namespace exports where applicable.
Each entrypoint also fingerprints non-exported local or relative declarations referenced by its
public signatures in `referencedDeclarations`, so a future comparison does not need to parse the
artifact again to detect changes hidden behind a public type name.

M6 performs extraction and normalization. M7 consumes two completed `PackageDeclarationSurface`
values and compares entrypoint variants, public facets, canonical signatures, members, nested
namespaces, external re-exports, and referenced declarations. Entrypoints are identified by
`exportPath` plus an ordered condition path; declaration files and declaration source files are
reported separately as provenance. Exports and referenced declarations are identified by their
public/local name plus M6 facet, with `kind` compared as mutable structure so a function-to-class
transition remains one modification.

M7 is synchronous and pure. It performs no I/O, parsing, network access, usage correlation,
breaking-change classification, risk scoring, upgrade recommendation, or rename inference.

M8 translates each M3 `ApiUsageSummary.canonicalPath` into a location inside the installed
`PackageDeclarationSurface` (an entrypoint plus a chain of exported/nested-namespace names, ending
optionally at a class/interface/enum member), then reports whether that location appears in an
M7 `PackageDeclarationSurfaceDiff`. A usage is `unresolved` when it never had a canonical path or
the translated location does not exist in the installed surface, `indeterminate` when the
translation is ambiguous (declaration merging produced more than one candidate facet, a member
name is shared by more than one declared member such as a getter/setter pair, or the path
continues past a declaration kind that cannot hold members or nested exports) or when the M7
diff itself marks the relevant entrypoint variant as indeterminate, `affected` when the location
appears in the diff's export, member, or nested changes, and `unaffected` otherwise. An entrypoint
exposed under more than one `conditionPaths` variant is checked against every variant; a change in
any one of them marks the usage `affected`. M8 never turns missing or ambiguous evidence into a
confirmed affected/unaffected verdict, mirroring M7's indeterminate-over-guess principle.

M8 is synchronous and pure. It performs no I/O, parsing, or network access, and it does not
classify breaking changes, score risk, recommend an upgrade, or infer renames.

## Requirements

- Node.js 20 or newer
- pnpm 10

## Installation

```bash
pnpm install
```

## CLI

From the repository root:

```bash
pnpm guardian scan ./test-projects/sample-typescript-app
pnpm guardian inspect ./test-projects/sample-typescript-app axios
pnpm guardian target ./test-projects/sample-typescript-app axios latest
```

`inspect` performs one scan and prints the correlated declaration, resolution, imports, evidence,
and API occurrences for the requested dependency.

`target` sends only the encoded public package name to `registry.npmjs.org`, resolves an exact
version from a dist-tag, exact version, or SemVer range, and reports the version change type,
including prerelease-only transitions.
`scan` and `inspect` remain offline.

The equivalent filtered workspace command is:

```bash
pnpm --filter @guardian/cli dev scan ../../test-projects/sample-typescript-app
```

Example output:

```text
Guardian v0.0.1

Project
  sample-typescript-app

Environment
  Node.js      yes
  TypeScript   yes
  Package mgr  pnpm

Dependencies
  7 direct
  2 development

axios
  declared  ^1.7.0
  resolved  1.7.9
  source    registry

Usage

axios
  2 files
  imports:
    3 imports
    default: axios
    symbols: AxiosError
  usages:
    axios.get                      src/http.ts:10:22
    axios.post                     src/http.ts:11:22
    axios.defaults.headers.common  src/http.ts:12:30
    axios.create                   src/second-http.ts:3:29
```

## Tests

```bash
pnpm test
```

The tests cover M1/M1.1 scanning, M2 pnpm resolution, M3 context correlation, offline M4 target resolution, synthetic M5 tarball acquisition, offline M6 declaration extraction, pure M7 comparison including variants, facets, overloads, members, namespaces, referenced declarations, provenance, incomplete surfaces, input immutability, and determinism, and pure M8 usage correlation including default/named/namespace-import convergence, member access, ambiguous facets, ambiguous member-name correlation, unresolvable member access, multi-variant entrypoints, indeterminate propagation from M7, installed-surface/diff package and version validation, input immutability, and determinism.

## Typecheck

```bash
pnpm typecheck
```

All workspace TypeScript uses strict mode.

## Safety

Scanning is read-only. Guardian does not install dependencies in the target, execute scripts or source files, alter manifests or lockfiles, or write into the target project.

The scanner uses the maintained `yaml` package only to parse existing pnpm lockfiles. It does not invoke pnpm internals or inspect `node_modules`. Registry operations use native Node.js `fetch` with an eight-second timeout, a 32 MiB metadata limit, and a `Guardian/0.0.1` User-Agent.

Artifacts are streamed to `guardian-artifact-*` directories directly under the operating system temp directory. SRI metadata is verified with `ssri`; legacy SHA-1 is accepted only when SRI is absent. Extraction starts only after verification, uses `tar` strict mode, rejects links and special entries, and requires an exact `package/package.json` name/version match. Callers own successful artifacts and must invoke the cleanup API; cleanup ownership is tied to the exact returned object and is idempotent.

Default artifact limits are 50 MiB compressed, 250 MiB extracted, 20,000 filesystem entries including implied parents, 50 MiB per file, a 1,000:1 compression ratio, and 256 path segments.

Declaration extraction reads only `package.json` and declaration files selected statically by
`types`, `typings`, `exports`, or the root `index.d.ts` fallback. All metadata and relative
re-export paths are checked lexically and through canonical filesystem paths. Open files must
match the validated device/inode, and declaration reads are byte-bounded. Parsing uses a
`ts-morph` project backed by an in-memory filesystem, so compiler resolution cannot inspect an
external `node_modules`. M6 never fetches, imports, requires, evaluates, installs, or executes
package code and never owns artifact cleanup.

Declaration comparison consumes only the supplied in-memory M6 contracts. Blocking extraction
issues make the affected entrypoint comparison indeterminate instead of turning incomplete output
into confirmed additions or removals. Original before/after extraction issues remain available on
the diff. Duplicate semantic identities are reported explicitly rather than overwritten in a map.
Recursive declaration graphs are cycle-checked, shared declaration pairs are memoized, and nested
comparison is capped at 256 levels with a normalized comparison issue instead of stack overflow.

Default declaration limits are 512 declaration files, 64 relative re-export edges per path,
10,000 declarations, 50,000 public/protected members, and 5 MiB per declaration file.

Usage impact correlation reads only the `DependencyContext`, `PackageDeclarationSurface`, and
`PackageDeclarationSurfaceDiff` objects already produced by M3/M6/M7; it never re-scans the
project, re-extracts declarations, or performs an additional M7 comparison. It validates that
`context.dependency`, `installedSurface.packageName`, and `diff.packageName` all agree, and that
`installedSurface.version` matches `diff.beforeVersion`, before correlating, throwing a typed
`UsageImpactCorrelationError` (`package-mismatch` or `version-mismatch`) otherwise. Recursion through nested
namespace exports is bounded by the finite segment count of a canonical path, so no depth limit
is needed the way M7 needs one for its diff-comparison graph.

If more than one of `pnpm-lock.yaml`, `package-lock.json`, and `yarn.lock` exists at the project root, scanning fails with an explicit ambiguity error. Guardian never selects a package manager silently in that situation.

## Current Limitations

- Installed dependency resolution currently supports pnpm lockfile v9 only; npm and Yarn return `unsupported` resolutions.
- Only direct `dependencies` and `devDependencies` are resolved.
- Registry aliases and pnpm references outside the documented v9 importer forms are left unresolved rather than inferred.
- Workspace membership is confirmed by an exact lockfile importer; workspace package patterns are not interpreted separately.
- Only static string module specifiers are recognized.
- Imports are associated only when the package root is declared in `dependencies` or `devDependencies`.
- TypeScript path mappings are not resolved; undeclared aliases are intentionally ignored.
- Re-exports and TypeScript `import = require()` are not analyzed.
- Dynamic-import binding usage is tracked only for direct awaited assignments such as `const module = await import("package")`.
- Symbol propagation is intentionally limited to `const local = new ImportedClass()` in the same source file.
- Factory results such as `const client = axios.create()` are recorded as the `axios.create` call, but later `client` methods are not attributed yet.
- Assignments through destructuring, properties, returns, parameters, containers, or control-flow joins are not followed.
- A direct reassignment stops subsequent attribution for that binding; Guardian does not attempt branch-sensitive data-flow.
- Dynamic computed member names are not converted into usage paths.
- Constructor-instance usages retain their observed local paths but do not receive an invented canonical API path.
- Target resolution supports public npm registry dependencies only; private registries and authentication are not supported.
- Workspace, link, file, Git, URL, and unknown resolution kinds return `unsupported` targets.
- Artifact acquisition accepts only HTTPS tarball URLs on `registry.npmjs.org` and rejects redirects.
- Artifact storage is temporary and has no persistent cache.
- Legacy packages with only `dist.shasum` use explicitly reported `sha1-legacy` verification.
- `typesVersions` is reported as `unsupported-types-versions`; M6 does not emulate TypeScript-version selection.
- Declaration export patterns support one unambiguous wildcard mapped to one wildcard over real files; overlapping or more complex patterns are reported rather than guessed.
- Relative declaration re-exports are resolved only inside the acquired artifact. External re-exports are represented but their dependency declarations are not resolved.
- Referenced declaration fingerprints follow local names, relative imports, and inline relative import types; package self-references, triple-slash references, and module augmentations are not fully resolved.
- Unsupported declaration syntax and ambiguous condition fallback arrays produce normalized issues rather than inferred APIs.
- M6 does not expand recursive type aliases, evaluate enum/variable initializers, or analyze full JSDoc.
- M7 reports structural additions, removals, modifications, signature deltas, and provenance only; it does not decide whether any change is breaking, safe, risky, or SemVer-compatible.
- M7 does not infer symbol renames. A missing name and a new name remain separate removal and addition records.
- M8 only correlates usages whose M3 evidence produced a `canonicalPath`; `constructor-instance` and `unattributed` evidence are reported as `unresolved` with no attempted translation.
- M8 resolves a "default" root canonical path against either an M6 `default` or `export=` declaration, since M3 cannot distinguish `export default` from CommonJS-interop `export = Foo` in consumer code; this is an M8 extension beyond M3's literal vocabulary, not an M6/M7 concept.
- A bare namespace-import reference with no accessed member (canonicalPath exactly `"namespace"`) has no single exportedName to correlate against and is reported `indeterminate` with an `unresolvable-member-access` issue rather than attributed to the whole entrypoint.
- A member name shared by more than one declared member of the same structured declaration (for example a getter and setter with the same name) is reported `indeterminate` with an `ambiguous-member-correlation` issue, distinct from facet ambiguity, which is declaration merging over the exported name itself rather than a name collision among one declaration's members.
- M8 does not resolve into `referencedDeclarations`; usage translation only ever targets an entrypoint's public `exports` tree, since referenced (non-exported) declarations are not reachable through application-code member access.
- M8 does not classify affected usages as breaking, safe, or risky, does not score impact, and does not recommend whether to upgrade.

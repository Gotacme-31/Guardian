# Guardian

Guardian is a local tool for understanding how software projects depend on external packages. Its long-term direction is to assess dependency updates, identify breaking API changes, measure their real impact, verify migrations, and eventually support automated pull requests.

> Guardian is currently an experimental prototype.

## M2 Project Scanner

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
- unresolved and unsupported resolution states without inspecting `node_modules`.

M2 does not contact registries, compare package releases or APIs, execute target code, generate changes, use AI, or integrate with GitHub.

## Architecture

```text
apps/cli                         argument handling and text output
packages/project-scanner         read-only project inspection and public contracts
  src/dependency-resolution      normalized resolution and pnpm lockfile adapter
test-projects/sample-typescript-app
                                  deterministic scanner fixture
test-projects/sample-pnpm-workspace
                                  pnpm workspace/importer fixture
```

The CLI contains no source-analysis logic. The scanner exposes:

```ts
scanProject(projectPath: string): Promise<ProjectScanResult>
```

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
```

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

The tests cover M1/M1.1 scanning and symbol analysis plus pnpm registry and protocol resolutions, peer suffixes, workspace discovery, exact importer selection, typed lockfile errors, unsupported managers, and read-only behavior.

## Typecheck

```bash
pnpm typecheck
```

All workspace TypeScript uses strict mode.

## Safety

Scanning is read-only. Guardian does not install dependencies in the target, execute scripts or source files, alter manifests or lockfiles, or write into the target project.

The scanner uses the maintained `yaml` package only to parse existing pnpm lockfiles. It does not invoke pnpm internals, inspect `node_modules`, or perform network requests.

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

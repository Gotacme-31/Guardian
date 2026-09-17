import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DECLARATION_SURFACE_LIMITS,
  extractDeclarationSurface,
  type AcquiredPackageArtifact,
  type PackageDeclarationSurface,
  type PublicApiDeclaration,
} from "../src/index.js";

interface SyntheticPackageOptions {
  name?: string;
  version?: string;
  manifest?: Record<string, unknown>;
  files?: Record<string, string>;
}

const temporaryRoots: string[] = [];

async function syntheticArtifact(
  options: SyntheticPackageOptions = {},
): Promise<AcquiredPackageArtifact> {
  const name = options.name ?? "fixture-package";
  const version = options.version ?? "1.0.0";
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "guardian-declarations-"));
  temporaryRoots.push(temporaryRoot);
  const packagePath = path.join(temporaryRoot, "package");
  await mkdir(packagePath);
  const manifest = { name, version, ...options.manifest };
  await writeFile(path.join(packagePath, "package.json"), JSON.stringify(manifest));
  for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
    const filePath = path.join(packagePath, ...relativePath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
  return {
    dependency: name,
    version,
    source: "npm",
    tarballUrl: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    verification: {
      verified: true,
      method: "sri",
      algorithm: "sha512",
      integrity: "sha512-fixture",
    },
    temporaryRoot,
    archivePath: path.join(temporaryRoot, "package.tgz"),
    extractionRoot: temporaryRoot,
    packagePath,
    downloadedBytes: 1,
  };
}

function rootExports(surface: PackageDeclarationSurface): readonly PublicApiDeclaration[] {
  return surface.entrypoints.find((entrypoint) => entrypoint.exportPath === ".")?.exports ?? [];
}

function exported(
  surface: PackageDeclarationSurface,
  name: string,
  kind?: PublicApiDeclaration["kind"],
): PublicApiDeclaration {
  const declaration = rootExports(surface).find((item) =>
    item.exportedName === name && (kind === undefined || item.kind === kind));
  expect(declaration, `missing ${name}${kind === undefined ? "" : ` (${kind})`}`).toBeDefined();
  return declaration as PublicApiDeclaration;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("TypeScript declaration entrypoints", () => {
  it("extracts a package root declared with types", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "./dist/index.d.ts" },
      files: { "dist/index.d.ts": "export declare function parse(value: string): number;" },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(surface).toMatchObject({
      packageName: "fixture-package",
      version: "1.0.0",
      issues: [],
    });
    expect(surface.entrypoints).toHaveLength(1);
    expect(surface.entrypoints[0]).toMatchObject({
      exportPath: ".",
      declarationFile: "dist/index.d.ts",
    });
    expect(exported(surface, "parse", "function")).toMatchObject({
      sourceFile: "dist/index.d.ts",
      defaultExport: false,
      signatures: ["function(value: string): number"],
    });
    expect(JSON.stringify(surface)).not.toContain(temporaryRoots[0]);
  });

  it("supports the legacy typings field", async () => {
    const artifact = await syntheticArtifact({
      manifest: { typings: "types/main.d.ts" },
      files: { "types/main.d.ts": "export interface Legacy { value: string }" },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(surface.entrypoints[0]?.declarationFile).toBe("types/main.d.ts");
    expect(exported(surface, "Legacy").kind).toBe("interface");
  });

  it("falls back only to root index.d.ts and does not expose other declaration files", async () => {
    const artifact = await syntheticArtifact({
      files: {
        "index.d.ts": "export interface Public {}",
        "internal.d.ts": "export interface Internal {}",
      },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(rootExports(surface).map((item) => item.exportedName)).toEqual(["Public"]);
    expect(surface.entrypoints[0]?.declarationFile).toBe("index.d.ts");
  });

  it("resolves a root exports condition containing types", async () => {
    const artifact = await syntheticArtifact({
      manifest: {
        exports: {
          types: "./types/index.d.ts",
          import: "./index.js",
        },
      },
      files: { "types/index.d.ts": "export type Root = string;" },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(surface.entrypoints).toEqual([
      expect.objectContaining({ exportPath: ".", declarationFile: "types/index.d.ts" }),
    ]);
  });

  it("keeps exports subpaths as separate public entrypoints", async () => {
    const artifact = await syntheticArtifact({
      manifest: {
        exports: {
          ".": { types: "./index.d.ts", import: "./index.js" },
          "./helpers": { types: "./helpers.d.ts", import: "./helpers.js" },
        },
      },
      files: {
        "index.d.ts": "export interface Root {}",
        "helpers.d.ts": "export declare const help: boolean;",
      },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(surface.entrypoints.map((entrypoint) => ({
      exportPath: entrypoint.exportPath,
      declarationFile: entrypoint.declarationFile,
      exports: entrypoint.exports.map((item) => item.exportedName),
    }))).toEqual([
      { exportPath: ".", declarationFile: "index.d.ts", exports: ["Root"] },
      { exportPath: "./helpers", declarationFile: "helpers.d.ts", exports: ["help"] },
    ]);
  });

  it("infers adjacent declarations from static runtime export targets", async () => {
    const artifact = await syntheticArtifact({
      manifest: {
        exports: {
          "./common": "./dist/common.cjs",
          "./feature": "./dist/feature.js",
          "./module": "./dist/module.mjs",
        },
      },
      files: {
        "dist/common.d.cts": "export interface Common {}",
        "dist/feature.d.ts": "export interface Feature {}",
        "dist/module.d.mts": "export interface Module {}",
      },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(surface.entrypoints.map((entrypoint) => [
      entrypoint.exportPath,
      entrypoint.declarationFile,
    ])).toEqual([
      ["./common", "dist/common.d.cts"],
      ["./feature", "dist/feature.d.ts"],
      ["./module", "dist/module.d.mts"],
    ]);
    expect(surface.issues).toEqual([]);
  });

  it("resolves nested type conditions when they identify one declaration file", async () => {
    const artifact = await syntheticArtifact({
      manifest: {
        exports: {
          ".": {
            import: { types: "./index.d.ts", default: "./index.js" },
            require: { types: "./index.d.ts", default: "./index.cjs" },
          },
        },
      },
      files: { "index.d.ts": "export interface Nested {}" },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(surface.issues).toEqual([]);
    expect(surface.entrypoints[0]?.conditionPaths).toEqual([
      ["import", "types"],
      ["require", "types"],
    ]);
    expect(exported(surface, "Nested").kind).toBe("interface");
  });

  it("retains distinct declaration variants for different nested conditions", async () => {
    const artifact = await syntheticArtifact({
      manifest: {
        exports: {
          ".": {
            import: { types: "./index.d.mts" },
            require: { types: "./index.d.cts" },
          },
        },
      },
      files: {
        "index.d.mts": "export interface ImportApi {}",
        "index.d.cts": "export interface RequireApi {}",
      },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(surface.entrypoints.map((entrypoint) => ({
      declarationFile: entrypoint.declarationFile,
      conditionPaths: entrypoint.conditionPaths,
    }))).toEqual([
      { declarationFile: "index.d.cts", conditionPaths: [["require", "types"]] },
      { declarationFile: "index.d.mts", conditionPaths: [["import", "types"]] },
    ]);
    expect(surface.issues).toEqual([]);
  });

  it("reports ambiguous declaration fallback arrays instead of guessing", async () => {
    const artifact = await syntheticArtifact({
      manifest: {
        exports: {
          ".": { types: ["./first.d.ts", "./second.d.ts"] },
        },
      },
      files: {
        "first.d.ts": "export interface First {}",
        "second.d.ts": "export interface Second {}",
      },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(surface.entrypoints).toEqual([]);
    expect(surface.issues).toContainEqual(expect.objectContaining({
      code: "unsupported-export-conditions",
      exportPath: ".",
    }));
  });

  it("expands one-to-one declaration export patterns from real files", async () => {
    const artifact = await syntheticArtifact({
      manifest: {
        exports: {
          "./*": { types: "./dist/*.d.ts" },
        },
      },
      files: {
        "dist/zeta.d.ts": "export interface Zeta {}",
        "dist/alpha.d.ts": "export interface Alpha {}",
        "dist/runtime.js": "throw new Error('must not execute');",
      },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(surface.entrypoints.map((entrypoint) => entrypoint.exportPath)).toEqual([
      "./alpha",
      "./zeta",
    ]);
    expect(surface.issues).toEqual([]);
  });

  it("reports unsupported export patterns instead of inventing entrypoints", async () => {
    const artifact = await syntheticArtifact({
      manifest: { exports: { "./**": { types: "./dist/*.d.ts" } } },
      files: { "dist/value.d.ts": "export interface Value {}" },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(surface.entrypoints).toEqual([]);
    expect(surface.issues).toContainEqual(expect.objectContaining({
      code: "unsupported-export-pattern",
    }));
  });

  it("honors exact export exclusions and rejects overlapping pattern results", async () => {
    const excluded = await syntheticArtifact({
      manifest: {
        exports: {
          "./*": { types: "./dist/*.d.ts" },
          "./private": null,
        },
      },
      files: {
        "dist/public.d.ts": "export interface Public {}",
        "dist/private.d.ts": "export interface Private {}",
      },
    });
    const excludedSurface = await extractDeclarationSurface(excluded);
    expect(excludedSurface.entrypoints.map((entrypoint) => entrypoint.exportPath)).toEqual([
      "./public",
    ]);

    const overlapping = await syntheticArtifact({
      manifest: {
        exports: {
          "./*": { types: "./dist/*.d.ts" },
          "./f*": { types: "./dist/f*.d.ts" },
        },
      },
      files: { "dist/foo.d.ts": "export interface Foo {}" },
    });
    const overlappingSurface = await extractDeclarationSurface(overlapping);
    expect(overlappingSurface.entrypoints).toEqual([]);
    expect(overlappingSurface.issues).toContainEqual(expect.objectContaining({
      code: "unsupported-export-pattern",
      exportPath: "./foo",
    }));
  });

  it("reports typesVersions without attempting to emulate TypeScript version selection", async () => {
    const artifact = await syntheticArtifact({
      manifest: {
        types: "index.d.ts",
        typesVersions: { ">=5": { "*": ["ts5/*"] } },
      },
      files: { "index.d.ts": "export interface Current {}" },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(exported(surface, "Current").kind).toBe("interface");
    expect(surface.issues).toContainEqual(expect.objectContaining({
      code: "unsupported-types-versions",
    }));
  });

  it("returns a normalized issue for a package without declarations", async () => {
    const artifact = await syntheticArtifact({
      files: { "index.js": "globalThis.executed = true;" },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(surface.entrypoints).toEqual([]);
    expect(surface.issues).toEqual([
      expect.objectContaining({ code: "declaration-entrypoint-missing" }),
    ]);
  });

  it("does not invent a root entrypoint when exports encapsulates or blocks it", async () => {
    const subpathOnly = await syntheticArtifact({
      manifest: {
        exports: {
          "./feature": { types: "./feature.d.ts" },
        },
      },
      files: {
        "index.d.ts": "export interface PhantomRoot {}",
        "feature.d.ts": "export interface Feature {}",
      },
    });
    const subpathSurface = await extractDeclarationSurface(subpathOnly);
    expect(subpathSurface.entrypoints.map((entrypoint) => entrypoint.exportPath)).toEqual([
      "./feature",
    ]);
    expect(JSON.stringify(subpathSurface)).not.toContain("PhantomRoot");

    const blockedRoot = await syntheticArtifact({
      manifest: {
        types: "index.d.ts",
        exports: { ".": null },
      },
      files: { "index.d.ts": "export interface BlockedRoot {}" },
    });
    const blockedSurface = await extractDeclarationSurface(blockedRoot);
    expect(blockedSurface.entrypoints).toEqual([]);
    expect(JSON.stringify(blockedSurface)).not.toContain("BlockedRoot");

    for (const exportsValue of [{}, { default: null }, [], [null]]) {
      const emptyConditions = await syntheticArtifact({
        manifest: { exports: exportsValue },
        files: { "index.d.ts": "export interface AlsoBlocked {}" },
      });
      const emptySurface = await extractDeclarationSurface(emptyConditions);
      expect(emptySurface.entrypoints).toEqual([]);
      expect(JSON.stringify(emptySurface)).not.toContain("AlsoBlocked");
    }
  });
});

describe("public declaration normalization", () => {
  it("captures functions, overloads, generics, rest parameters, and optional parameters", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export function parse(value: string): number;
          export function parse(value: Uint8Array): number;
          export function identity<T extends string>(value: T, optional?: boolean, ...rest: T[]): T;
        `,
      },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(exported(surface, "parse", "function").signatures).toEqual([
      "function(value: Uint8Array): number",
      "function(value: string): number",
    ]);
    expect(exported(surface, "identity", "function").signatures).toEqual([
      "function<T extends string>(value: T, optional?: boolean, ...rest: T[]): T",
    ]);
  });

  it("captures class heritage and all consumer-visible member forms", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          interface Contract {}
          declare class Base {}
          export declare class Client<T> extends Base implements Contract {
            constructor(value: string);
            public method(input: T): number;
            private secret(): void;
            protected hook(value?: T): void;
            static create(): Client<string>;
            public value: T;
            get label(): string;
            set label(next: string);
            readonly [key: string]: unknown;
          }
        `,
      },
    });

    const surface = await extractDeclarationSurface(artifact);
    const client = exported(surface, "Client", "class");
    expect(client.signatures).toEqual(["class<T> extends Base implements Contract"]);
    expect(client.kind).toBe("class");
    if (client.kind !== "class") {
      throw new Error("expected class");
    }
    expect(client.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "constructor", kind: "constructor" }),
      expect.objectContaining({ name: "method", kind: "method", visibility: "public" }),
      expect.objectContaining({ name: "hook", kind: "method", visibility: "protected" }),
      expect.objectContaining({ name: "create", kind: "method", static: true }),
      expect.objectContaining({ name: "value", kind: "property" }),
      expect.objectContaining({ name: "label", kind: "getter", readonly: true }),
      expect.objectContaining({ name: "label", kind: "setter", readonly: false }),
      expect.objectContaining({ name: "[index]", kind: "index-signature", readonly: true }),
    ]));
    expect(client.members.some((member) => member.name === "secret")).toBe(false);
  });

  it("retains public and protected constructor parameter properties but excludes private ones", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export class Parameters {
            constructor(public readonly id: string, protected state: number, private secret: string);
          }
        `,
      },
    });

    const declaration = exported(await extractDeclarationSurface(artifact), "Parameters", "class");
    if (declaration.kind !== "class") {
      throw new Error("expected class");
    }
    expect(declaration.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "id", kind: "property", readonly: true }),
      expect.objectContaining({ name: "state", kind: "property", visibility: "protected" }),
    ]));
    expect(declaration.members.some((member) => member.name === "secret")).toBe(false);
  });

  it("captures interface heritage, properties, methods, and structural signatures", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          interface Parent {}
          export interface Service<T> extends Parent {
            readonly id: string;
            value?: T;
            run?(input: T): Promise<T>;
            (input: string): boolean;
            new (value: T): Service<T>;
            readonly [key: string]: unknown;
          }
        `,
      },
    });

    const declaration = exported(await extractDeclarationSurface(artifact), "Service", "interface");
    if (declaration.kind !== "interface") {
      throw new Error("expected interface");
    }
    expect(declaration.signatures).toEqual(["interface<T> extends Parent"]);
    expect(declaration.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "id", kind: "property", readonly: true }),
      expect.objectContaining({ name: "value", kind: "property", optional: true }),
      expect.objectContaining({ name: "run", kind: "method", optional: true }),
      expect.objectContaining({ name: "[call]", kind: "call-signature" }),
      expect.objectContaining({ name: "[new]", kind: "construct-signature" }),
      expect.objectContaining({ name: "[index]", kind: "index-signature", readonly: true }),
    ]));
  });

  it("captures aliases, unions, enums, const, let, and var declarations", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export type ID = string | number;
          export enum Mode { A = "a", B = "b" }
          export declare const VERSION: string;
          export declare let current: ID;
          export declare var legacy: boolean;
        `,
      },
    });

    const surface = await extractDeclarationSurface(artifact);
    expect(exported(surface, "ID", "type").signatures).toEqual([
      "type = string | number",
    ]);
    const mode = exported(surface, "Mode", "enum");
    if (mode.kind !== "enum") {
      throw new Error("expected enum");
    }
    expect(mode.members).toEqual([
      expect.objectContaining({ name: "A", signatures: ["= \"a\""] }),
      expect.objectContaining({ name: "B", signatures: ["= \"b\""] }),
    ]);
    expect(exported(surface, "VERSION", "variable").signatures).toEqual(["const: string"]);
    expect(exported(surface, "current", "variable").signatures).toEqual(["let: ID"]);
    expect(exported(surface, "legacy", "variable").signatures).toEqual(["var: boolean"]);
  });

  it("captures namespace contents recursively", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export namespace Tools {
            export function run(value: string): void;
            export interface Options { quiet?: boolean }
          }
        `,
      },
    });

    const declaration = exported(await extractDeclarationSurface(artifact), "Tools", "namespace");
    if (declaration.kind !== "namespace") {
      throw new Error("expected namespace");
    }
    expect(declaration.exports.map((item) => [item.exportedName, item.kind])).toEqual([
      ["Options", "interface"],
      ["run", "function"],
    ]);
  });

  it("treats ambient namespace members as implicitly exported", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.cts" },
      files: {
        "index.d.cts": `
          declare namespace client {
            interface Config { timeout?: number }
            type ID = string | number;
            function create(config?: Config): Client;
            class Client { request(): void }
          }
          export = client;
        `,
      },
    });

    const declaration = exported(await extractDeclarationSurface(artifact), "export=", "namespace");
    if (declaration.kind !== "namespace") {
      throw new Error("expected namespace");
    }
    expect(declaration.exports.map((item) => [item.exportedName, item.kind])).toEqual([
      ["Client", "class"],
      ["Config", "interface"],
      ["ID", "type"],
      ["create", "function"],
    ]);
  });

  it("captures dotted ambient namespaces recursively", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.cts" },
      files: {
        "index.d.cts": `
          declare namespace client.api {
            interface Options { timeout?: number }
          }
          export = client;
        `,
      },
    });

    const declaration = exported(await extractDeclarationSurface(artifact), "export=", "namespace");
    if (declaration.kind !== "namespace") {
      throw new Error("expected namespace");
    }
    const api = declaration.exports.find((item) => item.exportedName === "api");
    expect(api).toMatchObject({ kind: "namespace" });
    if (api?.kind !== "namespace") {
      throw new Error("expected nested namespace");
    }
    expect(api.exports).toEqual([
      expect.objectContaining({ exportedName: "Options", kind: "interface" }),
    ]);
  });

  it("represents default export identity while preserving the declaration kind", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          interface Client { request(): void }
          declare const client: Client;
          export default client;
        `,
      },
    });

    expect(exported(await extractDeclarationSurface(artifact), "default")).toMatchObject({
      kind: "variable",
      defaultExport: true,
      signatures: ["const: Client"],
    });
  });

  it("captures an anonymous default function", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": "export default function (value: string): number;",
      },
    });

    expect(exported(await extractDeclarationSurface(artifact), "default")).toMatchObject({
      kind: "function",
      defaultExport: true,
      signatures: ["function(value: string): number"],
    });
  });

  it("preserves declaration-merging facets with deterministic ordinals", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export class Foo { method(): void }
          export namespace Foo { export const version: string }
        `,
      },
    });

    const facets = rootExports(await extractDeclarationSurface(artifact))
      .filter((item) => item.exportedName === "Foo");
    expect(facets.map((item) => ({ kind: item.kind, facet: item.facet }))).toEqual([
      { kind: "class", facet: 1 },
      { kind: "namespace", facet: 2 },
    ]);
  });

  it("preserves repeated interface and namespace merging facets", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export interface Merge { first: string }
          export interface Merge { second: number }
          export namespace Space { export const first: string }
          export namespace Space { export const second: number }
        `,
      },
    });

    const surface = await extractDeclarationSurface(artifact);
    expect(rootExports(surface).filter((item) => item.exportedName === "Merge")
      .map((item) => item.facet)).toEqual([1, 2]);
    expect(rootExports(surface).filter((item) => item.exportedName === "Space")
      .map((item) => item.facet)).toEqual([1, 2]);
  });

  it("retains a clean deprecated marker without including JSDoc in signatures", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          /** old docs\n           * @deprecated use current\n           */
          export declare function old(value: string): void;
        `,
      },
    });

    const declaration = exported(await extractDeclarationSurface(artifact), "old");
    expect(declaration.deprecated).toBe(true);
    expect(declaration.signatures).toEqual(["function(value: string): void"]);
  });

  it("canonicalizes formatting and comments without hiding semantic type changes", async () => {
    const compact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: { "index.d.ts": "export function value(input:string):number;" },
    });
    const formatted = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          // formatting must not affect the signature
          export function value(
            input: string
          ): number;
        `,
      },
    });
    const changed = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: { "index.d.ts": "export function value(input:string):string;" },
    });

    const compactSurface = await extractDeclarationSurface(compact);
    const formattedSurface = await extractDeclarationSurface(formatted);
    const changedSurface = await extractDeclarationSurface(changed);

    expect(formattedSurface).toEqual(compactSurface);
    expect(exported(changedSurface, "value").signatures)
      .not.toEqual(exported(compactSurface, "value").signatures);
  });

  it("fingerprints non-exported declarations referenced by public signatures", async () => {
    const stringOptions = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          interface Options { value: string }
          export function create(options: Options): void;
        `,
      },
    });
    const numberOptions = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          interface Options { value: number }
          export function create(options: Options): void;
        `,
      },
    });

    const stringSurface = await extractDeclarationSurface(stringOptions);
    const numberSurface = await extractDeclarationSurface(numberOptions);
    expect(exported(stringSurface, "create").signatures)
      .toEqual(exported(numberSurface, "create").signatures);
    expect(stringSurface.entrypoints[0]?.referencedDeclarations).toEqual([
      expect.objectContaining({
        name: "Options",
        kind: "interface",
        members: [expect.objectContaining({ name: "value", signatures: [": string"] })],
      }),
    ]);
    expect(numberSurface.entrypoints[0]?.referencedDeclarations).toEqual([
      expect.objectContaining({
        name: "Options",
        kind: "interface",
        members: [expect.objectContaining({ name: "value", signatures: [": number"] })],
      }),
    ]);
  });

  it("fingerprints referenced declarations from every function overload", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          interface First { first: string }
          interface Second { second: number }
          export function parse(value: First): void;
          export function parse(value: Second): void;
        `,
      },
    });

    const surface = await extractDeclarationSurface(artifact);
    expect(surface.entrypoints[0]?.referencedDeclarations.map((item) => item.name)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("fingerprints referenced declarations imported from a relative declaration file", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          import type { Options } from "./internal";
          export function create(options: Options): void;
        `,
        "internal.d.ts": "export interface Options { retries?: number }",
      },
    });

    const surface = await extractDeclarationSurface(artifact);
    expect(surface.entrypoints[0]?.referencedDeclarations).toEqual([
      expect.objectContaining({
        name: "Options",
        kind: "interface",
        sourceFile: "internal.d.ts",
        typeOnly: true,
      }),
    ]);
  });

  it("fingerprints inline import type references from relative declaration files", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export function create(options: import("./internal").Options): void;
        `,
        "internal.d.ts": "export interface Options { retries?: number }",
      },
    });

    const surface = await extractDeclarationSurface(artifact);
    expect(surface.entrypoints[0]?.referencedDeclarations).toEqual([
      expect.objectContaining({
        name: "import(\"./internal\").Options",
        kind: "interface",
        sourceFile: "internal.d.ts",
      }),
    ]);
  });
});

describe("static declaration re-exports", () => {
  it("resolves named, aliased, and default-as-named relative re-exports", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export { foo, InternalClient as Client, default as NamedDefault } from "./internal";
        `,
        "internal.d.ts": `
          export const foo: boolean;
          export interface InternalClient { request(): void }
          export default class DefaultClient { close(): void }
        `,
      },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(rootExports(surface).map((item) => [item.exportedName, item.kind])).toEqual([
      ["Client", "interface"],
      ["NamedDefault", "class"],
      ["foo", "variable"],
    ]);
    expect(rootExports(surface).every((item) => item.sourceFile === "internal.d.ts")).toBe(true);
  });

  it("resolves export star and chained re-exports while excluding default", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": "export * from './middle';",
        "middle.d.ts": "export * from './leaf'; export interface Middle {}",
        "leaf.d.ts": "export interface Leaf {} export default class HiddenDefault {}",
      },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(rootExports(surface).map((item) => item.exportedName)).toEqual(["Leaf", "Middle"]);
    expect(surface.issues).toEqual([]);
  });

  it("terminates cyclic re-exports and retains declarations reached before the cycle", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": "export * from './a';",
        "a.d.ts": "export interface A {} export * from './b';",
        "b.d.ts": "export interface B {} export * from './a';",
      },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(rootExports(surface).map((item) => item.exportedName)).toEqual(["A", "B"]);
    expect(surface.issues).toContainEqual(expect.objectContaining({ code: "reexport-cycle" }));
  });

  it("resolves named aliases through a cycle from direct declarations", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": "export { X } from './a';",
        "a.d.ts": "export interface Base { value: string } export { Y as X } from './b';",
        "b.d.ts": "export { Base as Y } from './a';",
      },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(exported(surface, "X")).toMatchObject({
      kind: "interface",
      sourceFile: "a.d.ts",
    });
    expect(surface.issues).toContainEqual(expect.objectContaining({ code: "reexport-cycle" }));
  });

  it("normalizes external named and star re-exports without resolving dependencies", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export { Something as ExternalThing } from "external-package";
          export * from "another-package";
        `,
      },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(rootExports(surface)).toEqual([
      expect.objectContaining({
        exportedName: "*",
        kind: "external-reexport",
        externalModule: "another-package",
        importedName: "*",
      }),
      expect.objectContaining({
        exportedName: "ExternalThing",
        kind: "external-reexport",
        externalModule: "external-package",
        importedName: "Something",
      }),
    ]);
    expect(surface.issues.filter((issue) => issue.code === "external-reexport")).toHaveLength(2);
  });

  it("preserves type-only re-export semantics", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export type { RuntimeClass as ClassType } from "./internal";
          export type * from "./types";
        `,
        "internal.d.ts": "export class RuntimeClass {}",
        "types.d.ts": "export interface Shape {} export const value: string;",
      },
    });

    const surface = await extractDeclarationSurface(artifact);
    expect(exported(surface, "ClassType")).toMatchObject({
      kind: "class",
      typeOnly: true,
    });
    expect(exported(surface, "Shape")).toMatchObject({ typeOnly: true });
    expect(exported(surface, "value")).toMatchObject({ typeOnly: true });
  });

  it("propagates type-only imports through local exports", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          import type { Client } from "./client";
          export { Client };
        `,
        "client.d.ts": "export class Client { request(): void }",
      },
    });

    expect(exported(await extractDeclarationSurface(artifact), "Client")).toMatchObject({
      kind: "class",
      typeOnly: true,
    });
  });

  it("applies explicit-over-star precedence and omits conflicting star names", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export * from "./first";
          export * from "./second";
          export { FirstShared as Shared } from "./first";
        `,
        "first.d.ts": `
          export interface FirstOnly {}
          export interface FirstShared {}
          export interface Conflict { first: string }
        `,
        "second.d.ts": `
          export interface SecondOnly {}
          export interface Shared { second: string }
          export interface Conflict { second: string }
        `,
      },
    });

    const surface = await extractDeclarationSurface(artifact);
    expect(rootExports(surface).map((item) => item.exportedName)).toEqual([
      "FirstOnly",
      "FirstShared",
      "SecondOnly",
      "Shared",
    ]);
    expect(surface.issues).toContainEqual(expect.objectContaining({
      code: "ambiguous-star-reexport",
      message: expect.stringContaining("Conflict"),
    }));
  });

  it("distinguishes CommonJS export assignment from ESM default", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.cts" },
      files: {
        "index.d.cts": `
          declare function client(value: string): void;
          export = client;
        `,
      },
    });

    expect(exported(await extractDeclarationSurface(artifact), "export=")).toMatchObject({
      kind: "function",
      defaultExport: false,
      exportEquals: true,
    });
  });
});

describe("declaration surface safety and limits", () => {
  it("reports a missing declaration entrypoint", async () => {
    const artifact = await syntheticArtifact({ manifest: { types: "missing.d.ts" } });

    const surface = await extractDeclarationSurface(artifact);

    expect(surface.entrypoints).toEqual([]);
    expect(surface.issues).toContainEqual(expect.objectContaining({
      code: "declaration-file-missing",
      declarationFile: "missing.d.ts",
    }));
  });

  it("reports syntactically invalid declarations without returning partial exports", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: { "index.d.ts": "export interface Broken { value: ; }" },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(rootExports(surface)).toEqual([]);
    expect(surface.issues).toContainEqual(expect.objectContaining({
      code: "declaration-file-invalid",
      declarationFile: "index.d.ts",
    }));
  });

  it("rejects package metadata path traversal without reading outside declarations", async () => {
    const artifact = await syntheticArtifact({ manifest: { types: "../outside.d.ts" } });
    await writeFile(path.join(artifact.temporaryRoot, "outside.d.ts"),
      "export interface Escaped {}");

    const surface = await extractDeclarationSurface(artifact);

    expect(rootExports(surface)).toEqual([]);
    expect(JSON.stringify(surface)).not.toContain("Escaped");
    expect(surface.issues).toContainEqual(expect.objectContaining({
      code: "declaration-path-escape",
    }));
  });

  it("rejects POSIX, Windows drive, and UNC absolute declaration paths", async () => {
    for (const declarationPath of [
      "/private/outside.d.ts",
      "C:\\outside.d.ts",
      "\\\\server\\share\\outside.d.ts",
    ]) {
      const artifact = await syntheticArtifact({ manifest: { types: declarationPath } });
      const surface = await extractDeclarationSurface(artifact);
      expect(surface.entrypoints).toEqual([]);
      expect(surface.issues).toContainEqual(expect.objectContaining({
        code: "declaration-path-invalid",
      }));
    }
  });

  it("rejects a declaration symlink escaping the canonical package path", async () => {
    const artifact = await syntheticArtifact({ manifest: { types: "index.d.ts" } });
    const outsidePath = path.join(artifact.temporaryRoot, "outside.d.ts");
    await writeFile(outsidePath, "export interface EscapedSymlink {}");
    await symlink(outsidePath, path.join(artifact.packagePath, "index.d.ts"));

    const surface = await extractDeclarationSurface(artifact);

    expect(surface.entrypoints).toEqual([]);
    expect(JSON.stringify(surface)).not.toContain("EscapedSymlink");
    expect(surface.issues).toContainEqual(expect.objectContaining({
      code: "declaration-path-escape",
    }));
  });

  it("rejects a relative re-export symlink escaping the package", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: { "index.d.ts": "export * from './escaped';" },
    });
    const outsidePath = path.join(artifact.temporaryRoot, "escaped.d.ts");
    await writeFile(outsidePath, "export interface EscapedReexport {}");
    await symlink(outsidePath, path.join(artifact.packagePath, "escaped.d.ts"));

    const surface = await extractDeclarationSurface(artifact);

    expect(rootExports(surface)).toEqual([]);
    expect(JSON.stringify(surface)).not.toContain("EscapedReexport");
    expect(surface.issues).toContainEqual(expect.objectContaining({
      code: "declaration-path-escape",
      specifier: "./escaped",
    }));
  });

  it("never fetches, imports, or executes package runtime files", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": "export interface Safe {}",
        "index.js": `require("node:fs").writeFileSync("executed", "yes");`,
      },
    });

    const before = await readFile(path.join(artifact.packagePath, "index.js"), "utf8");
    const surface = await extractDeclarationSurface(artifact);
    const after = await readFile(path.join(artifact.packagePath, "index.js"), "utf8");

    expect(exported(surface, "Safe").kind).toBe("interface");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(after).toBe(before);
  });

  it("enforces declaration file count and re-export depth limits", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": "export interface Root {} export * from './one';",
        "one.d.ts": "export interface One {} export * from './two';",
        "two.d.ts": "export interface Two {}",
      },
    });

    const fileLimited = await extractDeclarationSurface(artifact, {
      limits: { maxDeclarationFiles: 1 },
    });
    expect(rootExports(fileLimited).map((item) => item.exportedName)).toEqual(["Root"]);
    expect(fileLimited.issues).toContainEqual(expect.objectContaining({
      code: "analysis-limit-exceeded",
      limit: "maxDeclarationFiles",
    }));

    const depthLimited = await extractDeclarationSurface(artifact, {
      limits: { maxReexportDepth: 1 },
    });
    expect(rootExports(depthLimited).map((item) => item.exportedName)).toEqual(["One", "Root"]);
    expect(depthLimited.issues).toContainEqual(expect.objectContaining({
      code: "analysis-limit-exceeded",
      limit: "maxReexportDepth",
    }));
  });

  it("enforces declaration, member, and declaration file size limits", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export interface Alpha { first: string; second: number }
          export interface Beta {}
        `,
      },
    });

    const declarationLimited = await extractDeclarationSurface(artifact, {
      limits: { maxDeclarations: 1 },
    });
    expect(rootExports(declarationLimited).map((item) => item.exportedName)).toEqual(["Alpha"]);
    expect(declarationLimited.issues).toContainEqual(expect.objectContaining({
      limit: "maxDeclarations",
    }));

    const memberLimited = await extractDeclarationSurface(artifact, {
      limits: { maxMembers: 1 },
    });
    const alpha = exported(memberLimited, "Alpha", "interface");
    if (alpha.kind !== "interface") {
      throw new Error("expected interface");
    }
    expect(alpha.members).toHaveLength(1);
    expect(memberLimited.issues).toContainEqual(expect.objectContaining({ limit: "maxMembers" }));

    const sizeLimited = await extractDeclarationSurface(artifact, {
      limits: { maxDeclarationFileBytes: 10 },
    });
    expect(rootExports(sizeLimited)).toEqual([]);
    expect(sizeLimited.issues).toContainEqual(expect.objectContaining({
      limit: "maxDeclarationFileBytes",
    }));
  });

  it("publishes exact documented defaults and rejects invalid limit values", async () => {
    expect(DEFAULT_DECLARATION_SURFACE_LIMITS).toEqual({
      maxDeclarationFiles: 512,
      maxReexportDepth: 64,
      maxDeclarations: 10_000,
      maxMembers: 50_000,
      maxDeclarationFileBytes: 5 * 1024 * 1024,
    });
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: { "index.d.ts": "export interface Api {}" },
    });
    await expect(extractDeclarationSurface(artifact, {
      limits: { maxDeclarations: 0 },
    })).rejects.toThrow(RangeError);
  });
});

describe("declaration surface determinism", () => {
  it("sorts entrypoints, declarations, facets, signatures, members, and issues", async () => {
    const artifact = await syntheticArtifact({
      manifest: {
        exports: {
          "./z": { types: "z.d.ts" },
          ".": { types: "index.d.ts" },
          "./a": { types: "a.d.ts" },
        },
        typesVersions: { "*": { "*": ["legacy/*"] } },
      },
      files: {
        "z.d.ts": "export interface Z {}",
        "a.d.ts": "export interface A {}",
        "index.d.ts": `
          export interface Zebra { z: string; a: number }
          export function alpha(value: string): void;
          export function alpha(value: number): void;
        `,
      },
    });

    const surface = await extractDeclarationSurface(artifact);

    expect(surface.entrypoints.map((entrypoint) => entrypoint.exportPath)).toEqual([
      ".",
      "./a",
      "./z",
    ]);
    expect(rootExports(surface).map((item) => item.exportedName)).toEqual(["Zebra", "alpha"]);
    expect(exported(surface, "alpha").signatures).toEqual([
      "function(value: number): void",
      "function(value: string): void",
    ]);
    expect(surface.issues.map((issue) => issue.code)).toEqual(["unsupported-types-versions"]);
  });

  it("returns deeply equal output across repeated extraction", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": "export * from './api'; export { External } from 'external';",
        "api.d.ts": "export interface Api { value?: string }",
      },
    });

    const first = await extractDeclarationSurface(artifact);
    const second = await extractDeclarationSurface(artifact);
    const third = await extractDeclarationSurface(artifact);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("keeps merged facet ordering independent of source offsets", async () => {
    const compact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export interface Merge { beta: string }
          export interface Merge { alpha: string }
          export interface Merge { delta: string }
          export interface Merge { gamma: string }
        `,
      },
    });
    const shifted = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `













          export interface Merge { beta: string }
          export interface Merge { alpha: string }
          export interface Merge { delta: string }
          export interface Merge { gamma: string }
        `,
      },
    });

    expect(await extractDeclarationSurface(shifted))
      .toEqual(await extractDeclarationSurface(compact));
  });
});

describe("M6 audit regressions", () => {
  it("does not fall back through an explicitly blocked types condition", async () => {
    for (const typesCondition of [null, {}]) {
      const artifact = await syntheticArtifact({
        manifest: {
          types: "index.d.ts",
          exports: {
            types: typesCondition,
            default: "./index.js",
          },
        },
        files: {
          "index.d.ts": "export interface PhantomFallback {}",
        },
      });

      const surface = await extractDeclarationSurface(artifact);
      expect(surface.entrypoints).toEqual([]);
      expect(JSON.stringify(surface)).not.toContain("PhantomFallback");
      expect(surface.issues).toContainEqual(expect.objectContaining({
        code: "unsupported-export-conditions",
        exportPath: ".",
      }));
    }
  });

  it("does not fall back through invalid top-level types metadata", async () => {
    for (const invalidTypes of [null, {}]) {
      const artifact = await syntheticArtifact({
        manifest: { types: invalidTypes },
        files: { "index.d.ts": "export interface PhantomTopLevelFallback {}" },
      });

      const surface = await extractDeclarationSurface(artifact);
      expect(surface.entrypoints).toEqual([]);
      expect(JSON.stringify(surface)).not.toContain("PhantomTopLevelFallback");
      expect(surface.issues).toContainEqual(expect.objectContaining({
        code: "declaration-path-invalid",
        exportPath: ".",
      }));
    }
  });

  it("preserves private constructor non-constructibility without exposing a private member", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export class PublicConstructor {}
          export class PrivateConstructor { private constructor(); }
        `,
      },
    });
    const surface = await extractDeclarationSurface(artifact);
    const publicConstructor = exported(surface, "PublicConstructor", "class");
    const privateConstructor = exported(surface, "PrivateConstructor", "class");

    expect(publicConstructor.signatures).toEqual(["class"]);
    expect(privateConstructor.signatures).toEqual(["class private-constructor"]);
    if (privateConstructor.kind !== "class") {
      throw new Error("expected class");
    }
    expect(privateConstructor.members).toEqual([]);
  });

  it("does not fingerprint types referenced only by private class members", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          interface PrivateInput { value: string }
          interface ProtectedInput { value: number }
          export class Client {
            private consume(value: PrivateInput): void;
            protected extend(value: ProtectedInput): void;
          }
        `,
      },
    });
    const surface = await extractDeclarationSurface(artifact);

    expect(surface.entrypoints[0]?.referencedDeclarations.map((item) => item.name)).toEqual([
      "ProtectedInput",
    ]);
  });

  it("merges method overloads with mixed deprecation metadata", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export interface Parser {
            /** @deprecated use the object overload */
            parse(value: string): void;
            parse(value: { text: string }): void;
          }
        `,
      },
    });
    const declaration = exported(await extractDeclarationSurface(artifact), "Parser", "interface");
    if (declaration.kind !== "interface") {
      throw new Error("expected interface");
    }

    expect(declaration.members).toEqual([
      expect.objectContaining({
        name: "parse",
        kind: "method",
        deprecated: true,
        signatures: [
          "method(value: string): void",
          "method(value: {\n    text: string;\n}): void",
        ],
      }),
    ]);
  });

  it("keeps facet ordinals stable when one repeated declaration changes content", async () => {
    const beforeArtifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export interface Merge { alpha: string }
          export interface Merge { middle: string }
        `,
      },
    });
    const afterArtifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export interface Merge { zeta: string }
          export interface Merge { middle: string }
        `,
      },
    });
    const before = rootExports(await extractDeclarationSurface(beforeArtifact))
      .filter((item) => item.exportedName === "Merge");
    const after = rootExports(await extractDeclarationSurface(afterArtifact))
      .filter((item) => item.exportedName === "Merge");

    expect(before.map((item) => ({
      facet: item.facet,
      member: item.kind === "interface" ? item.members[0]?.name : undefined,
    }))).toEqual([
      { facet: 1, member: "alpha" },
      { facet: 2, member: "middle" },
    ]);
    expect(after.map((item) => ({
      facet: item.facet,
      member: item.kind === "interface" ? item.members[0]?.name : undefined,
    }))).toEqual([
      { facet: 1, member: "zeta" },
      { facet: 2, member: "middle" },
    ]);
  });

  it("keeps facet ordinals stable when a declaration kind changes", async () => {
    const beforeArtifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export declare const Merge: string;
          export interface Merge { value: string }
        `,
      },
    });
    const afterArtifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": `
          export declare function Merge(): string;
          export interface Merge { value: string }
        `,
      },
    });
    const before = rootExports(await extractDeclarationSurface(beforeArtifact))
      .filter((item) => item.exportedName === "Merge");
    const after = rootExports(await extractDeclarationSurface(afterArtifact))
      .filter((item) => item.exportedName === "Merge");

    expect(before.map((item) => [item.facet, item.kind])).toEqual([
      [1, "variable"],
      [2, "interface"],
    ]);
    expect(after.map((item) => [item.facet, item.kind])).toEqual([
      [1, "function"],
      [2, "interface"],
    ]);
  });

  it("memoizes a layered diamond re-export graph", async () => {
    const files: Record<string, string> = {
      "index.d.ts": "export * from './layer-00-a'; export * from './layer-00-b';",
    };
    const layers = 20;
    for (let index = 0; index < layers; index += 1) {
      const current = index.toString().padStart(2, "0");
      if (index === layers - 1) {
        files[`layer-${current}-a.d.ts`] = "export interface LeafA {}";
        files[`layer-${current}-b.d.ts`] = "export interface LeafB {}";
      } else {
        const next = (index + 1).toString().padStart(2, "0");
        const contents = `export * from './layer-${next}-a'; export * from './layer-${next}-b';`;
        files[`layer-${current}-a.d.ts`] = contents;
        files[`layer-${current}-b.d.ts`] = contents;
      }
    }
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files,
    });

    const surface = await extractDeclarationSurface(artifact);
    expect(rootExports(surface).map((item) => item.exportedName)).toEqual(["LeafA", "LeafB"]);
    expect(surface.issues).toEqual([]);
  });

  it("does not reuse cycle-truncated re-export results in a non-cyclic path", async () => {
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files: {
        "index.d.ts": "export * from './b'; export * as NS from './p';",
        "a.d.ts": "export * from './b';",
        "b.d.ts": "export * from './a'; export * from './c';",
        "c.d.ts": "export interface C {}",
        "p.d.ts": "export * from './a';",
      },
    });

    const surface = await extractDeclarationSurface(artifact);
    expect(exported(surface, "C")).toMatchObject({ kind: "interface" });
    const namespace = exported(surface, "NS", "namespace");
    if (namespace.kind !== "namespace") {
      throw new Error("expected namespace");
    }
    expect(namespace.exports).toEqual([
      expect.objectContaining({ exportedName: "C", kind: "interface" }),
    ]);
    expect(surface.issues).toContainEqual(expect.objectContaining({ code: "reexport-cycle" }));
  });

  it("memoizes shared acyclic ancestors that terminate in a cycle", async () => {
    const files: Record<string, string> = {
      "index.d.ts": "export * from './cycle-layer-00-a'; export * from './cycle-layer-00-b';",
      "cycle.d.ts": "export interface Leaf {} export * from './cycle';",
    };
    const layers = 18;
    for (let index = 0; index < layers; index += 1) {
      const current = index.toString().padStart(2, "0");
      if (index === layers - 1) {
        files[`cycle-layer-${current}-a.d.ts`] = "export * from './cycle';";
        files[`cycle-layer-${current}-b.d.ts`] = "export * from './cycle';";
      } else {
        const next = (index + 1).toString().padStart(2, "0");
        const contents = `export * from './cycle-layer-${next}-a'; export * from './cycle-layer-${next}-b';`;
        files[`cycle-layer-${current}-a.d.ts`] = contents;
        files[`cycle-layer-${current}-b.d.ts`] = contents;
      }
    }
    const artifact = await syntheticArtifact({
      manifest: { types: "index.d.ts" },
      files,
    });

    const surface = await extractDeclarationSurface(artifact);
    expect(rootExports(surface).map((item) => item.exportedName)).toEqual(["Leaf"]);
    expect(surface.issues).toContainEqual(expect.objectContaining({ code: "reexport-cycle" }));
  });
});

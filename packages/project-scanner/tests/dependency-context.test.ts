import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  buildDependencyContexts,
  findDependencyContext,
  scanProject,
  type DependencyContext,
  type DependencyInfo,
  type DependencyUsage,
  type InstalledDependencyResolution,
  type ProjectScanResult,
} from "../src/index.js";

const repositoryPath = fileURLToPath(new URL("../../..", import.meta.url));
const cliPath = path.join(repositoryPath, "apps/cli/src/index.ts");
const sampleProjectPath = path.join(repositoryPath, "test-projects/sample-typescript-app");
const sampleWorkspaceApiPath = path.join(
  repositoryPath,
  "test-projects/sample-pnpm-workspace/apps/api",
);

let sampleContexts: DependencyContext[];
let workspaceContexts: DependencyContext[];

function resolutionFor(
  dependency: string,
  dependencyType: DependencyInfo["type"],
  overrides: Partial<InstalledDependencyResolution> = {},
): InstalledDependencyResolution {
  return {
    dependency,
    dependencyType,
    declaredVersion: "^1.0.0",
    resolvedVersion: "1.0.1",
    resolvedReference: "1.0.1",
    kind: "registry",
    status: "resolved",
    ...overrides,
  };
}

function scanResult(
  declarations: DependencyInfo[],
  dependencyResolutions: InstalledDependencyResolution[],
  dependencyUsage: DependencyUsage[] = [],
): ProjectScanResult {
  return {
    projectPath: "/project",
    projectName: "project",
    projectType: { node: true, typescript: true },
    packageManager: "pnpm",
    dependencies: declarations.filter(({ type }) => type === "dependency"),
    devDependencies: declarations.filter(({ type }) => type === "devDependency"),
    dependencyUsage,
    dependencyResolutions,
  };
}

function repeatedAliasContext(): DependencyContext {
  const dependency = "date-fns";
  const declaration: DependencyInfo = {
    name: dependency,
    declaredVersion: "^4.0.0",
    type: "dependency",
  };
  const usage: DependencyUsage = {
    dependency,
    files: ["src/second.ts", "src/first.ts"],
    importCount: 2,
    imports: [
      {
        file: "src/second.ts",
        source: dependency,
        importedSymbols: ["format"],
        symbolBindings: [{ importedSymbol: "format", localBinding: "fmt" }],
        kind: "es-import",
      },
      {
        file: "src/first.ts",
        source: dependency,
        importedSymbols: ["format"],
        symbolBindings: [{ importedSymbol: "format", localBinding: "formatDate" }],
        kind: "es-import",
      },
    ],
    symbolUsages: [
      {
        dependency,
        file: "src/second.ts",
        importedSymbol: "format",
        localBinding: "fmt",
        usagePath: "format",
        kind: "call",
        line: 8,
        column: 3,
      },
      {
        dependency,
        file: "src/first.ts",
        importedSymbol: "format",
        localBinding: "formatDate",
        usagePath: "format",
        kind: "call",
        line: 4,
        column: 5,
      },
    ],
  };
  return buildDependencyContexts(scanResult(
    [declaration],
    [resolutionFor(dependency, "dependency", { declaredVersion: "^4.0.0" })],
    [usage],
  ))[0] as DependencyContext;
}

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", cliPath, ...args],
      { cwd: repositoryPath },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: typeof error?.code === "number" ? error.code : 0,
        });
      },
    );
  });
}

beforeAll(async () => {
  const [sampleScan, workspaceScan] = await Promise.all([
    scanProject(sampleProjectPath),
    scanProject(sampleWorkspaceApiPath),
  ]);
  sampleContexts = buildDependencyContexts(sampleScan);
  workspaceContexts = buildDependencyContexts(workspaceScan);
});

describe("dependency context correlation", () => {
  it("builds a registry dependency context", () => {
    const axios = findDependencyContext(sampleContexts, "axios");

    expect(axios).toMatchObject({
      dependency: "axios",
      declaration: { type: "dependency", declaredVersion: "^1.7.0" },
      resolution: { status: "resolved", resolvedVersion: "1.7.9", kind: "registry" },
      usage: { used: true },
    });
  });

  it("builds a development dependency context", () => {
    const vitest = findDependencyContext(sampleContexts, "vitest");

    expect(vitest).toMatchObject({
      declaration: { type: "devDependency", declaredVersion: "^3.0.0" },
      resolution: { dependencyType: "devDependency", status: "resolved" },
    });
  });

  it("includes a declared dependency with no usage", () => {
    const declaration: DependencyInfo = {
      name: "unused-package",
      declaredVersion: "^2.0.0",
      type: "dependency",
    };
    const [context] = buildDependencyContexts(scanResult(
      [declaration],
      [resolutionFor("unused-package", "dependency", {
        declaredVersion: "^2.0.0",
        resolvedVersion: "2.1.4",
        resolvedReference: "2.1.4",
      })],
    ));

    expect(context?.usage).toEqual({
      used: false,
      files: [],
      imports: [],
      importedSymbols: [],
      apiUsages: [],
    });
  });

  it("collects unique usage files from multiple source files", () => {
    expect(findDependencyContext(sampleContexts, "axios")?.usage.files).toEqual([
      "src/http.ts",
      "src/second-http.ts",
    ]);
  });

  it("summarizes a default import binding", () => {
    const imported = findDependencyContext(sampleContexts, "axios")?.usage.importedSymbols;

    expect(imported).toContainEqual(expect.objectContaining({
      importedSymbol: "default",
      localBinding: "axios",
      bindingKind: "default",
      importKind: "es-import",
    }));
  });

  it("summarizes a named import binding", () => {
    const imported = findDependencyContext(sampleContexts, "zod")?.usage.importedSymbols;

    expect(imported).toContainEqual(expect.objectContaining({
      importedSymbol: "z",
      localBinding: "z",
      bindingKind: "named",
    }));
  });

  it("preserves both identities of an aliased named import", () => {
    const imported = findDependencyContext(sampleContexts, "axios")?.usage.importedSymbols;

    expect(imported).toContainEqual(expect.objectContaining({
      importedSymbol: "AxiosError",
      localBinding: "HttpError",
      bindingKind: "named",
    }));
  });

  it("summarizes a namespace import", () => {
    const react = findDependencyContext(sampleContexts, "react");

    expect(react?.usage.importedSymbols).toContainEqual(expect.objectContaining({
      importedSymbol: "*",
      localBinding: "React",
      bindingKind: "namespace",
    }));
    expect(react?.usage.apiUsages).toContainEqual(expect.objectContaining({
      canonicalPath: "namespace.createElement",
      evidence: ["namespace-member"],
    }));
  });

  it("identifies evidence from a require binding", () => {
    const express = findDependencyContext(sampleContexts, "express");

    expect(express?.usage.importedSymbols).toContainEqual(expect.objectContaining({
      localBinding: "express",
      bindingKind: "module",
      importKind: "require",
    }));
    expect(express?.usage.apiUsages[0]).toMatchObject({
      localUsagePaths: ["express.json"],
      evidence: ["require-binding"],
    });
  });

  it("identifies evidence from a dynamic import", () => {
    const dynamicContext = findDependencyContext(sampleContexts, "some-package");

    expect(dynamicContext?.usage.apiUsages[0]).toMatchObject({
      canonicalPath: "namespace.doSomething",
      localUsagePaths: ["lazyModule.doSomething"],
      evidence: ["dynamic-import"],
    });
  });

  it("deduplicates equal canonical APIs", () => {
    expect(repeatedAliasContext().usage.apiUsages).toHaveLength(1);
  });

  it("counts API occurrences", () => {
    expect(repeatedAliasContext().usage.apiUsages[0]?.occurrenceCount).toBe(2);
  });

  it("preserves multiple original occurrences", () => {
    const api = repeatedAliasContext().usage.apiUsages[0];

    expect(api?.occurrences).toHaveLength(2);
    expect(api?.occurrences.map(({ file }) => file)).toEqual([
      "src/first.ts",
      "src/second.ts",
    ]);
    expect(api?.localUsagePaths).toEqual(["fmt", "formatDate"]);
  });

  it("sorts dependencies and API summaries deterministically", () => {
    const declarations: DependencyInfo[] = [
      { name: "zeta", declaredVersion: "^1.0.0", type: "dependency" },
      { name: "alpha", declaredVersion: "^1.0.0", type: "dependency" },
    ];
    const usage: DependencyUsage = {
      dependency: "alpha",
      files: ["src/index.ts"],
      importCount: 1,
      imports: [{
        file: "src/index.ts",
        source: "alpha",
        importedSymbols: [],
        defaultImport: "alpha",
        kind: "es-import",
      }],
      symbolUsages: [
        {
          dependency: "alpha",
          file: "src/index.ts",
          localBinding: "alpha",
          usagePath: "alpha.post",
          kind: "call",
          line: 3,
          column: 1,
        },
        {
          dependency: "alpha",
          file: "src/index.ts",
          localBinding: "alpha",
          usagePath: "alpha.get",
          kind: "call",
          line: 2,
          column: 1,
        },
      ],
    };
    const contexts = buildDependencyContexts(scanResult(
      declarations,
      declarations.map(({ name, type }) => resolutionFor(name, type)),
      [usage],
    ));

    expect(contexts.map(({ dependency }) => dependency)).toEqual(["alpha", "zeta"]);
    expect(contexts[0]?.usage.apiUsages.map(({ canonicalPath }) => canonicalPath)).toEqual([
      "default.get",
      "default.post",
    ]);
  });

  it("keeps a used dependency with unresolved resolution", () => {
    const declaration: DependencyInfo = {
      name: "some-package",
      declaredVersion: "^1.0.0",
      type: "dependency",
    };
    const usage: DependencyUsage = {
      dependency: "some-package",
      files: ["src/index.ts"],
      importCount: 1,
      imports: [{
        file: "src/index.ts",
        source: "some-package",
        importedSymbols: [],
        defaultImport: "module",
        kind: "es-import",
      }],
      symbolUsages: [],
    };
    const [context] = buildDependencyContexts(scanResult(
      [declaration],
      [{
        dependency: "some-package",
        dependencyType: "dependency",
        declaredVersion: "^1.0.0",
        kind: "unknown",
        status: "unresolved",
        issue: "dependency-not-found",
      }],
      [usage],
    ));

    expect(context).toMatchObject({
      resolution: { status: "unresolved", issue: "dependency-not-found" },
      usage: { used: true },
    });
  });

  it("builds contexts for unsupported package manager resolutions", () => {
    const declaration: DependencyInfo = {
      name: "axios",
      declaredVersion: "^1.7.0",
      type: "dependency",
    };
    const [context] = buildDependencyContexts(scanResult(
      [declaration],
      [{
        dependency: "axios",
        dependencyType: "dependency",
        declaredVersion: "^1.7.0",
        kind: "unknown",
        status: "unsupported",
        issue: "package-manager-unsupported",
      }],
    ));

    expect(context?.resolution.status).toBe("unsupported");
  });

  it("builds a workspace dependency context", () => {
    const shared = findDependencyContext(workspaceContexts, "@guardian/shared");

    expect(shared).toMatchObject({
      declaration: { declaredVersion: "workspace:*" },
      resolution: {
        kind: "workspace",
        status: "resolved",
        importer: "apps/api",
      },
      usage: { used: true },
    });
  });

  it("does not invent canonical mappings for constructor instances", () => {
    const prisma = findDependencyContext(sampleContexts, "@prisma/client");
    const instanceUsage = prisma?.usage.apiUsages.find(({ localUsagePaths }) =>
      localUsagePaths.includes("prisma.user.findMany"));

    expect(instanceUsage).toMatchObject({
      localUsagePaths: ["prisma.user.findMany"],
      evidence: ["constructor-instance"],
    });
    expect(instanceUsage?.canonicalPath).toBeUndefined();
  });

  it("preserves source locations in API occurrences", () => {
    const axios = findDependencyContext(sampleContexts, "axios");
    const getUsage = axios?.usage.apiUsages.find(({ canonicalPath }) =>
      canonicalPath === "default.get");

    expect(getUsage?.occurrences[0]).toMatchObject({
      file: "src/http.ts",
      line: 10,
      column: 22,
    });
  });

  it("normalizes a named alias to its canonical imported symbol", () => {
    const axios = findDependencyContext(sampleContexts, "axios");
    const errorUsage = axios?.usage.apiUsages.find(({ canonicalPath }) =>
      canonicalPath === "AxiosError");

    expect(errorUsage).toMatchObject({
      canonicalPath: "AxiosError",
      localUsagePaths: ["HttpError"],
    });
  });

  it("normalizes default member usage explicitly", () => {
    const axios = findDependencyContext(sampleContexts, "axios");

    expect(axios?.usage.apiUsages).toContainEqual(expect.objectContaining({
      canonicalPath: "default.get",
      localUsagePaths: ["axios.get"],
    }));
  });

  it("retains package subpath identity in canonical APIs", () => {
    const lodash = findDependencyContext(sampleContexts, "lodash");

    expect(lodash?.usage.apiUsages).toContainEqual(expect.objectContaining({
      canonicalPath: "lodash/map#default",
      localUsagePaths: ["map"],
    }));
  });

  it("marks ambiguous import evidence as unattributed", () => {
    const declaration: DependencyInfo = {
      name: "package",
      declaredVersion: "^1.0.0",
      type: "dependency",
    };
    const usage: DependencyUsage = {
      dependency: "package",
      files: ["src/index.ts"],
      importCount: 2,
      imports: [
        {
          file: "src/index.ts",
          source: "package",
          importedSymbols: ["foo"],
          symbolBindings: [{ importedSymbol: "foo", localBinding: "foo" }],
          kind: "es-import",
        },
        {
          file: "src/index.ts",
          source: "package",
          importedSymbols: ["foo"],
          symbolBindings: [{ importedSymbol: "foo", localBinding: "foo" }],
          kind: "require",
        },
      ],
      symbolUsages: [{
        dependency: "package",
        file: "src/index.ts",
        importedSymbol: "foo",
        localBinding: "foo",
        usagePath: "foo",
        kind: "call",
        line: 4,
        column: 1,
      }],
    };
    const [context] = buildDependencyContexts(scanResult(
      [declaration],
      [resolutionFor("package", "dependency")],
      [usage],
    ));

    expect(context?.usage.apiUsages[0]).toMatchObject({
      canonicalPath: "foo",
      evidence: ["unattributed"],
    });
  });

  it("normalizes import ordering independently from input order", () => {
    const declaration: DependencyInfo = {
      name: "package",
      declaredVersion: "^1.0.0",
      type: "dependency",
    };
    const imports: DependencyUsage["imports"] = [
      {
        file: "src/index.ts",
        source: "package",
        importedSymbols: ["zeta"],
        symbolBindings: [{ importedSymbol: "zeta", localBinding: "zeta" }],
        kind: "es-import",
      },
      {
        file: "src/index.ts",
        source: "package",
        importedSymbols: ["alpha"],
        symbolBindings: [{ importedSymbol: "alpha", localBinding: "alpha" }],
        kind: "es-import",
      },
    ];
    const contextForImports = (orderedImports: DependencyUsage["imports"]): DependencyContext =>
      buildDependencyContexts(scanResult(
        [declaration],
        [resolutionFor("package", "dependency")],
        [{
          dependency: "package",
          files: ["src/index.ts"],
          importCount: 2,
          imports: orderedImports,
          symbolUsages: [],
        }],
      ))[0] as DependencyContext;

    const permutedImports = [...imports].reverse().map((item) => ({
      ...item,
      importedSymbols: [...item.importedSymbols].reverse(),
      ...(item.symbolBindings === undefined
        ? {}
        : { symbolBindings: [...item.symbolBindings].reverse() }),
    }));
    expect(contextForImports(imports).usage).toEqual(contextForImports(permutedImports).usage);
  });

  it("does not merge constructor-instance usages by local spelling alone", () => {
    const declaration: DependencyInfo = {
      name: "some-sdk",
      declaredVersion: "^1.0.0",
      type: "dependency",
    };
    const usage: DependencyUsage = {
      dependency: "some-sdk",
      files: ["src/index.ts"],
      importCount: 1,
      imports: [{
        file: "src/index.ts",
        source: "some-sdk",
        importedSymbols: ["FirstClient", "SecondClient"],
        symbolBindings: [
          { importedSymbol: "FirstClient", localBinding: "FirstClient" },
          { importedSymbol: "SecondClient", localBinding: "SecondClient" },
        ],
        kind: "es-import",
      }],
      symbolUsages: [
        {
          dependency: "some-sdk",
          file: "src/index.ts",
          importedSymbol: "FirstClient",
          localBinding: "client",
          usagePath: "client.connect",
          kind: "call",
          line: 4,
          column: 1,
        },
        {
          dependency: "some-sdk",
          file: "src/index.ts",
          importedSymbol: "SecondClient",
          localBinding: "client",
          usagePath: "client.connect",
          kind: "call",
          line: 9,
          column: 1,
        },
      ],
    };
    const [context] = buildDependencyContexts(scanResult(
      [declaration],
      [resolutionFor("some-sdk", "dependency")],
      [usage],
    ));

    expect(context?.usage.apiUsages).toHaveLength(2);
    expect(context?.usage.apiUsages.every(({ canonicalPath }) =>
      canonicalPath === undefined)).toBe(true);
  });

  it("deduplicates repeated usages of the same observed constructor instance", () => {
    const declaration: DependencyInfo = {
      name: "some-sdk",
      declaredVersion: "^1.0.0",
      type: "dependency",
    };
    const baseOccurrence = {
      dependency: "some-sdk",
      file: "src/index.ts",
      importedSymbol: "Client",
      localBinding: "client",
      usagePath: "client.connect",
      kind: "call" as const,
      column: 1,
    };
    const usage: DependencyUsage = {
      dependency: "some-sdk",
      files: ["src/index.ts"],
      importCount: 1,
      imports: [{
        file: "src/index.ts",
        source: "some-sdk",
        importedSymbols: ["Client"],
        symbolBindings: [{ importedSymbol: "Client", localBinding: "Client" }],
        kind: "es-import",
      }],
      symbolUsages: [
        { ...baseOccurrence, line: 4 },
        { ...baseOccurrence, line: 5 },
      ],
    };
    const [context] = buildDependencyContexts(scanResult(
      [declaration],
      [resolutionFor("some-sdk", "dependency")],
      [usage],
    ));

    expect(context?.usage.apiUsages).toHaveLength(1);
    expect(context?.usage.apiUsages[0]).toMatchObject({
      occurrenceCount: 2,
      evidence: ["constructor-instance"],
    });
  });

  it("does not invent constructor evidence for unmatched usages", () => {
    const declaration: DependencyInfo = {
      name: "package",
      declaredVersion: "^1.0.0",
      type: "dependency",
    };
    const usage: DependencyUsage = {
      dependency: "package",
      files: ["src/index.ts"],
      importCount: 0,
      imports: [],
      symbolUsages: [{
        dependency: "package",
        file: "src/index.ts",
        localBinding: "value",
        usagePath: "value.run",
        kind: "call",
        line: 2,
        column: 1,
      }],
    };
    const [context] = buildDependencyContexts(scanResult(
      [declaration],
      [resolutionFor("package", "dependency")],
      [usage],
    ));

    expect(context?.usage.apiUsages[0]?.evidence).toEqual(["unattributed"]);
  });

  it("supports the inspect CLI command", async () => {
    const result = await runCli(["inspect", sampleProjectPath, "axios"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Guardian Dependency Context");
    expect(result.stdout).toContain("default.get");
    expect(result.stdout).toContain("version   1.7.9");
  });

  it("reports a clear CLI error for an undeclared dependency", async () => {
    const result = await runCli(["inspect", sampleProjectPath, "does-not-exist"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Guardian: Dependency "does-not-exist" is not declared by this project.',
    );
  });

  it("keeps the scan CLI command working", async () => {
    const result = await runCli(["scan", sampleProjectPath]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Guardian v0.0.1");
    expect(result.stdout).toContain("Usage\n");
    expect(result.stdout).toContain("axios.get");
  });
});

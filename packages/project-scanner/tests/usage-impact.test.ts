import { describe, expect, it, vi } from "vitest";

import {
  compareDeclarationSurfaces,
  correlateUsageImpact,
  UsageImpactCorrelationError,
  type ApiUsageSummary,
  type DeclarationEntrypoint,
  type DependencyContext,
  type DependencyUsageImpact,
  type ImportUsage,
  type InstalledDependencyResolution,
  type PackageDeclarationSurface,
  type PublicApiDeclaration,
  type PublicApiMember,
  type SignatureApiDeclaration,
  type StructuredApiDeclaration,
  type SymbolUsage,
  type UsageImpact,
} from "../src/index.js";

function apiFunction(
  exportedName = "value",
  signatures: readonly string[] = ["function(): void"],
  overrides: Partial<SignatureApiDeclaration> = {},
): SignatureApiDeclaration {
  return {
    exportedName,
    kind: "function",
    facet: 1,
    sourceFile: "index.d.ts",
    defaultExport: exportedName === "default",
    exportEquals: false,
    typeOnly: false,
    signatures,
    deprecated: false,
    ...overrides,
  };
}

function member(name: string, overrides: Partial<PublicApiMember> = {}): PublicApiMember {
  return {
    name,
    kind: "method",
    visibility: "public",
    static: false,
    optional: false,
    readonly: false,
    abstract: false,
    signatures: ["method(): void"],
    deprecated: false,
    ...overrides,
  };
}

function structuredDeclaration(
  exportedName: string,
  kind: "class" | "interface" | "enum",
  members: readonly PublicApiMember[] = [],
  overrides: Partial<StructuredApiDeclaration> = {},
): StructuredApiDeclaration {
  return {
    exportedName,
    kind,
    facet: 1,
    sourceFile: "index.d.ts",
    defaultExport: exportedName === "default",
    exportEquals: false,
    typeOnly: kind === "interface",
    signatures: [kind],
    deprecated: false,
    members,
    ...overrides,
  };
}

function namespaceDeclaration(
  exportedName: string,
  exports: readonly PublicApiDeclaration[],
  overrides: Partial<Extract<PublicApiDeclaration, { kind: "namespace" }>> = {},
): Extract<PublicApiDeclaration, { kind: "namespace" }> {
  return {
    exportedName,
    kind: "namespace",
    facet: 1,
    sourceFile: "index.d.ts",
    defaultExport: false,
    exportEquals: false,
    typeOnly: false,
    signatures: ["namespace"],
    deprecated: false,
    exports,
    ...overrides,
  };
}

function entrypoint(
  exports: readonly PublicApiDeclaration[] = [apiFunction()],
  options: {
    exportPath?: string;
    declarationFile?: string;
    conditionPaths?: readonly (readonly string[])[];
  } = {},
): DeclarationEntrypoint {
  return {
    exportPath: options.exportPath ?? ".",
    declarationFile: options.declarationFile ?? "index.d.ts",
    conditionPaths: options.conditionPaths ?? [["types"]],
    exports,
    referencedDeclarations: [],
  };
}

function surface(
  version: string,
  entrypoints: readonly DeclarationEntrypoint[] = [entrypoint()],
  packageName = "dep",
): PackageDeclarationSurface {
  return { packageName, version, entrypoints, issues: [] };
}

function importUsage(overrides: Partial<ImportUsage> = {}): ImportUsage {
  return {
    file: "src/index.ts",
    source: "dep",
    importedSymbols: [],
    kind: "es-import",
    ...overrides,
  };
}

function symbolUsage(overrides: Partial<SymbolUsage> = {}): SymbolUsage {
  return {
    dependency: "dep",
    file: "src/index.ts",
    localBinding: "dep",
    usagePath: "dep",
    kind: "call",
    line: 1,
    column: 1,
    ...overrides,
  };
}

function apiUsage(
  canonicalPath: string | undefined,
  occurrences: readonly SymbolUsage[],
  overrides: Partial<ApiUsageSummary> = {},
): ApiUsageSummary {
  return {
    ...(canonicalPath === undefined ? {} : { canonicalPath }),
    localUsagePaths: [...new Set(occurrences.map((item) => item.usagePath))],
    occurrenceCount: occurrences.length,
    evidence: ["direct-import"],
    occurrences: [...occurrences],
    ...overrides,
  };
}

function resolution(overrides: Partial<InstalledDependencyResolution> = {}): InstalledDependencyResolution {
  return {
    dependency: "dep",
    dependencyType: "dependency",
    declaredVersion: "^1.0.0",
    resolvedVersion: "1.0.0",
    resolvedReference: "1.0.0",
    kind: "registry",
    status: "resolved",
    ...overrides,
  };
}

function context(
  dependency: string,
  imports: readonly ImportUsage[],
  apiUsages: readonly ApiUsageSummary[],
): DependencyContext {
  return {
    dependency,
    declaration: { type: "dependency", declaredVersion: "^1.0.0" },
    resolution: resolution({ dependency }),
    usage: {
      used: true,
      files: [...new Set(imports.map((item) => item.file))],
      imports: [...imports],
      importedSymbols: [],
      apiUsages: [...apiUsages],
    },
  };
}

function impactFor(result: DependencyUsageImpact, canonicalPath: string): UsageImpact {
  const impact = result.impacts.find((item) => item.usage.canonicalPath === canonicalPath);
  if (impact === undefined) {
    throw new Error(`expected an impact for canonical path "${canonicalPath}"`);
  }
  return impact;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

describe("root export resolution", () => {
  it("matches a default-import usage to the default root export", () => {
    const before = surface("1.0.0", [entrypoint([apiFunction("default", ["function(): void"])])]);
    const after = surface("2.0.0", [entrypoint([apiFunction("default", ["function(value: string): void"])])]);
    const ctx = context("dep", [importUsage({ defaultImport: "dep" })], [
      apiUsage("default", [symbolUsage({ localBinding: "dep", usagePath: "default" })]),
    ]);

    const result = correlateUsageImpact(ctx, before, compareDeclarationSurfaces(before, after));
    const impact = impactFor(result, "default");

    expect(impact.status).toBe("affected");
    expect(impact.declarationPath).toEqual(["default"]);
    expect(impact.matchedChanges).toHaveLength(1);
    expect(impact.matchedChanges[0]).toMatchObject({ type: "export-modified" });
  });

  it("matches a named-import usage to its root export", () => {
    const before = surface("1.0.0", [
      entrypoint([structuredDeclaration("AxiosError", "class")]),
    ]);
    const after = surface("2.0.0", [
      entrypoint([structuredDeclaration("AxiosError", "class", [member("code")])]),
    ]);
    const ctx = context("dep", [
      importUsage({ importedSymbols: ["AxiosError"], symbolBindings: [{ importedSymbol: "AxiosError", localBinding: "AxiosError" }] }),
    ], [
      apiUsage("AxiosError", [symbolUsage({
        importedSymbol: "AxiosError",
        localBinding: "AxiosError",
        usagePath: "AxiosError",
        kind: "constructor",
      })]),
    ]);

    const result = correlateUsageImpact(ctx, before, compareDeclarationSurfaces(before, after));
    const impact = impactFor(result, "AxiosError");

    expect(impact.status).toBe("affected");
    expect(impact.declarationPath).toEqual(["AxiosError"]);
  });
});

describe("namespace import convergence", () => {
  it("resolves namespace.X to the same root export as an equivalent named import", () => {
    const before = surface("1.0.0", [
      entrypoint([apiFunction("createElement", ["function(): void"])]),
    ]);
    const after = surface("2.0.0", [
      entrypoint([apiFunction("createElement", ["function(tag: string): void"])]),
    ]);
    const diff = compareDeclarationSurfaces(before, after);

    const namespaceContext = context("dep", [importUsage({ namespaceImport: "NS" })], [
      apiUsage("namespace.createElement", [symbolUsage({
        localBinding: "NS",
        usagePath: "NS.createElement",
      })]),
    ]);
    const namedContext = context("dep", [
      importUsage({ importedSymbols: ["createElement"], symbolBindings: [{ importedSymbol: "createElement", localBinding: "createElement" }] }),
    ], [
      apiUsage("createElement", [symbolUsage({
        importedSymbol: "createElement",
        localBinding: "createElement",
        usagePath: "createElement",
      })]),
    ]);

    const namespaceResult = impactFor(
      correlateUsageImpact(namespaceContext, before, diff),
      "namespace.createElement",
    );
    const namedResult = impactFor(correlateUsageImpact(namedContext, before, diff), "createElement");

    expect(namespaceResult.status).toBe("affected");
    expect(namedResult.status).toBe("affected");
    expect(namespaceResult.declarationPath).toEqual(namedResult.declarationPath);
    expect(namespaceResult.matchedChanges).toEqual(namedResult.matchedChanges);
  });
});

describe("member access resolution", () => {
  it("correlates a two-level member access against a class declaration", () => {
    const before = surface("1.0.0", [
      entrypoint([structuredDeclaration("default", "class", [
        member("get", { signatures: ["method(url: string): void"] }),
      ])]),
    ]);
    const after = surface("2.0.0", [
      entrypoint([structuredDeclaration("default", "class", [
        member("get", { signatures: ["method(url: string, config?: object): void"] }),
      ])]),
    ]);
    const ctx = context("dep", [importUsage({ defaultImport: "http" })], [
      apiUsage("default.get", [symbolUsage({
        localBinding: "http",
        usagePath: "http.get",
        kind: "call",
      })]),
    ]);

    const result = correlateUsageImpact(ctx, before, compareDeclarationSurfaces(before, after));
    const impact = impactFor(result, "default.get");

    expect(impact.status).toBe("affected");
    expect(impact.declarationPath).toEqual(["default"]);
    expect(impact.matchedChanges).toHaveLength(1);
    expect(impact.matchedChanges[0]).toMatchObject({ type: "member-modified", name: "get" });
  });

  it("reports unaffected when the resolved member did not change", () => {
    const before = surface("1.0.0", [
      entrypoint([structuredDeclaration("default", "class", [member("get"), member("post")])]),
    ]);
    const after = surface("2.0.0", [
      entrypoint([structuredDeclaration("default", "class", [
        member("get"),
        member("post", { signatures: ["method(url: string, body: unknown): void"] }),
      ])]),
    ]);
    const ctx = context("dep", [importUsage({ defaultImport: "http" })], [
      apiUsage("default.get", [symbolUsage({ localBinding: "http", usagePath: "http.get" })]),
    ]);

    const result = correlateUsageImpact(ctx, before, compareDeclarationSurfaces(before, after));
    const impact = impactFor(result, "default.get");

    expect(impact.status).toBe("unaffected");
    expect(impact.matchedChanges).toEqual([]);
  });
});

describe("unresolved usages", () => {
  it("reports unresolved with no-canonical-path when canonicalPath is undefined", () => {
    const before = surface("1.0.0");
    const after = surface("2.0.0");
    const ctx = context("dep", [], [
      apiUsage(undefined, [symbolUsage({ localBinding: "instance", usagePath: "instance.method" })]),
    ]);

    const result = correlateUsageImpact(ctx, before, compareDeclarationSurfaces(before, after));

    expect(result.impacts).toHaveLength(1);
    expect(result.impacts[0]).toMatchObject({
      status: "unresolved",
      matchedChanges: [],
      issues: [{ code: "no-canonical-path" }],
    });
    expect(result.summary).toEqual({ affected: 0, unaffected: 0, unresolved: 1, indeterminate: 0 });
  });

  it("reports declaration-not-found when the resolved export does not exist", () => {
    const before = surface("1.0.0", [entrypoint([apiFunction("default")])]);
    const after = surface("2.0.0", [entrypoint([apiFunction("default")])]);
    const ctx = context("dep", [importUsage({ importedSymbols: ["Missing"], symbolBindings: [{ importedSymbol: "Missing", localBinding: "Missing" }] })], [
      apiUsage("Missing", [symbolUsage({ importedSymbol: "Missing", localBinding: "Missing", usagePath: "Missing" })]),
    ]);

    const result = correlateUsageImpact(ctx, before, compareDeclarationSurfaces(before, after));
    const impact = impactFor(result, "Missing");

    expect(impact.status).toBe("unresolved");
    expect(impact.issues).toEqual([expect.objectContaining({ code: "declaration-not-found" })]);
  });
});

describe("indeterminate propagation from M7", () => {
  it("marks a usage indeterminate when its entrypoint variant is comparison-indeterminate", () => {
    const before: PackageDeclarationSurface = {
      packageName: "dep",
      version: "1.0.0",
      entrypoints: [entrypoint([apiFunction("default")])],
      issues: [{
        code: "declaration-file-invalid",
        message: "Declaration file has a syntax error.",
        exportPath: ".",
      }],
    };
    const after = surface("2.0.0", [entrypoint([apiFunction("default")])]);
    const ctx = context("dep", [importUsage({ defaultImport: "dep" })], [
      apiUsage("default", [symbolUsage({ localBinding: "dep", usagePath: "default" })]),
    ]);

    const result = correlateUsageImpact(ctx, before, compareDeclarationSurfaces(before, after));
    const impact = impactFor(result, "default");

    expect(impact.status).toBe("indeterminate");
    expect(impact.issues).toContainEqual(expect.objectContaining({
      code: "indeterminate-source-comparison",
    }));
  });
});

describe("ambiguous facet correlation", () => {
  it("reports ambiguous-facet-correlation for two merged root declarations", () => {
    const before = surface("1.0.0", [entrypoint([
      apiFunction("foo", ["function(): void"], { facet: 1 }),
      namespaceDeclaration("foo", [apiFunction("bar")], { facet: 2 }),
    ])]);
    const after = surface("2.0.0", [entrypoint([
      apiFunction("foo", ["function(): void"], { facet: 1 }),
      namespaceDeclaration("foo", [apiFunction("bar", ["function(x: number): void"])], { facet: 2 }),
    ])]);
    const ctx = context("dep", [
      importUsage({ importedSymbols: ["foo"], symbolBindings: [{ importedSymbol: "foo", localBinding: "foo" }] }),
    ], [
      apiUsage("foo", [symbolUsage({ importedSymbol: "foo", localBinding: "foo", usagePath: "foo" })]),
    ]);

    const result = correlateUsageImpact(ctx, before, compareDeclarationSurfaces(before, after));
    const impact = impactFor(result, "foo");

    expect(impact.status).toBe("indeterminate");
    expect(impact.issues).toContainEqual(expect.objectContaining({
      code: "ambiguous-facet-correlation",
    }));
    // facet 2 (the namespace) changed; correlation still checks every candidate facet.
    expect(impact.matchedChanges.length).toBeGreaterThan(0);
  });
});

describe("ambiguous member correlation", () => {
  it("reports ambiguous-member-correlation when a getter and setter share a member name", () => {
    const before = surface("1.0.0", [
      entrypoint([structuredDeclaration("default", "class", [
        member("value", { kind: "getter" }),
        member("value", { kind: "setter" }),
      ])]),
    ]);
    const after = surface("2.0.0", [
      entrypoint([structuredDeclaration("default", "class", [
        member("value", { kind: "getter", signatures: ["get value(): number"] }),
        member("value", { kind: "setter" }),
      ])]),
    ]);
    const ctx = context("dep", [importUsage({ defaultImport: "dep" })], [
      apiUsage("default.value", [symbolUsage({ localBinding: "dep", usagePath: "dep.value" })]),
    ]);

    const result = correlateUsageImpact(ctx, before, compareDeclarationSurfaces(before, after));
    const impact = impactFor(result, "default.value");

    expect(impact.status).toBe("indeterminate");
    expect(impact.issues).toContainEqual(expect.objectContaining({
      code: "ambiguous-member-correlation",
    }));
    // the getter facet changed; correlation still surfaces it despite the ambiguity.
    expect(impact.matchedChanges.length).toBeGreaterThan(0);
  });
});

describe("unresolvable member access", () => {
  it("reports unresolvable-member-access when the canonical path continues past a function", () => {
    const before = surface("1.0.0", [entrypoint([apiFunction("default")])]);
    const after = surface("2.0.0", [entrypoint([apiFunction("default", ["function(x: number): void"])])]);
    const ctx = context("dep", [importUsage({ defaultImport: "dep" })], [
      apiUsage("default.extra", [symbolUsage({ localBinding: "dep", usagePath: "dep.extra" })]),
    ]);

    const result = correlateUsageImpact(ctx, before, compareDeclarationSurfaces(before, after));
    const impact = impactFor(result, "default.extra");

    expect(impact.status).toBe("indeterminate");
    expect(impact.issues).toContainEqual(expect.objectContaining({
      code: "unresolvable-member-access",
    }));
    expect(impact.declarationPath).toEqual(["default"]);
  });
});

describe("multiple conditionPath variants", () => {
  it("reports affected when one variant changed and a sibling variant did not", () => {
    const before = surface("1.0.0", [
      entrypoint([apiFunction("default", ["function(): void"])], {
        declarationFile: "esm.d.ts",
        conditionPaths: [["import"]],
      }),
      entrypoint([apiFunction("default", ["function(): void"])], {
        declarationFile: "cjs.d.ts",
        conditionPaths: [["require"]],
      }),
    ]);
    const after = surface("2.0.0", [
      entrypoint([apiFunction("default", ["function(value: string): void"])], {
        declarationFile: "esm.d.ts",
        conditionPaths: [["import"]],
      }),
      entrypoint([apiFunction("default", ["function(): void"])], {
        declarationFile: "cjs.d.ts",
        conditionPaths: [["require"]],
      }),
    ]);
    const diff = compareDeclarationSurfaces(before, after);
    // Sanity check on the fixture: only the "import" variant actually changed.
    expect(diff.entrypointChanges).toHaveLength(1);
    expect(diff.entrypointChanges[0]).toMatchObject({ conditionPath: ["import"] });

    const ctx = context("dep", [importUsage({ defaultImport: "dep" })], [
      apiUsage("default", [symbolUsage({ localBinding: "dep", usagePath: "default" })]),
    ]);

    const result = correlateUsageImpact(ctx, before, diff);
    const impact = impactFor(result, "default");

    expect(impact.status).toBe("affected");
  });
});

describe("package mismatch validation", () => {
  it("throws a typed error when dependency, installed surface, and diff package names disagree", () => {
    const before = surface("1.0.0", [], "other-dep");
    const after = surface("2.0.0", [], "other-dep");
    const ctx = context("dep", [], []);

    expect(() => correlateUsageImpact(ctx, before, compareDeclarationSurfaces(before, after)))
      .toThrowError(UsageImpactCorrelationError);
    try {
      correlateUsageImpact(ctx, before, compareDeclarationSurfaces(before, after));
    } catch (error) {
      expect(error).toMatchObject({
        code: "package-mismatch",
        dependency: "dep",
        installedSurfacePackageName: "other-dep",
        diffPackageName: "other-dep",
      });
    }
  });
});

describe("version mismatch validation", () => {
  it("throws a typed error when the installed surface version does not match diff.beforeVersion", () => {
    const before = surface("1.0.0");
    const mismatchedSurface = surface("1.5.0");
    const after = surface("2.0.0");
    const ctx = context("dep", [], []);

    expect(() => correlateUsageImpact(ctx, mismatchedSurface, compareDeclarationSurfaces(before, after)))
      .toThrowError(UsageImpactCorrelationError);
    try {
      correlateUsageImpact(ctx, mismatchedSurface, compareDeclarationSurfaces(before, after));
    } catch (error) {
      expect(error).toMatchObject({
        code: "version-mismatch",
        dependency: "dep",
        installedSurfaceVersion: "1.5.0",
        diffBeforeVersion: "1.0.0",
      });
    }
  });
});

describe("edge cases discovered while implementing", () => {
  it("matches a default-import usage against an export= (CommonJS interop) declaration", () => {
    const before = surface("1.0.0", [entrypoint([apiFunction("export=", ["function(): void"], { exportEquals: true })])]);
    const after = surface("2.0.0", [entrypoint([apiFunction("export=", ["function(value: string): void"], { exportEquals: true })])]);
    const ctx = context("dep", [importUsage({ defaultImport: "dep" })], [
      apiUsage("default", [symbolUsage({ localBinding: "dep", usagePath: "default" })]),
    ]);

    const result = correlateUsageImpact(ctx, before, compareDeclarationSurfaces(before, after));
    const impact = impactFor(result, "default");

    expect(impact.status).toBe("affected");
    expect(impact.declarationPath).toEqual(["export="]);
  });

  it("reports indeterminate for a bare namespace-import reference with no member segment", () => {
    const before = surface("1.0.0", [entrypoint([apiFunction("value")])]);
    const after = surface("2.0.0", [entrypoint([apiFunction("value", ["function(x: number): void"])])]);
    const ctx = context("dep", [importUsage({ namespaceImport: "NS" })], [
      apiUsage("namespace", [symbolUsage({ localBinding: "NS", usagePath: "NS", kind: "reference" })]),
    ]);

    const result = correlateUsageImpact(ctx, before, compareDeclarationSurfaces(before, after));
    const impact = impactFor(result, "namespace");

    expect(impact.status).toBe("indeterminate");
    expect(impact.declarationPath).toEqual([]);
    expect(impact.issues).toContainEqual(expect.objectContaining({
      code: "unresolvable-member-access",
    }));
  });
});

describe("purity and determinism", () => {
  it("does not mutate the context, installed surface, or diff inputs", () => {
    const before = deepFreeze(surface("1.0.0", [
      entrypoint([structuredDeclaration("default", "class", [member("get")])]),
    ]));
    const after = deepFreeze(surface("2.0.0", [
      entrypoint([structuredDeclaration("default", "class", [member("get", { signatures: ["method(x: number): void"] })])]),
    ]));
    const diff = deepFreeze(compareDeclarationSurfaces(
      structuredClone(before),
      structuredClone(after),
    ));
    const ctx = deepFreeze(context("dep", [importUsage({ defaultImport: "dep" })], [
      apiUsage("default.get", [symbolUsage({ localBinding: "dep", usagePath: "dep.get" })]),
    ]));
    const contextSnapshot = structuredClone(ctx);
    const beforeSnapshot = structuredClone(before);
    const diffSnapshot = structuredClone(diff);

    expect(() => correlateUsageImpact(ctx, before, diff)).not.toThrow();
    expect(ctx).toEqual(contextSnapshot);
    expect(before).toEqual(beforeSnapshot);
    expect(diff).toEqual(diffSnapshot);
  });

  it("returns deeply equal results across repeated calls", () => {
    const before = surface("1.0.0", [entrypoint([apiFunction("default")])]);
    const after = surface("2.0.0", [entrypoint([apiFunction("default", ["function(x: number): void"])])]);
    const diff = compareDeclarationSurfaces(before, after);
    const ctx = context("dep", [importUsage({ defaultImport: "dep" })], [
      apiUsage("default", [symbolUsage({ localBinding: "dep", usagePath: "default" })]),
    ]);

    const first = correlateUsageImpact(ctx, before, diff);
    expect(correlateUsageImpact(ctx, before, diff)).toEqual(first);
    expect(correlateUsageImpact(ctx, before, diff)).toEqual(first);
  });

  it("does not depend on localeCompare", () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("localeCompare must not be used");
      });
    const before = surface("1.0.0", [entrypoint([
      structuredDeclaration("default", "class", [member("b"), member("a")]),
    ])]);
    const after = surface("2.0.0", [entrypoint([
      structuredDeclaration("default", "class", [
        member("a"),
        member("b", { signatures: ["method(x: number): void"] }),
      ]),
    ])]);
    const diff = compareDeclarationSurfaces(before, after);
    const ctx = context("dep", [importUsage({ defaultImport: "dep" })], [
      apiUsage("default.b", [symbolUsage({ localBinding: "dep", usagePath: "dep.b" })]),
    ]);

    expect(() => correlateUsageImpact(ctx, before, diff)).not.toThrow();
    expect(localeCompare).not.toHaveBeenCalled();
  });
});

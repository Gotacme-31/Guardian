import { describe, expect, it, vi } from "vitest";

import {
  compareDeclarationSurfaces,
  DeclarationSurfaceComparisonError,
  type DeclarationEntrypoint,
  type DeclarationSurfaceIssue,
  type PackageDeclarationSurface,
  type PackageDeclarationSurfaceDiff,
  type PublicApiDeclaration,
  type PublicApiMember,
  type ReferencedApiDeclaration,
  type SignatureApiDeclaration,
  type StructuredApiDeclaration,
  type StructuredReferencedApiDeclaration,
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
    defaultExport: false,
    exportEquals: false,
    typeOnly: false,
    signatures,
    deprecated: false,
    ...overrides,
  };
}

function member(
  name: string,
  overrides: Partial<PublicApiMember> = {},
): PublicApiMember {
  return {
    name,
    kind: "property",
    visibility: "public",
    static: false,
    optional: false,
    readonly: false,
    abstract: false,
    signatures: [": string"],
    deprecated: false,
    ...overrides,
  };
}

function structuredDeclaration(
  exportedName: string,
  kind: "class" | "interface" | "enum",
  members: readonly PublicApiMember[] = [],
  signatures: readonly string[] = [kind],
  overrides: Partial<StructuredApiDeclaration> = {},
): StructuredApiDeclaration {
  return {
    exportedName,
    kind,
    facet: 1,
    sourceFile: "index.d.ts",
    defaultExport: false,
    exportEquals: false,
    typeOnly: kind === "interface",
    signatures,
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

function externalDeclaration(
  externalModule: string,
  importedName = "External",
): Extract<PublicApiDeclaration, { kind: "external-reexport" }> {
  return {
    exportedName: "External",
    kind: "external-reexport",
    facet: 1,
    sourceFile: "index.d.ts",
    defaultExport: false,
    exportEquals: false,
    typeOnly: false,
    signatures: [],
    deprecated: false,
    externalModule,
    importedName,
  };
}

function referencedInterface(
  name = "Options",
  members: readonly PublicApiMember[] = [member("value")],
  overrides: Partial<StructuredReferencedApiDeclaration> = {},
): StructuredReferencedApiDeclaration {
  return {
    name,
    kind: "interface",
    facet: 1,
    sourceFile: "internal.d.ts",
    typeOnly: true,
    signatures: ["interface"],
    deprecated: false,
    members,
    ...overrides,
  };
}

function entrypoint(
  exports: readonly PublicApiDeclaration[] = [apiFunction()],
  options: {
    exportPath?: string;
    declarationFile?: string;
    conditionPaths?: readonly (readonly string[])[];
    referencedDeclarations?: readonly ReferencedApiDeclaration[];
  } = {},
): DeclarationEntrypoint {
  return {
    exportPath: options.exportPath ?? ".",
    declarationFile: options.declarationFile ?? "index.d.ts",
    conditionPaths: options.conditionPaths ?? [["types"]],
    exports,
    referencedDeclarations: options.referencedDeclarations ?? [],
  };
}

function surface(
  version: string,
  entrypoints: readonly DeclarationEntrypoint[] = [entrypoint()],
  issues: readonly DeclarationSurfaceIssue[] = [],
  packageName = "fixture-package",
): PackageDeclarationSurface {
  return { packageName, version, entrypoints, issues };
}

function modifiedEntrypoint(diff: PackageDeclarationSurfaceDiff) {
  const change = diff.entrypointChanges[0];
  expect(change?.type).toBe("entrypoint-modified");
  if (change?.type !== "entrypoint-modified") {
    throw new Error("expected modified entrypoint");
  }
  return change;
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

describe("declaration surface comparison entrypoints", () => {
  it("returns an empty API diff for identical surfaces", () => {
    const input = surface("1.0.0");
    const diff = compareDeclarationSurfaces(input, structuredClone(input));

    expect(diff.entrypointChanges).toEqual([]);
    expect(diff.provenanceChanges).toEqual([]);
    expect(diff.comparisonIssues).toEqual([]);
    expect(diff.summary).toMatchObject({
      entrypointsAdded: 0,
      entrypointsRemoved: 0,
      entrypointsModified: 0,
      exportsAdded: 0,
      exportsRemoved: 0,
      exportsModified: 0,
      referencedDeclarationsModified: 0,
      hasApiChanges: false,
    });
  });

  it("ignores a version-only change", () => {
    const diff = compareDeclarationSurfaces(surface("1.0.0"), surface("2.0.0"));

    expect(diff).toMatchObject({
      packageName: "fixture-package",
      beforeVersion: "1.0.0",
      afterVersion: "2.0.0",
      entrypointChanges: [],
      provenanceChanges: [],
      comparisonIssues: [],
      summary: { hasApiChanges: false },
    });
  });

  it("reports an added entrypoint and its exports", () => {
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", []),
      surface("2.0.0", [entrypoint([apiFunction("create")])]),
    );

    expect(diff.entrypointChanges).toEqual([
      expect.objectContaining({
        type: "entrypoint-added",
        exportPath: ".",
        conditionPath: ["types"],
        exportChanges: [expect.objectContaining({
          type: "export-added",
          declarationPath: ["create"],
        })],
      }),
    ]);
    expect(diff.summary).toMatchObject({ entrypointsAdded: 1, exportsAdded: 1 });
  });

  it("reports a removed entrypoint and its exports", () => {
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([apiFunction("create")])]),
      surface("2.0.0", []),
    );

    expect(diff.entrypointChanges).toEqual([
      expect.objectContaining({
        type: "entrypoint-removed",
        beforeDeclarationFile: "index.d.ts",
        exportChanges: [expect.objectContaining({ type: "export-removed" })],
      }),
    ]);
    expect(diff.summary).toMatchObject({ entrypointsRemoved: 1, exportsRemoved: 1 });
  });

  it("compares added and removed condition variants independently", () => {
    const defaultPath = ["types", "default"];
    const requirePath = ["types", "require"];
    const before = surface("1.0.0", [entrypoint(undefined, {
      conditionPaths: [defaultPath],
    })]);
    const withRequire = surface("2.0.0", [entrypoint(undefined, {
      conditionPaths: [requirePath, defaultPath],
    })]);

    const added = compareDeclarationSurfaces(before, withRequire);
    expect(added.entrypointChanges).toEqual([
      expect.objectContaining({
        type: "entrypoint-added",
        conditionPath: requirePath,
      }),
    ]);
    const removed = compareDeclarationSurfaces(withRequire, before);
    expect(removed.entrypointChanges).toEqual([
      expect.objectContaining({
        type: "entrypoint-removed",
        conditionPath: requirePath,
      }),
    ]);
  });

  it("does not merge distinct variants sharing an export path", () => {
    const before = surface("1.0.0", [
      entrypoint([apiFunction("esm")], {
        declarationFile: "index.d.mts",
        conditionPaths: [["types", "import"]],
      }),
      entrypoint([apiFunction("cjs")], {
        declarationFile: "index.d.cts",
        conditionPaths: [["types", "require"]],
      }),
    ]);
    const after = surface("2.0.0", [
      entrypoint([apiFunction("esm", ["function(value: string): void"])], {
        declarationFile: "index.d.mts",
        conditionPaths: [["types", "import"]],
      }),
      entrypoint([apiFunction("cjs")], {
        declarationFile: "index.d.cts",
        conditionPaths: [["types", "require"]],
      }),
    ]);

    const diff = compareDeclarationSurfaces(before, after);
    expect(diff.entrypointChanges).toHaveLength(1);
    expect(diff.entrypointChanges[0]).toMatchObject({
      type: "entrypoint-modified",
      conditionPath: ["types", "import"],
    });
  });
});

describe("public export changes", () => {
  it("reports an added export", () => {
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([apiFunction("alpha")])]),
      surface("2.0.0", [entrypoint([apiFunction("alpha"), apiFunction("beta")])]),
    );

    expect(modifiedEntrypoint(diff).exportChanges).toEqual([
      expect.objectContaining({ type: "export-added", declarationPath: ["beta"] }),
    ]);
    expect(diff.summary.exportsAdded).toBe(1);
  });

  it("reports a removed export without inferring a rename", () => {
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([apiFunction("oldName")])]),
      surface("2.0.0", [entrypoint([apiFunction("newName")])]),
    );

    expect(modifiedEntrypoint(diff).exportChanges.map((change) => change.type)).toEqual([
      "export-added",
      "export-removed",
    ]);
    expect(JSON.stringify(diff)).not.toContain("rename");
  });

  it("reports a kind change on the same public facet as modification", () => {
    const diff = compareDeclarationSurfaces(
      surface("1.0.0"),
      surface("2.0.0", [entrypoint([
        structuredDeclaration("value", "class", [], ["class"]),
      ])]),
    );

    expect(modifiedEntrypoint(diff).exportChanges).toEqual([
      expect.objectContaining({
        type: "export-modified",
        declarationPath: ["value"],
        facet: 1,
        propertyChanges: [expect.objectContaining({
          property: "kind",
          before: "function",
          after: "class",
        })],
      }),
    ]);
  });

  it("reports signature replacement as added and removed canonical signatures", () => {
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([apiFunction("parse", ["function(value: string): void"])])]),
      surface("2.0.0", [entrypoint([apiFunction("parse", ["function(value: number): void"])])]),
    );
    const change = modifiedEntrypoint(diff).exportChanges[0];

    expect(change).toMatchObject({
      type: "export-modified",
      signatureChanges: [
        { type: "signature-added", signature: "function(value: number): void" },
        { type: "signature-removed", signature: "function(value: string): void" },
      ],
    });
    expect(diff.summary).toMatchObject({ signaturesAdded: 1, signaturesRemoved: 1 });
    expect(JSON.stringify(diff)).not.toMatch(/breaking|unsafe|risk/u);
  });

  it("reports an added overload without collapsing existing overloads", () => {
    const stringOverload = "function(value: string): void";
    const numberOverload = "function(value: number): void";
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([apiFunction("parse", [stringOverload])])]),
      surface("2.0.0", [entrypoint([apiFunction("parse", [numberOverload, stringOverload])])]),
    );

    expect(modifiedEntrypoint(diff).exportChanges[0]).toMatchObject({
      signatureChanges: [{ type: "signature-added", signature: numberOverload }],
    });
  });

  it("reports a removed overload", () => {
    const stringOverload = "function(value: string): void";
    const numberOverload = "function(value: number): void";
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([apiFunction("parse", [stringOverload, numberOverload])])]),
      surface("2.0.0", [entrypoint([apiFunction("parse", [stringOverload])])]),
    );

    expect(modifiedEntrypoint(diff).exportChanges[0]).toMatchObject({
      signatureChanges: [{ type: "signature-removed", signature: numberOverload }],
    });
  });

  it("treats an equivalent shuffled overload set as unchanged", () => {
    const signatures = [
      "function(value: string): void",
      "function(value: number): void",
    ];
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([apiFunction("parse", signatures)])]),
      surface("2.0.0", [entrypoint([apiFunction("parse", [...signatures].reverse())])]),
    );

    expect(diff.entrypointChanges).toEqual([]);
  });

  it.each([
    ["defaultExport", { defaultExport: true }],
    ["exportEquals", { exportEquals: true }],
    ["typeOnly", { typeOnly: true }],
  ] as const)("reports a %s flag change", (property, overrides) => {
    const diff = compareDeclarationSurfaces(
      surface("1.0.0"),
      surface("2.0.0", [entrypoint([apiFunction("value", undefined, overrides)])]),
    );

    expect(modifiedEntrypoint(diff).exportChanges[0]).toMatchObject({
      type: "export-modified",
      propertyChanges: [expect.objectContaining({ property, before: false, after: true })],
    });
  });

  it("reports deprecation added and removed", () => {
    const current = surface("1.0.0");
    const deprecated = surface("2.0.0", [entrypoint([
      apiFunction("value", undefined, { deprecated: true }),
    ])]);

    expect(modifiedEntrypoint(compareDeclarationSurfaces(current, deprecated)).exportChanges[0])
      .toMatchObject({ deprecationChange: { type: "deprecated-added" } });
    expect(modifiedEntrypoint(compareDeclarationSurfaces(deprecated, current)).exportChanges[0])
      .toMatchObject({ deprecationChange: { type: "deprecated-removed" } });
  });

  it("compares external re-export targets without resolving them", () => {
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([externalDeclaration("external-one")])]),
      surface("2.0.0", [entrypoint([externalDeclaration("external-two", "Renamed")])]),
    );

    expect(modifiedEntrypoint(diff).exportChanges[0]).toMatchObject({
      propertyChanges: [
        expect.objectContaining({ property: "externalModule", after: "external-two" }),
        expect.objectContaining({ property: "importedName", after: "Renamed" }),
      ],
    });
  });
});

describe("member and namespace comparison", () => {
  it("reports an added class member", () => {
    const before = structuredDeclaration("Client", "class");
    const after = structuredDeclaration("Client", "class", [member("request")]);
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([before])]),
      surface("2.0.0", [entrypoint([after])]),
    );

    expect(modifiedEntrypoint(diff).exportChanges[0]).toMatchObject({
      memberChanges: [expect.objectContaining({
        type: "member-added",
        member: expect.objectContaining({ name: "request" }),
      })],
    });
    expect(diff.summary.membersAdded).toBe(1);
  });

  it("reports a removed member", () => {
    const before = structuredDeclaration("Client", "class", [member("request")]);
    const after = structuredDeclaration("Client", "class");
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([before])]),
      surface("2.0.0", [entrypoint([after])]),
    );

    expect(modifiedEntrypoint(diff).exportChanges[0]).toMatchObject({
      memberChanges: [expect.objectContaining({ type: "member-removed" })],
    });
  });

  it("reports member kind, visibility, optionality, readonly, abstract, and signatures", () => {
    const beforeMember = member("run", {
      kind: "method",
      signatures: ["method(value: string): void"],
    });
    const afterMember = member("run", {
      kind: "property",
      visibility: "protected",
      optional: true,
      readonly: true,
      abstract: true,
      signatures: [": (value: number) => void"],
    });
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([
        structuredDeclaration("Client", "class", [beforeMember]),
      ])]),
      surface("2.0.0", [entrypoint([
        structuredDeclaration("Client", "class", [afterMember]),
      ])]),
    );
    const change = modifiedEntrypoint(diff).exportChanges[0];

    expect(change).toMatchObject({
      memberChanges: [expect.objectContaining({
        type: "member-modified",
        propertyChanges: expect.arrayContaining([
          expect.objectContaining({ property: "kind" }),
          expect.objectContaining({ property: "visibility" }),
          expect.objectContaining({ property: "optional" }),
          expect.objectContaining({ property: "readonly" }),
          expect.objectContaining({ property: "abstract" }),
        ]),
        signatureChanges: expect.arrayContaining([
          expect.objectContaining({ type: "signature-added" }),
          expect.objectContaining({ type: "signature-removed" }),
        ]),
      })],
    });
  });

  it("keeps getter and setter slots distinct", () => {
    const getter = member("value", { kind: "getter", readonly: true, signatures: ["get: string"] });
    const setter = member("value", { kind: "setter", signatures: ["set(next: string)"] });
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([
        structuredDeclaration("Client", "class", [getter, setter]),
      ])]),
      surface("2.0.0", [entrypoint([
        structuredDeclaration("Client", "class", [getter]),
      ])]),
    );

    expect(modifiedEntrypoint(diff).exportChanges[0]).toMatchObject({
      memberChanges: [expect.objectContaining({
        type: "member-removed",
        member: expect.objectContaining({ kind: "setter" }),
      })],
    });
  });

  it("detects interface heritage and generic constraint signature changes", () => {
    const heritageDiff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([
        structuredDeclaration("Child", "interface", [], ["interface<T> extends Parent"]),
      ])]),
      surface("2.0.0", [entrypoint([
        structuredDeclaration("Child", "interface", [], ["interface<T> extends Other"]),
      ])]),
    );
    expect(modifiedEntrypoint(heritageDiff).exportChanges[0]).toMatchObject({
      signatureChanges: expect.arrayContaining([
        expect.objectContaining({ type: "signature-added", signature: "interface<T> extends Other" }),
      ]),
    });

    const genericDiff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([
        apiFunction("identity", ["function<T extends string>(value: T): T"]),
      ])]),
      surface("2.0.0", [entrypoint([
        apiFunction("identity", ["function<T extends string | number>(value: T): T"]),
      ])]),
    );
    expect(modifiedEntrypoint(genericDiff).exportChanges[0]).toMatchObject({
      type: "export-modified",
      signatureChanges: expect.arrayContaining([expect.objectContaining({
        signature: "function<T extends string | number>(value: T): T",
      })]),
    });
  });

  it("detects enum member initializer changes", () => {
    const before = structuredDeclaration("Mode", "enum", [
      member("A", { kind: "enum-member", readonly: true, signatures: ["= \"a\""] }),
    ], ["enum"]);
    const after = structuredDeclaration("Mode", "enum", [
      member("A", { kind: "enum-member", readonly: true, signatures: ["= \"changed\""] }),
    ], ["enum"]);
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([before])]),
      surface("2.0.0", [entrypoint([after])]),
    );

    expect(modifiedEntrypoint(diff).exportChanges[0]).toMatchObject({
      memberChanges: [expect.objectContaining({
        type: "member-modified",
        signatureChanges: expect.arrayContaining([
          expect.objectContaining({ type: "signature-added", signature: "= \"changed\"" }),
        ]),
      })],
    });
  });

  it("reports a deeply nested namespace change with a semantic path", () => {
    const before = namespaceDeclaration("Outer", [
      namespaceDeclaration("Inner", [apiFunction("run", ["function(): string"])]),
    ]);
    const after = namespaceDeclaration("Outer", [
      namespaceDeclaration("Inner", [apiFunction("run", ["function(): number"])]),
    ]);
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([before])]),
      surface("2.0.0", [entrypoint([after])]),
    );
    const outer = modifiedEntrypoint(diff).exportChanges[0];

    expect(outer).toMatchObject({
      type: "export-modified",
      nestedExportChanges: [expect.objectContaining({
        declarationPath: ["Outer", "Inner"],
        nestedExportChanges: [expect.objectContaining({
          declarationPath: ["Outer", "Inner", "run"],
          signatureChanges: expect.any(Array),
        })],
      })],
    });
  });
});

describe("referenced declarations and provenance", () => {
  it("detects an effective API change in a referenced declaration", () => {
    const beforeReference = referencedInterface("Options", [member("value")]);
    const afterReference = referencedInterface("Options", [
      member("value", { signatures: [": number"] }),
    ]);
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([apiFunction("create")], {
        referencedDeclarations: [beforeReference],
      })]),
      surface("2.0.0", [entrypoint([apiFunction("create")], {
        referencedDeclarations: [afterReference],
      })]),
    );

    expect(modifiedEntrypoint(diff).referencedDeclarationChanges).toEqual([
      expect.objectContaining({
        type: "referenced-declaration-modified",
        declarationPath: ["Options"],
        memberChanges: [expect.objectContaining({ type: "member-modified" })],
      }),
    ]);
    expect(diff.summary.referencedDeclarationsModified).toBe(1);
  });

  it("reports referenced declarations added and removed", () => {
    const reference = referencedInterface();
    const added = compareDeclarationSurfaces(
      surface("1.0.0"),
      surface("2.0.0", [entrypoint(undefined, { referencedDeclarations: [reference] })]),
    );
    expect(modifiedEntrypoint(added).referencedDeclarationChanges[0]?.type)
      .toBe("referenced-declaration-added");

    const removed = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint(undefined, { referencedDeclarations: [reference] })]),
      surface("2.0.0"),
    );
    expect(modifiedEntrypoint(removed).referencedDeclarationChanges[0]?.type)
      .toBe("referenced-declaration-removed");
  });

  it("records declaration file relocation only as entrypoint provenance", () => {
    const diff = compareDeclarationSurfaces(
      surface("1.0.0"),
      surface("2.0.0", [entrypoint(undefined, { declarationFile: "dist/index.d.ts" })]),
    );

    expect(diff.entrypointChanges).toEqual([]);
    expect(diff.provenanceChanges).toEqual([
      {
        type: "entrypoint-declaration-file-changed",
        exportPath: ".",
        conditionPath: ["types"],
        beforeDeclarationFile: "index.d.ts",
        afterDeclarationFile: "dist/index.d.ts",
      },
    ]);
    expect(diff.summary).toMatchObject({
      provenanceChanges: 1,
      hasApiChanges: false,
    });
  });

  it("records resolved re-export source movement only as provenance", () => {
    const before = apiFunction("create", undefined, { sourceFile: "internal/a.d.ts" });
    const after = apiFunction("create", undefined, { sourceFile: "internal/b.d.ts" });
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([before])]),
      surface("2.0.0", [entrypoint([after])]),
    );

    expect(diff.entrypointChanges).toEqual([]);
    expect(diff.provenanceChanges).toEqual([
      expect.objectContaining({
        type: "export-source-file-changed",
        declarationPath: ["create"],
        beforeSourceFile: "internal/a.d.ts",
        afterSourceFile: "internal/b.d.ts",
      }),
    ]);
  });

  it("records referenced declaration source movement only as provenance", () => {
    const before = referencedInterface("Options", undefined, { sourceFile: "a.d.ts" });
    const after = referencedInterface("Options", undefined, { sourceFile: "b.d.ts" });
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint(undefined, { referencedDeclarations: [before] })]),
      surface("2.0.0", [entrypoint(undefined, { referencedDeclarations: [after] })]),
    );

    expect(diff.entrypointChanges).toEqual([]);
    expect(diff.provenanceChanges).toEqual([
      expect.objectContaining({
        type: "referenced-declaration-source-file-changed",
        declarationPath: ["Options"],
      }),
    ]);
  });

  it("distinguishes provenance beneath same-name namespace facets", () => {
    const namespaceFacet = (
      facet: number,
      childSource: string,
    ): PublicApiDeclaration => namespaceDeclaration("Merged", [
      apiFunction("child", undefined, { sourceFile: childSource }),
    ], { facet });
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([
        namespaceFacet(1, "one-before.d.ts"),
        namespaceFacet(2, "two-before.d.ts"),
      ])]),
      surface("2.0.0", [entrypoint([
        namespaceFacet(1, "one-after.d.ts"),
        namespaceFacet(2, "two-after.d.ts"),
      ])]),
    );

    expect(diff.entrypointChanges).toEqual([]);
    expect(diff.provenanceChanges).toEqual([
      expect.objectContaining({
        declarationPath: ["Merged", "child"],
        facetPath: [1, 1],
        beforeSourceFile: "one-before.d.ts",
      }),
      expect.objectContaining({
        declarationPath: ["Merged", "child"],
        facetPath: [2, 1],
        beforeSourceFile: "two-before.d.ts",
      }),
    ]);
  });
});

describe("comparison issues and defensive normalization", () => {
  it("does not claim removal when the after extraction is incomplete", () => {
    const missingIssue: DeclarationSurfaceIssue = {
      code: "declaration-file-missing",
      message: "Declaration file is missing.",
      exportPath: ".",
      declarationFile: "index.d.ts",
    };
    const diff = compareDeclarationSurfaces(
      surface("1.0.0"),
      surface("2.0.0", [], [missingIssue]),
    );

    expect(diff.entrypointChanges).toEqual([]);
    expect(diff.sourceIssues.after).toEqual([missingIssue]);
    expect(diff.comparisonIssues).toEqual([
      expect.objectContaining({
        code: "indeterminate-entrypoint-comparison",
        exportPath: ".",
        sourceIssueCodes: ["declaration-file-missing"],
      }),
    ]);
  });

  it("blocks false member removals across every variant of an incomplete export path", () => {
    const clientBefore = structuredDeclaration("Client", "class", [member("request")]);
    const clientAfter = structuredDeclaration("Client", "class");
    const variants = [["types", "default"], ["types", "require"]] as const;
    const issue: DeclarationSurfaceIssue = {
      code: "analysis-limit-exceeded",
      message: "Member analysis was truncated.",
      exportPath: ".",
      limit: "maxMembers",
    };
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([clientBefore], { conditionPaths: variants })]),
      surface("2.0.0", [entrypoint([clientAfter], { conditionPaths: variants })], [issue]),
    );

    expect(diff.entrypointChanges).toEqual([]);
    expect(diff.summary.membersRemoved).toBe(0);
    expect(diff.comparisonIssues).toEqual([
      expect.objectContaining({
        code: "indeterminate-entrypoint-comparison",
        conditionPath: ["types", "default"],
      }),
      expect.objectContaining({
        code: "indeterminate-entrypoint-comparison",
        conditionPath: ["types", "require"],
      }),
    ]);
  });

  it("reports an indeterminate package comparison for global extraction failure", () => {
    const issue: DeclarationSurfaceIssue = {
      code: "package-json-invalid",
      message: "Invalid package manifest.",
    };
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [], [issue]),
      surface("2.0.0", [], [issue]),
    );

    expect(diff.comparisonIssues).toEqual([
      expect.objectContaining({ code: "indeterminate-package-comparison" }),
    ]);
    expect(diff.summary.hasApiChanges).toBe(false);
  });

  it("preserves non-blocking external re-export issues without making comparison indeterminate", () => {
    const issue: DeclarationSurfaceIssue = {
      code: "external-reexport",
      message: "External declaration was not resolved.",
      exportPath: ".",
      sourceFile: "index.d.ts",
      specifier: "external-package",
    };
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", undefined, [issue]),
      surface("2.0.0", undefined, [issue]),
    );

    expect(diff.sourceIssues).toEqual({ before: [issue], after: [issue] });
    expect(diff.comparisonIssues).toEqual([]);
  });

  it("throws a typed error for package mismatch", () => {
    expect(() => compareDeclarationSurfaces(
      surface("1.0.0", undefined, undefined, "first-package"),
      surface("2.0.0", undefined, undefined, "second-package"),
    )).toThrowError(DeclarationSurfaceComparisonError);
    try {
      compareDeclarationSurfaces(
        surface("1.0.0", undefined, undefined, "first-package"),
        surface("2.0.0", undefined, undefined, "second-package"),
      );
    } catch (error) {
      expect(error).toMatchObject({
        code: "package-mismatch",
        beforePackageName: "first-package",
        afterPackageName: "second-package",
      });
    }
  });

  it("detects duplicate entrypoint identities without last-one-wins behavior", () => {
    const duplicate = entrypoint();
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [duplicate, structuredClone(duplicate)]),
      surface("2.0.0", [duplicate]),
    );

    expect(diff.entrypointChanges).toEqual([]);
    expect(diff.comparisonIssues).toContainEqual(expect.objectContaining({
      code: "duplicate-entrypoint-identity",
      side: "before",
    }));
  });

  it("detects repeated condition paths inside one entrypoint", () => {
    const repeated = entrypoint(undefined, {
      conditionPaths: [["types", "default"], ["types", "default"]],
    });
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [repeated]),
      surface("2.0.0", [entrypoint(undefined, {
        conditionPaths: [["types", "default"]],
      })]),
    );

    expect(diff.entrypointChanges).toEqual([]);
    expect(diff.comparisonIssues).toContainEqual(expect.objectContaining({
      code: "duplicate-entrypoint-identity",
      side: "before",
      conditionPath: ["types", "default"],
    }));
  });

  it("detects duplicate export, member, and reference identities", () => {
    const duplicateExport = apiFunction("duplicate");
    const duplicateMember = member("same");
    const duplicateReference = referencedInterface();
    const before = surface("1.0.0", [entrypoint([
      duplicateExport,
      structuredClone(duplicateExport),
      structuredDeclaration("Client", "class", [
        duplicateMember,
        structuredClone(duplicateMember),
      ]),
    ], {
      referencedDeclarations: [duplicateReference, structuredClone(duplicateReference)],
    })]);
    const after = surface("2.0.0", [entrypoint([
      duplicateExport,
      structuredDeclaration("Client", "class", [duplicateMember]),
    ], {
      referencedDeclarations: [duplicateReference],
    })]);

    const diff = compareDeclarationSurfaces(before, after);
    expect(diff.comparisonIssues.map((issue) => issue.code)).toEqual([
      "duplicate-export-identity",
      "duplicate-member-identity",
      "duplicate-referenced-declaration-identity",
    ]);
  });

  it("detects duplicate identities inside wholly added declaration trees", () => {
    const duplicateChild = apiFunction("child");
    const duplicateNestedMember = member("value");
    const addedNamespace = namespaceDeclaration("Tools", [
      duplicateChild,
      structuredClone(duplicateChild),
      structuredDeclaration("Client", "class", [
        duplicateNestedMember,
        structuredClone(duplicateNestedMember),
      ]),
    ]);
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", []),
      surface("2.0.0", [entrypoint([addedNamespace])]),
    );

    expect(diff.entrypointChanges[0]).toMatchObject({
      type: "entrypoint-added",
      exportChanges: [],
    });
    expect(diff.comparisonIssues.map((issue) => issue.code)).toEqual([
      "duplicate-export-identity",
      "duplicate-member-identity",
    ]);
  });

  it("keeps duplicate accessor issues distinct and shuffle-independent", () => {
    const getter = member("value", { kind: "getter", readonly: true });
    const setter = member("value", { kind: "setter" });
    const duplicateAccessors = [getter, structuredClone(getter), setter, structuredClone(setter)];
    const after = surface("2.0.0", [entrypoint([
      structuredDeclaration("Client", "class"),
    ])]);
    const first = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([
        structuredDeclaration("Client", "class", duplicateAccessors),
      ])]),
      after,
    );
    const shuffled = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint([
        structuredDeclaration("Client", "class", [...duplicateAccessors].reverse()),
      ])]),
      after,
    );

    expect(first.comparisonIssues).toEqual([
      expect.objectContaining({ memberName: "value", memberRole: "getter" }),
      expect.objectContaining({ memberName: "value", memberRole: "setter" }),
    ]);
    expect(shuffled).toEqual(first);
  });
});

describe("comparison purity and determinism", () => {
  it("terminates on cyclic referenced declaration graphs", () => {
    const beforeA = {
      name: "A",
      kind: "namespace",
      facet: 1,
      sourceFile: "internal.d.ts",
      typeOnly: true,
      signatures: ["namespace"],
      deprecated: false,
      declarations: [],
    } as unknown as Extract<ReferencedApiDeclaration, { kind: "namespace" }>;
    const beforeB = {
      ...beforeA,
      name: "B",
      declarations: [beforeA],
    };
    (beforeA.declarations as ReferencedApiDeclaration[]).push(beforeB);

    const afterA = {
      ...beforeA,
      declarations: [],
    } as unknown as Extract<ReferencedApiDeclaration, { kind: "namespace" }>;
    const afterB = {
      ...beforeB,
      declarations: [afterA],
    };
    (afterA.declarations as ReferencedApiDeclaration[]).push(afterB);

    const compare = () => compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint(undefined, { referencedDeclarations: [beforeA] })]),
      surface("2.0.0", [entrypoint(undefined, { referencedDeclarations: [afterA] })]),
    );

    expect(compare).not.toThrow();
    expect(compare().comparisonIssues).toContainEqual(expect.objectContaining({
      code: "recursive-declaration-graph",
      declarationPath: ["A", "B", "A"],
      facetPath: [1, 1, 1],
    }));
  });

  it("memoizes shared referenced declaration pairs", () => {
    const beforeShared = {
      name: "Shared",
      kind: "interface",
      facet: 1,
      sourceFile: "internal.d.ts",
      typeOnly: true,
      signatures: ["interface"],
      deprecated: false,
      members: [member("value", { signatures: [": string"] })],
    } satisfies ReferencedApiDeclaration;
    const afterShared = {
      ...beforeShared,
      members: [member("value", { signatures: [": number"] })],
    } satisfies ReferencedApiDeclaration;
    const makeOwner = (
      name: string,
      shared: ReferencedApiDeclaration,
    ): Extract<ReferencedApiDeclaration, { kind: "namespace" }> => ({
      name,
      kind: "namespace",
      facet: 1,
      sourceFile: "internal.d.ts",
      typeOnly: true,
      signatures: ["namespace"],
      deprecated: false,
      declarations: [shared],
    });
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint(undefined, {
        referencedDeclarations: [makeOwner("A", beforeShared), makeOwner("B", beforeShared)],
      })]),
      surface("2.0.0", [entrypoint(undefined, {
        referencedDeclarations: [makeOwner("A", afterShared), makeOwner("B", afterShared)],
      })]),
    );
    const changes = modifiedEntrypoint(diff).referencedDeclarationChanges;

    expect(changes).toEqual([
      expect.objectContaining({
        declarationPath: ["A"],
        nestedDeclarationChanges: [expect.objectContaining({
          declarationPath: ["A", "Shared"],
        })],
      }),
      expect.objectContaining({
        declarationPath: ["B"],
        nestedDeclarationChanges: [expect.objectContaining({
          declarationPath: ["B", "Shared"],
        })],
      }),
    ]);
    expect(diff.summary.referencedDeclarationsModified).toBe(4);
  });

  it("bounds deeply nested referenced declaration comparison", () => {
    const makeChain = (): ReferencedApiDeclaration => {
      let current: ReferencedApiDeclaration = referencedInterface("Leaf");
      for (let index = 299; index >= 0; index -= 1) {
        current = {
          name: `N${index.toString().padStart(3, "0")}`,
          kind: "namespace",
          facet: 1,
          sourceFile: "internal.d.ts",
          typeOnly: true,
          signatures: ["namespace"],
          deprecated: false,
          declarations: [current],
        };
      }
      return current;
    };
    const diff = compareDeclarationSurfaces(
      surface("1.0.0", [entrypoint(undefined, { referencedDeclarations: [makeChain()] })]),
      surface("2.0.0", [entrypoint(undefined, { referencedDeclarations: [makeChain()] })]),
    );

    expect(diff.comparisonIssues).toContainEqual(expect.objectContaining({
      code: "comparison-limit-exceeded",
    }));
  });

  it("does not cache a deep path failure for a later shallow occurrence", () => {
    const shared = referencedInterface("Shared");
    let deep: ReferencedApiDeclaration = shared;
    for (let index = 259; index >= 0; index -= 1) {
      deep = {
        name: `ADeep${index.toString().padStart(3, "0")}`,
        kind: "namespace",
        facet: 1,
        sourceFile: "internal.d.ts",
        typeOnly: true,
        signatures: ["namespace"],
        deprecated: false,
        declarations: [deep],
      };
    }
    const diff = compareDeclarationSurfaces(
      surface("1.0.0"),
      surface("2.0.0", [entrypoint(undefined, {
        referencedDeclarations: [deep, shared],
      })]),
    );

    expect(modifiedEntrypoint(diff).referencedDeclarationChanges).toEqual([
      expect.objectContaining({
        type: "referenced-declaration-added",
        declarationPath: ["Shared"],
      }),
    ]);
    expect(diff.comparisonIssues).toContainEqual(expect.objectContaining({
      code: "comparison-limit-exceeded",
    }));
  });

  it("does not let shallow validation bypass a later deep path limit", () => {
    const shared = referencedInterface("AShared");
    let deep: ReferencedApiDeclaration = shared;
    for (let index = 259; index >= 0; index -= 1) {
      deep = {
        name: `ZDeep${index.toString().padStart(3, "0")}`,
        kind: "namespace",
        facet: 1,
        sourceFile: "internal.d.ts",
        typeOnly: true,
        signatures: ["namespace"],
        deprecated: false,
        declarations: [deep],
      };
    }
    const diff = compareDeclarationSurfaces(
      surface("1.0.0"),
      surface("2.0.0", [entrypoint(undefined, {
        referencedDeclarations: [shared, deep],
      })]),
    );

    expect(modifiedEntrypoint(diff).referencedDeclarationChanges).toEqual([
      expect.objectContaining({
        type: "referenced-declaration-added",
        declarationPath: ["AShared"],
      }),
    ]);
    expect(diff.comparisonIssues).toContainEqual(expect.objectContaining({
      code: "comparison-limit-exceeded",
    }));
  });

  it("does not mutate deeply frozen inputs", () => {
    const before = deepFreeze(surface("1.0.0", [entrypoint([
      structuredDeclaration("Client", "class", [member("zeta"), member("alpha")]),
      apiFunction("parse", ["function(value: string): void", "function(): void"]),
    ], {
      referencedDeclarations: [referencedInterface()],
    })]));
    const after = deepFreeze(structuredClone(before));
    const beforeSnapshot = structuredClone(before);
    const afterSnapshot = structuredClone(after);

    expect(() => compareDeclarationSurfaces(before, after)).not.toThrow();
    expect(before).toEqual(beforeSnapshot);
    expect(after).toEqual(afterSnapshot);
  });

  it("produces the same result for equivalent shuffled arrays", () => {
    const firstIssue: DeclarationSurfaceIssue = {
      code: "external-reexport",
      message: "One",
      exportPath: ".",
      specifier: "one",
    };
    const secondIssue: DeclarationSurfaceIssue = {
      code: "external-reexport",
      message: "Two",
      exportPath: ".",
      specifier: "two",
    };
    const alpha = apiFunction("alpha", ["function(value: string): void", "function(): void"]);
    const zeta = structuredDeclaration("Zeta", "interface", [member("z"), member("a")]);
    const referenceA = referencedInterface("A");
    const referenceZ = referencedInterface("Z");
    const sortedBefore = surface("1.0.0", [entrypoint([alpha, zeta], {
      conditionPaths: [["types", "default"], ["types", "require"]],
      referencedDeclarations: [referenceA, referenceZ],
    })], [firstIssue, secondIssue]);
    const sortedAfter = structuredClone(sortedBefore);
    const shuffledBefore = surface("1.0.0", [entrypoint([
      { ...zeta, members: [...zeta.members].reverse() },
      { ...alpha, signatures: [...alpha.signatures].reverse() },
    ], {
      conditionPaths: [["types", "require"], ["types", "default"]],
      referencedDeclarations: [referenceZ, referenceA],
    })], [secondIssue, firstIssue]);
    const shuffledAfter = structuredClone(shuffledBefore);

    expect(compareDeclarationSurfaces(shuffledBefore, shuffledAfter))
      .toEqual(compareDeclarationSurfaces(sortedBefore, sortedAfter));
  });

  it("orders emitted changes independently of input array order", () => {
    const before = surface("1.0.0", [entrypoint([apiFunction("existing")])]);
    const beta = structuredDeclaration("beta", "class", [member("z"), member("a")]);
    const zeta = apiFunction("zeta", ["function(value: string): void", "function(): void"]);
    const sortedAfter = surface("2.0.0", [entrypoint([
      apiFunction("existing", ["function(value: number): void"]),
      beta,
      zeta,
    ])]);
    const shuffledAfter = surface("2.0.0", [entrypoint([
      { ...zeta, signatures: [...zeta.signatures].reverse() },
      { ...beta, members: [...beta.members].reverse() },
      apiFunction("existing", ["function(value: number): void"]),
    ])]);

    expect(compareDeclarationSurfaces(before, shuffledAfter))
      .toEqual(compareDeclarationSurfaces(before, sortedAfter));
  });

  it("returns deeply equal results across repeated comparisons", () => {
    const before = surface("1.0.0");
    const after = surface("2.0.0", [entrypoint([
      apiFunction("value", ["function(value: string): void"]),
    ])]);

    const first = compareDeclarationSurfaces(before, after);
    expect(compareDeclarationSurfaces(before, after)).toEqual(first);
    expect(compareDeclarationSurfaces(before, after)).toEqual(first);
  });

  it("does not depend on localeCompare", () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("localeCompare must not be used");
      });

    expect(() => compareDeclarationSurfaces(surface("1.0.0"), surface("2.0.0")))
      .not.toThrow();
    expect(localeCompare).not.toHaveBeenCalled();
  });
});

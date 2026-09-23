import { describe, expect, it, vi } from "vitest";

import {
  classifyUsageImpact,
  type ApiUsageSummary,
  type DependencyUsageImpact,
  type ExportChange,
  type MemberChange,
  type PublicApiDeclaration,
  type PublicApiMember,
  type SignatureApiDeclaration,
  type UsageImpact,
  type UsageImpactStatus,
} from "../src/index.js";

function apiFunction(exportedName = "value"): SignatureApiDeclaration {
  return {
    exportedName,
    kind: "function",
    facet: 1,
    sourceFile: "index.d.ts",
    defaultExport: exportedName === "default",
    exportEquals: false,
    typeOnly: false,
    signatures: ["function(): void"],
    deprecated: false,
  };
}

function member(name = "value", overrides: Partial<PublicApiMember> = {}): PublicApiMember {
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

function exportRemoved(declaration: PublicApiDeclaration = apiFunction()): ExportChange {
  return {
    type: "export-removed",
    declarationPath: [declaration.exportedName],
    facet: declaration.facet,
    facetPath: [declaration.facet],
    declaration,
  };
}

function exportAdded(declaration: PublicApiDeclaration = apiFunction()): ExportChange {
  return {
    type: "export-added",
    declarationPath: [declaration.exportedName],
    facet: declaration.facet,
    facetPath: [declaration.facet],
    declaration,
  };
}

function exportModified(
  overrides: Partial<Extract<ExportChange, { type: "export-modified" }>> = {},
): Extract<ExportChange, { type: "export-modified" }> {
  return {
    type: "export-modified",
    declarationPath: ["value"],
    facet: 1,
    facetPath: [1],
    propertyChanges: [],
    signatureChanges: [],
    memberChanges: [],
    nestedExportChanges: [],
    ...overrides,
  };
}

function memberRemoved(memberDeclaration: PublicApiMember = member()): MemberChange {
  return { type: "member-removed", member: memberDeclaration };
}

function memberAdded(memberDeclaration: PublicApiMember = member()): MemberChange {
  return { type: "member-added", member: memberDeclaration };
}

function memberModified(
  overrides: Partial<Extract<MemberChange, { type: "member-modified" }>> = {},
): Extract<MemberChange, { type: "member-modified" }> {
  return {
    type: "member-modified",
    name: "value",
    static: false,
    role: "ordinary",
    propertyChanges: [],
    signatureChanges: [],
    ...overrides,
  };
}

function apiUsage(canonicalPath = "value"): ApiUsageSummary {
  return {
    canonicalPath,
    localUsagePaths: [canonicalPath],
    occurrenceCount: 1,
    evidence: ["direct-import"],
    occurrences: [],
  };
}

function usageImpact(
  status: UsageImpactStatus,
  matchedChanges: readonly (ExportChange | MemberChange)[] = [],
  overrides: Partial<UsageImpact> = {},
): UsageImpact {
  return {
    usage: apiUsage(),
    status,
    matchedChanges,
    issues: [],
    ...overrides,
  };
}

function dependencyUsageImpact(impacts: readonly UsageImpact[]): DependencyUsageImpact {
  return {
    dependency: "dep",
    beforeVersion: "1.0.0",
    afterVersion: "2.0.0",
    impacts,
    summary: { affected: 0, unaffected: 0, unresolved: 0, indeterminate: 0 },
  };
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

describe("removal severity", () => {
  it("classifies export-removed as breaking", () => {
    const result = classifyUsageImpact(dependencyUsageImpact([
      usageImpact("affected", [exportRemoved()]),
    ]));

    expect(result.classifications[0]).toMatchObject({
      severity: "breaking",
      reasons: [{ code: "export-removed" }],
    });
    expect(result.summary).toEqual({ breaking: 1, safe: 0, needsReview: 0 });
  });

  it("classifies member-removed as breaking", () => {
    const result = classifyUsageImpact(dependencyUsageImpact([
      usageImpact("affected", [memberRemoved()]),
    ]));

    expect(result.classifications[0]).toMatchObject({
      severity: "breaking",
      reasons: [{ code: "member-removed" }],
    });
  });
});

describe("kind changes", () => {
  it("classifies a kind change on export-modified as breaking regardless of other changes", () => {
    const change = exportModified({
      propertyChanges: [
        { type: "property-changed", property: "kind", before: "function", after: "class" },
        { type: "property-changed", property: "typeOnly", before: false, after: true },
      ],
      signatureChanges: [{ type: "signature-removed", signature: "function(): void" }],
    });

    const result = classifyUsageImpact(dependencyUsageImpact([
      usageImpact("affected", [change]),
    ]));

    expect(result.classifications[0]).toMatchObject({
      severity: "breaking",
      reasons: [{ code: "kind-changed" }],
    });
  });

  it("classifies a kind change on member-modified as breaking", () => {
    const change = memberModified({
      propertyChanges: [
        { type: "property-changed", property: "kind", before: "method", after: "property" },
      ],
    });

    const result = classifyUsageImpact(dependencyUsageImpact([
      usageImpact("affected", [change]),
    ]));

    expect(result.classifications[0]?.severity).toBe("breaking");
  });
});

describe("signature-only changes", () => {
  it("classifies signature-added-only as safe", () => {
    const change = exportModified({
      signatureChanges: [{ type: "signature-added", signature: "function(x: number): void" }],
    });

    const result = classifyUsageImpact(dependencyUsageImpact([
      usageImpact("affected", [change]),
    ]));

    expect(result.classifications[0]).toMatchObject({
      severity: "safe",
      reasons: [{ code: "signature-added-only" }],
    });
    expect(result.summary).toEqual({ breaking: 0, safe: 1, needsReview: 0 });
  });

  it("classifies any signature-removed as needs-review, even alongside additions", () => {
    const change = exportModified({
      signatureChanges: [
        { type: "signature-added", signature: "function(x: number): void" },
        { type: "signature-removed", signature: "function(): void" },
      ],
    });

    const result = classifyUsageImpact(dependencyUsageImpact([
      usageImpact("affected", [change]),
    ]));

    expect(result.classifications[0]).toMatchObject({
      severity: "needs-review",
      reasons: [{ code: "signature-removed" }],
    });
  });
});

describe("property and deprecation changes", () => {
  it("classifies a non-kind property change as needs-review", () => {
    const change = exportModified({
      propertyChanges: [
        { type: "property-changed", property: "typeOnly", before: false, after: true },
      ],
    });

    const result = classifyUsageImpact(dependencyUsageImpact([
      usageImpact("affected", [change]),
    ]));

    expect(result.classifications[0]).toMatchObject({
      severity: "needs-review",
      reasons: [{ code: "property-changed", property: "typeOnly" }],
    });
  });

  it("classifies a deprecation change as needs-review", () => {
    const change = exportModified({ deprecationChange: { type: "deprecated-added" } });

    const result = classifyUsageImpact(dependencyUsageImpact([
      usageImpact("affected", [change]),
    ]));

    expect(result.classifications[0]).toMatchObject({
      severity: "needs-review",
      reasons: [{ code: "deprecation-changed" }],
    });
  });

  it("prioritizes deprecation over a non-kind property change", () => {
    const change = exportModified({
      propertyChanges: [
        { type: "property-changed", property: "typeOnly", before: false, after: true },
      ],
      deprecationChange: { type: "deprecated-added" },
    });

    const result = classifyUsageImpact(dependencyUsageImpact([
      usageImpact("affected", [change]),
    ]));

    expect(result.classifications[0]?.reasons).toEqual([{ code: "deprecation-changed" }]);
  });
});

describe("nested-change fallback", () => {
  it("classifies a modified leaf with no own property/deprecation/signature change as needs-review", () => {
    const change = exportModified({
      memberChanges: [{ type: "member-added", member: member("other") }],
    });

    const result = classifyUsageImpact(dependencyUsageImpact([
      usageImpact("affected", [change]),
    ]));

    expect(result.classifications[0]).toMatchObject({
      severity: "needs-review",
      reasons: [{ code: "nested-change" }],
    });
  });
});

describe("defensive export-added / member-added handling", () => {
  it("classifies an export-added match as needs-review rather than crashing", () => {
    const result = classifyUsageImpact(dependencyUsageImpact([
      usageImpact("affected", [exportAdded()]),
    ]));

    expect(result.classifications[0]).toMatchObject({
      severity: "needs-review",
      reasons: [{ code: "unexpected-change-type" }],
    });
  });

  it("classifies a member-added match as needs-review rather than crashing", () => {
    const result = classifyUsageImpact(dependencyUsageImpact([
      usageImpact("affected", [memberAdded()]),
    ]));

    expect(result.classifications[0]).toMatchObject({
      severity: "needs-review",
      reasons: [{ code: "unexpected-change-type" }],
    });
  });
});

describe("worst-of-many matched changes", () => {
  it("takes the worst severity across multiple matched changes and reports one reason per change", () => {
    const safeChange = exportModified({
      declarationPath: ["a"],
      signatureChanges: [{ type: "signature-added", signature: "function(x: number): void" }],
    });
    const needsReviewChange = exportModified({
      declarationPath: ["b"],
      propertyChanges: [
        { type: "property-changed", property: "typeOnly", before: false, after: true },
      ],
    });
    const breakingChange = exportRemoved(apiFunction("c"));

    const result = classifyUsageImpact(dependencyUsageImpact([
      usageImpact("affected", [safeChange, needsReviewChange, breakingChange]),
    ]));

    expect(result.classifications[0]).toMatchObject({
      severity: "breaking",
      reasons: [
        { code: "signature-added-only" },
        { code: "property-changed", property: "typeOnly" },
        { code: "export-removed" },
      ],
    });
    expect(result.summary).toEqual({ breaking: 1, safe: 0, needsReview: 0 });
  });

  it("does not deduplicate reasons that share the same code", () => {
    const change = exportRemoved(apiFunction("a"));
    const otherChange = memberRemoved(member("b"));

    const result = classifyUsageImpact(dependencyUsageImpact([
      usageImpact("affected", [change, otherChange]),
    ]));

    expect(result.classifications[0]?.reasons).toHaveLength(2);
  });
});

describe("non-affected statuses", () => {
  it.each<UsageImpactStatus>(["unaffected", "unresolved", "indeterminate"])(
    "omits severity for status %s and reports no reasons",
    (status) => {
      const result = classifyUsageImpact(dependencyUsageImpact([
        usageImpact(status, [exportRemoved()]),
      ]));

      expect(result.classifications[0]).toEqual({
        usage: expect.objectContaining({ status }),
        reasons: [],
      });
      expect(result.classifications[0]).not.toHaveProperty("severity");
      expect(result.summary).toEqual({ breaking: 0, safe: 0, needsReview: 0 });
    },
  );
});

describe("purity and determinism", () => {
  it("does not mutate the input DependencyUsageImpact", () => {
    const input = deepFreeze(dependencyUsageImpact([
      usageImpact("affected", [exportModified({
        propertyChanges: [
          { type: "property-changed", property: "typeOnly", before: false, after: true },
        ],
      })]),
      usageImpact("unaffected"),
    ]));
    const snapshot = structuredClone(input);

    expect(() => classifyUsageImpact(input)).not.toThrow();
    expect(input).toEqual(snapshot);
  });

  it("returns deeply equal results across repeated calls", () => {
    const input = dependencyUsageImpact([
      usageImpact("affected", [exportRemoved()]),
      usageImpact("affected", [exportModified({
        signatureChanges: [{ type: "signature-added", signature: "function(x: number): void" }],
      })]),
      usageImpact("unresolved"),
    ]);

    const first = classifyUsageImpact(input);
    expect(classifyUsageImpact(input)).toEqual(first);
    expect(classifyUsageImpact(input)).toEqual(first);
  });

  it("does not depend on localeCompare", () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("localeCompare must not be used");
      });
    const input = dependencyUsageImpact([
      usageImpact("affected", [exportRemoved()]),
    ]);

    expect(() => classifyUsageImpact(input)).not.toThrow();
    expect(localeCompare).not.toHaveBeenCalled();
  });
});

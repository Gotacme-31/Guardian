import { describe, expect, it } from "vitest";

import {
  buildMigrationProposal,
  classifyUsageImpact,
  type ApiUsageSummary,
  type ClassifiedUsageImpact,
  type DependencyImpactClassification,
  type DependencyUsageImpact,
  type ExportChange,
  type MemberChange,
  type PublicApiDeclaration,
  type PublicApiMember,
  type SignatureApiDeclaration,
  type SymbolUsage,
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
  occurrences: readonly SymbolUsage[] = [],
): ApiUsageSummary {
  return {
    ...(canonicalPath === undefined ? {} : { canonicalPath }),
    localUsagePaths: canonicalPath === undefined ? ["dep.unattributed"] : [canonicalPath],
    occurrenceCount: occurrences.length,
    evidence: ["direct-import"],
    occurrences: [...occurrences],
  };
}

function usageImpact(
  status: UsageImpactStatus,
  matchedChanges: readonly (ExportChange | MemberChange)[] = [],
  overrides: Partial<UsageImpact> = {},
): UsageImpact {
  return {
    usage: apiUsage("value", [symbolUsage()]),
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

function classificationFor(impacts: readonly UsageImpact[]): DependencyImpactClassification {
  return classifyUsageImpact(dependencyUsageImpact(impacts));
}

function proposalFor(impacts: readonly UsageImpact[]) {
  return buildMigrationProposal(classificationFor(impacts));
}

describe("export-removed / member-removed descriptions", () => {
  it("describes a removed export verbatim with its name and kind", () => {
    const proposal = proposalFor([usageImpact("affected", [exportRemoved(apiFunction("doThing"))])]);

    expect(proposal.breaking).toHaveLength(1);
    expect(proposal.breaking[0]?.changes).toEqual([{
      reason: { code: "export-removed" },
      description: 'Export "doThing" (function) was removed.',
    }]);
  });

  it("describes a removed member verbatim with its name and kind", () => {
    const proposal = proposalFor([usageImpact("affected", [memberRemoved(member("get"))])]);

    expect(proposal.breaking[0]?.changes).toEqual([{
      reason: { code: "member-removed" },
      description: 'Member "get" (method) was removed.',
    }]);
  });
});

describe("kind-changed description", () => {
  it("prints the verbatim before/after kind", () => {
    const change = exportModified({
      propertyChanges: [
        { type: "property-changed", property: "kind", before: "function", after: "class" },
      ],
    });
    const proposal = proposalFor([usageImpact("affected", [change])]);

    expect(proposal.breaking[0]?.changes).toEqual([{
      reason: { code: "kind-changed" },
      description: 'Kind changed: "function" -> "class".',
    }]);
  });
});

describe("signature descriptions", () => {
  it("lists every signature-added entry for signature-added-only", () => {
    const change = exportModified({
      signatureChanges: [
        { type: "signature-added", signature: "function(x: number): void" },
        { type: "signature-added", signature: "function(x: number, y: string): void" },
      ],
    });
    const proposal = proposalFor([usageImpact("affected", [change])]);

    expect(proposal.safe[0]?.changes).toEqual([{
      reason: { code: "signature-added-only" },
      description: "Signature(s) added:\n"
        + "  - function(x: number): void\n"
        + "  - function(x: number, y: string): void",
    }]);
  });

  it("lists every signature-removed entry, even alongside an addition", () => {
    const change = exportModified({
      signatureChanges: [
        { type: "signature-added", signature: "function(x: number): void" },
        { type: "signature-removed", signature: "function(): void" },
        { type: "signature-removed", signature: "function(x: string): void" },
      ],
    });
    const proposal = proposalFor([usageImpact("affected", [change])]);

    expect(proposal.needsReview[0]?.changes).toEqual([{
      reason: { code: "signature-removed" },
      description: "Signature(s) removed:\n"
        + "  - function(): void\n"
        + "  - function(x: string): void",
    }]);
  });
});

describe("property-changed description", () => {
  it("prints the verbatim before/after for the exact property named in the reason", () => {
    const change = exportModified({
      propertyChanges: [
        { type: "property-changed", property: "typeOnly", before: false, after: true },
      ],
    });
    const proposal = proposalFor([usageImpact("affected", [change])]);

    expect(proposal.needsReview[0]?.changes).toEqual([{
      reason: { code: "property-changed", property: "typeOnly" },
      description: "typeOnly changed: false -> true.",
    }]);
  });
});

describe("deprecation-changed description", () => {
  it("describes deprecated-added", () => {
    const change = exportModified({ deprecationChange: { type: "deprecated-added" } });
    const proposal = proposalFor([usageImpact("affected", [change])]);

    expect(proposal.needsReview[0]?.changes).toEqual([{
      reason: { code: "deprecation-changed" },
      description: "Marked as deprecated.",
    }]);
  });

  it("describes deprecated-removed", () => {
    const change = exportModified({ deprecationChange: { type: "deprecated-removed" } });
    const proposal = proposalFor([usageImpact("affected", [change])]);

    expect(proposal.needsReview[0]?.changes).toEqual([{
      reason: { code: "deprecation-changed" },
      description: "No longer deprecated.",
    }]);
  });
});

describe("nested-change description", () => {
  it("points at the declarationPath rather than inventing what changed", () => {
    const change = exportModified({
      declarationPath: ["Namespace", "child"],
      memberChanges: [{ type: "member-added", member: member("other") }],
    });
    const proposal = proposalFor([usageImpact("affected", [change])]);

    expect(proposal.needsReview[0]?.changes).toHaveLength(1);
    expect(proposal.needsReview[0]?.changes[0]).toMatchObject({ reason: { code: "nested-change" } });
    expect(proposal.needsReview[0]?.changes[0]?.description).toContain('["Namespace","child"]');
  });
});

describe("unexpected-change-type description", () => {
  it("describes an export-added match defensively instead of throwing", () => {
    const proposal = proposalFor([usageImpact("affected", [exportAdded(apiFunction("surprise"))])]);

    expect(proposal.needsReview[0]?.changes).toHaveLength(1);
    expect(proposal.needsReview[0]?.changes[0]).toMatchObject({
      reason: { code: "unexpected-change-type" },
    });
    expect(proposal.needsReview[0]?.changes[0]?.description).toContain('"export-added"');
  });

  it("describes a member-added match defensively instead of throwing", () => {
    const proposal = proposalFor([usageImpact("affected", [memberAdded(member("surprise"))])]);

    expect(proposal.needsReview[0]?.changes[0]?.description).toContain('"member-added"');
  });
});

describe("non-affected bucketing", () => {
  it("counts unaffected usages without itemizing them", () => {
    const proposal = proposalFor([
      usageImpact("unaffected"),
      usageImpact("affected", [exportRemoved()]),
    ]);

    expect(proposal.unaffectedCount).toBe(1);
    expect(proposal.review).toEqual([]);
    expect(proposal.summary.unaffected).toBe(1);
  });

  it("itemizes unresolved usages in review with their real issues", () => {
    const proposal = proposalFor([
      usageImpact("unresolved", [], {
        usage: apiUsage("missing", [symbolUsage({ usagePath: "missing" })]),
        issues: [{ code: "declaration-not-found", message: 'Canonical path "missing" was not found.' }],
      }),
    ]);

    expect(proposal.review).toEqual([{
      canonicalPath: "missing",
      localUsagePaths: ["missing"],
      occurrences: [expect.objectContaining({ usagePath: "missing" })],
      status: "unresolved",
      issues: [{ code: "declaration-not-found", message: 'Canonical path "missing" was not found.' }],
    }]);
    expect(proposal.summary.unresolved).toBe(1);
    expect(proposal.summary.indeterminate).toBe(0);
  });

  it("itemizes indeterminate usages in review with their real issues", () => {
    const proposal = proposalFor([
      usageImpact("indeterminate", [], {
        issues: [{ code: "ambiguous-facet-correlation", message: "Resolves to more than one declaration." }],
      }),
    ]);

    expect(proposal.review).toHaveLength(1);
    expect(proposal.review[0]).toMatchObject({ status: "indeterminate" });
    expect(proposal.review[0]?.issues).toEqual([
      { code: "ambiguous-facet-correlation", message: "Resolves to more than one declaration." },
    ]);
    expect(proposal.summary.indeterminate).toBe(1);
    expect(proposal.summary.unresolved).toBe(0);
  });
});

describe("defensive array-length verification", () => {
  it("throws a clear internal error when matchedChanges and reasons lengths disagree", () => {
    const misaligned: ClassifiedUsageImpact = {
      usage: usageImpact("affected", [exportRemoved(), exportRemoved(apiFunction("other"))]),
      severity: "breaking",
      reasons: [{ code: "export-removed" }],
    };
    const classification: DependencyImpactClassification = {
      dependency: "dep",
      beforeVersion: "1.0.0",
      afterVersion: "2.0.0",
      classifications: [misaligned],
      summary: { breaking: 1, safe: 0, needsReview: 0 },
    };

    expect(() => buildMigrationProposal(classification)).toThrowError(/length/i);
  });
});

describe("summary and bucketing counts", () => {
  it("produces the full summary across all six buckets", () => {
    const proposal = proposalFor([
      usageImpact("affected", [exportRemoved()]),
      usageImpact("affected", [exportModified({
        propertyChanges: [{ type: "property-changed", property: "typeOnly", before: false, after: true }],
      })]),
      usageImpact("affected", [exportModified({
        signatureChanges: [{ type: "signature-added", signature: "function(x: number): void" }],
      })]),
      usageImpact("unaffected"),
      usageImpact("unresolved"),
      usageImpact("indeterminate"),
    ]);

    expect(proposal.summary).toEqual({
      breaking: 1,
      needsReview: 1,
      safe: 1,
      unaffected: 1,
      unresolved: 1,
      indeterminate: 1,
    });
  });
});

describe("read-only report guarantee", () => {
  it("never lists a change count that implies anything beyond reporting", () => {
    // buildMigrationProposal has no apply/authorize/patch concept at all -- this is a structural
    // smoke test that the returned shape has no such field, not a behavioral assertion.
    const proposal = proposalFor([usageImpact("affected", [exportRemoved()])]);
    expect(proposal).not.toHaveProperty("apply");
    expect(proposal).not.toHaveProperty("applied");
    expect(proposal).not.toHaveProperty("patch");
  });
});

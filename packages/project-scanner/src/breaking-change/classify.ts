import type {
  DeclarationPropertyChange,
  DeprecationChange,
  ExportChange,
  MemberChange,
  SignatureChange,
} from "../declaration-diff/types.js";
import type { DependencyUsageImpact, UsageImpact } from "../usage-impact/types.js";
import type {
  ClassifiedUsageImpact,
  DependencyImpactClassification,
  ImpactClassificationSummary,
  ImpactSeverity,
  SeverityReason,
} from "./types.js";

const SEVERITY_PRIORITY: Record<ImpactSeverity, number> = {
  breaking: 3,
  "needs-review": 2,
  safe: 1,
};

interface ChangeVerdict {
  readonly severity: ImpactSeverity;
  readonly reason: SeverityReason;
}

function severityForModification(
  propertyChanges: readonly DeclarationPropertyChange[],
  deprecationChange: DeprecationChange | undefined,
  signatureChanges: readonly SignatureChange[],
): ChangeVerdict {
  const kindChange = propertyChanges.find((change) => change.property === "kind");
  if (kindChange !== undefined) {
    return { severity: "breaking", reason: { code: "kind-changed" } };
  }
  if (deprecationChange !== undefined) {
    return { severity: "needs-review", reason: { code: "deprecation-changed" } };
  }
  const firstProperty = propertyChanges[0];
  if (firstProperty !== undefined) {
    return {
      severity: "needs-review",
      reason: { code: "property-changed", property: firstProperty.property },
    };
  }
  if (signatureChanges.length > 0) {
    const hasRemoval = signatureChanges.some((change) => change.type === "signature-removed");
    return hasRemoval
      ? { severity: "needs-review", reason: { code: "signature-removed" } }
      : { severity: "safe", reason: { code: "signature-added-only" } };
  }
  return { severity: "needs-review", reason: { code: "nested-change" } };
}

/**
 * Evaluates the severity of a single leaf-level matched change. `matchedChanges` on a
 * `UsageImpact` is already flattened to the exact export/member the usage resolved to (see
 * `usage-impact/correlate.ts`'s `changesForLeaf`/`flattenExportChanges`) — an `export-modified`
 * entry here is the leaf itself, not an ancestor carrying an unrelated subtree. Reading only
 * `propertyChanges`/`deprecationChange`/`signatureChanges` (never `memberChanges` or
 * `nestedExportChanges`) is therefore correct: if none of those three account for the change, it
 * exists solely because of a nested member/export change that belongs to a *different* resolved
 * leaf, which case (f) below reports as "nested-change" without needing to inspect it.
 *
 * `export-added`/`member-added` are defensive branches. `changesForLeaf` only ever looks up a
 * change at the exact `(declarationPath, facetPath)` (or `(name, static, role)` for members) that
 * M8 resolved against `installedSurface` — i.e. a declaration/member that demonstrably exists on
 * the *before* side. M7 only emits `export-added`/`member-added` when the *before* side has zero
 * matches for that identity, which is a contradiction for a leaf M8 could resolve in the first
 * place — provided `installedSurface` really is `diff`'s before surface, which
 * `correlateUsageImpact` now enforces via its `version-mismatch` check. An added entry could only
 * reach here if a caller bypassed that pairing (e.g. handed M8 an `installedSurface` that isn't
 * actually the surface `diff` was computed from despite matching name/version). It is kept as a
 * `needs-review`/`unexpected-change-type` fallback rather than assumed impossible and left
 * unhandled.
 */
function severityForChange(change: ExportChange | MemberChange): ChangeVerdict {
  switch (change.type) {
    case "export-removed":
      return { severity: "breaking", reason: { code: "export-removed" } };
    case "member-removed":
      return { severity: "breaking", reason: { code: "member-removed" } };
    case "export-added":
    case "member-added":
      return { severity: "needs-review", reason: { code: "unexpected-change-type" } };
    case "export-modified":
    case "member-modified":
      return severityForModification(
        change.propertyChanges,
        change.deprecationChange,
        change.signatureChanges,
      );
  }
}

function classifyImpact(usage: UsageImpact): ClassifiedUsageImpact {
  if (usage.status !== "affected") {
    return { usage, reasons: [] };
  }

  let severity: ImpactSeverity = "safe";
  const reasons: SeverityReason[] = [];
  for (const change of usage.matchedChanges) {
    const verdict = severityForChange(change);
    reasons.push(verdict.reason);
    if (SEVERITY_PRIORITY[verdict.severity] > SEVERITY_PRIORITY[severity]) {
      severity = verdict.severity;
    }
  }

  return { usage, severity, reasons };
}

function summarize(classifications: readonly ClassifiedUsageImpact[]): ImpactClassificationSummary {
  const summary = { breaking: 0, safe: 0, needsReview: 0 };
  for (const classification of classifications) {
    if (classification.severity === "breaking") {
      summary.breaking += 1;
    } else if (classification.severity === "safe") {
      summary.safe += 1;
    } else if (classification.severity === "needs-review") {
      summary.needsReview += 1;
    }
  }
  return summary;
}

export function classifyUsageImpact(
  usageImpact: DependencyUsageImpact,
): DependencyImpactClassification {
  const classifications = usageImpact.impacts.map(classifyImpact);
  return {
    dependency: usageImpact.dependency,
    beforeVersion: usageImpact.beforeVersion,
    afterVersion: usageImpact.afterVersion,
    classifications,
    summary: summarize(classifications),
  };
}

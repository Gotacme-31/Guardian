import type { DeclarationPropertyName } from "../declaration-diff/types.js";
import type { UsageImpact } from "../usage-impact/types.js";

export type ImpactSeverity = "breaking" | "safe" | "needs-review";

export type SeverityReasonCode =
  | "export-removed"
  | "member-removed"
  | "kind-changed"
  | "signature-added-only"
  | "signature-removed"
  | "property-changed"
  | "deprecation-changed"
  | "nested-change"
  | "unexpected-change-type";

export interface SeverityReason {
  readonly code: SeverityReasonCode;
  readonly property?: DeclarationPropertyName;
}

export interface ClassifiedUsageImpact {
  readonly usage: UsageImpact;
  readonly severity?: ImpactSeverity;
  readonly reasons: readonly SeverityReason[];
}

export interface ImpactClassificationSummary {
  readonly breaking: number;
  readonly safe: number;
  readonly needsReview: number;
}

export interface DependencyImpactClassification {
  readonly dependency: string;
  readonly beforeVersion: string;
  readonly afterVersion: string;
  readonly classifications: readonly ClassifiedUsageImpact[];
  readonly summary: ImpactClassificationSummary;
}

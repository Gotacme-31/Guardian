import type { ImpactSeverity, SeverityReason } from "../breaking-change/types.js";
import type { UsageCorrelationIssue } from "../usage-impact/types.js";
import type { SymbolUsage } from "../types.js";

export interface MigrationProposalChangeDescription {
  readonly reason: SeverityReason;
  readonly description: string;
}

export interface MigrationProposalItem {
  readonly canonicalPath?: string;
  readonly localUsagePaths: readonly string[];
  readonly occurrences: readonly SymbolUsage[];
  readonly severity: ImpactSeverity;
  readonly changes: readonly MigrationProposalChangeDescription[];
}

export interface MigrationProposalReviewItem {
  readonly canonicalPath?: string;
  readonly localUsagePaths: readonly string[];
  readonly occurrences: readonly SymbolUsage[];
  readonly status: "unresolved" | "indeterminate";
  readonly issues: readonly UsageCorrelationIssue[];
}

export interface MigrationProposalSummary {
  readonly breaking: number;
  readonly needsReview: number;
  readonly safe: number;
  readonly unaffected: number;
  readonly unresolved: number;
  readonly indeterminate: number;
}

export interface MigrationProposal {
  readonly dependency: string;
  readonly beforeVersion: string;
  readonly afterVersion: string;
  readonly breaking: readonly MigrationProposalItem[];
  readonly needsReview: readonly MigrationProposalItem[];
  readonly safe: readonly MigrationProposalItem[];
  readonly review: readonly MigrationProposalReviewItem[];
  readonly unaffectedCount: number;
  readonly summary: MigrationProposalSummary;
}

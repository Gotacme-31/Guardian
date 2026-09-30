import type { MigrationProposalSummary } from "../migration-proposal/types.js";
import type { VersionBumpBlockingReason, VersionBumpEligibility } from "./types.js";

/**
 * A version bump is only eligible when the M11 proposal proves nothing is left to look at:
 * `safe` and `unaffected` usages never block, since M11 already established they need no human
 * attention. Every other bucket does, and every applicable reason is reported (not just the
 * first) so the CLI can show the whole picture rather than making the caller re-run to discover
 * the next blocker.
 */
export function checkVersionBumpEligibility(
  summary: MigrationProposalSummary,
): VersionBumpEligibility {
  const blockingReasons: VersionBumpBlockingReason[] = [];
  if (summary.breaking > 0) {
    blockingReasons.push("breaking-changes-present");
  }
  if (summary.needsReview > 0) {
    blockingReasons.push("needs-review-present");
  }
  if (summary.unresolved > 0) {
    blockingReasons.push("unresolved-usages-present");
  }
  if (summary.indeterminate > 0) {
    blockingReasons.push("indeterminate-usages-present");
  }
  return { eligible: blockingReasons.length === 0, blockingReasons };
}

import type {
  ClassifiedUsageImpact,
  DependencyImpactClassification,
} from "../breaking-change/types.js";
import { describeChange } from "./describe-change.js";
import type {
  MigrationProposal,
  MigrationProposalChangeDescription,
  MigrationProposalItem,
  MigrationProposalReviewItem,
} from "./types.js";

function internalError(message: string): Error {
  return new Error(`Migration proposal internal error: ${message}`);
}

/**
 * `classifyImpact` (breaking-change/classify.ts) pushes exactly one `SeverityReason` per element
 * of `usage.matchedChanges`, in the same order, whenever `severity !== undefined`. This zips the
 * two arrays back together and throws instead of silently misaligning them if that invariant is
 * ever violated upstream.
 */
function buildChangeDescriptions(
  classified: ClassifiedUsageImpact,
): MigrationProposalChangeDescription[] {
  const { matchedChanges } = classified.usage;
  const { reasons } = classified;
  if (matchedChanges.length !== reasons.length) {
    throw internalError(
      `matchedChanges (${matchedChanges.length}) and reasons (${reasons.length}) have different `
      + `lengths for canonical path "${classified.usage.usage.canonicalPath ?? "(none)"}"; `
      + "classifyImpact must push exactly one reason per matched change.",
    );
  }
  return matchedChanges.map((change, index) => {
    const reason = reasons[index];
    if (reason === undefined) {
      throw internalError(`missing reason at index ${index} despite equal-length arrays.`);
    }
    return { reason, description: describeChange(change, reason) };
  });
}

function buildItem(classified: ClassifiedUsageImpact): MigrationProposalItem {
  if (classified.severity === undefined) {
    throw internalError("buildItem called without a severity.");
  }
  const { canonicalPath, localUsagePaths, occurrences } = classified.usage.usage;
  return {
    ...(canonicalPath === undefined ? {} : { canonicalPath }),
    localUsagePaths,
    occurrences,
    severity: classified.severity,
    changes: buildChangeDescriptions(classified),
  };
}

function buildReviewItem(
  classified: ClassifiedUsageImpact,
  status: "unresolved" | "indeterminate",
): MigrationProposalReviewItem {
  const { canonicalPath, localUsagePaths, occurrences } = classified.usage.usage;
  return {
    ...(canonicalPath === undefined ? {} : { canonicalPath }),
    localUsagePaths,
    occurrences,
    status,
    issues: classified.usage.issues,
  };
}

export function buildMigrationProposal(
  classification: DependencyImpactClassification,
): MigrationProposal {
  const breaking: MigrationProposalItem[] = [];
  const needsReview: MigrationProposalItem[] = [];
  const safe: MigrationProposalItem[] = [];
  const review: MigrationProposalReviewItem[] = [];
  let unaffectedCount = 0;

  for (const classified of classification.classifications) {
    if (classified.severity !== undefined) {
      const item = buildItem(classified);
      if (classified.severity === "breaking") {
        breaking.push(item);
      } else if (classified.severity === "needs-review") {
        needsReview.push(item);
      } else {
        safe.push(item);
      }
      continue;
    }

    switch (classified.usage.status) {
      case "unaffected":
        unaffectedCount += 1;
        break;
      case "unresolved":
      case "indeterminate":
        review.push(buildReviewItem(classified, classified.usage.status));
        break;
      case "affected":
        throw internalError(
          'usage status "affected" carries no severity; classifyImpact should have assigned one.',
        );
    }
  }

  return {
    dependency: classification.dependency,
    beforeVersion: classification.beforeVersion,
    afterVersion: classification.afterVersion,
    breaking,
    needsReview,
    safe,
    review,
    unaffectedCount,
    summary: {
      breaking: breaking.length,
      needsReview: needsReview.length,
      safe: safe.length,
      unaffected: unaffectedCount,
      unresolved: review.filter((item) => item.status === "unresolved").length,
      indeterminate: review.filter((item) => item.status === "indeterminate").length,
    },
  };
}

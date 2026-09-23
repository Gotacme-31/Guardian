import type { ApiUsageSummary } from "../dependency-context/types.js";
import type { ExportChange, MemberChange } from "../declaration-diff/types.js";

export type UsageImpactErrorCode = "package-mismatch" | "version-mismatch";

export class UsageImpactCorrelationError extends Error {
  readonly code: UsageImpactErrorCode;
  readonly dependency: string;
  readonly installedSurfacePackageName: string;
  readonly diffPackageName: string;
  readonly installedSurfaceVersion: string;
  readonly diffBeforeVersion: string;

  constructor(
    code: UsageImpactErrorCode,
    dependency: string,
    installedSurfacePackageName: string,
    diffPackageName: string,
    installedSurfaceVersion: string,
    diffBeforeVersion: string,
  ) {
    super(
      code === "package-mismatch"
        ? `Cannot correlate usage impact: dependency "${dependency}", installed surface package `
          + `"${installedSurfacePackageName}", and diff package "${diffPackageName}" do not all match.`
        : `Cannot correlate usage impact: installed surface version "${installedSurfaceVersion}" `
          + `does not match diff.beforeVersion "${diffBeforeVersion}" for dependency "${dependency}".`,
    );
    this.name = "UsageImpactCorrelationError";
    this.code = code;
    this.dependency = dependency;
    this.installedSurfacePackageName = installedSurfacePackageName;
    this.diffPackageName = diffPackageName;
    this.installedSurfaceVersion = installedSurfaceVersion;
    this.diffBeforeVersion = diffBeforeVersion;
  }
}

export type UsageImpactStatus =
  | "affected"
  | "unaffected"
  | "unresolved"
  | "indeterminate";

export type UsageCorrelationIssueCode =
  | "no-canonical-path"
  | "entrypoint-not-found"
  | "declaration-not-found"
  | "ambiguous-facet-correlation"
  | "ambiguous-member-correlation"
  | "unresolvable-member-access"
  | "indeterminate-source-comparison";

export interface UsageCorrelationIssue {
  readonly code: UsageCorrelationIssueCode;
  readonly message: string;
  readonly canonicalPath?: string;
}

export interface UsageImpact {
  readonly usage: ApiUsageSummary;
  readonly status: UsageImpactStatus;
  readonly exportPath?: string;
  readonly declarationPath?: readonly string[];
  readonly matchedChanges: readonly (ExportChange | MemberChange)[];
  readonly issues: readonly UsageCorrelationIssue[];
}

export interface UsageImpactSummary {
  readonly affected: number;
  readonly unaffected: number;
  readonly unresolved: number;
  readonly indeterminate: number;
}

export interface DependencyUsageImpact {
  readonly dependency: string;
  readonly beforeVersion: string;
  readonly afterVersion: string;
  readonly impacts: readonly UsageImpact[];
  readonly summary: UsageImpactSummary;
}

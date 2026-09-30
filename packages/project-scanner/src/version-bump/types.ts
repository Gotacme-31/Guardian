export type VersionBumpBlockingReason =
  | "breaking-changes-present"
  | "needs-review-present"
  | "unresolved-usages-present"
  | "indeterminate-usages-present";

export interface VersionBumpEligibility {
  readonly eligible: boolean;
  readonly blockingReasons: readonly VersionBumpBlockingReason[];
}

export type VersionRangeOperator = "" | "^" | "~";

export interface ComposedVersionBump {
  readonly operator: VersionRangeOperator;
  readonly newDeclaredVersion: string;
}

export type VersionCompositionError = "unsupported-range-format";

export type VersionBumpWriteError =
  | "package-json-not-found"
  | "package-json-invalid"
  | "declared-version-mismatch"
  | "pattern-not-found";

export interface VersionBumpWriteResult {
  readonly packageJsonPath: string;
  readonly field: "dependencies" | "devDependencies";
  readonly previousDeclaredVersion: string;
  readonly newDeclaredVersion: string;
}

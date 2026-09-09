import type { DependencyContext } from "../dependency-context/types.js";

export type TargetResolutionStatus =
  | "resolved"
  | "not-found"
  | "unsupported"
  | "invalid-request"
  | "registry-error";

export type TargetResolutionIssue =
  | "non-registry-dependency"
  | "invalid-package-name"
  | "package-not-found"
  | "tag-not-found"
  | "version-not-found"
  | "no-matching-version"
  | "invalid-target"
  | "invalid-registry-response"
  | "network-error"
  | "timeout"
  | "rate-limited"
  | "registry-unavailable"
  | "http-error";

export type DependencyUpgradeType =
  | "same"
  | "patch"
  | "minor"
  | "major"
  | "prerelease"
  | "downgrade"
  | "unknown";

interface DependencyTargetResolutionBase {
  dependency: string;
  installedVersion?: string;
  requestedTarget: string;
  source: "npm";
}

export interface ResolvedDependencyTarget extends DependencyTargetResolutionBase {
  resolvedVersion: string;
  status: "resolved";
  distTag?: string;
  upgradeType: DependencyUpgradeType;
}

export interface FailedDependencyTarget extends DependencyTargetResolutionBase {
  status: Exclude<TargetResolutionStatus, "resolved">;
  issue: TargetResolutionIssue;
  httpStatus?: number;
}

export type DependencyTargetResolution = ResolvedDependencyTarget | FailedDependencyTarget;

export interface TargetResolverOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface DependencyTargetResolver {
  resolve(
    context: DependencyContext,
    requestedTarget: string,
  ): Promise<DependencyTargetResolution>;
}

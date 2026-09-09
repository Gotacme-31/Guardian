import * as semver from "semver";

import type { DependencyContext } from "../dependency-context/types.js";
import {
  createNpmMetadataClient,
  isSafeNpmPackageName,
  isValidNpmDistTag,
  type NpmMetadataResult,
} from "./npm.js";
import type {
  DependencyTargetResolution,
  DependencyTargetResolver,
  DependencyUpgradeType,
  TargetResolutionIssue,
  TargetResolutionStatus,
  TargetResolverOptions,
} from "./types.js";

interface ResolvedTarget {
  version: string;
  distTag?: string;
}

type ParsedTarget =
  | { kind: "tag"; value: string }
  | { kind: "exact"; value: string }
  | { kind: "range"; value: string }
  | { kind: "invalid" };

function baseResult(
  context: DependencyContext,
  requestedTarget: string,
): Pick<DependencyTargetResolution, "dependency" | "installedVersion" | "requestedTarget" | "source"> {
  return {
    dependency: context.dependency,
    ...(context.resolution.resolvedVersion === undefined
      ? {}
      : { installedVersion: context.resolution.resolvedVersion }),
    requestedTarget,
    source: "npm",
  };
}

function failedResult(
  context: DependencyContext,
  requestedTarget: string,
  status: Exclude<TargetResolutionStatus, "resolved">,
  issue: TargetResolutionIssue,
  httpStatus?: number,
): DependencyTargetResolution {
  return {
    ...baseResult(context, requestedTarget),
    status,
    issue,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

function targetFromMetadata(
  metadata: Extract<NpmMetadataResult, { status: "available" }>["metadata"],
  requestedTarget: ParsedTarget,
): ResolvedTarget | TargetResolutionIssue {
  if (requestedTarget.kind === "tag") {
    const taggedVersion = metadata.distTags.get(requestedTarget.value);
    return taggedVersion === undefined
      ? "tag-not-found"
      : { version: taggedVersion, distTag: requestedTarget.value };
  }
  if (requestedTarget.kind === "exact") {
    return metadata.versions.includes(requestedTarget.value)
      ? { version: requestedTarget.value }
      : "version-not-found";
  }
  if (requestedTarget.kind === "range") {
    const version = semver.maxSatisfying(metadata.versions, requestedTarget.value);
    return version === null ? "no-matching-version" : { version };
  }
  return "invalid-target";
}

function parseRequestedTarget(requestedTarget: string): ParsedTarget {
  if (requestedTarget === "" || requestedTarget !== requestedTarget.trim()) {
    return { kind: "invalid" };
  }
  const exactVersion = semver.valid(requestedTarget);
  if (exactVersion !== null) {
    return { kind: "exact", value: exactVersion };
  }
  const range = semver.validRange(requestedTarget);
  if (range !== null) {
    return { kind: "range", value: range };
  }
  return isValidNpmDistTag(requestedTarget)
    ? { kind: "tag", value: requestedTarget }
    : { kind: "invalid" };
}

export function classifyUpgradeType(
  installedVersion: string | undefined,
  targetVersion: string,
): DependencyUpgradeType {
  if (installedVersion === undefined) {
    return "unknown";
  }
  const installed = semver.parse(installedVersion);
  const target = semver.parse(targetVersion);
  if (installed === null || target === null) {
    return "unknown";
  }
  const comparison = semver.compare(target, installed);
  if (comparison < 0) {
    return "downgrade";
  }
  if (comparison === 0) {
    return "same";
  }
  if (target.major !== installed.major) {
    return "major";
  }
  if (target.minor !== installed.minor) {
    return "minor";
  }
  return target.patch !== installed.patch ? "patch" : "prerelease";
}

export function createDependencyTargetResolver(
  options: TargetResolverOptions = {},
): DependencyTargetResolver {
  const npmClient = createNpmMetadataClient(options);

  return {
    async resolve(
      context: DependencyContext,
      requestedTarget: string,
    ): Promise<DependencyTargetResolution> {
      if (context.resolution.kind !== "registry") {
        return failedResult(
          context,
          requestedTarget,
          "unsupported",
          "non-registry-dependency",
        );
      }
      const parsedTarget = parseRequestedTarget(requestedTarget);
      if (parsedTarget.kind === "invalid") {
        return failedResult(context, requestedTarget, "invalid-request", "invalid-target");
      }
      if (!isSafeNpmPackageName(context.dependency)) {
        return failedResult(
          context,
          requestedTarget,
          "invalid-request",
          "invalid-package-name",
        );
      }

      const metadataResult = await npmClient.getMetadata(context.dependency);
      if (metadataResult.status === "not-found") {
        return failedResult(
          context,
          requestedTarget,
          "not-found",
          metadataResult.issue,
          metadataResult.httpStatus,
        );
      }
      if (metadataResult.status === "error") {
        return failedResult(
          context,
          requestedTarget,
          "registry-error",
          metadataResult.issue,
          metadataResult.httpStatus,
        );
      }

      const resolvedTarget = targetFromMetadata(metadataResult.metadata, parsedTarget);
      if (typeof resolvedTarget === "string") {
        const status = resolvedTarget === "invalid-target"
          ? "invalid-request"
          : resolvedTarget === "invalid-registry-response"
            ? "registry-error"
            : "not-found";
        return failedResult(context, requestedTarget, status, resolvedTarget);
      }

      return {
        ...baseResult(context, requestedTarget),
        resolvedVersion: resolvedTarget.version,
        status: "resolved",
        ...(resolvedTarget.distTag === undefined ? {} : { distTag: resolvedTarget.distTag }),
        upgradeType: classifyUpgradeType(
          context.resolution.resolvedVersion,
          resolvedTarget.version,
        ),
      };
    },
  };
}

const defaultResolver = createDependencyTargetResolver();

export function resolveDependencyTarget(
  context: DependencyContext,
  requestedTarget: string,
): Promise<DependencyTargetResolution> {
  return defaultResolver.resolve(context, requestedTarget);
}

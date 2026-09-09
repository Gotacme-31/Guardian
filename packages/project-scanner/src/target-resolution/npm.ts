import * as semver from "semver";

import type { TargetResolutionIssue, TargetResolverOptions } from "./types.js";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/";
const DEFAULT_TIMEOUT_MS = 8_000;
const USER_AGENT = "Guardian/0.0.1";

export interface NpmPackageMetadata {
  distTags: Map<string, string>;
  versions: string[];
}

export type NpmMetadataResult =
  | { status: "available"; metadata: NpmPackageMetadata }
  | { status: "not-found"; issue: "package-not-found"; httpStatus: 404 }
  | {
    status: "error";
    issue: Exclude<TargetResolutionIssue, "non-registry-dependency" | "package-not-found" | "tag-not-found" | "version-not-found" | "no-matching-version" | "invalid-target">;
    httpStatus?: number;
  };

export interface NpmMetadataClient {
  getMetadata(packageName: string): Promise<NpmMetadataResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidNpmDistTag(tag: string): boolean {
  return tag !== ""
    && encodeURIComponent(tag) === tag
    && semver.validRange(tag) === null;
}

export function isSafeNpmPackageName(packageName: string): boolean {
  if (packageName === "" || packageName.length > 214) {
    return false;
  }
  const segments = packageName.startsWith("@")
    ? packageName.slice(1).split("/")
    : packageName.split("/");
  return segments.length === (packageName.startsWith("@") ? 2 : 1)
    && segments.every((segment) =>
      segment !== ""
      && segment !== "."
      && segment !== ".."
      && encodeURIComponent(segment) === segment);
}

function parseMetadata(value: unknown): NpmPackageMetadata | undefined {
  if (!isRecord(value) || !isRecord(value.versions) || !isRecord(value["dist-tags"])) {
    return undefined;
  }

  const versions: string[] = [];
  for (const [version, versionMetadata] of Object.entries(value.versions)) {
    if (semver.valid(version) !== version || !isRecord(versionMetadata)) {
      return undefined;
    }
    versions.push(version);
  }
  versions.sort(semver.compare);

  const distTags = new Map<string, string>();
  for (const [tag, version] of Object.entries(value["dist-tags"])) {
    if (
      !isValidNpmDistTag(tag)
      || typeof version !== "string"
      || semver.valid(version) !== version
      || !versions.includes(version)
    ) {
      return undefined;
    }
    distTags.set(tag, version);
  }

  return { distTags, versions };
}

function packageUrl(packageName: string): URL {
  return new URL(encodeURIComponent(packageName), NPM_REGISTRY_URL);
}

export function createNpmMetadataClient(
  options: TargetResolverOptions = {},
): NpmMetadataClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Target resolver timeoutMs must be a positive finite number.");
  }
  const cache = new Map<string, Promise<NpmMetadataResult>>();

  async function requestMetadata(
    packageName: string,
    signal: AbortSignal,
  ): Promise<NpmMetadataResult> {
    try {
      let response: Response;
      try {
        response = await fetchImplementation(packageUrl(packageName), {
          headers: { "User-Agent": USER_AGENT },
          signal,
        });
      } catch (error) {
        if (signal.aborted) {
          return { status: "error", issue: "timeout" };
        }
        return { status: "error", issue: "network-error" };
      }

      if (response.status === 404) {
        return { status: "not-found", issue: "package-not-found", httpStatus: 404 };
      }
      if (response.status === 429) {
        return { status: "error", issue: "rate-limited", httpStatus: 429 };
      }
      if (response.status >= 500) {
        return {
          status: "error",
          issue: "registry-unavailable",
          httpStatus: response.status,
        };
      }
      if (!response.ok) {
        return { status: "error", issue: "http-error", httpStatus: response.status };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        return {
          status: "error",
          issue: signal.aborted ? "timeout" : "invalid-registry-response",
        };
      }
      const metadata = parseMetadata(body);
      return metadata === undefined
        ? { status: "error", issue: "invalid-registry-response" }
        : { status: "available", metadata };
    } catch (error) {
      return { status: "error", issue: signal.aborted ? "timeout" : "network-error" };
    }
  }

  async function fetchMetadata(packageName: string): Promise<NpmMetadataResult> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<NpmMetadataResult>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve({ status: "error", issue: "timeout" });
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        requestMetadata(packageName, controller.signal),
        deadline,
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  return {
    getMetadata(packageName: string): Promise<NpmMetadataResult> {
      const existing = cache.get(packageName);
      if (existing !== undefined) {
        return existing;
      }
      const request = fetchMetadata(packageName).then((result) => {
        if (result.status !== "available" && cache.get(packageName) === request) {
          cache.delete(packageName);
        }
        return result;
      });
      cache.set(packageName, request);
      return request;
    },
  };
}

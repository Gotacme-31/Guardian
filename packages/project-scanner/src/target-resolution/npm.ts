import * as semver from "semver";

import type { TargetResolutionIssue, TargetResolverOptions } from "./types.js";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const USER_AGENT = "Guardian/0.0.1";

export interface NpmPackageMetadata {
  distTags: Map<string, string>;
  versions: string[];
}

export type NpmVersionArtifactMetadata =
  | {
    status: "available";
    tarball?: string;
    integrity?: string;
    shasum?: string;
  }
  | { status: "invalid" };

export type NpmMetadataFailure =
  | { status: "not-found"; issue: "package-not-found"; httpStatus: 404 }
  | {
    status: "error";
    issue: Exclude<TargetResolutionIssue, "non-registry-dependency" | "package-not-found" | "tag-not-found" | "version-not-found" | "no-matching-version" | "invalid-target">;
    httpStatus?: number;
  };

export type NpmMetadataResult =
  | { status: "available"; metadata: NpmPackageMetadata }
  | NpmMetadataFailure;

export type NpmVersionMetadataResult =
  | { status: "available"; metadata: NpmVersionArtifactMetadata }
  | NpmMetadataFailure;

export interface NpmMetadataClient {
  getMetadata(packageName: string): Promise<NpmMetadataResult>;
  getVersionMetadata(packageName: string, version: string): Promise<NpmVersionMetadataResult>;
}

class NpmMetadataBodyNetworkError extends Error {}

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

function parseVersionMetadata(
  value: unknown,
  packageName: string,
  version: string,
): NpmVersionArtifactMetadata {
  if (
    !isRecord(value)
    || value.name !== packageName
    || value.version !== version
    || !isRecord(value.dist)
  ) {
    return { status: "invalid" };
  }
  const { tarball, integrity, shasum } = value.dist;
  if (
    (tarball !== undefined && typeof tarball !== "string")
    || (integrity !== undefined && typeof integrity !== "string")
    || (shasum !== undefined && typeof shasum !== "string")
  ) {
    return { status: "invalid" };
  }
  return {
    status: "available",
    ...(typeof tarball === "string" ? { tarball } : {}),
    ...(typeof integrity === "string" ? { integrity } : {}),
    ...(typeof shasum === "string" ? { shasum } : {}),
  };
}

function packageUrl(packageName: string): URL {
  return new URL(encodeURIComponent(packageName), NPM_REGISTRY_URL);
}

function packageVersionUrl(packageName: string, version: string): URL {
  return new URL(
    `${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
    NPM_REGISTRY_URL,
  );
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readMetadataBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) {
    throw new Error("Registry metadata response has no body.");
  }
  const contentLength = response.headers.get("Content-Length");
  if (
    contentLength !== null
    && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_METADATA_BYTES)
  ) {
    await cancelBody(response);
    throw new Error("Registry metadata response is too large.");
  }

  const reader = response.body.getReader();
  if (signal.aborted) {
    await reader.cancel("Registry metadata request aborted.").catch(() => undefined);
    throw new Error("Registry metadata request was aborted.");
  }
  const abortReader = (): void => {
    void reader.cancel("Registry metadata request aborted.").catch(() => undefined);
  };
  signal.addEventListener("abort", abortReader, { once: true });
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        throw new NpmMetadataBodyNetworkError(
          "Registry metadata response failed while streaming.",
          { cause: error },
        );
      }
      const { done, value } = chunk;
      if (done) {
        break;
      }
      if (signal.aborted || value === undefined) {
        throw new Error("Registry metadata request was aborted.");
      }
      const buffer = Buffer.from(value);
      if (buffer.byteLength === 0) {
        await reader.cancel("Registry metadata response returned an empty chunk.")
          .catch(() => undefined);
        throw new Error("Registry metadata response returned an empty chunk.");
      }
      if (buffer.byteLength > MAX_METADATA_BYTES - totalBytes) {
        await reader.cancel("Registry metadata response is too large.").catch(() => undefined);
        throw new Error("Registry metadata response is too large.");
      }
      chunks.push(buffer);
      totalBytes += buffer.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as unknown;
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
  const versionCache = new Map<string, Promise<NpmVersionMetadataResult>>();

  async function requestDocument(
    url: URL,
    accept: string,
    signal: AbortSignal,
  ): Promise<{ status: "available"; body: unknown } | NpmMetadataFailure> {
    try {
      let response: Response;
      try {
        response = await fetchImplementation(url, {
          headers: {
            Accept: accept,
            "User-Agent": USER_AGENT,
          },
          redirect: "manual",
          signal,
        });
      } catch (error) {
        if (signal.aborted) {
          return { status: "error", issue: "timeout" };
        }
        return { status: "error", issue: "network-error" };
      }
      if (signal.aborted) {
        await cancelBody(response);
        return { status: "error", issue: "timeout" };
      }

      if (response.status === 404) {
        await cancelBody(response);
        return { status: "not-found", issue: "package-not-found", httpStatus: 404 };
      }
      if (response.status === 429) {
        await cancelBody(response);
        return { status: "error", issue: "rate-limited", httpStatus: 429 };
      }
      if (response.status >= 500) {
        await cancelBody(response);
        return {
          status: "error",
          issue: "registry-unavailable",
          httpStatus: response.status,
        };
      }
      if (response.status >= 300 && response.status < 400) {
        await cancelBody(response);
        return { status: "error", issue: "http-error", httpStatus: response.status };
      }
      if (!response.ok) {
        await cancelBody(response);
        return { status: "error", issue: "http-error", httpStatus: response.status };
      }

      let body: unknown;
      try {
        body = await readMetadataBody(response, signal);
      } catch (error) {
        return {
          status: "error",
          issue: signal.aborted
            ? "timeout"
            : error instanceof NpmMetadataBodyNetworkError
              ? "network-error"
              : "invalid-registry-response",
        };
      }
      return { status: "available", body };
    } catch (error) {
      return { status: "error", issue: signal.aborted ? "timeout" : "network-error" };
    }
  }

  async function withTimeout<T>(
    request: (signal: AbortSignal) => Promise<T>,
    timeoutResult: T,
  ): Promise<T> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<T>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(timeoutResult);
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        request(controller.signal),
        deadline,
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  async function fetchMetadata(packageName: string): Promise<NpmMetadataResult> {
    return withTimeout(async (signal) => {
      const result = await requestDocument(
        packageUrl(packageName),
        "application/vnd.npm.install-v1+json",
        signal,
      );
      if (result.status !== "available") {
        return result;
      }
      const metadata = parseMetadata(result.body);
      return metadata === undefined
        ? { status: "error", issue: "invalid-registry-response" }
        : { status: "available", metadata };
    }, { status: "error", issue: "timeout" });
  }

  async function fetchVersionMetadata(
    packageName: string,
    version: string,
  ): Promise<NpmVersionMetadataResult> {
    return withTimeout(async (signal) => {
      const result = await requestDocument(
        packageVersionUrl(packageName, version),
        "application/json",
        signal,
      );
      return result.status !== "available"
        ? result
        : {
          status: "available",
          metadata: parseVersionMetadata(result.body, packageName, version),
        };
    }, { status: "error", issue: "timeout" });
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
    getVersionMetadata(packageName: string, version: string): Promise<NpmVersionMetadataResult> {
      const key = `${packageName}\0${version}`;
      const existing = versionCache.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const request = fetchVersionMetadata(packageName, version).then((result) => {
        if (result.status !== "available" && versionCache.get(key) === request) {
          versionCache.delete(key);
        }
        return result;
      });
      versionCache.set(key, request);
      return request;
    },
  };
}

import { open, type FileHandle } from "node:fs/promises";
import type { ReadableStreamDefaultReader } from "node:stream/web";

import * as semver from "semver";

import {
  createNpmMetadataClient,
  isSafeNpmPackageName,
  type NpmMetadataClient,
  type NpmMetadataFailure,
} from "../target-resolution/npm.js";
import { PackageArtifactError } from "./errors.js";
import type {
  ArtifactAcquisitionOptions,
  NpmArtifactMetadata,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const USER_AGENT = "Guardian/0.0.1";

function metadataFailure(
  result: Extract<NpmMetadataFailure, { status: "error" }>,
): never {
  const code = result.issue === "timeout"
    ? "artifact-metadata-timeout"
    : result.issue === "network-error"
      ? "artifact-metadata-network-error"
      : result.issue === "rate-limited"
        ? "artifact-metadata-rate-limited"
        : result.issue === "registry-unavailable" || result.issue === "http-error"
          ? "artifact-metadata-unavailable"
          : "artifact-metadata-invalid";
  throw new PackageArtifactError(code, "Could not obtain valid package artifact metadata.", {
    ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
  });
}

export function createArtifactMetadataClient(
  options: ArtifactAcquisitionOptions,
): NpmMetadataClient {
  return createNpmMetadataClient({
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

export async function resolveNpmArtifactMetadata(
  client: NpmMetadataClient,
  dependency: string,
  version: string,
): Promise<NpmArtifactMetadata> {
  if (!isSafeNpmPackageName(dependency)) {
    throw new PackageArtifactError(
      "invalid-package-name",
      `Invalid public npm package name: "${dependency}".`,
    );
  }
  if (semver.valid(version) !== version) {
    throw new PackageArtifactError(
      "invalid-version",
      `Artifact version must be an exact canonical SemVer: "${version}".`,
    );
  }

  const result = await client.getVersionMetadata(dependency, version);
  if (result.status !== "available") {
    if (result.status === "not-found") {
      throw new PackageArtifactError(
        "artifact-version-not-found",
        `Artifact metadata for ${dependency}@${version} was not found.`,
        { httpStatus: result.httpStatus },
      );
    }
    metadataFailure(result);
  }
  const artifact = result.metadata;
  if (artifact.status === "invalid") {
    throw new PackageArtifactError(
      "artifact-metadata-invalid",
      `Artifact metadata for ${dependency}@${version} is invalid.`,
    );
  }
  if (artifact.tarball === undefined) {
    throw new PackageArtifactError(
      "artifact-metadata-invalid",
      `Artifact metadata for ${dependency}@${version} has no tarball URL.`,
    );
  }

  let tarballUrl: URL;
  try {
    tarballUrl = new URL(artifact.tarball);
  } catch (error) {
    throw new PackageArtifactError(
      "tarball-url-invalid",
      `Invalid tarball URL for ${dependency}@${version}.`,
      { cause: error },
    );
  }
  if (
    tarballUrl.protocol !== "https:"
    || tarballUrl.hostname !== "registry.npmjs.org"
    || tarballUrl.port !== ""
    || tarballUrl.username !== ""
    || tarballUrl.password !== ""
  ) {
    throw new PackageArtifactError(
      "tarball-url-invalid",
      `Tarball URL for ${dependency}@${version} is outside the public npm registry.`,
    );
  }

  const base = {
    dependency,
    version,
    tarballUrl: tarballUrl.toString(),
  };
  if (artifact.integrity !== undefined) {
    return {
      ...base,
      integrity: artifact.integrity,
      ...(artifact.shasum === undefined ? {} : { shasum: artifact.shasum }),
    };
  }
  if (artifact.shasum !== undefined) {
    return { ...base, shasum: artifact.shasum };
  }
  throw new PackageArtifactError(
    "integrity-metadata-missing",
    `No integrity metadata is available for ${dependency}@${version}.`,
  );
}

function validateContentLength(
  response: Response,
  maxCompressedBytes: number,
): number | undefined {
  const header = response.headers.get("Content-Length");
  if (header === null) {
    return undefined;
  }
  if (!/^\d+$/.test(header)) {
    throw new PackageArtifactError(
      "download-response-invalid",
      "Tarball response contains an invalid Content-Length header.",
    );
  }
  const contentLength = Number(header);
  if (!Number.isSafeInteger(contentLength)) {
    throw new PackageArtifactError(
      "download-response-invalid",
      "Tarball response Content-Length is not a safe integer.",
    );
  }
  if (contentLength > maxCompressedBytes) {
    throw new PackageArtifactError(
      "compressed-size-limit-exceeded",
      `Tarball Content-Length exceeds the ${maxCompressedBytes} byte limit.`,
    );
  }
  return contentLength;
}

function validateDownloadResponse(response: Response): void {
  if (response.status >= 300 && response.status < 400) {
    throw new PackageArtifactError(
      "download-redirect-rejected",
      "Tarball download redirect was rejected.",
      { httpStatus: response.status },
    );
  }
  if (response.status === 404) {
    throw new PackageArtifactError(
      "download-not-found",
      "Tarball was not found in the public npm registry.",
      { httpStatus: 404 },
    );
  }
  if (response.status === 429) {
    throw new PackageArtifactError(
      "download-rate-limited",
      "The public npm registry rate-limited the tarball request.",
      { httpStatus: 429 },
    );
  }
  if (response.status >= 500) {
    throw new PackageArtifactError(
      "download-unavailable",
      "The public npm registry could not serve the tarball.",
      { httpStatus: response.status },
    );
  }
  if (!response.ok) {
    throw new PackageArtifactError(
      "download-http-error",
      `Tarball request failed with HTTP ${response.status}.`,
      { httpStatus: response.status },
    );
  }
  if (response.body === null) {
    throw new PackageArtifactError(
      "download-response-invalid",
      "Tarball response has no body.",
    );
  }
}

async function writeChunk(file: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset, null);
    if (bytesWritten === 0) {
      throw new PackageArtifactError(
        "filesystem-error",
        "Could not make progress while writing the tarball.",
      );
    }
    offset += bytesWritten;
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
) {
  try {
    return await reader.read();
  } catch (error) {
    throw new PackageArtifactError(
      signal.aborted ? "download-timeout" : "download-network-error",
      signal.aborted
        ? "Tarball download timed out."
        : "Tarball download failed while reading the response body.",
      { cause: error },
    );
  }
}

export async function downloadNpmTarball(
  metadata: NpmArtifactMetadata,
  archivePath: string,
  options: ArtifactAcquisitionOptions,
  maxCompressedBytes: number,
): Promise<number> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Artifact acquisition timeoutMs must be a positive finite number.");
  }

  let file: FileHandle;
  try {
    file = await open(archivePath, "wx", 0o600);
  } catch (error) {
    throw new PackageArtifactError("filesystem-error", "Could not create tarball storage.", {
      cause: error,
    });
  }

  const controller = new AbortController();
  let archiveFile: FileHandle | undefined = file;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  async function closeArchiveFile(): Promise<void> {
    const file = archiveFile;
    archiveFile = undefined;
    await file?.close();
  }
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      void activeReader?.cancel("Tarball download timed out.").catch(() => undefined);
      void closeArchiveFile().then(
        () => reject(new PackageArtifactError("download-timeout", "Tarball download timed out.")),
        (error: unknown) => reject(new PackageArtifactError(
          "filesystem-error",
          "Could not close the timed-out tarball file.",
          { cause: error },
        )),
      );
    }, timeoutMs);
  });

  const operation = (async (): Promise<number> => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      let response: Response;
      try {
        response = await fetchImplementation(metadata.tarballUrl, {
          headers: { "User-Agent": USER_AGENT },
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        throw new PackageArtifactError(
          controller.signal.aborted ? "download-timeout" : "download-network-error",
          controller.signal.aborted
            ? "Tarball download timed out."
            : "Tarball download failed due to a network error.",
          { cause: error },
        );
      }
      if (controller.signal.aborted) {
        await response.body?.cancel().catch(() => undefined);
        throw new PackageArtifactError("download-timeout", "Tarball download timed out.");
      }

      let contentLength: number | undefined;
      try {
        validateDownloadResponse(response);
        contentLength = validateContentLength(response, maxCompressedBytes);
      } catch (error) {
        controller.abort();
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
      const body = response.body;
      if (body === null) {
        throw new PackageArtifactError(
          "download-response-invalid",
          "Tarball response has no body.",
        );
      }
      reader = body.getReader();
      activeReader = reader;
      let downloadedBytes = 0;
      while (true) {
        const { done, value } = await readChunk(reader, controller.signal);
        if (controller.signal.aborted) {
          throw new PackageArtifactError("download-timeout", "Tarball download timed out.");
        }
        if (done) {
          break;
        }
        if (value === undefined) {
          throw new PackageArtifactError(
            "download-response-invalid",
            "Tarball stream returned an invalid chunk.",
          );
        }
        const buffer = Buffer.from(value);
        if (buffer.byteLength === 0) {
          throw new PackageArtifactError(
            "download-response-invalid",
            "Tarball stream returned an empty chunk.",
          );
        }
        if (
          contentLength !== undefined
          && buffer.byteLength > contentLength - downloadedBytes
        ) {
          controller.abort();
          void reader.cancel("Tarball exceeded its Content-Length.").catch(() => undefined);
          throw new PackageArtifactError(
            "download-response-invalid",
            "Tarball response body exceeds its Content-Length.",
          );
        }
        if (buffer.byteLength > maxCompressedBytes - downloadedBytes) {
          controller.abort();
          void reader.cancel("Tarball compressed size limit exceeded.").catch(() => undefined);
          throw new PackageArtifactError(
            "compressed-size-limit-exceeded",
            `Tarball stream exceeds the ${maxCompressedBytes} byte limit.`,
          );
        }
        await writeChunk(file, buffer);
        downloadedBytes += buffer.byteLength;
      }
      if (contentLength !== undefined && downloadedBytes !== contentLength) {
        throw new PackageArtifactError(
          "download-response-invalid",
          "Tarball response body ended before its Content-Length.",
        );
      }
      return downloadedBytes;
    } catch (error) {
      controller.abort();
      void reader?.cancel("Tarball download failed.").catch(() => undefined);
      throw error;
    } finally {
      if (reader !== undefined && activeReader === reader) {
        activeReader = undefined;
      }
      reader?.releaseLock();
      if (archiveFile === file) {
        archiveFile = undefined;
      }
      await file.close();
    }
  })();

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

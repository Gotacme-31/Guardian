import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { extract, Parser, type ReadEntry } from "tar";

import { PackageArtifactError } from "./errors.js";
import type { ArtifactAcquisitionLimits } from "./types.js";

const ALLOWED_ENTRY_TYPES = new Set([
  "File",
  "OldFile",
  "ContiguousFile",
  "Directory",
]);
const MAX_ARCHIVE_DEPTH = 256;
const MAX_META_ENTRY_BYTES = 1024 * 1024;

function validateEntryPath(entryPath: string): string[] {
  if (
    entryPath === ""
    || entryPath.includes("\0")
    || path.posix.isAbsolute(entryPath)
    || path.win32.isAbsolute(entryPath)
    || /^[A-Za-z]:/.test(entryPath)
    || entryPath.includes("\\")
  ) {
    throw new PackageArtifactError(
      "archive-path-unsafe",
      `Archive contains an unsafe path: "${entryPath}".`,
    );
  }

  const normalized = entryPath.replace(/\/+$/, "");
  const segments = normalized.split("/");
  if (
    segments[0] !== "package"
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new PackageArtifactError(
      "archive-path-unsafe",
      `Archive entry is outside the expected package root: "${entryPath}".`,
    );
  }
  if (segments.length > MAX_ARCHIVE_DEPTH) {
    throw new PackageArtifactError(
      "archive-entry-limit-exceeded",
      `Archive entry exceeds the ${MAX_ARCHIVE_DEPTH} segment depth limit.`,
    );
  }
  return segments;
}

function validateEntryType(entry: ReadEntry): void {
  if (entry.invalid || entry.unsupported || !ALLOWED_ENTRY_TYPES.has(entry.type)) {
    throw new PackageArtifactError(
      "archive-entry-type-unsupported",
      `Archive entry type "${entry.type}" is not allowed.`,
    );
  }
}

function validateEntrySafety(entry: ReadEntry): string[] {
  const segments = validateEntryPath(entry.path);
  validateEntryType(entry);
  if (entry.extended?.size !== undefined || entry.globalExtended?.size !== undefined) {
    throw new PackageArtifactError(
      "archive-invalid",
      `Archive entry "${entry.path}" uses an unsupported PAX size override.`,
    );
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new PackageArtifactError(
      "archive-invalid",
      `Archive entry "${entry.path}" has an invalid size.`,
    );
  }
  return segments;
}

function decompressionRatio(
  downloadedBytes: number,
  limits: ArtifactAcquisitionLimits,
): number {
  const maximumTarBytes = limits.maxExtractedBytes + (limits.maxEntries * 1024) + 1024;
  return Math.min(
    limits.maxCompressionRatio,
    Math.max(1, maximumTarBytes / Math.max(1, downloadedBytes)),
  );
}

async function consumeArchive(archivePath: string, parser: Parser): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(archivePath);
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      input.destroy();
      reject(error);
    };
    input.once("error", fail);
    parser.once("error", fail);
    parser.once("end", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    input.pipe(parser as unknown as NodeJS.WritableStream);
  });
}

async function preflightArchive(
  archivePath: string,
  downloadedBytes: number,
  limits: ArtifactAcquisitionLimits,
): Promise<void> {
  const impliedPaths = new Set<string>();
  let archiveEntryCount = 0;
  let extractedBytes = 0;
  let validationError: PackageArtifactError | undefined;
  function recordError(error: PackageArtifactError): void {
    validationError ??= error;
  }
  function countArchiveHeader(): void {
    archiveEntryCount += 1;
    if (archiveEntryCount > limits.maxEntries) {
      recordError(new PackageArtifactError(
        "archive-entry-limit-exceeded",
        `Archive exceeds the ${limits.maxEntries} header entry limit.`,
      ));
    }
  }
  try {
    const headerCounter = new Parser({
      strict: true,
      // A negative limit makes tar emit every metadata header, including empty ones.
      maxMetaEntrySize: -1,
      maxDecompressionRatio: decompressionRatio(downloadedBytes, limits),
      onReadEntry(entry) {
        countArchiveHeader();
        entry.resume();
      },
    });
    headerCounter.on("ignoredEntry", countArchiveHeader);
    await consumeArchive(archivePath, headerCounter);
    if (validationError !== undefined) {
      throw validationError;
    }

    const parser = new Parser({
      strict: true,
      maxMetaEntrySize: MAX_META_ENTRY_BYTES,
      maxDecompressionRatio: decompressionRatio(downloadedBytes, limits),
      onReadEntry(entry) {
        if (validationError !== undefined) {
          entry.resume();
          return;
        }
        try {
          const segments = validateEntrySafety(entry);
          let impliedPath = "";
          for (const segment of segments) {
            impliedPath = impliedPath === "" ? segment : `${impliedPath}/${segment}`;
            impliedPaths.add(impliedPath);
            if (impliedPaths.size > limits.maxEntries) {
              throw new PackageArtifactError(
                "archive-entry-limit-exceeded",
                `Archive exceeds the ${limits.maxEntries} entry limit including parent directories.`,
              );
            }
          }
          if (entry.type !== "Directory") {
            if (entry.size > limits.maxSingleFileBytes) {
              throw new PackageArtifactError(
                "archive-file-size-limit-exceeded",
                `Archive entry "${entry.path}" exceeds the single-file limit.`,
              );
            }
            if (entry.size > limits.maxExtractedBytes - extractedBytes) {
              throw new PackageArtifactError(
                "archive-size-limit-exceeded",
                `Archive exceeds the ${limits.maxExtractedBytes} extracted byte limit.`,
              );
            }
            extractedBytes += entry.size;
          }
        } catch (error) {
          validationError = error instanceof PackageArtifactError
            ? error
            : new PackageArtifactError("archive-invalid", "Archive entry validation failed.", {
              cause: error,
            });
        } finally {
          entry.resume();
        }
      },
    });
    parser.on("ignoredEntry", (entry: ReadEntry) => {
      recordError(new PackageArtifactError(
        "archive-entry-type-unsupported",
        `Archive entry type "${entry.type}" is not allowed.`,
      ));
    });
    await consumeArchive(archivePath, parser);
  } catch (error) {
    if (validationError !== undefined) {
      throw validationError;
    }
    if (error instanceof PackageArtifactError) {
      throw error;
    }
    throw new PackageArtifactError("archive-invalid", "Tarball is not a valid safe archive.", {
      cause: error,
    });
  }
  if (validationError !== undefined) {
    throw validationError;
  }
}

async function validateExtractedTree(
  extractionRoot: string,
  limits: ArtifactAcquisitionLimits,
): Promise<void> {
  let entryCount = 0;
  let extractedBytes = 0;

  async function visit(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        throw new PackageArtifactError(
          "archive-entry-limit-exceeded",
          `Extracted tree exceeds the ${limits.maxEntries} entry limit.`,
        );
      }
      const entryPath = path.join(directoryPath, entry.name);
      const entryStat = await lstat(entryPath);
      if (entryStat.isSymbolicLink() || (!entryStat.isDirectory() && !entryStat.isFile())) {
        throw new PackageArtifactError(
          "archive-entry-type-unsupported",
          "Extracted tree contains a link or special filesystem entry.",
        );
      }
      if (entryStat.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (entryStat.size > limits.maxSingleFileBytes) {
        throw new PackageArtifactError(
          "archive-file-size-limit-exceeded",
          `Extracted file "${entry.name}" exceeds the single-file limit.`,
        );
      }
      if (entryStat.size > limits.maxExtractedBytes - extractedBytes) {
        throw new PackageArtifactError(
          "archive-size-limit-exceeded",
          `Extracted tree exceeds the ${limits.maxExtractedBytes} byte limit.`,
        );
      }
      extractedBytes += entryStat.size;
    }
  }

  try {
    await visit(extractionRoot);
  } catch (error) {
    if (error instanceof PackageArtifactError) {
      throw error;
    }
    throw new PackageArtifactError(
      "filesystem-error",
      "Could not validate the extracted package tree.",
      { cause: error },
    );
  }
}

export async function extractPackageArchive(
  archivePath: string,
  extractionRoot: string,
  downloadedBytes: number,
  limits: ArtifactAcquisitionLimits,
): Promise<string> {
  await preflightArchive(archivePath, downloadedBytes, limits);
  await mkdir(extractionRoot, { recursive: false, mode: 0o700 });

  try {
    await extract({
      file: archivePath,
      cwd: extractionRoot,
      strict: true,
      maxMetaEntrySize: MAX_META_ENTRY_BYTES,
      preserveOwner: false,
      noMtime: true,
      unlink: true,
      umask: 0o077,
      maxDepth: MAX_ARCHIVE_DEPTH,
      maxDecompressionRatio: decompressionRatio(downloadedBytes, limits),
      filter(_entryPath, entry) {
        validateEntrySafety(entry as ReadEntry);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof PackageArtifactError) {
      throw error;
    }
    throw new PackageArtifactError("archive-invalid", "Tarball extraction failed.", {
      cause: error,
    });
  }

  await validateExtractedTree(extractionRoot, limits);
  return path.join(extractionRoot, "package");
}

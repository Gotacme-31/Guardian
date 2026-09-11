import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DependencyContext } from "../dependency-context/types.js";
import type { ResolvedDependencyTarget } from "../target-resolution/types.js";
import { PackageArtifactError } from "./errors.js";
import { extractPackageArchive } from "./extraction.js";
import {
  validateArtifactIntegrityMetadata,
  verifyArtifactIntegrity,
} from "./integrity.js";
import {
  createArtifactMetadataClient,
  downloadNpmTarball,
  resolveNpmArtifactMetadata,
} from "./npm.js";
import type {
  AcquiredDependencyArtifactPair,
  AcquiredPackageArtifact,
  ArtifactAcquisitionLimits,
  ArtifactAcquisitionOptions,
  PackageArtifactAcquirer,
} from "./types.js";

export const DEFAULT_ARTIFACT_LIMITS: Readonly<ArtifactAcquisitionLimits> = {
  maxCompressedBytes: 50 * 1024 * 1024,
  maxExtractedBytes: 250 * 1024 * 1024,
  maxEntries: 20_000,
  maxSingleFileBytes: 50 * 1024 * 1024,
  maxCompressionRatio: 1_000,
};

const artifactOwnership = new WeakMap<AcquiredPackageArtifact, string>();
const cleanedArtifacts = new WeakSet<AcquiredPackageArtifact>();

function artifactLimits(
  overrides: Partial<ArtifactAcquisitionLimits> | undefined,
): ArtifactAcquisitionLimits {
  const limits = { ...DEFAULT_ARTIFACT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`Artifact limit ${name} must be a positive safe integer.`);
    }
  }
  if (limits.maxSingleFileBytes > limits.maxExtractedBytes) {
    throw new RangeError("Artifact maxSingleFileBytes cannot exceed maxExtractedBytes.");
  }
  const maximumTarBytes = limits.maxExtractedBytes + (limits.maxEntries * 1024) + 1024;
  if (!Number.isSafeInteger(maximumTarBytes)) {
    throw new RangeError("Combined artifact extraction limits exceed safe integer range.");
  }
  return limits;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function validatePackageManifest(
  packagePath: string,
  dependency: string,
  version: string,
): Promise<void> {
  const manifestPath = path.join(packagePath, "package.json");
  let contents: string;
  try {
    contents = await readFile(manifestPath, "utf8");
  } catch (error) {
    const code = isRecord(error) && error.code === "ENOENT"
      ? "package-json-missing"
      : "filesystem-error";
    throw new PackageArtifactError(code, `Could not read extracted package.json.`, {
      cause: error,
    });
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(contents);
  } catch (error) {
    throw new PackageArtifactError(
      "package-json-invalid",
      "Extracted package.json is not valid JSON.",
      { cause: error },
    );
  }
  if (!isRecord(manifest) || typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new PackageArtifactError(
      "package-json-invalid",
      "Extracted package.json must contain string name and version fields.",
    );
  }
  if (manifest.name !== dependency) {
    throw new PackageArtifactError(
      "package-name-mismatch",
      `Extracted package name "${manifest.name}" does not match "${dependency}".`,
    );
  }
  if (manifest.version !== version) {
    throw new PackageArtifactError(
      "package-version-mismatch",
      `Extracted package version "${manifest.version}" does not match "${version}".`,
    );
  }
}

async function removeTemporaryRoot(temporaryRoot: string): Promise<void> {
  await rm(temporaryRoot, { recursive: true, force: true });
}

export function createPackageArtifactAcquirer(
  options: ArtifactAcquisitionOptions = {},
): PackageArtifactAcquirer {
  const limits = artifactLimits(options.limits);
  const metadataClient = createArtifactMetadataClient(options);

  async function acquire(
    dependency: string,
    version: string,
  ): Promise<AcquiredPackageArtifact> {
    const metadata = await resolveNpmArtifactMetadata(metadataClient, dependency, version);
    validateArtifactIntegrityMetadata(metadata);

    let temporaryRoot: string;
    try {
      temporaryRoot = await mkdtemp(path.join(tmpdir(), "guardian-artifact-"));
    } catch (error) {
      throw new PackageArtifactError(
        "filesystem-error",
        "Could not create temporary artifact storage.",
        { cause: error },
      );
    }
    const archivePath = path.join(temporaryRoot, "package.tgz");
    const extractionRoot = path.join(temporaryRoot, "extracted");

    try {
      const downloadedBytes = await downloadNpmTarball(
        metadata,
        archivePath,
        options,
        limits.maxCompressedBytes,
      );
      const verification = await verifyArtifactIntegrity(
        archivePath,
        metadata,
        downloadedBytes,
      );
      const packagePath = await extractPackageArchive(
        archivePath,
        extractionRoot,
        downloadedBytes,
        limits,
      );
      await validatePackageManifest(packagePath, dependency, version);

      const artifact: AcquiredPackageArtifact = {
        dependency,
        version,
        source: "npm",
        tarballUrl: metadata.tarballUrl,
        verification,
        temporaryRoot,
        archivePath,
        extractionRoot,
        packagePath,
        downloadedBytes,
      };
      artifactOwnership.set(artifact, temporaryRoot);
      return artifact;
    } catch (error) {
      try {
        await removeTemporaryRoot(temporaryRoot);
      } catch (cleanupError) {
        throw new PackageArtifactError(
          "cleanup-failed",
          `Artifact acquisition failed and temporary cleanup also failed.`,
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
      if (error instanceof PackageArtifactError || error instanceof RangeError) {
        throw error;
      }
      throw new PackageArtifactError(
        "filesystem-error",
        `Could not acquire ${dependency}@${version}.`,
        { cause: error },
      );
    }
  }

  async function acquirePair(
    context: DependencyContext,
    target: ResolvedDependencyTarget,
  ): Promise<AcquiredDependencyArtifactPair> {
    if (context.resolution.kind !== "registry") {
      throw new PackageArtifactError(
        "non-registry-dependency",
        `Artifacts are only supported for registry dependencies.`,
      );
    }
    if (
      context.resolution.status !== "resolved"
      || context.resolution.dependency !== context.dependency
    ) {
      throw new PackageArtifactError(
        "target-context-mismatch",
        `Dependency context does not contain a consistent resolved registry dependency.`,
      );
    }
    if (target.dependency !== context.dependency) {
      throw new PackageArtifactError(
        "target-dependency-mismatch",
        `Target dependency does not match the dependency context.`,
      );
    }
    const installedVersion = context.resolution.resolvedVersion;
    if (installedVersion === undefined) {
      throw new PackageArtifactError(
        "installed-version-missing",
        `Installed version is unavailable for ${context.dependency}.`,
      );
    }
    if (target.installedVersion !== installedVersion) {
      throw new PackageArtifactError(
        "target-context-mismatch",
        `Target resolution was not produced from the supplied dependency context.`,
      );
    }

    const installed = await acquire(context.dependency, installedVersion);
    if (installedVersion === target.resolvedVersion) {
      return { installed, target: installed, deduplicated: true };
    }
    try {
      const targetArtifact = await acquire(context.dependency, target.resolvedVersion);
      return { installed, target: targetArtifact, deduplicated: false };
    } catch (error) {
      try {
        await cleanupPackageArtifact(installed);
      } catch (cleanupError) {
        throw new PackageArtifactError(
          "cleanup-failed",
          `Target acquisition failed and installed artifact cleanup also failed.`,
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
      throw error;
    }
  }

  return { acquire, acquirePair };
}

export function acquirePackageArtifact(
  dependency: string,
  version: string,
  options: ArtifactAcquisitionOptions = {},
): Promise<AcquiredPackageArtifact> {
  return createPackageArtifactAcquirer(options).acquire(dependency, version);
}

export function acquireDependencyArtifactPair(
  context: DependencyContext,
  target: ResolvedDependencyTarget,
  options: ArtifactAcquisitionOptions = {},
): Promise<AcquiredDependencyArtifactPair> {
  return createPackageArtifactAcquirer(options).acquirePair(context, target);
}

export async function cleanupPackageArtifact(
  artifact: AcquiredPackageArtifact,
): Promise<void> {
  const ownedRoot = artifactOwnership.get(artifact);
  if (ownedRoot === undefined) {
    if (cleanedArtifacts.has(artifact)) {
      return;
    }
    throw new PackageArtifactError(
      "cleanup-path-invalid",
      "Refusing to remove temporary storage not owned by this artifact instance.",
    );
  }
  try {
    await removeTemporaryRoot(ownedRoot);
  } catch (error) {
    throw new PackageArtifactError("cleanup-failed", "Could not clean artifact storage.", {
      cause: error,
    });
  }
  artifactOwnership.delete(artifact);
  cleanedArtifacts.add(artifact);
}

export async function cleanupDependencyArtifactPair(
  pair: AcquiredDependencyArtifactPair,
): Promise<void> {
  const artifacts = new Set([pair.installed, pair.target]);
  const results = await Promise.allSettled([...artifacts].map(cleanupPackageArtifact));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new PackageArtifactError(
      "cleanup-failed",
      "Could not clean all artifact pair storage.",
      { cause: new AggregateError(failures) },
    );
  }
}

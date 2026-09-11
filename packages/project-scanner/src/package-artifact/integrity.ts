import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";

import * as ssri from "ssri";

import { PackageArtifactError } from "./errors.js";
import type {
  ArtifactVerification,
  NpmArtifactMetadata,
} from "./types.js";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function parseSriAlgorithm(integrity: string): string {
  try {
    const parsed = ssri.parse(integrity, { strict: true }) as ssri.IntegrityMap | null;
    const algorithm = parsed?.pickAlgorithm();
    if (algorithm === null || algorithm === undefined) {
      throw new Error("SRI metadata contains no supported hash.");
    }
    return algorithm;
  } catch (error) {
    throw new PackageArtifactError(
      "integrity-metadata-invalid",
      "Package SRI metadata is invalid.",
      { cause: error },
    );
  }
}

function validateLegacySha1(shasum: string): void {
  if (!/^[0-9a-fA-F]{40}$/.test(shasum)) {
    throw new PackageArtifactError(
      "integrity-metadata-invalid",
      "Package SHA-1 shasum metadata is invalid.",
    );
  }
}

export function validateArtifactIntegrityMetadata(metadata: NpmArtifactMetadata): void {
  if (metadata.integrity !== undefined) {
    parseSriAlgorithm(metadata.integrity);
    return;
  }
  if (metadata.shasum !== undefined) {
    validateLegacySha1(metadata.shasum);
    return;
  }
  throw new PackageArtifactError(
    "integrity-metadata-missing",
    `No integrity metadata is available for ${metadata.dependency}@${metadata.version}.`,
  );
}

async function verifySri(
  archivePath: string,
  integrity: string,
  downloadedBytes: number,
): Promise<ArtifactVerification> {
  const algorithm = parseSriAlgorithm(integrity);

  try {
    const verified = await ssri.checkStream(createReadStream(archivePath), integrity, {
      strict: true,
      size: downloadedBytes,
    });
    return {
      verified: true,
      method: "sri",
      algorithm: verified.algorithm || algorithm,
      integrity,
    };
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EINTEGRITY" && code !== "EBADSIZE") {
      throw new PackageArtifactError(
        "filesystem-error",
        "Could not read the downloaded tarball for verification.",
        { cause: error },
      );
    }
    throw new PackageArtifactError(
      "integrity-verification-failed",
      "Downloaded tarball does not match its SRI metadata.",
      { cause: error },
    );
  }
}

async function verifyLegacySha1(
  archivePath: string,
  shasum: string,
): Promise<ArtifactVerification> {
  validateLegacySha1(shasum);

  const hash = createHash("sha1");
  try {
    for await (const chunk of createReadStream(archivePath)) {
      hash.update(chunk as Buffer);
    }
  } catch (error) {
    throw new PackageArtifactError(
      "filesystem-error",
      "Could not read the downloaded tarball for verification.",
      { cause: error },
    );
  }
  const actual = hash.digest();
  const expected = Buffer.from(shasum, "hex");
  if (!timingSafeEqual(actual, expected)) {
    throw new PackageArtifactError(
      "integrity-verification-failed",
      "Downloaded tarball does not match its legacy SHA-1 shasum.",
    );
  }

  return {
    verified: true,
    method: "sha1-legacy",
    algorithm: "sha1",
    shasum,
  };
}

export async function verifyArtifactIntegrity(
  archivePath: string,
  metadata: NpmArtifactMetadata,
  downloadedBytes: number,
): Promise<ArtifactVerification> {
  if (metadata.integrity !== undefined) {
    return verifySri(archivePath, metadata.integrity, downloadedBytes);
  }
  if (metadata.shasum !== undefined) {
    return verifyLegacySha1(archivePath, metadata.shasum);
  }
  throw new PackageArtifactError(
    "integrity-metadata-missing",
    `No integrity metadata is available for ${metadata.dependency}@${metadata.version}.`,
  );
}

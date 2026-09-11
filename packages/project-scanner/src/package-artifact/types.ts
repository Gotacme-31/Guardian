import type { DependencyContext } from "../dependency-context/types.js";
import type { ResolvedDependencyTarget } from "../target-resolution/types.js";

export interface ArtifactAcquisitionLimits {
  maxCompressedBytes: number;
  maxExtractedBytes: number;
  maxEntries: number;
  maxSingleFileBytes: number;
  maxCompressionRatio: number;
}

export interface ArtifactAcquisitionOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  limits?: Partial<ArtifactAcquisitionLimits>;
}

interface NpmArtifactMetadataBase {
  dependency: string;
  version: string;
  tarballUrl: string;
}

export type NpmArtifactMetadata = NpmArtifactMetadataBase & (
  | { integrity: string; shasum?: string }
  | { integrity?: never; shasum: string }
);

export type ArtifactVerification =
  | {
    readonly verified: true;
    readonly method: "sri";
    readonly algorithm: string;
    readonly integrity: string;
    readonly shasum?: never;
  }
  | {
    readonly verified: true;
    readonly method: "sha1-legacy";
    readonly algorithm: "sha1";
    readonly integrity?: never;
    readonly shasum: string;
  };

export interface AcquiredPackageArtifact {
  readonly dependency: string;
  readonly version: string;
  readonly source: "npm";
  readonly tarballUrl: string;
  readonly verification: ArtifactVerification;
  readonly temporaryRoot: string;
  readonly archivePath: string;
  readonly extractionRoot: string;
  readonly packagePath: string;
  readonly downloadedBytes: number;
}

export interface AcquiredDependencyArtifactPair {
  readonly installed: AcquiredPackageArtifact;
  readonly target: AcquiredPackageArtifact;
  readonly deduplicated: boolean;
}

export interface PackageArtifactAcquirer {
  acquire(dependency: string, version: string): Promise<AcquiredPackageArtifact>;
  acquirePair(
    context: DependencyContext,
    target: ResolvedDependencyTarget,
  ): Promise<AcquiredDependencyArtifactPair>;
}

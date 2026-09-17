export { ProjectScanError, type ProjectScanErrorCode } from "./errors.js";
export { scanProject } from "./scanner.js";
export {
  DEFAULT_DECLARATION_SURFACE_LIMITS,
  extractDeclarationSurface,
} from "./declaration-surface/index.js";
export type {
  DeclarationEntrypoint,
  DeclarationSurfaceIssue,
  DeclarationSurfaceIssueCode,
  DeclarationSurfaceLimits,
  DeclarationSurfaceOptions,
  ExternalReexportApiDeclaration,
  NamespaceApiDeclaration,
  PackageDeclarationSurface,
  PublicApiDeclaration,
  PublicApiDeclarationKind,
  PublicApiMember,
  PublicApiMemberKind,
  ReferencedApiDeclaration,
  SignatureReferencedApiDeclaration,
  SignatureApiDeclaration,
  StructuredReferencedApiDeclaration,
  StructuredApiDeclaration,
  NamespaceReferencedApiDeclaration,
  ExternalReferencedApiDeclaration,
} from "./declaration-surface/index.js";
export {
  acquireDependencyArtifactPair,
  acquirePackageArtifact,
  cleanupDependencyArtifactPair,
  cleanupPackageArtifact,
  createPackageArtifactAcquirer,
  DEFAULT_ARTIFACT_LIMITS,
} from "./package-artifact/index.js";
export {
  PackageArtifactError,
  type PackageArtifactErrorCode,
} from "./package-artifact/errors.js";
export type {
  AcquiredDependencyArtifactPair,
  AcquiredPackageArtifact,
  ArtifactAcquisitionLimits,
  ArtifactAcquisitionOptions,
  ArtifactVerification,
  NpmArtifactMetadata,
  PackageArtifactAcquirer,
} from "./package-artifact/types.js";
export {
  classifyUpgradeType,
  createDependencyTargetResolver,
  resolveDependencyTarget,
} from "./target-resolution/index.js";
export type {
  DependencyTargetResolution,
  DependencyTargetResolver,
  DependencyUpgradeType,
  FailedDependencyTarget,
  ResolvedDependencyTarget,
  TargetResolutionIssue,
  TargetResolutionStatus,
  TargetResolverOptions,
} from "./target-resolution/types.js";
export {
  buildDependencyContexts,
  findDependencyContext,
} from "./dependency-context/index.js";
export type {
  ApiUsageEvidence,
  ApiUsageSummary,
  DependencyContext,
  DependencyDeclarationContext,
  DependencyUsageContext,
  ImportedBindingKind,
  ImportedSymbolSummary,
} from "./dependency-context/types.js";
export type {
  DependencyResolutionIssue,
  DependencyResolutionKind,
  DependencyResolutionStatus,
  InstalledDependencyResolution,
} from "./dependency-resolution/types.js";
export type {
  DependencyInfo,
  DependencyType,
  DependencyUsage,
  ImportKind,
  ImportSymbolBinding,
  ImportUsage,
  PackageManager,
  ProjectScanResult,
  SymbolUsage,
  SymbolUsageKind,
} from "./types.js";

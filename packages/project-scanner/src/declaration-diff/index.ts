export {
  compareDeclarationSurfaces,
  DeclarationSurfaceComparisonError,
} from "./compare.js";
export { conditionPathIdentity, entrypointIdentity, memberRole } from "./identity.js";
export type {
  ComparisonIssueCode,
  DeclarationComparisonErrorCode,
  DeclarationComparisonIssue,
  DeclarationDiffSide,
  DeclarationPropertyChange,
  DeclarationPropertyName,
  DeclarationSourceIssues,
  DeclarationSurfaceDiffSummary,
  DeprecationChange,
  EntrypointChange,
  ExportChange,
  MemberChange,
  PackageDeclarationSurfaceDiff,
  ProvenanceChange,
  ReferencedDeclarationChange,
  SignatureChange,
} from "./types.js";

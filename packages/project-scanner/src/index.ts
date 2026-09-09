export { ProjectScanError, type ProjectScanErrorCode } from "./errors.js";
export { scanProject } from "./scanner.js";
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

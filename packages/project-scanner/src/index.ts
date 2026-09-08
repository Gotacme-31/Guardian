export { ProjectScanError, type ProjectScanErrorCode } from "./errors.js";
export { scanProject } from "./scanner.js";
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
  ImportUsage,
  PackageManager,
  ProjectScanResult,
  SymbolUsage,
  SymbolUsageKind,
} from "./types.js";

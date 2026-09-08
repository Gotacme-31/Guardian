import type { DependencyInfo, DependencyType, PackageManager } from "../types.js";

export type DependencyResolutionKind =
  | "registry"
  | "workspace"
  | "link"
  | "file"
  | "git"
  | "url"
  | "unknown";

export type DependencyResolutionStatus = "resolved" | "unresolved" | "unsupported";

export type DependencyResolutionIssue =
  | "package-manager-unsupported"
  | "lockfile-not-found"
  | "dependency-not-found"
  | "specifier-mismatch"
  | "invalid-entry"
  | "unrecognized-reference";

export interface InstalledDependencyResolution {
  dependency: string;
  dependencyType: DependencyType;
  declaredVersion: string;
  lockfileSpecifier?: string;
  resolvedVersion?: string;
  resolvedReference?: string;
  kind: DependencyResolutionKind;
  status: DependencyResolutionStatus;
  issue?: DependencyResolutionIssue;
  workspaceRoot?: string;
  lockfilePath?: string;
  importer?: string;
}

export interface DependencyResolutionRequest {
  projectPath: string;
  packageManager: PackageManager;
  dependencies: DependencyInfo[];
}

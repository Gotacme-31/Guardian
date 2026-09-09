import type { InstalledDependencyResolution } from "./dependency-resolution/types.js";

export type PackageManager = "pnpm" | "npm" | "yarn" | "unknown";

export type DependencyType = "dependency" | "devDependency";

export interface DependencyInfo {
  name: string;
  declaredVersion: string;
  type: DependencyType;
}

export type ImportKind = "es-import" | "require" | "dynamic-import";

export interface ImportSymbolBinding {
  importedSymbol: string;
  localBinding: string;
}

export interface ImportUsage {
  file: string;
  source: string;
  importedSymbols: string[];
  symbolBindings?: ImportSymbolBinding[];
  defaultImport?: string;
  namespaceImport?: string;
  kind: ImportKind;
}

export type SymbolUsageKind = "call" | "member-access" | "constructor" | "reference";

export interface SymbolUsage {
  dependency: string;
  file: string;
  importedSymbol?: string;
  localBinding: string;
  usagePath: string;
  kind: SymbolUsageKind;
  line: number;
  column: number;
}

export interface DependencyUsage {
  dependency: string;
  files: string[];
  importCount: number;
  imports: ImportUsage[];
  symbolUsages: SymbolUsage[];
}

export interface ProjectScanResult {
  projectPath: string;
  projectName: string;
  projectType: {
    node: boolean;
    typescript: boolean;
  };
  packageManager: PackageManager;
  dependencies: DependencyInfo[];
  devDependencies: DependencyInfo[];
  dependencyUsage: DependencyUsage[];
  dependencyResolutions: InstalledDependencyResolution[];
}

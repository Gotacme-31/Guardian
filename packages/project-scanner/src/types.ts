export type PackageManager = "pnpm" | "npm" | "yarn" | "unknown";

export type DependencyType = "dependency" | "devDependency";

export interface DependencyInfo {
  name: string;
  declaredVersion: string;
  type: DependencyType;
}

export type ImportKind = "es-import" | "require" | "dynamic-import";

export interface ImportUsage {
  file: string;
  source: string;
  importedSymbols: string[];
  defaultImport?: string;
  namespaceImport?: string;
  kind: ImportKind;
}

export interface DependencyUsage {
  dependency: string;
  files: string[];
  importCount: number;
  imports: ImportUsage[];
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
}

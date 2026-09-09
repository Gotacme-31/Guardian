import type { InstalledDependencyResolution } from "../dependency-resolution/types.js";
import type {
  DependencyType,
  ImportKind,
  ImportUsage,
  SymbolUsage,
} from "../types.js";

export interface DependencyDeclarationContext {
  type: DependencyType;
  declaredVersion: string;
}

export type ImportedBindingKind = "default" | "named" | "namespace" | "module";

export interface ImportedSymbolSummary {
  importedSymbol?: string;
  localBinding: string;
  bindingKind: ImportedBindingKind;
  importKind: ImportKind;
  files: string[];
}

export type ApiUsageEvidence =
  | "direct-import"
  | "namespace-member"
  | "constructor-instance"
  | "require-binding"
  | "dynamic-import"
  | "unattributed";

export interface ApiUsageSummary {
  canonicalPath?: string;
  localUsagePaths: string[];
  occurrenceCount: number;
  evidence: ApiUsageEvidence[];
  occurrences: SymbolUsage[];
}

export interface DependencyUsageContext {
  used: boolean;
  files: string[];
  imports: ImportUsage[];
  importedSymbols: ImportedSymbolSummary[];
  apiUsages: ApiUsageSummary[];
}

export interface DependencyContext {
  dependency: string;
  declaration: DependencyDeclarationContext;
  resolution: InstalledDependencyResolution;
  usage: DependencyUsageContext;
}

import type {
  DependencyInfo,
  ImportUsage,
  ProjectScanResult,
  SymbolUsage,
} from "../types.js";
import type {
  ApiUsageEvidence,
  ApiUsageSummary,
  DependencyContext,
  DependencyUsageContext,
  ImportedBindingKind,
  ImportedSymbolSummary,
} from "./types.js";

interface NormalizedOccurrence {
  canonicalPath?: string;
  localUsagePath: string;
  evidence: ApiUsageEvidence;
  occurrence: SymbolUsage;
}

function compareImports(left: ImportUsage, right: ImportUsage): number {
  return left.file.localeCompare(right.file)
    || left.kind.localeCompare(right.kind)
    || left.source.localeCompare(right.source)
    || (left.defaultImport ?? "").localeCompare(right.defaultImport ?? "")
    || (left.namespaceImport ?? "").localeCompare(right.namespaceImport ?? "")
    || [...left.importedSymbols].sort().join("\0")
      .localeCompare([...right.importedSymbols].sort().join("\0"))
    || [...(left.symbolBindings ?? [])]
      .sort((a, b) => a.importedSymbol.localeCompare(b.importedSymbol)
        || a.localBinding.localeCompare(b.localBinding))
      .map((binding) => `${binding.importedSymbol}\0${binding.localBinding}`)
      .join("\0")
      .localeCompare([...(right.symbolBindings ?? [])]
        .sort((a, b) => a.importedSymbol.localeCompare(b.importedSymbol)
          || a.localBinding.localeCompare(b.localBinding))
        .map((binding) => `${binding.importedSymbol}\0${binding.localBinding}`)
        .join("\0"));
}

function compareOccurrences(left: SymbolUsage, right: SymbolUsage): number {
  return left.file.localeCompare(right.file)
    || left.line - right.line
    || left.column - right.column
    || left.usagePath.localeCompare(right.usagePath)
    || left.kind.localeCompare(right.kind);
}

function normalizeImportUsage(importUsage: ImportUsage): ImportUsage {
  const symbolBindings = importUsage.symbolBindings === undefined
    ? undefined
    : [...importUsage.symbolBindings].sort((left, right) =>
      left.importedSymbol.localeCompare(right.importedSymbol)
      || left.localBinding.localeCompare(right.localBinding));
  return {
    ...importUsage,
    importedSymbols: [...importUsage.importedSymbols].sort(),
    ...(symbolBindings === undefined ? {} : { symbolBindings }),
  };
}

function replacePathRoot(usagePath: string, replacement: string): string {
  const separator = usagePath.indexOf(".");
  return separator === -1 ? replacement : `${replacement}${usagePath.slice(separator)}`;
}

function pathRoot(usagePath: string): string {
  const separator = usagePath.indexOf(".");
  return separator === -1 ? usagePath : usagePath.slice(0, separator);
}

function localUsagePath(usage: SymbolUsage): string {
  return usage.importedSymbol !== undefined && pathRoot(usage.usagePath) === usage.importedSymbol
    ? replacePathRoot(usage.usagePath, usage.localBinding)
    : usage.usagePath;
}

function evidenceForImport(importUsage: ImportUsage, namespace: boolean): ApiUsageEvidence {
  if (importUsage.kind === "require") {
    return "require-binding";
  }
  if (importUsage.kind === "dynamic-import") {
    return "dynamic-import";
  }
  return namespace ? "namespace-member" : "direct-import";
}

function evidenceForImports(
  imports: ImportUsage[],
  namespace: boolean,
): ApiUsageEvidence {
  const evidence = new Set(imports.map((item) => evidenceForImport(item, namespace)));
  return evidence.size === 1 ? [...evidence][0] as ApiUsageEvidence : "unattributed";
}

function canonicalPathForImports(
  imports: ImportUsage[],
  dependency: string,
  canonicalPath: string,
): string | undefined {
  const sources = [...new Set(imports.map((item) => item.source))];
  if (sources.length !== 1) {
    return undefined;
  }
  const [source] = sources;
  return source === dependency ? canonicalPath : `${source}#${canonicalPath}`;
}

function normalizeOccurrence(
  usage: SymbolUsage,
  imports: ImportUsage[],
): NormalizedOccurrence {
  const importsInFile = imports.filter((item) => item.file === usage.file);
  const localPath = localUsagePath(usage);

  if (usage.importedSymbol !== undefined) {
    const matchingImports = importsInFile.filter((item) =>
      item.symbolBindings?.some((binding) =>
        binding.importedSymbol === usage.importedSymbol
        && binding.localBinding === usage.localBinding)
      || (usage.importedSymbol === usage.localBinding
        && item.importedSymbols.includes(usage.importedSymbol)));
    if (matchingImports.length > 0 && pathRoot(usage.usagePath) === usage.importedSymbol) {
      const canonicalPath = canonicalPathForImports(
        matchingImports,
        usage.dependency,
        usage.usagePath,
      );
      return {
        ...(canonicalPath === undefined ? {} : { canonicalPath }),
        localUsagePath: localPath,
        evidence: evidenceForImports(matchingImports, false),
        occurrence: usage,
      };
    }
    return {
      localUsagePath: localPath,
      evidence: pathRoot(usage.usagePath) === usage.localBinding
        ? "constructor-instance"
        : "unattributed",
      occurrence: usage,
    };
  }

  const defaultImports = importsInFile.filter((item) =>
    item.defaultImport === usage.localBinding);
  if (defaultImports.length > 0) {
    const canonicalPath = defaultImports.every((item) => item.kind === "es-import")
      ? canonicalPathForImports(
        defaultImports,
        usage.dependency,
        replacePathRoot(usage.usagePath, "default"),
      )
      : undefined;
    return {
      ...(canonicalPath === undefined ? {} : { canonicalPath }),
      localUsagePath: localPath,
      evidence: evidenceForImports(defaultImports, false),
      occurrence: usage,
    };
  }

  const namespaceImports = importsInFile.filter((item) =>
    item.namespaceImport === usage.localBinding);
  if (namespaceImports.length > 0) {
    const canonicalPath = canonicalPathForImports(
      namespaceImports,
      usage.dependency,
      replacePathRoot(usage.usagePath, "namespace"),
    );
    return {
      ...(canonicalPath === undefined ? {} : { canonicalPath }),
      localUsagePath: localPath,
      evidence: evidenceForImports(namespaceImports, true),
      occurrence: usage,
    };
  }

  return {
    localUsagePath: localPath,
    evidence: "unattributed",
    occurrence: usage,
  };
}

function buildImportedSymbols(imports: ImportUsage[]): ImportedSymbolSummary[] {
  const summaries = new Map<string, {
    importedSymbol?: string;
    localBinding: string;
    bindingKind: ImportedBindingKind;
    importKind: ImportUsage["kind"];
    files: Set<string>;
  }>();

  function add(
    item: ImportUsage,
    localBinding: string,
    bindingKind: ImportedBindingKind,
    importedSymbol?: string,
  ): void {
    const key = [item.kind, bindingKind, importedSymbol ?? "", localBinding].join("\0");
    const existing = summaries.get(key) ?? {
      ...(importedSymbol === undefined ? {} : { importedSymbol }),
      localBinding,
      bindingKind,
      importKind: item.kind,
      files: new Set<string>(),
    };
    existing.files.add(item.file);
    summaries.set(key, existing);
  }

  for (const item of imports) {
    if (item.defaultImport !== undefined) {
      add(
        item,
        item.defaultImport,
        item.kind === "require" ? "module" : "default",
        item.kind === "require" ? undefined : "default",
      );
    }
    if (item.namespaceImport !== undefined) {
      add(item, item.namespaceImport, "namespace", "*");
    }
    if (item.symbolBindings !== undefined) {
      for (const binding of item.symbolBindings) {
        add(item, binding.localBinding, "named", binding.importedSymbol);
      }
    } else {
      for (const importedSymbol of item.importedSymbols) {
        add(item, importedSymbol, "named", importedSymbol);
      }
    }
  }

  return [...summaries.values()].map((summary) => ({
    ...(summary.importedSymbol === undefined
      ? {}
      : { importedSymbol: summary.importedSymbol }),
    localBinding: summary.localBinding,
    bindingKind: summary.bindingKind,
    importKind: summary.importKind,
    files: [...summary.files].sort(),
  })).sort((left, right) =>
    (left.importedSymbol ?? "").localeCompare(right.importedSymbol ?? "")
    || left.localBinding.localeCompare(right.localBinding)
    || left.importKind.localeCompare(right.importKind)
    || left.bindingKind.localeCompare(right.bindingKind)
    || left.files.join("\0").localeCompare(right.files.join("\0")));
}

function buildApiUsages(
  symbolUsages: SymbolUsage[],
  imports: ImportUsage[],
): ApiUsageSummary[] {
  const summaries = new Map<string, {
    canonicalPath?: string;
    localUsagePaths: Set<string>;
    evidence: Set<ApiUsageEvidence>;
    occurrences: SymbolUsage[];
  }>();

  for (const symbolUsage of symbolUsages) {
    const normalized = normalizeOccurrence(symbolUsage, imports);
    const key = normalized.canonicalPath === undefined
      ? [
        "local",
        normalized.occurrence.importedSymbol ?? "",
        normalized.localUsagePath,
        normalized.occurrence.file,
        normalized.occurrence.localBinding,
      ].join("\0")
      : `canonical\0${normalized.canonicalPath}`;
    const existing = summaries.get(key) ?? {
      ...(normalized.canonicalPath === undefined
        ? {}
        : { canonicalPath: normalized.canonicalPath }),
      localUsagePaths: new Set<string>(),
      evidence: new Set<ApiUsageEvidence>(),
      occurrences: [],
    };
    existing.localUsagePaths.add(normalized.localUsagePath);
    existing.evidence.add(normalized.evidence);
    existing.occurrences.push(normalized.occurrence);
    summaries.set(key, existing);
  }

  return [...summaries.values()].map((summary) => ({
    ...(summary.canonicalPath === undefined ? {} : { canonicalPath: summary.canonicalPath }),
    localUsagePaths: [...summary.localUsagePaths].sort(),
    occurrenceCount: summary.occurrences.length,
    evidence: [...summary.evidence].sort(),
    occurrences: [...summary.occurrences].sort(compareOccurrences),
  })).sort((left, right) =>
    (left.canonicalPath ?? left.localUsagePaths[0] ?? "")
      .localeCompare(right.canonicalPath ?? right.localUsagePaths[0] ?? "")
    || left.localUsagePaths.join("\0").localeCompare(right.localUsagePaths.join("\0"))
    || left.evidence.join("\0").localeCompare(right.evidence.join("\0"))
    || compareOccurrences(
      left.occurrences[0] as SymbolUsage,
      right.occurrences[0] as SymbolUsage,
    ));
}

function resolutionKey(dependency: string, type: DependencyInfo["type"]): string {
  return `${dependency}\0${type}`;
}

export function buildDependencyContexts(scan: ProjectScanResult): DependencyContext[] {
  const usages = new Map(scan.dependencyUsage.map((usage) => [usage.dependency, usage]));
  const resolutions = new Map(scan.dependencyResolutions.map((resolution) => [
    resolutionKey(resolution.dependency, resolution.dependencyType),
    resolution,
  ]));
  const declarations = [...scan.dependencies, ...scan.devDependencies].sort((left, right) =>
    left.name.localeCompare(right.name) || left.type.localeCompare(right.type));

  return declarations.map((declaration) => {
    const resolution = resolutions.get(resolutionKey(declaration.name, declaration.type));
    if (resolution === undefined) {
      throw new Error(`Missing dependency resolution for "${declaration.name}".`);
    }

    const dependencyUsage = usages.get(declaration.name);
    const imports = (dependencyUsage?.imports ?? [])
      .map(normalizeImportUsage)
      .sort(compareImports);
    const symbolUsages = dependencyUsage?.symbolUsages ?? [];
    const usage: DependencyUsageContext = {
      used: imports.length > 0 || symbolUsages.length > 0,
      files: [...new Set([
        ...(dependencyUsage?.files ?? []),
        ...imports.map((item) => item.file),
        ...symbolUsages.map((item) => item.file),
      ])].sort(),
      imports,
      importedSymbols: buildImportedSymbols(imports),
      apiUsages: buildApiUsages(symbolUsages, imports),
    };

    return {
      dependency: declaration.name,
      declaration: {
        type: declaration.type,
        declaredVersion: declaration.declaredVersion,
      },
      resolution,
      usage,
    };
  });
}

export function findDependencyContext(
  contexts: DependencyContext[],
  dependency: string,
): DependencyContext | undefined {
  return contexts.find((context) => context.dependency === dependency);
}

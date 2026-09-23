import type { ApiUsageSummary, DependencyContext } from "../dependency-context/types.js";
import {
  conditionPathIdentity,
  entrypointIdentity,
  memberRole,
} from "../declaration-diff/index.js";
import type {
  EntrypointChange,
  ExportChange,
  MemberChange,
  PackageDeclarationSurfaceDiff,
} from "../declaration-diff/types.js";
import type { PackageDeclarationSurface } from "../declaration-surface/types.js";
import type { ImportUsage, SymbolUsage } from "../types.js";
import { parseCanonicalRest, resolveRoot, type ExportChainResolution, type ResolvedLeaf } from "./translate.js";
import {
  UsageImpactCorrelationError,
  type DependencyUsageImpact,
  type UsageCorrelationIssue,
  type UsageImpact,
  type UsageImpactStatus,
  type UsageImpactSummary,
} from "./types.js";

type MatchedChange = ExportChange | MemberChange;

interface VariantOutcome {
  readonly status: UsageImpactStatus;
  readonly declarationPath?: readonly string[];
  readonly matchedChanges: readonly MatchedChange[];
  readonly issues: readonly UsageCorrelationIssue[];
}

const STATUS_PRIORITY: Record<UsageImpactStatus, number> = {
  affected: 3,
  indeterminate: 2,
  unaffected: 1,
  unresolved: 0,
};

function importsMatchingOccurrence(
  occurrence: SymbolUsage,
  imports: readonly ImportUsage[],
): readonly ImportUsage[] {
  const inFile = imports.filter((item) => item.file === occurrence.file);
  if (occurrence.importedSymbol !== undefined) {
    return inFile.filter((item) =>
      item.symbolBindings?.some((binding) =>
        binding.importedSymbol === occurrence.importedSymbol
        && binding.localBinding === occurrence.localBinding)
      || (item.symbolBindings === undefined
        && occurrence.importedSymbol === occurrence.localBinding
        && item.importedSymbols.includes(occurrence.importedSymbol)));
  }
  const defaultMatches = inFile.filter((item) => item.defaultImport === occurrence.localBinding);
  if (defaultMatches.length > 0) {
    return defaultMatches;
  }
  return inFile.filter((item) => item.namespaceImport === occurrence.localBinding);
}

/**
 * M3's ApiUsageSummary does not expose the raw import specifier directly; it is folded into
 * `canonicalPath` (as a "source#" prefix) once `buildApiUsages` has already validated it is
 * unique per usage group. M8 re-derives it independently by cross-referencing each occurrence
 * against `DependencyUsageContext.imports`, mirroring M3's own matching (named/default/namespace
 * binding lookup), rather than parsing the canonicalPath string, so it stays correct even if a
 * usage group's occurrences span multiple files.
 */
export function deriveSource(
  usage: ApiUsageSummary,
  imports: readonly ImportUsage[],
): string | undefined {
  const sources = new Set<string>();
  for (const occurrence of usage.occurrences) {
    const matches = importsMatchingOccurrence(occurrence, imports);
    if (matches.length === 0) {
      return undefined;
    }
    for (const match of matches) {
      sources.add(match.source);
    }
  }
  return sources.size === 1 ? [...sources][0] : undefined;
}

export function deriveExportPath(source: string, dependency: string): string | undefined {
  if (source === dependency) {
    return ".";
  }
  const prefix = `${dependency}/`;
  return source.startsWith(prefix) ? `./${source.slice(prefix.length)}` : undefined;
}

function indexEntrypointChanges(
  diff: PackageDeclarationSurfaceDiff,
): Map<string, EntrypointChange> {
  const map = new Map<string, EntrypointChange>();
  for (const change of diff.entrypointChanges) {
    map.set(entrypointIdentity(change.exportPath, change.conditionPath), change);
  }
  return map;
}

const exportChangeIndexCache = new WeakMap<EntrypointChange, Map<string, ExportChange[]>>();

function flattenExportChanges(
  changes: readonly ExportChange[],
  index: Map<string, ExportChange[]>,
): void {
  for (const change of changes) {
    const key = JSON.stringify([change.declarationPath, change.facetPath]);
    const bucket = index.get(key);
    if (bucket === undefined) {
      index.set(key, [change]);
    } else {
      bucket.push(change);
    }
    if (change.type === "export-modified") {
      flattenExportChanges(change.nestedExportChanges, index);
    }
  }
}

function exportChangeIndex(entrypointChange: EntrypointChange): Map<string, ExportChange[]> {
  const cached = exportChangeIndexCache.get(entrypointChange);
  if (cached !== undefined) {
    return cached;
  }
  const index = new Map<string, ExportChange[]>();
  flattenExportChanges(entrypointChange.exportChanges, index);
  exportChangeIndexCache.set(entrypointChange, index);
  return index;
}

function memberChangeMatches(change: MemberChange, target: NonNullable<ResolvedLeaf["member"]>): boolean {
  if (change.type === "member-modified") {
    return change.name === target.name
      && change.static === target.static
      && change.role === target.role;
  }
  return change.member.name === target.name
    && change.member.static === target.static
    && memberRole(change.member) === target.role;
}

function changesForLeaf(
  leaf: ResolvedLeaf,
  index: Map<string, ExportChange[]>,
): MatchedChange[] {
  const key = JSON.stringify([leaf.declarationPath, leaf.facetPath]);
  const exportMatches = index.get(key) ?? [];
  if (leaf.member === undefined) {
    return [...exportMatches];
  }
  const member = leaf.member;
  const results: MatchedChange[] = [];
  for (const change of exportMatches) {
    if (change.type !== "export-modified") {
      results.push(change);
      continue;
    }
    for (const memberChange of change.memberChanges) {
      if (memberChangeMatches(memberChange, member)) {
        results.push(memberChange);
      }
    }
  }
  return results;
}

function isVariantIndeterminate(
  diff: PackageDeclarationSurfaceDiff,
  exportPath: string,
  conditionPath: readonly string[],
): boolean {
  return diff.comparisonIssues.some((issue) =>
    issue.code === "indeterminate-package-comparison"
    || (issue.code === "indeterminate-entrypoint-comparison"
      && issue.exportPath === exportPath
      && (issue.conditionPath === undefined
        || conditionPathIdentity(issue.conditionPath) === conditionPathIdentity(conditionPath))));
}

function issueKey(issue: UsageCorrelationIssue): string {
  return JSON.stringify([issue.code, issue.canonicalPath ?? null, issue.message]);
}

function dedupeIssues(issues: readonly UsageCorrelationIssue[]): UsageCorrelationIssue[] {
  const seen = new Map<string, UsageCorrelationIssue>();
  for (const issue of issues) {
    const key = issueKey(issue);
    if (!seen.has(key)) {
      seen.set(key, issue);
    }
  }
  return [...seen.values()];
}

function dedupeChanges(changes: readonly MatchedChange[]): MatchedChange[] {
  const seen = new Set<MatchedChange>();
  const result: MatchedChange[] = [];
  for (const change of changes) {
    if (!seen.has(change)) {
      seen.add(change);
      result.push(change);
    }
  }
  return result;
}

function resolveLeafOutcome(
  resolution: ExportChainResolution,
  index: Map<string, ExportChange[]>,
): {
  status: UsageImpactStatus;
  declarationPath?: readonly string[];
  matchedChanges: MatchedChange[];
} {
  const matchedChanges = resolution.leaves.flatMap((leaf) => changesForLeaf(leaf, index));
  const hasAmbiguousOrUnresolvable = resolution.issues.some((issue) =>
    issue.code === "ambiguous-facet-correlation"
    || issue.code === "ambiguous-member-correlation"
    || issue.code === "unresolvable-member-access");
  const firstLeaf = resolution.leaves[0];
  if (hasAmbiguousOrUnresolvable) {
    return {
      status: "indeterminate",
      matchedChanges,
      ...(firstLeaf === undefined ? {} : { declarationPath: firstLeaf.declarationPath }),
    };
  }
  if (firstLeaf === undefined) {
    return { status: "unresolved", matchedChanges };
  }
  return {
    status: matchedChanges.length > 0 ? "affected" : "unaffected",
    declarationPath: firstLeaf.declarationPath,
    matchedChanges,
  };
}

function correlateVariant(
  conditionPath: readonly string[],
  exportPath: string,
  canonicalPath: string,
  resolution: ExportChainResolution,
  diff: PackageDeclarationSurfaceDiff,
  entrypointChangeMap: Map<string, EntrypointChange>,
): VariantOutcome {
  if (isVariantIndeterminate(diff, exportPath, conditionPath)) {
    const firstLeaf = resolution.leaves[0];
    return {
      status: "indeterminate",
      matchedChanges: [],
      issues: [
        ...resolution.issues,
        {
          code: "indeterminate-source-comparison",
          message:
            `Entrypoint "${exportPath}" (condition ${JSON.stringify(conditionPath)}) could not `
            + "be compared conclusively because surface extraction was incomplete.",
          canonicalPath,
        },
      ],
      ...(firstLeaf === undefined ? {} : { declarationPath: firstLeaf.declarationPath }),
    };
  }

  const entrypointChange = entrypointChangeMap.get(entrypointIdentity(exportPath, conditionPath));
  const index = entrypointChange === undefined
    ? new Map<string, ExportChange[]>()
    : exportChangeIndex(entrypointChange);
  const outcome = resolveLeafOutcome(resolution, index);
  return {
    status: outcome.status,
    matchedChanges: outcome.matchedChanges,
    issues: resolution.issues,
    ...(outcome.declarationPath === undefined ? {} : { declarationPath: outcome.declarationPath }),
  };
}

function combineVariants(variants: readonly VariantOutcome[]): {
  status: UsageImpactStatus;
  declarationPath?: readonly string[];
  matchedChanges: MatchedChange[];
  issues: UsageCorrelationIssue[];
} {
  let winner: VariantOutcome | undefined;
  for (const variant of variants) {
    if (winner === undefined || STATUS_PRIORITY[variant.status] > STATUS_PRIORITY[winner.status]) {
      winner = variant;
    }
  }
  const matchedChanges = dedupeChanges(variants.flatMap((variant) => variant.matchedChanges));
  const issues = dedupeIssues(variants.flatMap((variant) => variant.issues));
  return {
    status: winner?.status ?? "unresolved",
    matchedChanges,
    issues,
    ...(winner?.declarationPath === undefined ? {} : { declarationPath: winner.declarationPath }),
  };
}

function correlateSingleUsage(
  usage: ApiUsageSummary,
  dependency: string,
  imports: readonly ImportUsage[],
  installedSurface: PackageDeclarationSurface,
  diff: PackageDeclarationSurfaceDiff,
  entrypointChangeMap: Map<string, EntrypointChange>,
): UsageImpact {
  if (usage.canonicalPath === undefined) {
    return {
      usage,
      status: "unresolved",
      matchedChanges: [],
      issues: [{
        code: "no-canonical-path",
        message: "Usage evidence was insufficient to derive a canonical API path.",
      }],
    };
  }
  const canonicalPath = usage.canonicalPath;

  const source = deriveSource(usage, imports);
  if (source === undefined) {
    return {
      usage,
      status: "unresolved",
      matchedChanges: [],
      issues: [{
        code: "entrypoint-not-found",
        message:
          `Could not uniquely determine the import specifier behind canonical path `
          + `"${canonicalPath}" from the recorded imports.`,
        canonicalPath,
      }],
    };
  }

  const exportPath = deriveExportPath(source, dependency);
  if (exportPath === undefined) {
    return {
      usage,
      status: "unresolved",
      matchedChanges: [],
      issues: [{
        code: "entrypoint-not-found",
        message: `Import specifier "${source}" does not resolve under dependency "${dependency}".`,
        canonicalPath,
      }],
    };
  }

  const matchingEntrypoints = installedSurface.entrypoints.filter((entrypoint) =>
    entrypoint.exportPath === exportPath);
  if (matchingEntrypoints.length === 0) {
    return {
      usage,
      status: "unresolved",
      exportPath,
      matchedChanges: [],
      issues: [{
        code: "entrypoint-not-found",
        message: `No entrypoint "${exportPath}" exists in the installed declaration surface.`,
        canonicalPath,
      }],
    };
  }

  const parsed = parseCanonicalRest(canonicalPath.includes("#")
    ? canonicalPath.slice(canonicalPath.indexOf("#") + 1)
    : canonicalPath);

  if (parsed.bareNamespaceReference) {
    return {
      usage,
      status: "indeterminate",
      exportPath,
      declarationPath: [],
      matchedChanges: [],
      issues: [{
        code: "unresolvable-member-access",
        message:
          `Canonical path "${canonicalPath}" references the whole namespace-import object, `
          + "which has no single exportedName to correlate against.",
        canonicalPath,
      }],
    };
  }

  const variants: VariantOutcome[] = [];
  for (const entrypoint of matchingEntrypoints) {
    const resolution = resolveRoot(entrypoint.exports, parsed, canonicalPath);
    for (const conditionPath of entrypoint.conditionPaths) {
      variants.push(correlateVariant(
        conditionPath,
        exportPath,
        canonicalPath,
        resolution,
        diff,
        entrypointChangeMap,
      ));
    }
  }

  const combined = combineVariants(variants);
  return {
    usage,
    status: combined.status,
    exportPath,
    matchedChanges: combined.matchedChanges,
    issues: combined.issues,
    ...(combined.declarationPath === undefined ? {} : { declarationPath: combined.declarationPath }),
  };
}

function summarize(impacts: readonly UsageImpact[]): UsageImpactSummary {
  const summary = { affected: 0, unaffected: 0, unresolved: 0, indeterminate: 0 };
  for (const impact of impacts) {
    summary[impact.status] += 1;
  }
  return summary;
}

export function correlateUsageImpact(
  context: DependencyContext,
  installedSurface: PackageDeclarationSurface,
  diff: PackageDeclarationSurfaceDiff,
): DependencyUsageImpact {
  if (
    context.dependency !== installedSurface.packageName
    || context.dependency !== diff.packageName
  ) {
    throw new UsageImpactCorrelationError(
      "package-mismatch",
      context.dependency,
      installedSurface.packageName,
      diff.packageName,
      installedSurface.version,
      diff.beforeVersion,
    );
  }
  if (installedSurface.version !== diff.beforeVersion) {
    throw new UsageImpactCorrelationError(
      "version-mismatch",
      context.dependency,
      installedSurface.packageName,
      diff.packageName,
      installedSurface.version,
      diff.beforeVersion,
    );
  }

  const entrypointChangeMap = indexEntrypointChanges(diff);
  const imports = context.usage.imports;
  const impacts = context.usage.apiUsages.map((usage) => correlateSingleUsage(
    usage,
    context.dependency,
    imports,
    installedSurface,
    diff,
    entrypointChangeMap,
  ));

  return {
    dependency: context.dependency,
    beforeVersion: diff.beforeVersion,
    afterVersion: diff.afterVersion,
    impacts,
    summary: summarize(impacts),
  };
}

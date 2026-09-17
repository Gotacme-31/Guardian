import type {
  DeclarationEntrypoint,
  DeclarationSurfaceIssue,
  PackageDeclarationSurface,
  PublicApiDeclaration,
  PublicApiMember,
  ReferencedApiDeclaration,
} from "../declaration-surface/types.js";
import {
  compareText,
  conditionPathIdentity,
  declarationIdentity,
  entrypointIdentity,
  memberIdentity,
  memberRole,
  uniqueSorted,
} from "./identity.js";
import type {
  ComparisonIssueCode,
  DeclarationComparisonErrorCode,
  DeclarationComparisonIssue,
  DeclarationDiffSide,
  DeclarationPropertyChange,
  DeclarationPropertyName,
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

interface EntrypointVariant {
  exportPath: string;
  conditionPath: readonly string[];
  declarationFile: string;
  exports: readonly PublicApiDeclaration[];
  referencedDeclarations: readonly ReferencedApiDeclaration[];
}

interface PublicPairTemplate {
  basePath: readonly string[];
  baseFacetPath: readonly number[];
  change?: Extract<ExportChange, { type: "export-modified" }>;
  provenanceChanges: readonly ProvenanceChange[];
  issues: readonly DeclarationComparisonIssue[];
  height: number;
}

interface ReferencedPairTemplate {
  basePath: readonly string[];
  baseFacetPath: readonly number[];
  change?: Extract<ReferencedDeclarationChange, { type: "referenced-declaration-modified" }>;
  provenanceChanges: readonly ProvenanceChange[];
  issues: readonly DeclarationComparisonIssue[];
  height: number;
}

interface ComparisonContext {
  exportPath: string;
  conditionPath: readonly string[];
  issues: Map<string, DeclarationComparisonIssue>;
  provenanceChanges: ProvenanceChange[];
  publicPairs: WeakMap<PublicApiDeclaration, WeakMap<PublicApiDeclaration, "active" | PublicPairTemplate>>;
  referencedPairs: WeakMap<ReferencedApiDeclaration, WeakMap<ReferencedApiDeclaration, "active" | ReferencedPairTemplate>>;
  publicValidation: Record<DeclarationDiffSide, WeakMap<PublicApiDeclaration, "active" | number>>;
  referencedValidation: Record<DeclarationDiffSide, WeakMap<ReferencedApiDeclaration, "active" | number>>;
  publicNormalization: WeakMap<PublicApiDeclaration, PublicApiDeclaration>;
  referencedNormalization: WeakMap<ReferencedApiDeclaration, ReferencedApiDeclaration>;
  publicHeights: WeakMap<PublicApiDeclaration, number>;
  referencedHeights: WeakMap<ReferencedApiDeclaration, number>;
}

const MAX_COMPARISON_DEPTH = 256;

const BLOCKING_ISSUE_CODES = new Set<DeclarationSurfaceIssue["code"]>([
  "package-json-missing",
  "package-json-invalid",
  "declaration-entrypoint-missing",
  "declaration-file-missing",
  "declaration-file-invalid",
  "declaration-path-invalid",
  "declaration-path-escape",
  "unsupported-export-conditions",
  "unsupported-export-pattern",
  "unsupported-types-versions",
  "unresolved-reexport",
  "ambiguous-star-reexport",
  "reexport-cycle",
  "unsupported-declaration",
  "analysis-limit-exceeded",
]);

export class DeclarationSurfaceComparisonError extends Error {
  readonly code: DeclarationComparisonErrorCode;
  readonly beforePackageName: string;
  readonly afterPackageName: string;

  constructor(beforePackageName: string, afterPackageName: string) {
    super(
      `Cannot compare declaration surfaces for "${beforePackageName}" and "${afterPackageName}".`,
    );
    this.name = "DeclarationSurfaceComparisonError";
    this.code = "package-mismatch";
    this.beforePackageName = beforePackageName;
    this.afterPackageName = afterPackageName;
  }
}

function groupedBy<T>(items: readonly T[], keyFor: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [item]);
    } else {
      group.push(item);
    }
  }
  return groups;
}

function sortedUnion(left: Iterable<string>, right: Iterable<string>): string[] {
  return [...new Set([...left, ...right])].sort(compareText);
}

function issueIdentity(issue: DeclarationComparisonIssue): string {
  return JSON.stringify([
    issue.code,
    issue.side ?? null,
    issue.exportPath ?? null,
    issue.conditionPath ?? null,
    issue.declarationPath ?? null,
    issue.facet ?? null,
    issue.facetPath ?? null,
    issue.memberName ?? null,
    issue.memberStatic ?? null,
    issue.memberRole ?? null,
    issue.sourceIssueCodes ?? null,
  ]);
}

function addComparisonIssue(
  issues: Map<string, DeclarationComparisonIssue>,
  issue: DeclarationComparisonIssue,
): void {
  issues.set(issueIdentity(issue), issue);
}

function pairTraversalState<T extends object, TTemplate>(
  states: WeakMap<T, WeakMap<T, "active" | TTemplate>>,
  before: T,
  after: T,
): "new" | "active" | TTemplate {
  const afterStates = states.get(before);
  const state = afterStates?.get(after);
  if (state !== undefined) {
    return state;
  }
  const createdAfterStates = afterStates
    ?? new WeakMap<T, "active" | TTemplate>();
  createdAfterStates.set(after, "active");
  if (afterStates === undefined) {
    states.set(before, createdAfterStates);
  }
  return "new";
}

function completePairTraversal<T extends object, TTemplate>(
  states: WeakMap<T, WeakMap<T, "active" | TTemplate>>,
  before: T,
  after: T,
  template: TTemplate,
): void {
  states.get(before)?.set(after, template);
}

function discardPairTraversal<T extends object, TTemplate>(
  states: WeakMap<T, WeakMap<T, "active" | TTemplate>>,
  before: T,
  after: T,
): void {
  states.get(before)?.delete(after);
}

function declarationGraphHeight<T extends object>(
  declaration: T,
  children: (item: T) => readonly T[],
  cache: WeakMap<T, number>,
  active: WeakSet<T> = new WeakSet(),
): number {
  const cached = cache.get(declaration);
  if (cached !== undefined) {
    return cached;
  }
  if (active.has(declaration)) {
    return 0;
  }
  active.add(declaration);
  let height = 0;
  for (const child of children(declaration)) {
    height = Math.max(
      height,
      Math.min(MAX_COMPARISON_DEPTH, declarationGraphHeight(child, children, cache, active) + 1),
    );
  }
  active.delete(declaration);
  cache.set(declaration, height);
  return height;
}

function replacePrefix<T>(
  values: readonly T[],
  beforePrefix: readonly T[],
  afterPrefix: readonly T[],
): T[] {
  return [...afterPrefix, ...values.slice(beforePrefix.length)];
}

function rebaseExportChange(
  change: ExportChange,
  beforePath: readonly string[],
  afterPath: readonly string[],
  beforeFacetPath: readonly number[],
  afterFacetPath: readonly number[],
): ExportChange {
  const declarationPath = replacePrefix(change.declarationPath, beforePath, afterPath);
  const facetPath = replacePrefix(change.facetPath, beforeFacetPath, afterFacetPath);
  return change.type === "export-modified"
    ? {
      ...change,
      declarationPath,
      facetPath,
      nestedExportChanges: change.nestedExportChanges.map((nested) =>
        rebaseExportChange(
          nested,
          beforePath,
          afterPath,
          beforeFacetPath,
          afterFacetPath,
        )),
    }
    : { ...change, declarationPath, facetPath };
}

function rebaseReferencedChange(
  change: ReferencedDeclarationChange,
  beforePath: readonly string[],
  afterPath: readonly string[],
  beforeFacetPath: readonly number[],
  afterFacetPath: readonly number[],
): ReferencedDeclarationChange {
  const declarationPath = replacePrefix(change.declarationPath, beforePath, afterPath);
  const facetPath = replacePrefix(change.facetPath, beforeFacetPath, afterFacetPath);
  return change.type === "referenced-declaration-modified"
    ? {
      ...change,
      declarationPath,
      facetPath,
      nestedDeclarationChanges: change.nestedDeclarationChanges.map((nested) =>
        rebaseReferencedChange(
          nested,
          beforePath,
          afterPath,
          beforeFacetPath,
          afterFacetPath,
        )),
    }
    : { ...change, declarationPath, facetPath };
}

function rebaseProvenanceChange(
  change: ProvenanceChange,
  beforePath: readonly string[],
  afterPath: readonly string[],
  beforeFacetPath: readonly number[],
  afterFacetPath: readonly number[],
): ProvenanceChange {
  if (change.type === "entrypoint-declaration-file-changed") {
    return change;
  }
  return {
    ...change,
    declarationPath: replacePrefix(change.declarationPath, beforePath, afterPath),
    facetPath: replacePrefix(change.facetPath, beforeFacetPath, afterFacetPath),
  };
}

function rebaseComparisonIssue(
  issue: DeclarationComparisonIssue,
  beforePath: readonly string[],
  afterPath: readonly string[],
  beforeFacetPath: readonly number[],
  afterFacetPath: readonly number[],
): DeclarationComparisonIssue {
  const declarationPath = issue.declarationPath === undefined
    ? undefined
    : replacePrefix(issue.declarationPath, beforePath, afterPath);
  const facetPath = issue.facetPath === undefined
    ? undefined
    : replacePrefix(issue.facetPath, beforeFacetPath, afterFacetPath);
  return {
    ...issue,
    ...(declarationPath === undefined ? {} : { declarationPath }),
    ...(facetPath === undefined ? {} : { facetPath }),
    message: issue.code === "recursive-declaration-graph" && declarationPath !== undefined
      ? `Recursive declaration graph encountered at "${declarationPath.join(".")}".`
      : issue.message,
  };
}

function replayPublicTemplate(
  template: PublicPairTemplate,
  declarationPath: readonly string[],
  facetPath: readonly number[],
  context: ComparisonContext,
): Extract<ExportChange, { type: "export-modified" }> | undefined {
  for (const provenance of template.provenanceChanges) {
    context.provenanceChanges.push(rebaseProvenanceChange(
      provenance,
      template.basePath,
      declarationPath,
      template.baseFacetPath,
      facetPath,
    ));
  }
  for (const issue of template.issues) {
    addComparisonIssue(context.issues, rebaseComparisonIssue(
      issue,
      template.basePath,
      declarationPath,
      template.baseFacetPath,
      facetPath,
    ));
  }
  return template.change === undefined
    ? undefined
    : rebaseExportChange(
      template.change,
      template.basePath,
      declarationPath,
      template.baseFacetPath,
      facetPath,
    ) as Extract<ExportChange, { type: "export-modified" }>;
}

function replayReferencedTemplate(
  template: ReferencedPairTemplate,
  declarationPath: readonly string[],
  facetPath: readonly number[],
  context: ComparisonContext,
): Extract<ReferencedDeclarationChange, { type: "referenced-declaration-modified" }> | undefined {
  for (const provenance of template.provenanceChanges) {
    context.provenanceChanges.push(rebaseProvenanceChange(
      provenance,
      template.basePath,
      declarationPath,
      template.baseFacetPath,
      facetPath,
    ));
  }
  for (const issue of template.issues) {
    addComparisonIssue(context.issues, rebaseComparisonIssue(
      issue,
      template.basePath,
      declarationPath,
      template.baseFacetPath,
      facetPath,
    ));
  }
  return template.change === undefined
    ? undefined
    : rebaseReferencedChange(
      template.change,
      template.basePath,
      declarationPath,
      template.baseFacetPath,
      facetPath,
    ) as Extract<ReferencedDeclarationChange, { type: "referenced-declaration-modified" }>;
}

function sourceIssueIdentity(issue: DeclarationSurfaceIssue): string {
  return JSON.stringify([
    issue.code,
    issue.exportPath ?? null,
    issue.declarationFile ?? null,
    issue.sourceFile ?? null,
    issue.specifier ?? null,
    issue.limit ?? null,
    issue.message,
  ]);
}

function normalizeSourceIssues(
  issues: readonly DeclarationSurfaceIssue[],
): DeclarationSurfaceIssue[] {
  return [...issues].sort((left, right) =>
    compareText(sourceIssueIdentity(left), sourceIssueIdentity(right)));
}

function normalizedMember(member: PublicApiMember): PublicApiMember {
  return {
    ...member,
    signatures: uniqueSorted(member.signatures),
  };
}

function memberSortKey(member: PublicApiMember): string {
  return JSON.stringify([
    memberIdentity(member),
    member.kind,
    member.visibility,
    member.optional,
    member.readonly,
    member.abstract,
    uniqueSorted(member.signatures),
    member.deprecated,
  ]);
}

function normalizedMembers(members: readonly PublicApiMember[]): PublicApiMember[] {
  return members.map(normalizedMember).sort((left, right) =>
    compareText(memberSortKey(left), memberSortKey(right)));
}

function publicDeclarationSortKey(declaration: PublicApiDeclaration): string {
  return JSON.stringify([
    declaration.exportedName,
    declaration.facet,
    declaration.kind,
    uniqueSorted(declaration.signatures),
    declaration.sourceFile,
  ]);
}

function normalizedPublicDeclaration(
  declaration: PublicApiDeclaration,
  cache: WeakMap<PublicApiDeclaration, PublicApiDeclaration>,
): PublicApiDeclaration {
  const cached = cache.get(declaration);
  if (cached !== undefined) {
    return cached;
  }
  const base = {
    exportedName: declaration.exportedName,
    kind: declaration.kind,
    facet: declaration.facet,
    sourceFile: declaration.sourceFile,
    defaultExport: declaration.defaultExport,
    exportEquals: declaration.exportEquals,
    typeOnly: declaration.typeOnly,
    signatures: uniqueSorted(declaration.signatures),
    deprecated: declaration.deprecated,
  };
  if (
    declaration.kind === "class"
    || declaration.kind === "interface"
    || declaration.kind === "enum"
  ) {
    const normalized: PublicApiDeclaration = {
      ...base,
      kind: declaration.kind,
      members: normalizedMembers(declaration.members),
    };
    cache.set(declaration, normalized);
    return normalized;
  }
  if (declaration.kind === "namespace") {
    const normalized: PublicApiDeclaration = {
      ...base,
      kind: "namespace",
      exports: declaration.exports
        .map((item) => normalizedPublicDeclaration(item, cache))
        .sort((left, right) =>
          compareText(publicDeclarationSortKey(left), publicDeclarationSortKey(right))),
    };
    cache.set(declaration, normalized);
    return normalized;
  }
  if (declaration.kind === "external-reexport") {
    const normalized: PublicApiDeclaration = {
      ...base,
      kind: "external-reexport",
      externalModule: declaration.externalModule,
      importedName: declaration.importedName,
    };
    cache.set(declaration, normalized);
    return normalized;
  }
  const normalized: PublicApiDeclaration = { ...base, kind: declaration.kind };
  cache.set(declaration, normalized);
  return normalized;
}

function referencedDeclarationSortKey(declaration: ReferencedApiDeclaration): string {
  return JSON.stringify([
    declaration.name,
    declaration.facet,
    declaration.kind,
    uniqueSorted(declaration.signatures),
    declaration.sourceFile,
  ]);
}

function normalizedReferencedDeclaration(
  declaration: ReferencedApiDeclaration,
  cache: WeakMap<ReferencedApiDeclaration, ReferencedApiDeclaration>,
): ReferencedApiDeclaration {
  const cached = cache.get(declaration);
  if (cached !== undefined) {
    return cached;
  }
  const base = {
    name: declaration.name,
    kind: declaration.kind,
    facet: declaration.facet,
    sourceFile: declaration.sourceFile,
    typeOnly: declaration.typeOnly,
    signatures: uniqueSorted(declaration.signatures),
    deprecated: declaration.deprecated,
  };
  if (
    declaration.kind === "class"
    || declaration.kind === "interface"
    || declaration.kind === "enum"
  ) {
    const normalized: ReferencedApiDeclaration = {
      ...base,
      kind: declaration.kind,
      members: normalizedMembers(declaration.members),
    };
    cache.set(declaration, normalized);
    return normalized;
  }
  if (declaration.kind === "namespace") {
    const normalized: ReferencedApiDeclaration = {
      ...base,
      kind: "namespace",
      declarations: declaration.declarations
        .map((item) => normalizedReferencedDeclaration(item, cache))
        .sort((left, right) =>
          compareText(referencedDeclarationSortKey(left), referencedDeclarationSortKey(right))),
    };
    cache.set(declaration, normalized);
    return normalized;
  }
  if (declaration.kind === "external-reexport") {
    const normalized: ReferencedApiDeclaration = {
      ...base,
      kind: "external-reexport",
      externalModule: declaration.externalModule,
      importedName: declaration.importedName,
    };
    cache.set(declaration, normalized);
    return normalized;
  }
  const normalized: ReferencedApiDeclaration = { ...base, kind: declaration.kind };
  cache.set(declaration, normalized);
  return normalized;
}

function propertyChange(
  property: DeclarationPropertyName,
  before: string | boolean,
  after: string | boolean,
): DeclarationPropertyChange | undefined {
  return before === after
    ? undefined
    : { type: "property-changed", property, before, after };
}

function deprecationChange(
  before: boolean,
  after: boolean,
): DeprecationChange | undefined {
  if (before === after) {
    return undefined;
  }
  return after ? { type: "deprecated-added" } : { type: "deprecated-removed" };
}

function signatureChanges(
  before: readonly string[],
  after: readonly string[],
): SignatureChange[] {
  const beforeSignatures = uniqueSorted(before);
  const afterSignatures = uniqueSorted(after);
  const beforeSet = new Set(beforeSignatures);
  const afterSet = new Set(afterSignatures);
  return [
    ...afterSignatures
      .filter((signature) => !beforeSet.has(signature))
      .map((signature): SignatureChange => ({ type: "signature-added", signature })),
    ...beforeSignatures
      .filter((signature) => !afterSet.has(signature))
      .map((signature): SignatureChange => ({ type: "signature-removed", signature })),
  ].sort((left, right) =>
    compareText(left.type, right.type) || compareText(left.signature, right.signature));
}

function duplicateIssue(
  code: ComparisonIssueCode,
  side: DeclarationDiffSide,
  context: ComparisonContext,
  message: string,
  details: {
    declarationPath?: readonly string[];
    facet?: number;
    facetPath?: readonly number[];
    memberName?: string;
    memberStatic?: boolean;
    memberRole?: string;
  } = {},
): void {
  addComparisonIssue(context.issues, {
    code,
    side,
    exportPath: context.exportPath,
    conditionPath: [...context.conditionPath],
    message,
    ...(details.declarationPath === undefined
      ? {}
      : { declarationPath: [...details.declarationPath] }),
    ...(details.facet === undefined ? {} : { facet: details.facet }),
    ...(details.facetPath === undefined ? {} : { facetPath: [...details.facetPath] }),
    ...(details.memberName === undefined ? {} : { memberName: details.memberName }),
    ...(details.memberStatic === undefined ? {} : { memberStatic: details.memberStatic }),
    ...(details.memberRole === undefined ? {} : { memberRole: details.memberRole }),
  });
}

function traversalIssue(
  code: "recursive-declaration-graph" | "comparison-limit-exceeded",
  context: ComparisonContext,
  declarationPath: readonly string[],
  facetPath: readonly number[],
  facet: number,
  side?: DeclarationDiffSide,
): void {
  addComparisonIssue(context.issues, {
    code,
    message: code === "recursive-declaration-graph"
      ? `Recursive declaration graph encountered at "${declarationPath.join(".")}".`
      : `Declaration comparison exceeded maximum depth ${MAX_COMPARISON_DEPTH}.`,
    ...(side === undefined ? {} : { side }),
    exportPath: context.exportPath,
    conditionPath: [...context.conditionPath],
    declarationPath: [...declarationPath],
    facet,
    facetPath: [...facetPath],
  });
}

function validateMemberIdentities(
  members: readonly PublicApiMember[],
  declarationPath: readonly string[],
  facet: number,
  facetPath: readonly number[],
  side: DeclarationDiffSide,
  context: ComparisonContext,
): boolean {
  let valid = true;
  for (const [key, group] of groupedBy(members, memberIdentity)) {
    if (group.length > 1) {
      duplicateIssue(
        "duplicate-member-identity",
        side,
        context,
        `Multiple ${side} members share identity ${key}.`,
        {
          declarationPath,
          facet,
          facetPath,
          memberName: group[0]!.name,
          memberStatic: group[0]!.static,
          memberRole: memberRole(group[0]!),
        },
      );
      valid = false;
    }
  }
  return valid;
}

function validatePublicDeclaration(
  declaration: PublicApiDeclaration,
  declarationPath: readonly string[],
  parentFacetPath: readonly number[],
  side: DeclarationDiffSide,
  context: ComparisonContext,
  depth: number,
): number | undefined {
  const facetPath = [...parentFacetPath, declaration.facet];
  if (depth >= MAX_COMPARISON_DEPTH) {
    traversalIssue(
      "comparison-limit-exceeded",
      context,
      declarationPath,
      facetPath,
      declaration.facet,
      side,
    );
    return undefined;
  }
  const previousState = context.publicValidation[side].get(declaration);
  if (previousState === "active") {
    traversalIssue(
      "recursive-declaration-graph",
      context,
      declarationPath,
      facetPath,
      declaration.facet,
      side,
    );
    return undefined;
  }
  if (typeof previousState === "number") {
    if (depth + previousState >= MAX_COMPARISON_DEPTH) {
      traversalIssue(
        "comparison-limit-exceeded",
        context,
        declarationPath,
        facetPath,
        declaration.facet,
        side,
      );
      return undefined;
    }
    return previousState;
  }
  context.publicValidation[side].set(declaration, "active");
  let valid = validateMemberIdentities(
    publicMembers(declaration),
    declarationPath,
    declaration.facet,
    facetPath,
    side,
    context,
  );
  let height = 0;
  const nested = nestedPublicDeclarations(declaration);
  for (const [key, group] of groupedBy(nested, (item) =>
    declarationIdentity(item.exportedName, item.facet))) {
    const sample = group[0]!;
    const nestedPath = [...declarationPath, sample.exportedName];
    if (group.length > 1) {
      duplicateIssue(
        "duplicate-export-identity",
        side,
        context,
        `Multiple ${side} exports share identity ${key}.`,
        {
          declarationPath: nestedPath,
          facet: sample.facet,
          facetPath: [...facetPath, sample.facet],
        },
      );
      valid = false;
    }
    for (const item of group) {
      const childHeight = validatePublicDeclaration(
        item,
        nestedPath,
        facetPath,
        side,
        context,
        depth + 1,
      );
      if (childHeight === undefined) {
        valid = false;
      } else {
        height = Math.max(height, childHeight + 1);
      }
    }
  }
  if (valid) {
    context.publicValidation[side].set(declaration, height);
    return height;
  } else {
    context.publicValidation[side].delete(declaration);
    return undefined;
  }
}

function validateReferencedDeclaration(
  declaration: ReferencedApiDeclaration,
  declarationPath: readonly string[],
  parentFacetPath: readonly number[],
  side: DeclarationDiffSide,
  context: ComparisonContext,
  depth: number,
): number | undefined {
  const facetPath = [...parentFacetPath, declaration.facet];
  if (depth >= MAX_COMPARISON_DEPTH) {
    traversalIssue(
      "comparison-limit-exceeded",
      context,
      declarationPath,
      facetPath,
      declaration.facet,
      side,
    );
    return undefined;
  }
  const previousState = context.referencedValidation[side].get(declaration);
  if (previousState === "active") {
    traversalIssue(
      "recursive-declaration-graph",
      context,
      declarationPath,
      facetPath,
      declaration.facet,
      side,
    );
    return undefined;
  }
  if (typeof previousState === "number") {
    if (depth + previousState >= MAX_COMPARISON_DEPTH) {
      traversalIssue(
        "comparison-limit-exceeded",
        context,
        declarationPath,
        facetPath,
        declaration.facet,
        side,
      );
      return undefined;
    }
    return previousState;
  }
  context.referencedValidation[side].set(declaration, "active");
  let valid = validateMemberIdentities(
    referencedMembers(declaration),
    declarationPath,
    declaration.facet,
    facetPath,
    side,
    context,
  );
  let height = 0;
  const nested = nestedReferencedDeclarations(declaration);
  for (const [key, group] of groupedBy(nested, (item) =>
    declarationIdentity(item.name, item.facet))) {
    const sample = group[0]!;
    const nestedPath = [...declarationPath, sample.name];
    if (group.length > 1) {
      duplicateIssue(
        "duplicate-referenced-declaration-identity",
        side,
        context,
        `Multiple ${side} referenced declarations share identity ${key}.`,
        {
          declarationPath: nestedPath,
          facet: sample.facet,
          facetPath: [...facetPath, sample.facet],
        },
      );
      valid = false;
    }
    for (const item of group) {
      const childHeight = validateReferencedDeclaration(
        item,
        nestedPath,
        facetPath,
        side,
        context,
        depth + 1,
      );
      if (childHeight === undefined) {
        valid = false;
      } else {
        height = Math.max(height, childHeight + 1);
      }
    }
  }
  if (valid) {
    context.referencedValidation[side].set(declaration, height);
    return height;
  } else {
    context.referencedValidation[side].delete(declaration);
    return undefined;
  }
}

function compareMembers(
  before: readonly PublicApiMember[],
  after: readonly PublicApiMember[],
  declarationPath: readonly string[],
  facet: number,
  facetPath: readonly number[],
  context: ComparisonContext,
): MemberChange[] {
  const beforeGroups = groupedBy(before, memberIdentity);
  const afterGroups = groupedBy(after, memberIdentity);
  const changes: MemberChange[] = [];
  for (const key of sortedUnion(beforeGroups.keys(), afterGroups.keys())) {
    const beforeGroup = beforeGroups.get(key) ?? [];
    const afterGroup = afterGroups.get(key) ?? [];
    if (beforeGroup.length > 1) {
      duplicateIssue(
        "duplicate-member-identity",
        "before",
        context,
        `Multiple before members share identity ${key}.`,
        {
          declarationPath,
          facet,
          facetPath,
          memberName: beforeGroup[0]!.name,
          memberStatic: beforeGroup[0]!.static,
          memberRole: memberRole(beforeGroup[0]!),
        },
      );
    }
    if (afterGroup.length > 1) {
      duplicateIssue(
        "duplicate-member-identity",
        "after",
        context,
        `Multiple after members share identity ${key}.`,
        {
          declarationPath,
          facet,
          facetPath,
          memberName: afterGroup[0]!.name,
          memberStatic: afterGroup[0]!.static,
          memberRole: memberRole(afterGroup[0]!),
        },
      );
    }
    if (beforeGroup.length !== 1 || afterGroup.length !== 1) {
      if (beforeGroup.length === 0 && afterGroup.length === 1) {
        changes.push({ type: "member-added", member: normalizedMember(afterGroup[0]!) });
      } else if (beforeGroup.length === 1 && afterGroup.length === 0) {
        changes.push({ type: "member-removed", member: normalizedMember(beforeGroup[0]!) });
      }
      continue;
    }

    const beforeMember = beforeGroup[0]!;
    const afterMember = afterGroup[0]!;
    const propertyChanges = [
      propertyChange("kind", beforeMember.kind, afterMember.kind),
      propertyChange("visibility", beforeMember.visibility, afterMember.visibility),
      propertyChange("optional", beforeMember.optional, afterMember.optional),
      propertyChange("readonly", beforeMember.readonly, afterMember.readonly),
      propertyChange("abstract", beforeMember.abstract, afterMember.abstract),
    ].filter((change): change is DeclarationPropertyChange => change !== undefined);
    const changedDeprecation = deprecationChange(
      beforeMember.deprecated,
      afterMember.deprecated,
    );
    const changedSignatures = signatureChanges(
      beforeMember.signatures,
      afterMember.signatures,
    );
    if (
      propertyChanges.length > 0
      || changedDeprecation !== undefined
      || changedSignatures.length > 0
    ) {
      changes.push({
        type: "member-modified",
        name: beforeMember.name,
        static: beforeMember.static,
        role: memberRole(beforeMember),
        propertyChanges,
        ...(changedDeprecation === undefined
          ? {}
          : { deprecationChange: changedDeprecation }),
        signatureChanges: changedSignatures,
      });
    }
  }
  return changes;
}

function publicMembers(declaration: PublicApiDeclaration): readonly PublicApiMember[] {
  return declaration.kind === "class"
    || declaration.kind === "interface"
    || declaration.kind === "enum"
    ? declaration.members
    : [];
}

function nestedPublicDeclarations(
  declaration: PublicApiDeclaration,
): readonly PublicApiDeclaration[] {
  return declaration.kind === "namespace" ? declaration.exports : [];
}

function comparePublicDeclarations(
  before: readonly PublicApiDeclaration[],
  after: readonly PublicApiDeclaration[],
  parentPath: readonly string[],
  parentFacetPath: readonly number[],
  context: ComparisonContext,
  depth: number,
): ExportChange[] {
  const beforeGroups = groupedBy(before, (declaration) =>
    declarationIdentity(declaration.exportedName, declaration.facet));
  const afterGroups = groupedBy(after, (declaration) =>
    declarationIdentity(declaration.exportedName, declaration.facet));
  const changes: ExportChange[] = [];

  for (const key of sortedUnion(beforeGroups.keys(), afterGroups.keys())) {
    const beforeGroup = beforeGroups.get(key) ?? [];
    const afterGroup = afterGroups.get(key) ?? [];
    const sample = beforeGroup[0] ?? afterGroup[0];
    if (sample === undefined) {
      continue;
    }
    const declarationPath = [...parentPath, sample.exportedName];
    const facetPath = [...parentFacetPath, sample.facet];
    if (beforeGroup.length > 1) {
      duplicateIssue(
        "duplicate-export-identity",
        "before",
        context,
        `Multiple before exports share identity ${key}.`,
        { declarationPath, facet: sample.facet, facetPath },
      );
    }
    if (afterGroup.length > 1) {
      duplicateIssue(
        "duplicate-export-identity",
        "after",
        context,
        `Multiple after exports share identity ${key}.`,
        { declarationPath, facet: sample.facet, facetPath },
      );
    }
    if (beforeGroup.length !== 1 || afterGroup.length !== 1) {
      if (beforeGroup.length === 0 && afterGroup.length === 1) {
        if (validatePublicDeclaration(
          afterGroup[0]!,
          declarationPath,
          parentFacetPath,
          "after",
          context,
          depth,
        ) !== undefined) {
          changes.push({
            type: "export-added",
            declarationPath,
            facet: sample.facet,
            facetPath,
            declaration: normalizedPublicDeclaration(
              afterGroup[0]!,
              context.publicNormalization,
            ),
          });
        }
      } else if (beforeGroup.length === 1 && afterGroup.length === 0) {
        if (validatePublicDeclaration(
          beforeGroup[0]!,
          declarationPath,
          parentFacetPath,
          "before",
          context,
          depth,
        ) !== undefined) {
          changes.push({
            type: "export-removed",
            declarationPath,
            facet: sample.facet,
            facetPath,
            declaration: normalizedPublicDeclaration(
              beforeGroup[0]!,
              context.publicNormalization,
            ),
          });
        }
      }
      continue;
    }

    const beforeDeclaration = beforeGroup[0]!;
    const afterDeclaration = afterGroup[0]!;
    if (depth >= MAX_COMPARISON_DEPTH) {
      traversalIssue(
        "comparison-limit-exceeded",
        context,
        declarationPath,
        facetPath,
        beforeDeclaration.facet,
      );
      continue;
    }
    const traversalState = pairTraversalState(
      context.publicPairs,
      beforeDeclaration,
      afterDeclaration,
    );
    if (traversalState === "active") {
      traversalIssue(
        "recursive-declaration-graph",
        context,
        declarationPath,
        facetPath,
        beforeDeclaration.facet,
      );
      continue;
    }
    if (traversalState !== "new") {
      if (depth + traversalState.height >= MAX_COMPARISON_DEPTH) {
        traversalIssue(
          "comparison-limit-exceeded",
          context,
          declarationPath,
          facetPath,
          beforeDeclaration.facet,
        );
        continue;
      }
      const replayed = replayPublicTemplate(
        traversalState,
        declarationPath,
        facetPath,
        context,
      );
      if (replayed !== undefined) {
        changes.push(replayed);
      }
      continue;
    }
    const provenanceStart = context.provenanceChanges.length;
    const issueKeysBefore = new Set(context.issues.keys());
    if (beforeDeclaration.sourceFile !== afterDeclaration.sourceFile) {
      context.provenanceChanges.push({
        type: "export-source-file-changed",
        exportPath: context.exportPath,
        conditionPath: [...context.conditionPath],
        declarationPath,
        facet: beforeDeclaration.facet,
        facetPath,
        beforeSourceFile: beforeDeclaration.sourceFile,
        afterSourceFile: afterDeclaration.sourceFile,
      });
    }
    const propertyChanges = [
      propertyChange("kind", beforeDeclaration.kind, afterDeclaration.kind),
      propertyChange(
        "defaultExport",
        beforeDeclaration.defaultExport,
        afterDeclaration.defaultExport,
      ),
      propertyChange(
        "exportEquals",
        beforeDeclaration.exportEquals,
        afterDeclaration.exportEquals,
      ),
      propertyChange("typeOnly", beforeDeclaration.typeOnly, afterDeclaration.typeOnly),
    ].filter((change): change is DeclarationPropertyChange => change !== undefined);
    if (
      beforeDeclaration.kind === "external-reexport"
      && afterDeclaration.kind === "external-reexport"
    ) {
      const moduleChange = propertyChange(
        "externalModule",
        beforeDeclaration.externalModule,
        afterDeclaration.externalModule,
      );
      const importChange = propertyChange(
        "importedName",
        beforeDeclaration.importedName,
        afterDeclaration.importedName,
      );
      if (moduleChange !== undefined) {
        propertyChanges.push(moduleChange);
      }
      if (importChange !== undefined) {
        propertyChanges.push(importChange);
      }
    }
    const changedDeprecation = deprecationChange(
      beforeDeclaration.deprecated,
      afterDeclaration.deprecated,
    );
    const changedSignatures = signatureChanges(
      beforeDeclaration.signatures,
      afterDeclaration.signatures,
    );
    const memberChanges = compareMembers(
      publicMembers(beforeDeclaration),
      publicMembers(afterDeclaration),
      declarationPath,
      beforeDeclaration.facet,
      facetPath,
      context,
    );
    const nestedExportChanges = comparePublicDeclarations(
      nestedPublicDeclarations(beforeDeclaration),
      nestedPublicDeclarations(afterDeclaration),
      declarationPath,
      facetPath,
      context,
      depth + 1,
    );
    const declarationChanged =
      propertyChanges.length > 0
      || changedDeprecation !== undefined
      || changedSignatures.length > 0
      || memberChanges.length > 0
      || nestedExportChanges.length > 0;
    const emittedChange: Extract<ExportChange, { type: "export-modified" }> | undefined =
      declarationChanged ? {
        type: "export-modified",
        declarationPath,
        facet: beforeDeclaration.facet,
        facetPath,
        propertyChanges,
        ...(changedDeprecation === undefined
          ? {}
          : { deprecationChange: changedDeprecation }),
        signatureChanges: changedSignatures,
        memberChanges,
        nestedExportChanges,
      } : undefined;
    if (emittedChange !== undefined) {
      changes.push(emittedChange);
    }
    const newIssues = [...context.issues.entries()]
      .filter(([issueKey]) => !issueKeysBefore.has(issueKey))
      .map(([, issue]) => issue);
    if (newIssues.some((issue) => issue.code === "comparison-limit-exceeded")) {
      discardPairTraversal(context.publicPairs, beforeDeclaration, afterDeclaration);
    } else {
      completePairTraversal(context.publicPairs, beforeDeclaration, afterDeclaration, {
        basePath: declarationPath,
        baseFacetPath: facetPath,
        ...(emittedChange === undefined ? {} : { change: emittedChange }),
        provenanceChanges: context.provenanceChanges.slice(provenanceStart),
        issues: newIssues,
        height: Math.max(
          declarationGraphHeight(
            beforeDeclaration,
            nestedPublicDeclarations,
            context.publicHeights,
          ),
          declarationGraphHeight(
            afterDeclaration,
            nestedPublicDeclarations,
            context.publicHeights,
          ),
        ),
      });
    }
  }
  return changes;
}

function referencedMembers(
  declaration: ReferencedApiDeclaration,
): readonly PublicApiMember[] {
  return declaration.kind === "class"
    || declaration.kind === "interface"
    || declaration.kind === "enum"
    ? declaration.members
    : [];
}

function nestedReferencedDeclarations(
  declaration: ReferencedApiDeclaration,
): readonly ReferencedApiDeclaration[] {
  return declaration.kind === "namespace" ? declaration.declarations : [];
}

function compareReferencedDeclarations(
  before: readonly ReferencedApiDeclaration[],
  after: readonly ReferencedApiDeclaration[],
  parentPath: readonly string[],
  parentFacetPath: readonly number[],
  context: ComparisonContext,
  depth: number,
): ReferencedDeclarationChange[] {
  const beforeGroups = groupedBy(before, (declaration) =>
    declarationIdentity(declaration.name, declaration.facet));
  const afterGroups = groupedBy(after, (declaration) =>
    declarationIdentity(declaration.name, declaration.facet));
  const changes: ReferencedDeclarationChange[] = [];

  for (const key of sortedUnion(beforeGroups.keys(), afterGroups.keys())) {
    const beforeGroup = beforeGroups.get(key) ?? [];
    const afterGroup = afterGroups.get(key) ?? [];
    const sample = beforeGroup[0] ?? afterGroup[0];
    if (sample === undefined) {
      continue;
    }
    const declarationPath = [...parentPath, sample.name];
    const facetPath = [...parentFacetPath, sample.facet];
    if (beforeGroup.length > 1) {
      duplicateIssue(
        "duplicate-referenced-declaration-identity",
        "before",
        context,
        `Multiple before referenced declarations share identity ${key}.`,
        { declarationPath, facet: sample.facet, facetPath },
      );
    }
    if (afterGroup.length > 1) {
      duplicateIssue(
        "duplicate-referenced-declaration-identity",
        "after",
        context,
        `Multiple after referenced declarations share identity ${key}.`,
        { declarationPath, facet: sample.facet, facetPath },
      );
    }
    if (beforeGroup.length !== 1 || afterGroup.length !== 1) {
      if (beforeGroup.length === 0 && afterGroup.length === 1) {
        if (validateReferencedDeclaration(
          afterGroup[0]!,
          declarationPath,
          parentFacetPath,
          "after",
          context,
          depth,
        ) !== undefined) {
          changes.push({
            type: "referenced-declaration-added",
            declarationPath,
            facet: sample.facet,
            facetPath,
            declaration: normalizedReferencedDeclaration(
              afterGroup[0]!,
              context.referencedNormalization,
            ),
          });
        }
      } else if (beforeGroup.length === 1 && afterGroup.length === 0) {
        if (validateReferencedDeclaration(
          beforeGroup[0]!,
          declarationPath,
          parentFacetPath,
          "before",
          context,
          depth,
        ) !== undefined) {
          changes.push({
            type: "referenced-declaration-removed",
            declarationPath,
            facet: sample.facet,
            facetPath,
            declaration: normalizedReferencedDeclaration(
              beforeGroup[0]!,
              context.referencedNormalization,
            ),
          });
        }
      }
      continue;
    }

    const beforeDeclaration = beforeGroup[0]!;
    const afterDeclaration = afterGroup[0]!;
    if (depth >= MAX_COMPARISON_DEPTH) {
      traversalIssue(
        "comparison-limit-exceeded",
        context,
        declarationPath,
        facetPath,
        beforeDeclaration.facet,
      );
      continue;
    }
    const traversalState = pairTraversalState(
      context.referencedPairs,
      beforeDeclaration,
      afterDeclaration,
    );
    if (traversalState === "active") {
      traversalIssue(
        "recursive-declaration-graph",
        context,
        declarationPath,
        facetPath,
        beforeDeclaration.facet,
      );
      continue;
    }
    if (traversalState !== "new") {
      if (depth + traversalState.height >= MAX_COMPARISON_DEPTH) {
        traversalIssue(
          "comparison-limit-exceeded",
          context,
          declarationPath,
          facetPath,
          beforeDeclaration.facet,
        );
        continue;
      }
      const replayed = replayReferencedTemplate(
        traversalState,
        declarationPath,
        facetPath,
        context,
      );
      if (replayed !== undefined) {
        changes.push(replayed);
      }
      continue;
    }
    const provenanceStart = context.provenanceChanges.length;
    const issueKeysBefore = new Set(context.issues.keys());
    if (beforeDeclaration.sourceFile !== afterDeclaration.sourceFile) {
      context.provenanceChanges.push({
        type: "referenced-declaration-source-file-changed",
        exportPath: context.exportPath,
        conditionPath: [...context.conditionPath],
        declarationPath,
        facet: beforeDeclaration.facet,
        facetPath,
        beforeSourceFile: beforeDeclaration.sourceFile,
        afterSourceFile: afterDeclaration.sourceFile,
      });
    }
    const propertyChanges = [
      propertyChange("kind", beforeDeclaration.kind, afterDeclaration.kind),
      propertyChange("typeOnly", beforeDeclaration.typeOnly, afterDeclaration.typeOnly),
    ].filter((change): change is DeclarationPropertyChange => change !== undefined);
    if (
      beforeDeclaration.kind === "external-reexport"
      && afterDeclaration.kind === "external-reexport"
    ) {
      const moduleChange = propertyChange(
        "externalModule",
        beforeDeclaration.externalModule,
        afterDeclaration.externalModule,
      );
      const importChange = propertyChange(
        "importedName",
        beforeDeclaration.importedName,
        afterDeclaration.importedName,
      );
      if (moduleChange !== undefined) {
        propertyChanges.push(moduleChange);
      }
      if (importChange !== undefined) {
        propertyChanges.push(importChange);
      }
    }
    const changedDeprecation = deprecationChange(
      beforeDeclaration.deprecated,
      afterDeclaration.deprecated,
    );
    const changedSignatures = signatureChanges(
      beforeDeclaration.signatures,
      afterDeclaration.signatures,
    );
    const memberChanges = compareMembers(
      referencedMembers(beforeDeclaration),
      referencedMembers(afterDeclaration),
      declarationPath,
      beforeDeclaration.facet,
      facetPath,
      context,
    );
    const nestedDeclarationChanges = compareReferencedDeclarations(
      nestedReferencedDeclarations(beforeDeclaration),
      nestedReferencedDeclarations(afterDeclaration),
      declarationPath,
      facetPath,
      context,
      depth + 1,
    );
    const declarationChanged =
      propertyChanges.length > 0
      || changedDeprecation !== undefined
      || changedSignatures.length > 0
      || memberChanges.length > 0
      || nestedDeclarationChanges.length > 0;
    const emittedChange: Extract<ReferencedDeclarationChange, {
      type: "referenced-declaration-modified";
    }> | undefined = declarationChanged ? {
        type: "referenced-declaration-modified",
        declarationPath,
        facet: beforeDeclaration.facet,
        facetPath,
        propertyChanges,
        ...(changedDeprecation === undefined
          ? {}
          : { deprecationChange: changedDeprecation }),
        signatureChanges: changedSignatures,
        memberChanges,
        nestedDeclarationChanges,
      } : undefined;
    if (emittedChange !== undefined) {
      changes.push(emittedChange);
    }
    const newIssues = [...context.issues.entries()]
      .filter(([issueKey]) => !issueKeysBefore.has(issueKey))
      .map(([, issue]) => issue);
    if (newIssues.some((issue) => issue.code === "comparison-limit-exceeded")) {
      discardPairTraversal(context.referencedPairs, beforeDeclaration, afterDeclaration);
    } else {
      completePairTraversal(context.referencedPairs, beforeDeclaration, afterDeclaration, {
        basePath: declarationPath,
        baseFacetPath: facetPath,
        ...(emittedChange === undefined ? {} : { change: emittedChange }),
        provenanceChanges: context.provenanceChanges.slice(provenanceStart),
        issues: newIssues,
        height: Math.max(
          declarationGraphHeight(
            beforeDeclaration,
            nestedReferencedDeclarations,
            context.referencedHeights,
          ),
          declarationGraphHeight(
            afterDeclaration,
            nestedReferencedDeclarations,
            context.referencedHeights,
          ),
        ),
      });
    }
  }
  return changes;
}

function expandEntrypoints(entrypoints: readonly DeclarationEntrypoint[]): EntrypointVariant[] {
  const variants: EntrypointVariant[] = [];
  for (const entrypoint of entrypoints) {
    const conditionPaths = entrypoint.conditionPaths.length === 0
      ? [[]]
      : entrypoint.conditionPaths.map((conditionPath) => [...conditionPath]).sort((left, right) =>
        compareText(conditionPathIdentity(left), conditionPathIdentity(right)));
    for (const conditionPath of conditionPaths) {
      variants.push({
        exportPath: entrypoint.exportPath,
        conditionPath,
        declarationFile: entrypoint.declarationFile,
        exports: entrypoint.exports,
        referencedDeclarations: entrypoint.referencedDeclarations,
      });
    }
  }
  return variants;
}

function blockingIssues(
  issues: readonly DeclarationSurfaceIssue[],
  exportPath: string,
): DeclarationSurfaceIssue[] {
  return issues.filter((issue) =>
    BLOCKING_ISSUE_CODES.has(issue.code)
    && (issue.exportPath === undefined || issue.exportPath === exportPath));
}

function issueCodes(issues: readonly DeclarationSurfaceIssue[]): string[] {
  return uniqueSorted(issues.map((issue) => issue.code));
}

function addIndeterminateIssue(
  issues: Map<string, DeclarationComparisonIssue>,
  exportPath: string,
  conditionPath: readonly string[] | undefined,
  beforeIssues: readonly DeclarationSurfaceIssue[],
  afterIssues: readonly DeclarationSurfaceIssue[],
): void {
  const codes = uniqueSorted([...issueCodes(beforeIssues), ...issueCodes(afterIssues)]);
  addComparisonIssue(issues, {
    code: "indeterminate-entrypoint-comparison",
    message: `Entrypoint "${exportPath}" cannot be compared conclusively because extraction was incomplete.`,
    exportPath,
    ...(conditionPath === undefined ? {} : { conditionPath: [...conditionPath] }),
    sourceIssueCodes: codes,
  });
}

function provenanceSortKey(change: ProvenanceChange): string {
  return JSON.stringify([
    change.type,
    change.exportPath,
    change.conditionPath,
    "declarationPath" in change ? change.declarationPath : null,
    "facet" in change ? change.facet : null,
    "facetPath" in change ? change.facetPath : null,
    "beforeDeclarationFile" in change ? change.beforeDeclarationFile : null,
    "afterDeclarationFile" in change ? change.afterDeclarationFile : null,
    "beforeSourceFile" in change ? change.beforeSourceFile : null,
    "afterSourceFile" in change ? change.afterSourceFile : null,
  ]);
}

function createSummary(
  entrypointChanges: readonly EntrypointChange[],
  provenanceChanges: readonly ProvenanceChange[],
  comparisonIssues: readonly DeclarationComparisonIssue[],
): DeclarationSurfaceDiffSummary {
  const counts = {
    entrypointsAdded: 0,
    entrypointsRemoved: 0,
    entrypointsModified: 0,
    exportsAdded: 0,
    exportsRemoved: 0,
    exportsModified: 0,
    membersAdded: 0,
    membersRemoved: 0,
    membersModified: 0,
    signaturesAdded: 0,
    signaturesRemoved: 0,
    referencedDeclarationsAdded: 0,
    referencedDeclarationsRemoved: 0,
    referencedDeclarationsModified: 0,
  };

  function countMemberChanges(changes: readonly MemberChange[]): void {
    for (const change of changes) {
      if (change.type === "member-added") {
        counts.membersAdded += 1;
      } else if (change.type === "member-removed") {
        counts.membersRemoved += 1;
      } else {
        counts.membersModified += 1;
        for (const signature of change.signatureChanges) {
          if (signature.type === "signature-added") {
            counts.signaturesAdded += 1;
          } else {
            counts.signaturesRemoved += 1;
          }
        }
      }
    }
  }

  function countExportChanges(changes: readonly ExportChange[]): void {
    for (const change of changes) {
      if (change.type === "export-added") {
        counts.exportsAdded += 1;
      } else if (change.type === "export-removed") {
        counts.exportsRemoved += 1;
      } else {
        counts.exportsModified += 1;
        for (const signature of change.signatureChanges) {
          if (signature.type === "signature-added") {
            counts.signaturesAdded += 1;
          } else {
            counts.signaturesRemoved += 1;
          }
        }
        countMemberChanges(change.memberChanges);
        countExportChanges(change.nestedExportChanges);
      }
    }
  }

  function countReferencedChanges(changes: readonly ReferencedDeclarationChange[]): void {
    for (const change of changes) {
      if (change.type === "referenced-declaration-added") {
        counts.referencedDeclarationsAdded += 1;
      } else if (change.type === "referenced-declaration-removed") {
        counts.referencedDeclarationsRemoved += 1;
      } else {
        counts.referencedDeclarationsModified += 1;
        for (const signature of change.signatureChanges) {
          if (signature.type === "signature-added") {
            counts.signaturesAdded += 1;
          } else {
            counts.signaturesRemoved += 1;
          }
        }
        countMemberChanges(change.memberChanges);
        countReferencedChanges(change.nestedDeclarationChanges);
      }
    }
  }

  for (const entrypoint of entrypointChanges) {
    if (entrypoint.type === "entrypoint-added") {
      counts.entrypointsAdded += 1;
    } else if (entrypoint.type === "entrypoint-removed") {
      counts.entrypointsRemoved += 1;
    } else {
      counts.entrypointsModified += 1;
    }
    countExportChanges(entrypoint.exportChanges);
    countReferencedChanges(entrypoint.referencedDeclarationChanges);
  }

  const hasApiChanges = Object.values(counts).some((count) => count > 0);
  return {
    ...counts,
    provenanceChanges: provenanceChanges.length,
    comparisonIssues: comparisonIssues.length,
    hasApiChanges,
  };
}

export function compareDeclarationSurfaces(
  before: PackageDeclarationSurface,
  after: PackageDeclarationSurface,
): PackageDeclarationSurfaceDiff {
  if (before.packageName !== after.packageName) {
    throw new DeclarationSurfaceComparisonError(before.packageName, after.packageName);
  }

  const beforeIssues = normalizeSourceIssues(before.issues);
  const afterIssues = normalizeSourceIssues(after.issues);
  const comparisonIssueMap = new Map<string, DeclarationComparisonIssue>();
  const provenanceChanges: ProvenanceChange[] = [];
  const beforeGroups = groupedBy(expandEntrypoints(before.entrypoints), (entrypoint) =>
    entrypointIdentity(entrypoint.exportPath, entrypoint.conditionPath));
  const afterGroups = groupedBy(expandEntrypoints(after.entrypoints), (entrypoint) =>
    entrypointIdentity(entrypoint.exportPath, entrypoint.conditionPath));
  const entrypointChanges: EntrypointChange[] = [];
  const representedExportPaths = new Set<string>();

  for (const key of sortedUnion(beforeGroups.keys(), afterGroups.keys())) {
    const beforeGroup = beforeGroups.get(key) ?? [];
    const afterGroup = afterGroups.get(key) ?? [];
    const sample = beforeGroup[0] ?? afterGroup[0];
    if (sample === undefined) {
      continue;
    }
    representedExportPaths.add(sample.exportPath);
    const context: ComparisonContext = {
      exportPath: sample.exportPath,
      conditionPath: sample.conditionPath,
      issues: comparisonIssueMap,
      provenanceChanges,
      publicPairs: new WeakMap(),
      referencedPairs: new WeakMap(),
      publicValidation: { before: new WeakMap(), after: new WeakMap() },
      referencedValidation: { before: new WeakMap(), after: new WeakMap() },
      publicNormalization: new WeakMap(),
      referencedNormalization: new WeakMap(),
      publicHeights: new WeakMap(),
      referencedHeights: new WeakMap(),
    };
    if (beforeGroup.length > 1) {
      duplicateIssue(
        "duplicate-entrypoint-identity",
        "before",
        context,
        `Multiple before entrypoints share identity ${key}.`,
      );
    }
    if (afterGroup.length > 1) {
      duplicateIssue(
        "duplicate-entrypoint-identity",
        "after",
        context,
        `Multiple after entrypoints share identity ${key}.`,
      );
    }
    if (beforeGroup.length > 1 || afterGroup.length > 1) {
      continue;
    }

    const relevantBeforeIssues = blockingIssues(beforeIssues, sample.exportPath);
    const relevantAfterIssues = blockingIssues(afterIssues, sample.exportPath);
    if (relevantBeforeIssues.length > 0 || relevantAfterIssues.length > 0) {
      addIndeterminateIssue(
        comparisonIssueMap,
        sample.exportPath,
        sample.conditionPath,
        relevantBeforeIssues,
        relevantAfterIssues,
      );
      continue;
    }

    const beforeVariant = beforeGroup[0];
    const afterVariant = afterGroup[0];
    if (beforeVariant === undefined && afterVariant !== undefined) {
      entrypointChanges.push({
        type: "entrypoint-added",
        exportPath: afterVariant.exportPath,
        conditionPath: [...afterVariant.conditionPath],
        afterDeclarationFile: afterVariant.declarationFile,
        exportChanges: comparePublicDeclarations(
          [],
          afterVariant.exports,
          [],
          [],
          context,
          0,
        ),
        referencedDeclarationChanges: compareReferencedDeclarations(
          [],
          afterVariant.referencedDeclarations,
          [],
          [],
          context,
          0,
        ),
      });
      continue;
    }
    if (beforeVariant !== undefined && afterVariant === undefined) {
      entrypointChanges.push({
        type: "entrypoint-removed",
        exportPath: beforeVariant.exportPath,
        conditionPath: [...beforeVariant.conditionPath],
        beforeDeclarationFile: beforeVariant.declarationFile,
        exportChanges: comparePublicDeclarations(
          beforeVariant.exports,
          [],
          [],
          [],
          context,
          0,
        ),
        referencedDeclarationChanges: compareReferencedDeclarations(
          beforeVariant.referencedDeclarations,
          [],
          [],
          [],
          context,
          0,
        ),
      });
      continue;
    }
    if (beforeVariant === undefined || afterVariant === undefined) {
      continue;
    }

    if (beforeVariant.declarationFile !== afterVariant.declarationFile) {
      provenanceChanges.push({
        type: "entrypoint-declaration-file-changed",
        exportPath: beforeVariant.exportPath,
        conditionPath: [...beforeVariant.conditionPath],
        beforeDeclarationFile: beforeVariant.declarationFile,
        afterDeclarationFile: afterVariant.declarationFile,
      });
    }
    const exportChanges = comparePublicDeclarations(
      beforeVariant.exports,
      afterVariant.exports,
      [],
      [],
      context,
      0,
    );
    const referencedDeclarationChanges = compareReferencedDeclarations(
      beforeVariant.referencedDeclarations,
      afterVariant.referencedDeclarations,
      [],
      [],
      context,
      0,
    );
    if (exportChanges.length > 0 || referencedDeclarationChanges.length > 0) {
      entrypointChanges.push({
        type: "entrypoint-modified",
        exportPath: beforeVariant.exportPath,
        conditionPath: [...beforeVariant.conditionPath],
        beforeDeclarationFile: beforeVariant.declarationFile,
        afterDeclarationFile: afterVariant.declarationFile,
        exportChanges,
        referencedDeclarationChanges,
      });
    }
  }

  const unrepresentedIssuePaths = uniqueSorted([
    ...beforeIssues,
    ...afterIssues,
  ].flatMap((issue) =>
    BLOCKING_ISSUE_CODES.has(issue.code)
    && issue.exportPath !== undefined
    && !representedExportPaths.has(issue.exportPath)
      ? [issue.exportPath]
      : []));
  for (const exportPath of unrepresentedIssuePaths) {
    addIndeterminateIssue(
      comparisonIssueMap,
      exportPath,
      undefined,
      blockingIssues(beforeIssues, exportPath),
      blockingIssues(afterIssues, exportPath),
    );
  }
  const globalBeforeIssues = beforeIssues.filter((issue) =>
    BLOCKING_ISSUE_CODES.has(issue.code) && issue.exportPath === undefined);
  const globalAfterIssues = afterIssues.filter((issue) =>
    BLOCKING_ISSUE_CODES.has(issue.code) && issue.exportPath === undefined);
  if (
    representedExportPaths.size === 0
    && (globalBeforeIssues.length > 0 || globalAfterIssues.length > 0)
  ) {
    const codes = uniqueSorted([
      ...issueCodes(globalBeforeIssues),
      ...issueCodes(globalAfterIssues),
    ]);
    addComparisonIssue(comparisonIssueMap, {
      code: "indeterminate-package-comparison",
      message: "Package declaration surfaces cannot be compared conclusively because extraction was incomplete.",
      sourceIssueCodes: codes,
    });
  }

  provenanceChanges.sort((left, right) =>
    compareText(provenanceSortKey(left), provenanceSortKey(right)));
  const comparisonIssues = [...comparisonIssueMap.values()].sort((left, right) =>
    compareText(issueIdentity(left), issueIdentity(right)));
  const summary = createSummary(entrypointChanges, provenanceChanges, comparisonIssues);

  return {
    packageName: before.packageName,
    beforeVersion: before.version,
    afterVersion: after.version,
    entrypointChanges,
    provenanceChanges,
    sourceIssues: {
      before: beforeIssues,
      after: afterIssues,
    },
    comparisonIssues,
    summary,
  };
}

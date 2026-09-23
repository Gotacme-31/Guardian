import { memberRole } from "../declaration-diff/index.js";
import type {
  PublicApiDeclaration,
  PublicApiMember,
} from "../declaration-surface/types.js";
import type { UsageCorrelationIssue } from "./types.js";

export interface ResolvedMember {
  readonly name: string;
  readonly static: boolean;
  readonly role: string;
}

export interface ResolvedLeaf {
  readonly declarationPath: readonly string[];
  readonly facetPath: readonly number[];
  readonly member?: ResolvedMember;
}

export interface ExportChainResolution {
  readonly leaves: readonly ResolvedLeaf[];
  readonly issues: readonly UsageCorrelationIssue[];
}

interface DeclarationCandidate {
  readonly declaration: PublicApiDeclaration;
  readonly declarationPath: readonly string[];
  readonly facetPath: readonly number[];
}

export interface ParsedCanonicalPath {
  readonly bareNamespaceReference: boolean;
  readonly rootNames: readonly string[];
  readonly remainingSegments: readonly string[];
}

/**
 * "namespace.X" in M3's vocabulary means "came from `import * as X`", not the M6
 * `PublicApiDeclarationKind` "namespace" (a `declare namespace` block). Per M8's translation
 * rule 2, it resolves exactly like a named import of X, so the literal "namespace" segment is
 * consumed and X becomes the root name.
 *
 * The "default" root additionally matches an M6 `export=` declaration: M3 cannot distinguish
 * `export default` from CommonJS-interop `export = Foo` (both surface as a default import in
 * consumer code), while M6 records the latter under exportedName "export=". Without this
 * fallback, every CJS-interop package would falsely report `declaration-not-found` for its most
 * common usage shape.
 */
export function parseCanonicalRest(rest: string): ParsedCanonicalPath {
  const segments = rest.split(".");
  const [first, ...afterFirst] = segments as [string, ...string[]];
  if (first === "namespace") {
    const [second, ...afterSecond] = afterFirst;
    if (second === undefined) {
      return { bareNamespaceReference: true, rootNames: [], remainingSegments: [] };
    }
    return rootNamesFor(second, afterSecond);
  }
  return rootNamesFor(first, afterFirst);
}

function rootNamesFor(name: string, remaining: readonly string[]): ParsedCanonicalPath {
  return {
    bareNamespaceReference: false,
    rootNames: name === "default" ? ["default", "export="] : [name],
    remainingSegments: remaining,
  };
}

function declarationMembers(declaration: PublicApiDeclaration): readonly PublicApiMember[] {
  return declaration.kind === "class"
    || declaration.kind === "interface"
    || declaration.kind === "enum"
    ? declaration.members
    : [];
}

function nestedExports(declaration: PublicApiDeclaration): readonly PublicApiDeclaration[] {
  return declaration.kind === "namespace" ? declaration.exports : [];
}

function canDescend(declaration: PublicApiDeclaration): boolean {
  return declaration.kind === "class"
    || declaration.kind === "interface"
    || declaration.kind === "enum"
    || declaration.kind === "namespace";
}

function declarationNotFoundIssue(canonicalPath: string, name: string): UsageCorrelationIssue {
  return {
    code: "declaration-not-found",
    message:
      `Canonical path "${canonicalPath}" references "${name}", which does not exist in the `
      + "installed declaration surface.",
    canonicalPath,
  };
}

function ambiguousFacetIssue(canonicalPath: string, name: string): UsageCorrelationIssue {
  return {
    code: "ambiguous-facet-correlation",
    message:
      `Canonical path "${canonicalPath}" resolves "${name}" to more than one declaration and `
      + "cannot be attributed to a single one from usage evidence alone.",
    canonicalPath,
  };
}

function unresolvableMemberAccessIssue(canonicalPath: string, name: string): UsageCorrelationIssue {
  return {
    code: "unresolvable-member-access",
    message:
      `Canonical path "${canonicalPath}" continues past "${name}", which cannot be resolved `
      + "further in the installed declaration surface.",
    canonicalPath,
  };
}

/**
 * Distinct from `ambiguousFacetIssue`: facets disambiguate declaration-merged *declarations*
 * sharing an `exportedName` (M6's own concept). Member name collisions (e.g. a getter and a
 * setter both named "value") are a different, member-level ambiguity that M6's `members` array
 * does not carry a merge-order counter for, so it gets its own issue code rather than overloading
 * "facet" to mean two different things.
 */
function ambiguousMemberIssue(canonicalPath: string, name: string): UsageCorrelationIssue {
  return {
    code: "ambiguous-member-correlation",
    message:
      `Canonical path "${canonicalPath}" resolves member "${name}" to more than one member `
      + "(e.g. a getter/setter pair) and cannot be attributed to a single one from usage "
      + "evidence alone.",
    canonicalPath,
  };
}

export function rootCandidates(
  exports: readonly PublicApiDeclaration[],
  rootNames: readonly string[],
): PublicApiDeclaration[] {
  return exports.filter((declaration) => rootNames.includes(declaration.exportedName));
}

/**
 * Walks the remaining canonicalPath segments against a set of candidate M6 declarations
 * (usually one; more than one only when an earlier step was itself ambiguous). Recurses into
 * `.exports` for M6 namespace declarations and terminates at `.members` for class/interface/enum
 * declarations. Declarations that cannot hold members or nested exports (function, variable,
 * type, unknown, external-reexport) stop the walk with an `unresolvable-member-access` issue
 * instead of guessing. Every branch is finite: each recursive call consumes exactly one segment,
 * so this always terminates without needing a depth limit.
 */
export function resolveExportChain(
  candidates: readonly DeclarationCandidate[],
  segments: readonly string[],
  canonicalPath: string,
): ExportChainResolution {
  if (segments.length === 0) {
    return {
      leaves: candidates.map((candidate) => ({
        declarationPath: candidate.declarationPath,
        facetPath: candidate.facetPath,
      })),
      issues: [],
    };
  }

  const [segment, ...rest] = segments as [string, ...string[]];
  const leaves: ResolvedLeaf[] = [];
  const issues: UsageCorrelationIssue[] = [];

  for (const candidate of candidates) {
    const { declaration, declarationPath, facetPath } = candidate;
    if (!canDescend(declaration)) {
      issues.push(unresolvableMemberAccessIssue(canonicalPath, declaration.exportedName));
      leaves.push({ declarationPath, facetPath });
      continue;
    }

    if (declaration.kind === "namespace") {
      const matches = nestedExports(declaration).filter((item) => item.exportedName === segment);
      if (matches.length === 0) {
        issues.push(declarationNotFoundIssue(canonicalPath, segment));
        continue;
      }
      if (matches.length > 1) {
        issues.push(ambiguousFacetIssue(canonicalPath, segment));
      }
      const nested = resolveExportChain(
        matches.map((item) => ({
          declaration: item,
          declarationPath: [...declarationPath, segment],
          facetPath: [...facetPath, item.facet],
        })),
        rest,
        canonicalPath,
      );
      leaves.push(...nested.leaves);
      issues.push(...nested.issues);
      continue;
    }

    const memberMatches = declarationMembers(declaration).filter((member) =>
      member.name === segment);
    if (memberMatches.length === 0) {
      issues.push(declarationNotFoundIssue(canonicalPath, segment));
      continue;
    }
    if (memberMatches.length > 1) {
      issues.push(ambiguousMemberIssue(canonicalPath, segment));
    }
    for (const member of memberMatches) {
      if (rest.length > 0) {
        issues.push(unresolvableMemberAccessIssue(canonicalPath, segment));
        leaves.push({ declarationPath, facetPath });
        continue;
      }
      leaves.push({
        declarationPath,
        facetPath,
        member: { name: member.name, static: member.static, role: memberRole(member) },
      });
    }
  }

  return { leaves, issues };
}

export function resolveRoot(
  exports: readonly PublicApiDeclaration[],
  parsed: ParsedCanonicalPath,
  canonicalPath: string,
): ExportChainResolution {
  const roots = rootCandidates(exports, parsed.rootNames);
  if (roots.length === 0) {
    return {
      leaves: [],
      issues: [declarationNotFoundIssue(canonicalPath, parsed.rootNames.join(" or "))],
    };
  }
  const rootIssues = roots.length > 1
    ? [ambiguousFacetIssue(canonicalPath, parsed.rootNames.join(" or "))]
    : [];
  const candidates = roots.map((declaration) => ({
    declaration,
    declarationPath: [declaration.exportedName],
    facetPath: [declaration.facet],
  }));
  const chain = resolveExportChain(candidates, parsed.remainingSegments, canonicalPath);
  return { leaves: chain.leaves, issues: [...rootIssues, ...chain.issues] };
}

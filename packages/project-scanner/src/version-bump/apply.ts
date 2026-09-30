import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import * as semver from "semver";

import type { DependencyType } from "../types.js";
import type {
  ComposedVersionBump,
  VersionBumpWriteError,
  VersionBumpWriteResult,
  VersionCompositionError,
  VersionRangeOperator,
} from "./types.js";

const DECLARED_VERSION_PATTERN = /^([\^~]?)(\S+)$/;

/**
 * Recognizes only a caret, a tilde, or no prefix at all in front of an otherwise-exact semver
 * version. Anything else — a compound range (">=1.0.0 <2.0.0"), a wildcard ("*", "1.x"), a
 * dist-tag ("latest"), or a prefix that isn't exactly "^"/"~" — fails either the regex (compound
 * ranges contain whitespace, which `\S+` cannot span) or the `semver.valid` check on the
 * remainder (wildcards and tags are never a single valid exact version). Never guesses at how to
 * rewrite a range shape it does not recognize.
 */
export function composeVersionBump(
  declaredVersion: string,
  resolvedVersion: string,
): ComposedVersionBump | { readonly error: VersionCompositionError } {
  const match = DECLARED_VERSION_PATTERN.exec(declaredVersion);
  if (match === null) {
    return { error: "unsupported-range-format" };
  }
  const [, rawOperator = "", rest = ""] = match;
  if (semver.valid(rest) === null) {
    return { error: "unsupported-range-format" };
  }

  const operator = rawOperator as VersionRangeOperator;
  const newDeclaredVersion = `${operator}${resolvedVersion}`;
  if (semver.validRange(newDeclaredVersion) === null) {
    return { error: "unsupported-range-format" };
  }

  return { operator, newDeclaredVersion };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return isRecord(error) && typeof error.code === "string";
}

/**
 * Locates the raw-text span of a top-level `"dependencies"`/`"devDependencies"` object: from its
 * opening `{` to its matching closing `}`, tracking brace depth and skipping over string literals
 * (including escaped quotes) so a `{`/`}` character inside a value never desyncs the count. This
 * is what lets `applyVersionBump` search only inside the correct section's text, so the same
 * dependency name declared with a different version in the *other* section is never touched.
 */
function findSectionSpan(
  rawContents: string,
  field: "dependencies" | "devDependencies",
): { start: number; end: number } | undefined {
  const keyPattern = JSON.stringify(field);
  const keyIndex = rawContents.indexOf(keyPattern);
  if (keyIndex === -1) {
    return undefined;
  }

  let cursor = keyIndex + keyPattern.length;
  const skipWhitespace = (): void => {
    while (cursor < rawContents.length && /\s/.test(rawContents.charAt(cursor))) {
      cursor += 1;
    }
  };

  skipWhitespace();
  if (rawContents.charAt(cursor) !== ":") {
    return undefined;
  }
  cursor += 1;
  skipWhitespace();
  if (rawContents.charAt(cursor) !== "{") {
    return undefined;
  }

  const objectStart = cursor;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index < rawContents.length; index += 1) {
    const char = rawContents.charAt(index);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { start: objectStart, end: index + 1 };
      }
    }
  }
  return undefined;
}

/**
 * The only filesystem write in Guardian. Deliberately does not `JSON.parse` + `JSON.stringify`
 * the whole file back out (that would reformat every line); instead it replaces exactly one
 * `"name": "version"` substring inside the correct section's brace-bounded text, byte for byte,
 * leaving everything else in the file untouched.
 */
export async function applyVersionBump(
  projectPath: string,
  dependency: string,
  dependencyType: DependencyType,
  previousDeclaredVersion: string,
  newDeclaredVersion: string,
): Promise<VersionBumpWriteResult | { readonly error: VersionBumpWriteError }> {
  const packageJsonPath = path.join(projectPath, "package.json");
  const field: "dependencies" | "devDependencies" =
    dependencyType === "dependency" ? "dependencies" : "devDependencies";

  let rawContents: string;
  try {
    rawContents = await readFile(packageJsonPath, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { error: "package-json-not-found" };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContents);
  } catch {
    return { error: "package-json-invalid" };
  }
  if (!isRecord(parsed)) {
    return { error: "package-json-invalid" };
  }
  const section = parsed[field];
  if (!isRecord(section) || section[dependency] !== previousDeclaredVersion) {
    return { error: "declared-version-mismatch" };
  }

  const span = findSectionSpan(rawContents, field);
  if (span === undefined) {
    return { error: "pattern-not-found" };
  }
  const sectionText = rawContents.slice(span.start, span.end);
  const pattern = `${JSON.stringify(dependency)}: ${JSON.stringify(previousDeclaredVersion)}`;
  const firstIndex = sectionText.indexOf(pattern);
  if (firstIndex === -1 || sectionText.indexOf(pattern, firstIndex + 1) !== -1) {
    return { error: "pattern-not-found" };
  }

  const absoluteIndex = span.start + firstIndex;
  const replacement = `${JSON.stringify(dependency)}: ${JSON.stringify(newDeclaredVersion)}`;
  const updatedContents = rawContents.slice(0, absoluteIndex)
    + replacement
    + rawContents.slice(absoluteIndex + pattern.length);

  await writeFile(packageJsonPath, updatedContents, "utf8");

  return {
    packageJsonPath,
    field,
    previousDeclaredVersion,
    newDeclaredVersion,
  };
}

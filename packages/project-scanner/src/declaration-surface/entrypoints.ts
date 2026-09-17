import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  DeclarationSurfaceIssue,
  DeclarationSurfaceLimits,
} from "./types.js";

export interface DeclarationEntrypointCandidate {
  exportPath: string;
  declarationFile: string;
  conditionPaths: string[][];
}

export interface PackageFile {
  absolutePath: string;
  relativePath: string;
  size: number;
  device: bigint;
  inode: bigint;
}

export type PackageFileResolution =
  | { status: "resolved"; file: PackageFile }
  | { status: "missing"; relativePath: string }
  | { status: "invalid" }
  | { status: "escape" };

export interface PackagePathResolver {
  packagePath: string;
  resolveFile(requestedPath: string): Promise<PackageFileResolution>;
}

interface TypeTargetResult {
  targets: TypeTarget[];
  ambiguous: boolean;
}

interface TypeTarget {
  declarationFile: string;
  conditionPath: string[];
}

interface EntrypointDiscoveryResult {
  entrypoints: DeclarationEntrypointCandidate[];
  issues: DeclarationSurfaceIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slashPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isContained(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function pathIsAbsoluteOnAnyPlatform(filePath: string): boolean {
  return path.posix.isAbsolute(filePath)
    || path.win32.isAbsolute(filePath)
    || /^[A-Za-z]:[\\/]/u.test(filePath)
    || filePath.startsWith("\\\\");
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

export async function createPackagePathResolver(
  packagePath: string,
): Promise<PackagePathResolver> {
  const canonicalPackagePath = await realpath(packagePath);

  return {
    packagePath: canonicalPackagePath,
    async resolveFile(requestedPath: string): Promise<PackageFileResolution> {
      if (
        requestedPath.length === 0
        || requestedPath.includes("\0")
        || requestedPath.includes("\\")
        || pathIsAbsoluteOnAnyPlatform(requestedPath)
      ) {
        return { status: "invalid" };
      }

      const withoutPrefix = requestedPath.startsWith("./")
        ? requestedPath.slice(2)
        : requestedPath;
      const normalized = path.posix.normalize(withoutPrefix);
      if (
        normalized === ".."
        || normalized.startsWith("../")
        || normalized === "."
      ) {
        return { status: normalized === "." ? "invalid" : "escape" };
      }

      const lexicalPath = path.resolve(canonicalPackagePath, ...normalized.split("/"));
      if (!isContained(canonicalPackagePath, lexicalPath)) {
        return { status: "escape" };
      }

      let canonicalPath: string;
      try {
        canonicalPath = await realpath(lexicalPath);
      } catch (error) {
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
          return { status: "missing", relativePath: normalized };
        }
        return { status: "invalid" };
      }
      if (!isContained(canonicalPackagePath, canonicalPath)) {
        return { status: "escape" };
      }

      try {
        const fileStat = await stat(canonicalPath, { bigint: true });
        if (!fileStat.isFile()) {
          return { status: "invalid" };
        }
        return {
          status: "resolved",
          file: {
            absolutePath: canonicalPath,
            relativePath: slashPath(path.relative(canonicalPackagePath, lexicalPath)),
            size: Number(fileStat.size),
            device: fileStat.dev,
            inode: fileStat.ino,
          },
        };
      } catch {
        return { status: "invalid" };
      }
    },
  };
}

function uniqueTargets(targets: TypeTarget[]): TypeTarget[] {
  const unique = new Map<string, TypeTarget>();
  for (const target of targets) {
    const key = `${target.declarationFile}\0${target.conditionPath.join("\0")}`;
    unique.set(key, target);
  }
  return [...unique.values()].sort((left, right) =>
    compareText(left.declarationFile, right.declarationFile)
    || compareText(left.conditionPath.join("\0"), right.conditionPath.join("\0")));
}

function declarationPathForExportTarget(target: string): string | undefined {
  if (/\.d\.(?:ts|mts|cts)$/u.test(target)) {
    return target;
  }
  if (target.endsWith(".mjs")) {
    return `${target.slice(0, -4)}.d.mts`;
  }
  if (target.endsWith(".cjs")) {
    return `${target.slice(0, -4)}.d.cts`;
  }
  if (target.endsWith(".jsx")) {
    return `${target.slice(0, -4)}.d.ts`;
  }
  if (target.endsWith(".js")) {
    return `${target.slice(0, -3)}.d.ts`;
  }
  return undefined;
}

function hasExportTarget(value: unknown): boolean {
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.some(hasExportTarget);
  }
  return isRecord(value) && Object.values(value).some(hasExportTarget);
}

function hasTypesCondition(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasTypesCondition);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.hasOwn(value, "types") || Object.values(value).some(hasTypesCondition);
}

function resolveTypesBranch(value: unknown, conditionPath: string[]): TypeTargetResult {
  if (typeof value === "string") {
    return {
      targets: [{ declarationFile: value, conditionPath }],
      ambiguous: false,
    };
  }
  if (Array.isArray(value)) {
    const resolved = value.map((item) => resolveTypesBranch(item, conditionPath));
    const targets = uniqueTargets(resolved.flatMap((item) => item.targets));
    const declarationFiles = new Set(targets.map((target) => target.declarationFile));
    return {
      targets,
      ambiguous: resolved.some((item) => item.ambiguous) || declarationFiles.size > 1,
    };
  }
  if (!isRecord(value)) {
    return { targets: [], ambiguous: true };
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return { targets: [], ambiguous: true };
  }
  const resolved = keys
    .sort(compareText)
    .map((condition) => resolveTypesBranch(value[condition], [...conditionPath, condition]));
  return {
    targets: uniqueTargets(resolved.flatMap((item) => item.targets)),
    ambiguous: resolved.some((item) => item.ambiguous),
  };
}

function resolveExportTypes(value: unknown, conditionPath: string[] = []): TypeTargetResult {
  if (typeof value === "string") {
    const declarationFile = declarationPathForExportTarget(value);
    return declarationFile !== undefined
      ? {
        targets: [{ declarationFile, conditionPath }],
        ambiguous: false,
      }
      : { targets: [], ambiguous: false };
  }
  if (Array.isArray(value)) {
    const resolved = value.map((item) => resolveExportTypes(item, conditionPath));
    const targets = uniqueTargets(resolved.flatMap((item) => item.targets));
    const declarationFiles = new Set(targets.map((target) => target.declarationFile));
    return {
      targets,
      ambiguous: resolved.some((item) => item.ambiguous) || declarationFiles.size > 1,
    };
  }
  if (!isRecord(value)) {
    return { targets: [], ambiguous: false };
  }
  if (Object.hasOwn(value, "types")) {
    return resolveTypesBranch(value.types, [...conditionPath, "types"]);
  }

  const resolved = Object.keys(value)
    .filter((condition) => !condition.startsWith("."))
    .sort(compareText)
    .map((condition) => resolveExportTypes(value[condition], [...conditionPath, condition]));
  return {
    targets: uniqueTargets(resolved.flatMap((item) => item.targets)),
    ambiguous: resolved.some((item) => item.ambiguous),
  };
}

function issueForResolution(
  resolution: Exclude<PackageFileResolution, { status: "resolved" }>,
  exportPath: string,
  declarationFile: string,
): DeclarationSurfaceIssue {
  if (resolution.status === "missing") {
    return {
      code: "declaration-file-missing",
      message: `Declaration file "${resolution.relativePath}" does not exist.`,
      exportPath,
      declarationFile: resolution.relativePath,
    };
  }
  if (resolution.status === "escape") {
    return {
      code: "declaration-path-escape",
      message: `Declaration path "${declarationFile}" escapes the package artifact.`,
      exportPath,
      declarationFile,
    };
  }
  return {
    code: "declaration-path-invalid",
    message: `Declaration path "${declarationFile}" is invalid.`,
    exportPath,
    declarationFile,
  };
}

function wildcardCount(value: string): number {
  return [...value].filter((character) => character === "*").length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function walkFiles(
  directoryPath: string,
  visitFile: (filePath: string) => Promise<boolean>,
): Promise<boolean> {
  async function visit(currentPath: string): Promise<boolean> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (!await visit(entryPath)) {
          return false;
        }
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (!await visitFile(entryPath)) {
          return false;
        }
      }
    }
    return true;
  }

  return visit(directoryPath);
}

async function expandPattern(
  resolver: PackagePathResolver,
  exportPattern: string,
  targetPattern: string,
  conditionPath: string[],
  limits: DeclarationSurfaceLimits,
): Promise<EntrypointDiscoveryResult> {
  const unsupported = (): EntrypointDiscoveryResult => ({
    entrypoints: [],
    issues: [{
      code: "unsupported-export-pattern",
      message: `Export pattern "${exportPattern}" cannot be expanded unambiguously.`,
      exportPath: exportPattern,
      declarationFile: targetPattern,
    }],
  });
  if (
    wildcardCount(exportPattern) !== 1
    || wildcardCount(targetPattern) !== 1
    || !exportPattern.startsWith("./")
    || !targetPattern.startsWith("./")
    || targetPattern.includes("\\")
    || !/\.d\.(?:ts|mts|cts)$/u.test(targetPattern)
  ) {
    return unsupported();
  }

  const wildcardIndex = targetPattern.indexOf("*");
  const staticPrefix = targetPattern.slice(2, wildcardIndex);
  const slashIndex = staticPrefix.lastIndexOf("/");
  const directory = slashIndex === -1 ? "." : staticPrefix.slice(0, slashIndex);
  const directoryPath = directory === "."
    ? resolver.packagePath
    : path.resolve(resolver.packagePath, ...directory.split("/"));
  if (!isContained(resolver.packagePath, directoryPath)) {
    return unsupported();
  }

  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpath(directoryPath);
    const directoryStat = await lstat(canonicalDirectory);
    if (!directoryStat.isDirectory() || !isContained(resolver.packagePath, canonicalDirectory)) {
      return unsupported();
    }
  } catch {
    return unsupported();
  }

  const normalizedTarget = targetPattern.slice(2);
  const [targetPrefix, targetSuffix] = normalizedTarget.split("*") as [string, string];
  const targetExpression = new RegExp(
    `^${escapeRegExp(targetPrefix)}(.+)${escapeRegExp(targetSuffix)}$`,
    "u",
  );
  const [exportPrefix, exportSuffix] = exportPattern.split("*") as [string, string];
  const matches: DeclarationEntrypointCandidate[] = [];
  let exceeded = false;
  try {
    await walkFiles(canonicalDirectory, async (absoluteFile) => {
      const relativeFile = slashPath(path.relative(resolver.packagePath, absoluteFile));
      const match = targetExpression.exec(relativeFile);
      const capture = match?.[1];
      if (capture === undefined) {
        return true;
      }
      if (matches.length >= limits.maxDeclarationFiles) {
        exceeded = true;
        return false;
      }
      const resolution = await resolver.resolveFile(relativeFile);
      if (resolution.status === "resolved") {
        matches.push({
          exportPath: `${exportPrefix}${capture}${exportSuffix}`,
          declarationFile: resolution.file.relativePath,
          conditionPaths: [[...conditionPath]],
        });
      }
      return true;
    });
  } catch {
    return unsupported();
  }

  matches.sort((left, right) =>
    compareText(left.exportPath, right.exportPath)
    || compareText(left.declarationFile, right.declarationFile));
  if (matches.length === 0) {
    return unsupported();
  }
  const duplicatePath = matches.find((candidate, index) =>
    index > 0 && matches[index - 1]?.exportPath === candidate.exportPath);
  if (duplicatePath !== undefined) {
    return unsupported();
  }
  if (exceeded) {
    return {
      entrypoints: matches,
      issues: [{
        code: "analysis-limit-exceeded",
        message: `Export pattern "${exportPattern}" exceeds maxDeclarationFiles (${limits.maxDeclarationFiles}).`,
        exportPath: exportPattern,
        limit: "maxDeclarationFiles",
      }],
    };
  }
  return { entrypoints: matches, issues: [] };
}

export async function discoverDeclarationEntrypoints(
  manifest: Record<string, unknown>,
  resolver: PackagePathResolver,
  limits: DeclarationSurfaceLimits,
): Promise<EntrypointDiscoveryResult> {
  const issues: DeclarationSurfaceIssue[] = [];
  let candidates: DeclarationEntrypointCandidate[] = [];
  let foundTypeMetadata = false;

  const addCandidate = (candidate: DeclarationEntrypointCandidate): void => {
    const existing = candidates.find((item) =>
      item.exportPath === candidate.exportPath
      && item.declarationFile === candidate.declarationFile);
    if (existing === undefined) {
      candidates.push(candidate);
      return;
    }
    const paths = new Map(existing.conditionPaths.map((conditionPath) => [
      conditionPath.join("\0"),
      conditionPath,
    ]));
    for (const conditionPath of candidate.conditionPaths) {
      paths.set(conditionPath.join("\0"), conditionPath);
    }
    existing.conditionPaths = [...paths.values()].sort((left, right) =>
      compareText(left.join("\0"), right.join("\0")));
  };

  if (Object.hasOwn(manifest, "typesVersions")) {
    issues.push({
      code: "unsupported-types-versions",
      message: "typesVersions mappings are not resolved by declaration surface extraction.",
    });
  }

  const exportEntries: Array<[string, unknown]> = [];
  let rootExportAllowed = manifest.exports === undefined;
  if (manifest.exports !== undefined) {
    const exportsValue = manifest.exports;
    if (isRecord(exportsValue)) {
      const keys = Object.keys(exportsValue);
      const subpathKeys = keys.filter((key) => key.startsWith("."));
      if (subpathKeys.length === keys.length && keys.length > 0) {
        rootExportAllowed = Object.hasOwn(exportsValue, ".") && exportsValue["."] !== null;
        for (const key of subpathKeys.sort(compareText)) {
          exportEntries.push([key, exportsValue[key]]);
        }
      } else if (subpathKeys.length === 0) {
        rootExportAllowed = hasExportTarget(exportsValue);
        exportEntries.push([".", exportsValue]);
      } else {
        issues.push({
          code: "unsupported-export-conditions",
          message: "exports mixes subpaths and conditions and cannot be resolved confidently.",
        });
      }
    } else if (typeof exportsValue === "string" || Array.isArray(exportsValue)) {
      rootExportAllowed = hasExportTarget(exportsValue);
      exportEntries.push([".", exportsValue]);
    }
  }

  const exactExportPaths = new Set(exportEntries
    .map(([exportPath]) => exportPath)
    .filter((exportPath) => !exportPath.includes("*")));
  const patternOwners = new Map<string, string>();
  const conflictingPatternPaths = new Set<string>();
  let rootTypesConditionPresent = false;

  for (const [exportPath, value] of exportEntries) {
    if (hasTypesCondition(value)) {
      foundTypeMetadata = true;
      if (exportPath === ".") {
        rootTypesConditionPresent = true;
      }
    }
    const resolved = resolveExportTypes(value);
    if (resolved.targets.length > 0) {
      foundTypeMetadata = true;
    }
    if (resolved.ambiguous) {
      issues.push({
        code: "unsupported-export-conditions",
        message: `Fallback type conditions for export "${exportPath}" are ambiguous.`,
        exportPath,
      });
      continue;
    }
    for (const target of resolved.targets) {
      if (exportPath.includes("*") || target.declarationFile.includes("*")) {
        const expanded = await expandPattern(
          resolver,
          exportPath,
          target.declarationFile,
          target.conditionPath,
          limits,
        );
        issues.push(...expanded.issues);
        for (const entrypoint of expanded.entrypoints) {
          if (exactExportPaths.has(entrypoint.exportPath)) {
            continue;
          }
          const owner = patternOwners.get(entrypoint.exportPath);
          if (owner !== undefined && owner !== exportPath) {
            if (!conflictingPatternPaths.has(entrypoint.exportPath)) {
              issues.push({
                code: "unsupported-export-pattern",
                message: `Overlapping export patterns produce "${entrypoint.exportPath}".`,
                exportPath: entrypoint.exportPath,
              });
              conflictingPatternPaths.add(entrypoint.exportPath);
            }
            candidates = candidates.filter((candidate) =>
              candidate.exportPath !== entrypoint.exportPath);
            continue;
          }
          if (!conflictingPatternPaths.has(entrypoint.exportPath)) {
            patternOwners.set(entrypoint.exportPath, exportPath);
            addCandidate(entrypoint);
          }
        }
        continue;
      }
      addCandidate({
        exportPath,
        declarationFile: target.declarationFile,
        conditionPaths: [[...target.conditionPath]],
      });
    }
  }

  const legacyTypes = typeof manifest.types === "string"
    ? manifest.types
    : typeof manifest.typings === "string"
      ? manifest.typings
      : undefined;
  if (legacyTypes !== undefined) {
    foundTypeMetadata = true;
    if (
      rootExportAllowed
      && !rootTypesConditionPresent
      && !candidates.some((candidate) => candidate.exportPath === ".")
    ) {
      addCandidate({
        exportPath: ".",
        declarationFile: legacyTypes,
        conditionPaths: [[typeof manifest.types === "string" ? "types" : "typings"]],
      });
    }
  } else if (
    (manifest.types !== undefined && typeof manifest.types !== "string")
    || (manifest.typings !== undefined && typeof manifest.typings !== "string")
  ) {
    foundTypeMetadata = true;
    issues.push({
      code: "declaration-path-invalid",
      message: "package.json types/typings must be a string declaration path.",
      exportPath: ".",
    });
  }

  if (!foundTypeMetadata && rootExportAllowed) {
    const fallback = await resolver.resolveFile("index.d.ts");
    if (fallback.status === "resolved") {
      addCandidate({
        exportPath: ".",
        declarationFile: fallback.file.relativePath,
        conditionPaths: [["fallback"]],
      });
    }
  }

  const entrypoints: DeclarationEntrypointCandidate[] = [];
  candidates.sort((left, right) =>
    compareText(left.exportPath, right.exportPath)
    || compareText(left.declarationFile, right.declarationFile));
  for (const candidate of candidates) {
    const { exportPath, declarationFile } = candidate;
    if (!/\.d\.(?:ts|mts|cts)$/u.test(declarationFile)) {
      issues.push({
        code: "declaration-path-invalid",
        message: `Declaration path "${declarationFile}" is not a declaration file.`,
        exportPath,
        declarationFile,
      });
      continue;
    }
    const resolution = await resolver.resolveFile(declarationFile);
    if (resolution.status !== "resolved") {
      issues.push(issueForResolution(resolution, exportPath, declarationFile));
      continue;
    }
    entrypoints.push({
      exportPath,
      declarationFile: resolution.file.relativePath,
      conditionPaths: candidate.conditionPaths,
    });
  }

  if (entrypoints.length === 0 && candidates.length === 0) {
    issues.push({
      code: "declaration-entrypoint-missing",
      message: "Package does not expose a TypeScript declaration entrypoint.",
    });
  }

  return { entrypoints, issues };
}

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parseAllDocuments } from "yaml";

import { ProjectScanError } from "../errors.js";
import type { DependencyInfo } from "../types.js";
import type {
  DependencyResolutionIssue,
  DependencyResolutionKind,
  InstalledDependencyResolution,
} from "./types.js";

const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface PnpmWorkspaceContext {
  workspaceRoot: string;
  lockfilePath?: string;
  importer: string;
}

interface LockedPnpmWorkspaceContext extends PnpmWorkspaceContext {
  lockfilePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw new ProjectScanError(
      "PROJECT_UNREADABLE",
      `Could not inspect ${filePath} while discovering the pnpm workspace.`,
      { cause: error },
    );
  }
}

function posixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function importerKey(workspaceRoot: string, projectPath: string): string {
  const relativePath = posixPath(path.relative(workspaceRoot, projectPath));
  return relativePath === "" ? "." : relativePath;
}

export async function discoverPnpmWorkspace(
  projectPath: string,
): Promise<PnpmWorkspaceContext | undefined> {
  let currentPath = path.resolve(projectPath);

  while (true) {
    const lockfilePath = path.join(currentPath, "pnpm-lock.yaml");
    const workspaceFilePath = path.join(currentPath, "pnpm-workspace.yaml");
    const [hasLockfile, hasWorkspaceFile] = await Promise.all([
      fileExists(lockfilePath),
      fileExists(workspaceFilePath),
    ]);

    if ((currentPath === path.resolve(projectPath) && hasLockfile) || hasWorkspaceFile) {
      return {
        workspaceRoot: currentPath,
        ...(hasLockfile ? { lockfilePath } : {}),
        importer: importerKey(currentPath, projectPath),
      };
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }
    currentPath = parentPath;
  }
}

function protocolKind(reference: string): DependencyResolutionKind | undefined {
  if (reference.startsWith("workspace:")) {
    return "workspace";
  }
  if (reference.startsWith("link:")) {
    return "link";
  }
  if (reference.startsWith("file:")) {
    return "file";
  }
  if (
    reference.startsWith("git:")
    || reference.startsWith("git+")
    || reference.startsWith("github:")
    || reference.startsWith("gitlab:")
    || reference.startsWith("bitbucket:")
    || reference.startsWith("ssh://")
  ) {
    return "git";
  }
  if (reference.startsWith("http:") || reference.startsWith("https:")) {
    return "url";
  }
  return undefined;
}

function registryVersion(reference: string): string | undefined {
  const suffixStart = reference.indexOf("(");
  const version = suffixStart === -1 ? reference : reference.slice(0, suffixStart);
  if (!EXACT_SEMVER.test(version)) {
    return undefined;
  }
  if (suffixStart === -1) {
    return version;
  }

  let index = suffixStart;
  while (index < reference.length) {
    if (reference[index] !== "(") {
      return undefined;
    }
    const contentStart = index + 1;
    let depth = 1;
    index += 1;
    while (index < reference.length && depth > 0) {
      if (reference[index] === "(") {
        depth += 1;
      } else if (reference[index] === ")") {
        depth -= 1;
      }
      index += 1;
    }
    if (depth !== 0 || index === contentStart + 1) {
      return undefined;
    }
  }

  return version;
}

function resolutionKind(
  declaredVersion: string,
  resolvedReference: string | undefined,
): DependencyResolutionKind {
  const declaredKind = protocolKind(declaredVersion);
  if (declaredKind !== undefined) {
    return declaredKind;
  }
  if (resolvedReference !== undefined) {
    const kind = protocolKind(resolvedReference);
    if (kind !== undefined) {
      return kind;
    }
    if (registryVersion(resolvedReference) !== undefined) {
      return "registry";
    }
  }
  return "unknown";
}

function unresolvedResolution(
  dependency: DependencyInfo,
  context: PnpmWorkspaceContext,
  issue: DependencyResolutionIssue,
  details: {
    kind?: DependencyResolutionKind;
    lockfileSpecifier?: string;
    resolvedReference?: string;
    resolvedVersion?: string;
  } = {},
): InstalledDependencyResolution {
  return {
    dependency: dependency.name,
    dependencyType: dependency.type,
    declaredVersion: dependency.declaredVersion,
    kind: details.kind ?? "unknown",
    status: "unresolved",
    issue,
    workspaceRoot: context.workspaceRoot,
    ...(context.lockfilePath === undefined ? {} : { lockfilePath: context.lockfilePath }),
    importer: context.importer,
    ...(details.lockfileSpecifier === undefined
      ? {}
      : { lockfileSpecifier: details.lockfileSpecifier }),
    ...(details.resolvedReference === undefined
      ? {}
      : { resolvedReference: details.resolvedReference }),
    ...(details.resolvedVersion === undefined
      ? {}
      : { resolvedVersion: details.resolvedVersion }),
  };
}

function resolutionForEntry(
  dependency: DependencyInfo,
  entry: unknown,
  context: LockedPnpmWorkspaceContext,
): InstalledDependencyResolution {
  if (entry === undefined) {
    return unresolvedResolution(dependency, context, "dependency-not-found", {
      kind: resolutionKind(dependency.declaredVersion, undefined),
    });
  }
  if (!isRecord(entry)) {
    return unresolvedResolution(dependency, context, "invalid-entry");
  }

  const lockfileSpecifier = typeof entry.specifier === "string" ? entry.specifier : undefined;
  const resolvedReference = typeof entry.version === "string" ? entry.version : undefined;
  const kind = resolutionKind(dependency.declaredVersion, resolvedReference);
  const resolvedVersion = resolvedReference === undefined
    ? undefined
    : registryVersion(resolvedReference);
  const details = {
    kind,
    ...(lockfileSpecifier === undefined ? {} : { lockfileSpecifier }),
    ...(resolvedReference === undefined ? {} : { resolvedReference }),
    ...(resolvedVersion === undefined ? {} : { resolvedVersion }),
  };

  if (lockfileSpecifier === undefined || resolvedReference === undefined) {
    return unresolvedResolution(dependency, context, "invalid-entry", details);
  }
  if (lockfileSpecifier !== dependency.declaredVersion) {
    return unresolvedResolution(dependency, context, "specifier-mismatch", details);
  }
  if (kind === "unknown" || (kind === "registry" && resolvedVersion === undefined)) {
    return unresolvedResolution(dependency, context, "unrecognized-reference", details);
  }

  const referenceKind = protocolKind(resolvedReference);
  const isCompatibleReference = kind === "registry"
    || (kind === "workspace" && (referenceKind === "workspace" || referenceKind === "link"))
    || (kind === "git" && (referenceKind === "git" || referenceKind === "url"))
    || referenceKind === kind;
  if (!isCompatibleReference) {
    return unresolvedResolution(dependency, context, "unrecognized-reference", details);
  }

  return {
    dependency: dependency.name,
    dependencyType: dependency.type,
    declaredVersion: dependency.declaredVersion,
    lockfileSpecifier,
    ...(resolvedVersion === undefined ? {} : { resolvedVersion }),
    resolvedReference,
    kind,
    status: "resolved",
    workspaceRoot: context.workspaceRoot,
    lockfilePath: context.lockfilePath,
    importer: context.importer,
  };
}

async function readPnpmLockfile(lockfilePath: string): Promise<Record<string, unknown>> {
  let contents: string;
  try {
    contents = await readFile(lockfilePath, "utf8");
  } catch (error) {
    throw new ProjectScanError(
      "PNPM_LOCKFILE_UNREADABLE",
      `Could not read pnpm lockfile at ${lockfilePath}.`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    const documents = parseAllDocuments(contents);
    const documentError = documents.flatMap((document) => document.errors)[0];
    if (documentError !== undefined) {
      throw documentError;
    }
    parsed = documents.filter((document) => document.contents !== null).at(-1)?.toJS();
  } catch (error) {
    throw new ProjectScanError(
      "PNPM_LOCKFILE_INVALID",
      `Invalid YAML in pnpm lockfile at ${lockfilePath}.`,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw new ProjectScanError(
      "PNPM_LOCKFILE_INVALID_STRUCTURE",
      `pnpm lockfile at ${lockfilePath} must contain a YAML mapping.`,
    );
  }

  const lockfileVersion = parsed.lockfileVersion;
  const normalizedLockfileVersion = String(lockfileVersion);
  if (
    (typeof lockfileVersion !== "string" && typeof lockfileVersion !== "number")
    || (normalizedLockfileVersion !== "9" && normalizedLockfileVersion !== "9.0")
  ) {
    throw new ProjectScanError(
      "PNPM_LOCKFILE_UNSUPPORTED_VERSION",
      `pnpm lockfile at ${lockfilePath} must use lockfile version 9.`,
    );
  }
  return parsed;
}

export async function resolvePnpmDependencies(
  projectPath: string,
  dependencies: DependencyInfo[],
): Promise<InstalledDependencyResolution[]> {
  const context = await discoverPnpmWorkspace(projectPath);
  if (context?.lockfilePath === undefined) {
    const unresolvedContext = context ?? {
      workspaceRoot: path.resolve(projectPath),
      importer: ".",
    };
    return dependencies.map((dependency) =>
      unresolvedResolution(dependency, unresolvedContext, "lockfile-not-found"));
  }

  const lockedContext: LockedPnpmWorkspaceContext = {
    ...context,
    lockfilePath: context.lockfilePath,
  };

  const lockfile = await readPnpmLockfile(lockedContext.lockfilePath);
  if (!isRecord(lockfile.importers)) {
    throw new ProjectScanError(
      "PNPM_LOCKFILE_INVALID_STRUCTURE",
      `pnpm lockfile at ${lockedContext.lockfilePath} does not contain an importers mapping.`,
    );
  }

  const importer = lockfile.importers[lockedContext.importer];
  if (!isRecord(importer)) {
    throw new ProjectScanError(
      "PNPM_IMPORTER_NOT_FOUND",
      `Importer "${lockedContext.importer}" was not found in ${lockedContext.lockfilePath}.`,
    );
  }

  const sections = new Map<string, Record<string, unknown>>();
  for (const sectionName of ["dependencies", "devDependencies"] as const) {
    const section = importer[sectionName];
    if (section !== undefined && !isRecord(section)) {
      throw new ProjectScanError(
        "PNPM_LOCKFILE_INVALID_STRUCTURE",
        `Importer "${lockedContext.importer}" has an invalid ${sectionName} mapping.`,
      );
    }
    sections.set(sectionName, section ?? {});
  }

  return dependencies.map((dependency) => {
    const sectionName = dependency.type === "dependency" ? "dependencies" : "devDependencies";
    return resolutionForEntry(
      dependency,
      sections.get(sectionName)?.[dependency.name],
      lockedContext,
    );
  });
}

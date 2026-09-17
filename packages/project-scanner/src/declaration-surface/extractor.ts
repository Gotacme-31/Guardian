import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { Project, ts, type SourceFile } from "ts-morph";

import type { AcquiredPackageArtifact } from "../package-artifact/types.js";
import {
  createPackagePathResolver,
  discoverDeclarationEntrypoints,
  type PackageFileResolution,
  type PackageFile,
  type PackagePathResolver,
} from "./entrypoints.js";
import {
  copyDeclaration,
  extractFileDeclarationModel,
  type AnalysisBudget,
  type FileDeclarationModel,
  type ImportBinding,
  type InternalDeclaration,
} from "./signatures.js";
import type {
  DeclarationEntrypoint,
  DeclarationSurfaceIssue,
  DeclarationSurfaceLimits,
  DeclarationSurfaceOptions,
  PackageDeclarationSurface,
  PublicApiDeclaration,
  PublicApiMember,
  ReferencedApiDeclaration,
} from "./types.js";

export const DEFAULT_DECLARATION_SURFACE_LIMITS: Readonly<DeclarationSurfaceLimits> = {
  maxDeclarationFiles: 512,
  maxReexportDepth: 64,
  maxDeclarations: 10_000,
  maxMembers: 50_000,
  maxDeclarationFileBytes: 5 * 1024 * 1024,
};

interface ModuleResolution {
  kind: "internal";
  declarationFile: string;
}

interface ResolutionContext {
  exportPath: string;
  sourceFile: string;
  specifier: string;
}

interface PackageFileContents {
  contents: string;
  size: number;
}

class PackageFileSizeLimitError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitsWithDefaults(
  overrides: Partial<DeclarationSurfaceLimits> | undefined,
): DeclarationSurfaceLimits {
  const limits = { ...DEFAULT_DECLARATION_SURFACE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`Declaration surface limit ${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

async function readPackageFile(
  file: PackageFile,
  maximumBytes?: number,
): Promise<PackageFileContents> {
  const handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fileStat = await handle.stat({ bigint: true });
    if (
      !fileStat.isFile()
      || fileStat.dev !== file.device
      || fileStat.ino !== file.inode
    ) {
      throw new Error("Package path is not a regular file.");
    }
    if (maximumBytes !== undefined && fileStat.size > BigInt(maximumBytes)) {
      throw new PackageFileSizeLimitError();
    }
    let contents: Buffer;
    if (maximumBytes === undefined) {
      contents = await handle.readFile();
    } else {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let position = 0;
      while (totalBytes <= maximumBytes) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - totalBytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
        if (bytesRead === 0) {
          break;
        }
        chunks.push(buffer.subarray(0, bytesRead));
        totalBytes += bytesRead;
        position += bytesRead;
      }
      if (totalBytes > maximumBytes) {
        throw new PackageFileSizeLimitError();
      }
      contents = Buffer.concat(chunks, totalBytes);
    }
    const finalStat = await handle.stat({ bigint: true });
    if (finalStat.dev !== file.device || finalStat.ino !== file.inode) {
      throw new Error("Package file identity changed during analysis.");
    }
    return {
      contents: contents.toString("utf8"),
      size: contents.byteLength,
    };
  } finally {
    await handle.close();
  }
}

function issueKey(issue: DeclarationSurfaceIssue): string {
  return [
    issue.code,
    issue.exportPath ?? "",
    issue.declarationFile ?? "",
    issue.sourceFile ?? "",
    issue.specifier ?? "",
    issue.limit ?? "",
    issue.message,
  ].join("\0");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortIssues(issues: Iterable<DeclarationSurfaceIssue>): DeclarationSurfaceIssue[] {
  return [...issues].sort((left, right) => compareText(issueKey(left), issueKey(right)));
}

function compareMembers(left: PublicApiMember, right: PublicApiMember): number {
  return compareText(left.name, right.name)
    || compareText(left.kind, right.kind)
    || compareText(left.visibility, right.visibility)
    || Number(left.static) - Number(right.static)
    || Number(left.optional) - Number(right.optional)
    || Number(left.readonly) - Number(right.readonly)
    || Number(left.abstract) - Number(right.abstract)
    || compareText(JSON.stringify(left.signatures), JSON.stringify(right.signatures));
}

function normalizedMembers(members: readonly PublicApiMember[]): PublicApiMember[] {
  return members.map((member) => ({
    ...member,
    signatures: [...new Set(member.signatures)].sort(compareText),
  })).sort(compareMembers);
}

function internalSortKey(declaration: InternalDeclaration): string {
  const members = declaration.members === undefined
    ? ""
    : JSON.stringify(normalizedMembers(declaration.members));
  const namespaceExports = declaration.namespaceExports === undefined
    ? ""
    : declaration.namespaceExports.map(internalSortKey).sort(compareText).join("\u0001");
  return [
    declaration.exportedName,
    declaration.kind,
    declaration.sourceFile,
    JSON.stringify([...declaration.signatures].sort()),
    members,
    namespaceExports,
    declaration.exportEquals,
    declaration.typeOnly,
    declaration.externalModule ?? "",
    declaration.importedName ?? "",
  ].join("\0");
}

function compareInternalDeclarations(
  left: InternalDeclaration,
  right: InternalDeclaration,
): number {
  return compareText(left.exportedName, right.exportedName)
    || compareText(left.sourceFile, right.sourceFile)
    || left.sourceOrder - right.sourceOrder
    || compareText(left.kind, right.kind)
    || compareText(internalSortKey(left), internalSortKey(right));
}

function deduplicateDeclarations(
  declarations: readonly InternalDeclaration[],
): InternalDeclaration[] {
  const unique = new Map<string, InternalDeclaration>();
  for (const declaration of declarations) {
    const key = [
      declaration.exportedName,
      declaration.originId,
      declaration.externalModule ?? "",
      declaration.importedName ?? "",
      declaration.exportEquals,
      declaration.typeOnly,
    ].join("\0");
    if (!unique.has(key)) {
      unique.set(key, declaration);
    }
  }
  return [...unique.values()].sort(compareInternalDeclarations);
}

function publicDeclarations(
  declarations: readonly InternalDeclaration[],
): PublicApiDeclaration[] {
  const facets = new Map<string, number>();
  return deduplicateDeclarations(declarations).map((declaration) => {
    const facet = (facets.get(declaration.exportedName) ?? 0) + 1;
    facets.set(declaration.exportedName, facet);
    const base = {
      exportedName: declaration.exportedName,
      kind: declaration.kind,
      facet,
      sourceFile: declaration.sourceFile,
      defaultExport: declaration.defaultExport,
      exportEquals: declaration.exportEquals,
      typeOnly: declaration.typeOnly,
      signatures: [...new Set(declaration.signatures)]
        .sort(compareText),
      deprecated: declaration.deprecated,
    };
    if (
      declaration.kind === "class"
      || declaration.kind === "interface"
      || declaration.kind === "enum"
    ) {
      return {
        ...base,
        kind: declaration.kind,
        members: normalizedMembers(declaration.members ?? []),
      };
    }
    if (declaration.kind === "namespace") {
      return {
        ...base,
        kind: "namespace",
        exports: publicDeclarations(declaration.namespaceExports ?? []),
      };
    }
    if (declaration.kind === "external-reexport") {
      return {
        ...base,
        kind: "external-reexport",
        externalModule: declaration.externalModule ?? "",
        importedName: declaration.importedName ?? "",
      };
    }
    return {
      ...base,
      kind: declaration.kind,
    };
  });
}

function referencedApiDeclarations(
  declarations: readonly InternalDeclaration[],
): ReferencedApiDeclaration[] {
  const facets = new Map<string, number>();
  return deduplicateDeclarations(declarations).map((declaration) => {
    const facet = (facets.get(declaration.exportedName) ?? 0) + 1;
    facets.set(declaration.exportedName, facet);
    const base = {
      name: declaration.exportedName,
      kind: declaration.kind,
      facet,
      sourceFile: declaration.sourceFile,
      typeOnly: declaration.typeOnly,
      signatures: [...new Set(declaration.signatures)].sort(compareText),
      deprecated: declaration.deprecated,
    };
    if (
      declaration.kind === "class"
      || declaration.kind === "interface"
      || declaration.kind === "enum"
    ) {
      return {
        ...base,
        kind: declaration.kind,
        members: normalizedMembers(declaration.members ?? []),
      };
    }
    if (declaration.kind === "namespace") {
      return {
        ...base,
        kind: "namespace",
        declarations: referencedApiDeclarations(declaration.namespaceExports ?? []),
      };
    }
    if (declaration.kind === "external-reexport") {
      return {
        ...base,
        kind: "external-reexport",
        externalModule: declaration.externalModule ?? "",
        importedName: declaration.importedName ?? "",
      };
    }
    return {
      ...base,
      kind: declaration.kind,
    };
  });
}

function moduleCandidates(sourceFile: string, specifier: string): string[] | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  if (specifier.includes("\0") || specifier.includes("\\")) {
    return [];
  }
  const sourceDirectory = path.posix.dirname(sourceFile);
  const target = path.posix.join(sourceDirectory, specifier);
  if (/\.d\.(?:ts|mts|cts)$/u.test(target)) {
    return [target];
  }
  if (target.endsWith(".mjs")) {
    return [`${target.slice(0, -4)}.d.mts`];
  }
  if (target.endsWith(".cjs")) {
    return [`${target.slice(0, -4)}.d.cts`];
  }
  if (target.endsWith(".js") || target.endsWith(".jsx")) {
    const extensionLength = target.endsWith(".jsx") ? 4 : 3;
    return [`${target.slice(0, -extensionLength)}.d.ts`];
  }
  if (path.posix.extname(target) !== "") {
    return [];
  }
  return [
    `${target}.d.ts`,
    `${target}.d.mts`,
    `${target}.d.cts`,
    `${target}/index.d.ts`,
    `${target}/index.d.mts`,
    `${target}/index.d.cts`,
  ];
}

function resolutionIssue(
  resolution: Exclude<PackageFileResolution, { status: "resolved" }>,
  context: ResolutionContext,
): DeclarationSurfaceIssue {
  if (resolution.status === "escape") {
    return {
      code: "declaration-path-escape",
      message: `Re-export "${context.specifier}" escapes the package artifact.`,
      exportPath: context.exportPath,
      sourceFile: context.sourceFile,
      specifier: context.specifier,
    };
  }
  if (resolution.status === "invalid") {
    return {
      code: "declaration-path-invalid",
      message: `Re-export "${context.specifier}" has an invalid declaration path.`,
      exportPath: context.exportPath,
      sourceFile: context.sourceFile,
      specifier: context.specifier,
    };
  }
  return {
    code: "unresolved-reexport",
    message: `Relative re-export "${context.specifier}" cannot be resolved inside the artifact.`,
    exportPath: context.exportPath,
    sourceFile: context.sourceFile,
    specifier: context.specifier,
  };
}

export async function extractDeclarationSurface(
  artifact: AcquiredPackageArtifact,
  options: DeclarationSurfaceOptions = {},
): Promise<PackageDeclarationSurface> {
  const limits = limitsWithDefaults(options.limits);
  const issueMap = new Map<string, DeclarationSurfaceIssue>();
  const addIssue = (issue: DeclarationSurfaceIssue): void => {
    issueMap.set(issueKey(issue), issue);
  };
  const emptySurface = (): PackageDeclarationSurface => ({
    packageName: artifact.dependency,
    version: artifact.version,
    entrypoints: [],
    issues: sortIssues(issueMap.values()),
  });

  let resolver: PackagePathResolver;
  try {
    resolver = await createPackagePathResolver(artifact.packagePath);
  } catch {
    addIssue({
      code: "package-json-missing",
      message: "Artifact package directory is unavailable.",
    });
    return emptySurface();
  }

  const manifestResolution = await resolver.resolveFile("package.json");
  if (manifestResolution.status !== "resolved") {
    addIssue({
      code: manifestResolution.status === "missing"
        ? "package-json-missing"
        : "package-json-invalid",
      message: manifestResolution.status === "missing"
        ? "Artifact package.json does not exist."
        : "Artifact package.json path is invalid or escapes the package.",
    });
    return emptySurface();
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse((await readPackageFile(manifestResolution.file)).contents);
  } catch {
    addIssue({
      code: "package-json-invalid",
      message: "Artifact package.json is not valid JSON or cannot be read.",
    });
    return emptySurface();
  }
  if (
    !isRecord(manifest)
    || manifest.name !== artifact.dependency
    || manifest.version !== artifact.version
  ) {
    addIssue({
      code: "package-json-invalid",
      message: "Artifact package.json identity does not match the acquired artifact.",
    });
    return emptySurface();
  }

  const discovery = await discoverDeclarationEntrypoints(manifest, resolver, limits);
  discovery.issues.forEach(addIssue);

  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ESNext,
      noLib: true,
      skipLibCheck: true,
    },
  });
  const models = new Map<string, FileDeclarationModel | null>();
  const resolvedExports = new Map<string, Promise<InternalDeclaration[]>>();
  const cycleAffectedFiles = new Set<string>();
  const sourceFiles = new Map<string, SourceFile>();
  const budget: AnalysisBudget = {
    declarations: 0,
    members: 0,
    maxDeclarations: limits.maxDeclarations,
    maxMembers: limits.maxMembers,
  };

  async function loadModel(
    declarationFile: string,
    exportPath: string,
  ): Promise<FileDeclarationModel | undefined> {
    if (models.has(declarationFile)) {
      return models.get(declarationFile) ?? undefined;
    }
    if (models.size >= limits.maxDeclarationFiles) {
      addIssue({
        code: "analysis-limit-exceeded",
        message: `Declaration analysis exceeds maxDeclarationFiles (${limits.maxDeclarationFiles}).`,
        exportPath,
        declarationFile,
        limit: "maxDeclarationFiles",
      });
      return undefined;
    }

    const resolution = await resolver.resolveFile(declarationFile);
    if (resolution.status !== "resolved") {
      addIssue(resolutionIssue(resolution, {
        exportPath,
        sourceFile: declarationFile,
        specifier: declarationFile,
      }));
      models.set(declarationFile, null);
      return undefined;
    }
    let fileContents: PackageFileContents;
    try {
      fileContents = await readPackageFile(
        resolution.file,
        limits.maxDeclarationFileBytes,
      );
    } catch (error) {
      if (error instanceof PackageFileSizeLimitError) {
        addIssue({
          code: "analysis-limit-exceeded",
          message: `Declaration file "${resolution.file.relativePath}" exceeds maxDeclarationFileBytes (${limits.maxDeclarationFileBytes}).`,
          exportPath,
          declarationFile: resolution.file.relativePath,
          limit: "maxDeclarationFileBytes",
        });
        models.set(declarationFile, null);
        return undefined;
      }
      addIssue({
        code: "declaration-file-invalid",
        message: `Declaration file "${resolution.file.relativePath}" cannot be read.`,
        exportPath,
        declarationFile: resolution.file.relativePath,
      });
      models.set(declarationFile, null);
      return undefined;
    }
    const virtualPath = path.posix.join("/package", resolution.file.relativePath);
    const sourceFile = project.createSourceFile(virtualPath, fileContents.contents, { overwrite: true });
    sourceFiles.set(resolution.file.relativePath, sourceFile);
    const diagnostics = project.getProgram().getSyntacticDiagnostics(sourceFile);
    if (diagnostics.length > 0) {
      addIssue({
        code: "declaration-file-invalid",
        message: `Declaration file "${resolution.file.relativePath}" contains ${diagnostics.length} syntax error(s).`,
        exportPath,
        declarationFile: resolution.file.relativePath,
      });
      models.set(declarationFile, null);
      return undefined;
    }
    const model = extractFileDeclarationModel(
      sourceFile.compilerNode,
      resolution.file.relativePath,
      budget,
      addIssue,
    );
    models.set(resolution.file.relativePath, model);
    if (resolution.file.relativePath !== declarationFile) {
      models.set(declarationFile, model);
    }
    return model;
  }

  async function resolveModule(
    context: ResolutionContext,
  ): Promise<ModuleResolution | undefined> {
    const candidates = moduleCandidates(context.sourceFile, context.specifier);
    if (candidates === undefined) {
      return undefined;
    }
    if (candidates.length === 0) {
      addIssue({
        code: "declaration-path-invalid",
        message: `Relative re-export "${context.specifier}" is not a supported declaration path.`,
        exportPath: context.exportPath,
        sourceFile: context.sourceFile,
        specifier: context.specifier,
      });
      return undefined;
    }
    let lastResolution: Exclude<PackageFileResolution, { status: "resolved" }> = {
      status: "missing",
      relativePath: candidates[0] ?? context.specifier,
    };
    for (const candidate of candidates) {
      const resolution = await resolver.resolveFile(candidate);
      if (resolution.status === "resolved") {
        return { kind: "internal", declarationFile: resolution.file.relativePath };
      }
      lastResolution = resolution;
      if (resolution.status === "escape" || resolution.status === "invalid") {
        break;
      }
    }
    addIssue(resolutionIssue(lastResolution, context));
    return undefined;
  }

  function externalDeclaration(
    originId: string,
    sourceFile: string,
    exportedName: string,
    importedName: string,
    externalModule: string,
    typeOnly: boolean,
  ): InternalDeclaration {
    return {
      originId: `${originId}:${exportedName}:${importedName}`,
      sourceOrder: 0,
      exportedName,
      kind: "external-reexport",
      sourceFile,
      defaultExport: exportedName === "default",
      exportEquals: false,
      typeOnly,
      references: [],
      importTypeReferences: [],
      signatures: [],
      deprecated: false,
      externalModule,
      importedName,
    };
  }

  function reportExternal(
    exportPath: string,
    sourceFile: string,
    specifier: string,
  ): void {
    addIssue({
      code: "external-reexport",
      message: `External re-export "${specifier}" is represented without resolving the dependency.`,
      exportPath,
      sourceFile,
      specifier,
    });
  }

  async function followInternal(
    targetFile: string,
    context: ResolutionContext,
    depth: number,
    stack: ReadonlySet<string>,
  ): Promise<InternalDeclaration[]> {
    if (stack.has(targetFile)) {
      const stackFiles = [...stack];
      const cycleStart = stackFiles.indexOf(targetFile);
      const cycleFiles = cycleStart === -1
        ? [targetFile]
        : stackFiles.slice(cycleStart);
      for (const file of cycleFiles) {
        cycleAffectedFiles.add(JSON.stringify([context.exportPath, file]));
      }
      addIssue({
        code: "reexport-cycle",
        message: `Re-export cycle reaches "${targetFile}".`,
        exportPath: context.exportPath,
        sourceFile: context.sourceFile,
        specifier: context.specifier,
      });
      const cyclicModel = await loadModel(targetFile, context.exportPath);
      if (cyclicModel === undefined) {
        return [];
      }
      const directDeclarations = [...cyclicModel.immediateExports];
      for (const binding of cyclicModel.exportBindings) {
        const locals = cyclicModel.locals.get(binding.localName) ?? [];
        const candidates = binding.originId === undefined
          ? locals
          : locals.filter((declaration) => declaration.originId === binding.originId);
        directDeclarations.push(...candidates.map((declaration) =>
          copyDeclaration(declaration, binding.exportedName, binding)));
      }
      return deduplicateDeclarations(directDeclarations);
    }
    if (depth >= limits.maxReexportDepth) {
      addIssue({
        code: "analysis-limit-exceeded",
        message: `Re-export analysis exceeds maxReexportDepth (${limits.maxReexportDepth}).`,
        exportPath: context.exportPath,
        sourceFile: context.sourceFile,
        specifier: context.specifier,
        limit: "maxReexportDepth",
      });
      return [];
    }
    return resolveFileExports(targetFile, context.exportPath, depth + 1, stack);
  }

  async function resolveImportBinding(
    binding: ImportBinding,
    exportedName: string,
    sourceFile: string,
    exportPath: string,
    depth: number,
    stack: ReadonlySet<string>,
    options: { exportEquals: boolean; typeOnly: boolean },
  ): Promise<InternalDeclaration[]> {
    const effectiveOptions = {
      exportEquals: options.exportEquals,
      typeOnly: options.typeOnly || binding.typeOnly,
    };
    const context = { exportPath, sourceFile, specifier: binding.specifier };
    const resolution = await resolveModule(context);
    if (resolution === undefined) {
      if (!binding.specifier.startsWith(".")) {
        reportExternal(exportPath, sourceFile, binding.specifier);
        return [externalDeclaration(
          `${sourceFile}:import:${binding.specifier}`,
          sourceFile,
          exportedName,
          binding.importedName,
          binding.specifier,
          effectiveOptions.typeOnly,
        )];
      }
      return [];
    }
    const targetExports = await followInternal(
      resolution.declarationFile,
      context,
      depth,
      stack,
    );
    if (binding.namespace) {
      return [{
        originId: `${sourceFile}:namespace-import:${binding.specifier}`,
        sourceOrder: 0,
        exportedName,
        kind: "namespace",
        sourceFile,
        defaultExport: exportedName === "default",
        exportEquals: effectiveOptions.exportEquals,
        typeOnly: effectiveOptions.typeOnly,
        references: [],
        importTypeReferences: [],
        signatures: ["namespace"],
        deprecated: false,
        namespaceExports: targetExports,
      }];
    }
    return targetExports
      .filter((declaration) => declaration.exportedName === binding.importedName)
      .map((declaration) => copyDeclaration(declaration, exportedName, effectiveOptions));
  }

  async function resolveFileExports(
    declarationFile: string,
    exportPath: string,
    depth: number,
    stack: ReadonlySet<string>,
  ): Promise<InternalDeclaration[]> {
    const fileKey = JSON.stringify([exportPath, declarationFile]);
    if (cycleAffectedFiles.has(fileKey)) {
      return resolveFileExportsUncached(declarationFile, exportPath, depth, stack);
    }
    const cacheKey = JSON.stringify([exportPath, declarationFile, depth]);
    const cached = resolvedExports.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const pending = resolveFileExportsUncached(declarationFile, exportPath, depth, stack);
    resolvedExports.set(cacheKey, pending);
    try {
      const declarations = await pending;
      if (cycleAffectedFiles.has(fileKey)) {
        resolvedExports.delete(cacheKey);
      }
      return declarations;
    } catch (error) {
      resolvedExports.delete(cacheKey);
      throw error;
    }
  }

  async function resolveFileExportsUncached(
    declarationFile: string,
    exportPath: string,
    depth: number,
    stack: ReadonlySet<string>,
  ): Promise<InternalDeclaration[]> {
    const model = await loadModel(declarationFile, exportPath);
    if (model === undefined) {
      return [];
    }
    const nextStack = new Set(stack);
    nextStack.add(declarationFile);
    const declarations = [...model.immediateExports];
    const starExports: Array<{
      declarations: InternalDeclaration[];
      sourceFile: string;
      specifier: string;
    }> = [];
    const explicitNames = new Set([
      ...model.immediateExports.map((declaration) => declaration.exportedName),
      ...model.exportBindings.map((binding) => binding.exportedName),
      ...model.reexports.flatMap((reexport) => reexport.mode === "named"
        ? reexport.bindings.map((binding) => binding.exportedName)
        : reexport.mode === "namespace"
          ? [reexport.exportedName]
          : []),
    ]);

    for (const binding of model.exportBindings) {
      const locals = model.locals.get(binding.localName);
      if (locals !== undefined) {
        const candidates = binding.originId === undefined
          ? locals
          : locals.filter((declaration) => declaration.originId === binding.originId);
        declarations.push(...candidates.map((declaration) =>
          copyDeclaration(declaration, binding.exportedName, binding)));
        continue;
      }
      const imported = model.imports.get(binding.localName);
      if (imported !== undefined) {
        declarations.push(...await resolveImportBinding(
          imported,
          binding.exportedName,
          declarationFile,
          exportPath,
          depth,
          nextStack,
          binding,
        ));
      } else {
        addIssue({
          code: "unresolved-reexport",
          message: `Exported local name "${binding.localName}" cannot be resolved.`,
          exportPath,
          sourceFile: declarationFile,
          specifier: binding.localName,
        });
      }
    }

    for (const reexport of model.reexports) {
      const context = {
        exportPath,
        sourceFile: declarationFile,
        specifier: reexport.specifier,
      };
      const resolution = await resolveModule(context);
      if (resolution === undefined) {
        if (!reexport.specifier.startsWith(".")) {
          reportExternal(exportPath, declarationFile, reexport.specifier);
          if (reexport.mode === "named") {
            declarations.push(...reexport.bindings.map((binding) => externalDeclaration(
              reexport.originId,
              declarationFile,
              binding.exportedName,
              binding.importedName,
              reexport.specifier,
              binding.typeOnly,
            )));
          } else {
            declarations.push(externalDeclaration(
              reexport.originId,
              declarationFile,
              reexport.mode === "namespace" ? reexport.exportedName : "*",
              "*",
              reexport.specifier,
              reexport.typeOnly,
            ));
          }
        }
        continue;
      }
      const targetExports = await followInternal(
        resolution.declarationFile,
        context,
        depth,
        nextStack,
      );
      if (reexport.mode === "star") {
        starExports.push({
          declarations: targetExports
            .filter((declaration) => declaration.exportedName !== "default")
            .map((declaration) => copyDeclaration(declaration, declaration.exportedName, {
              typeOnly: reexport.typeOnly || declaration.typeOnly,
            })),
          sourceFile: declarationFile,
          specifier: reexport.specifier,
        });
      } else if (reexport.mode === "namespace") {
        declarations.push({
          originId: reexport.originId,
          sourceOrder: 0,
          exportedName: reexport.exportedName,
          kind: "namespace",
          sourceFile: declarationFile,
          defaultExport: reexport.exportedName === "default",
          exportEquals: false,
          typeOnly: reexport.typeOnly,
          references: [],
          importTypeReferences: [],
          signatures: ["namespace"],
          deprecated: false,
          namespaceExports: targetExports,
        });
      } else {
        for (const binding of reexport.bindings) {
          const matches = targetExports.filter((declaration) =>
            declaration.exportedName === binding.importedName);
          if (matches.length === 0) {
            addIssue({
              code: "unresolved-reexport",
              message: `Re-exported name "${binding.importedName}" cannot be resolved from "${reexport.specifier}".`,
              exportPath,
              sourceFile: declarationFile,
              specifier: reexport.specifier,
            });
          }
          declarations.push(...matches.map((declaration) =>
            copyDeclaration(declaration, binding.exportedName, {
              typeOnly: binding.typeOnly || declaration.typeOnly,
            })));
        }
      }
    }

    const starsByName = new Map<string, Array<{
      declarations: InternalDeclaration[];
      sourceFile: string;
      specifier: string;
    }>>();
    for (const starExport of starExports) {
      const names = new Set(starExport.declarations.map((declaration) =>
        declaration.exportedName));
      for (const name of names) {
        const sources = starsByName.get(name) ?? [];
        sources.push({
          ...starExport,
          declarations: starExport.declarations.filter((declaration) =>
            declaration.exportedName === name),
        });
        starsByName.set(name, sources);
      }
    }
    for (const [name, sources] of starsByName) {
      if (explicitNames.has(name)) {
        continue;
      }
      const originSets = sources.map((source) =>
        [...new Set(source.declarations.map((declaration) => declaration.originId))]
          .sort(compareText)
          .join("\0"));
      if (new Set(originSets).size > 1) {
        const first = sources[0];
        if (first !== undefined) {
          addIssue({
            code: "ambiguous-star-reexport",
            message: `Exported name "${name}" is ambiguous across export-star declarations.`,
            exportPath,
            sourceFile: first.sourceFile,
            specifier: first.specifier,
          });
        }
        continue;
      }
      const declarationsByOrigin = new Map<string, InternalDeclaration>();
      for (const declaration of sources.flatMap((source) => source.declarations)) {
        const existing = declarationsByOrigin.get(declaration.originId);
        if (existing === undefined || (existing.typeOnly && !declaration.typeOnly)) {
          declarationsByOrigin.set(declaration.originId, declaration);
        }
      }
      declarations.push(...declarationsByOrigin.values());
    }
    return deduplicateDeclarations(declarations);
  }

  async function collectReferencedDeclarations(
    roots: readonly InternalDeclaration[],
    exportPath: string,
  ): Promise<InternalDeclaration[]> {
    const processed = new Set<string>();
    const queue: InternalDeclaration[] = [];
    const references: InternalDeclaration[] = [];

    function enqueue(
      declaration: InternalDeclaration,
      name: string,
      includeReference: boolean,
    ): void {
      const identified = copyDeclaration(declaration, name, {
        typeOnly: declaration.typeOnly,
      });
      const key = `${identified.originId}\0${name}\0${identified.typeOnly}`;
      if (processed.has(key)) {
        return;
      }
      processed.add(key);
      queue.push(identified);
      if (includeReference) {
        references.push(identified);
      }
      for (const nested of identified.namespaceExports ?? []) {
        enqueue(nested, nested.exportedName, false);
      }
    }

    for (const root of roots) {
      enqueue(root, root.exportedName, false);
    }

    for (let index = 0; index < queue.length; index += 1) {
      const declaration = queue[index];
      if (declaration === undefined || declaration.kind === "external-reexport") {
        continue;
      }
      const model = models.get(declaration.sourceFile);
      if (model === undefined || model === null) {
        continue;
      }
      for (const referenceName of declaration.references) {
        const locals = model.locals.get(referenceName);
        if (locals !== undefined) {
          for (const local of locals) {
            enqueue(local, referenceName, true);
          }
          continue;
        }
        const imported = model.imports.get(referenceName);
        if (imported === undefined) {
          continue;
        }
        const importedDeclarations = await resolveImportBinding(
          imported,
          referenceName,
          declaration.sourceFile,
          exportPath,
          0,
          new Set([declaration.sourceFile]),
          { exportEquals: false, typeOnly: imported.typeOnly },
        );
        for (const importedDeclaration of importedDeclarations) {
          enqueue(importedDeclaration, referenceName, true);
        }
      }
      for (const importReference of declaration.importTypeReferences) {
        const importedName = importReference.importedName === "*"
          ? "*"
          : importReference.importedName.split(".")[0] ?? importReference.importedName;
        const importedDeclarations = await resolveImportBinding(
          {
            specifier: importReference.specifier,
            importedName,
            namespace: importedName === "*",
            typeOnly: true,
          },
          importReference.importedName === "*"
            ? `import("${importReference.specifier}")`
            : `import("${importReference.specifier}").${importReference.importedName}`,
          declaration.sourceFile,
          exportPath,
          0,
          new Set([declaration.sourceFile]),
          { exportEquals: false, typeOnly: true },
        );
        for (const importedDeclaration of importedDeclarations) {
          enqueue(importedDeclaration, importedDeclaration.exportedName, true);
        }
      }
    }
    return deduplicateDeclarations(references);
  }

  const entrypoints: DeclarationEntrypoint[] = [];
  for (const entrypoint of discovery.entrypoints) {
    const declarations = await resolveFileExports(
      entrypoint.declarationFile,
      entrypoint.exportPath,
      0,
      new Set(),
    );
    const referencedDeclarations = await collectReferencedDeclarations(
      declarations,
      entrypoint.exportPath,
    );
    entrypoints.push({
      exportPath: entrypoint.exportPath,
      declarationFile: entrypoint.declarationFile,
      conditionPaths: entrypoint.conditionPaths,
      exports: publicDeclarations(declarations),
      referencedDeclarations: referencedApiDeclarations(referencedDeclarations),
    });
  }
  entrypoints.sort((left, right) =>
    compareText(left.exportPath, right.exportPath)
    || compareText(left.declarationFile, right.declarationFile)
    || compareText(JSON.stringify(left.conditionPaths), JSON.stringify(right.conditionPaths)));

  return {
    packageName: artifact.dependency,
    version: artifact.version,
    entrypoints,
    issues: sortIssues(issueMap.values()),
  };
}

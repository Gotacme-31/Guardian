import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  Node,
  Project,
  SyntaxKind,
  type CallExpression,
  type Identifier,
  type SourceFile,
} from "ts-morph";

import { ProjectScanError } from "./errors.js";
import {
  discoverPnpmWorkspace,
  resolveInstalledDependencies,
} from "./dependency-resolution/index.js";
import {
  analyzeSymbolUsages,
  type ImportedSymbolBinding,
} from "./symbol-usage.js";
import type {
  DependencyInfo,
  DependencyType,
  DependencyUsage,
  ImportUsage,
  PackageManager,
  ProjectScanResult,
  SymbolUsage,
} from "./types.js";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".vite",
  ".turbo",
  ".cache",
  "out",
]);

const LOCKFILES: ReadonlyArray<{ file: string; manager: Exclude<PackageManager, "unknown"> }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "package-lock.json", manager: "npm" },
  { file: "yarn.lock", manager: "yarn" },
];

interface PackageManifest {
  name?: string;
  declaredPackageManager?: string;
  dependencies: DependencyInfo[];
  devDependencies: DependencyInfo[];
}

interface MutableDependencyUsage {
  files: Set<string>;
  imports: ImportUsage[];
  symbolUsages: SymbolUsage[];
}

interface FoundImport {
  dependency: string;
  usage: ImportUsage;
}

interface SourceFileAnalysis {
  imports: FoundImport[];
  symbolUsages: SymbolUsage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDependencies(
  value: unknown,
  field: "dependencies" | "devDependencies",
  type: DependencyType,
): DependencyInfo[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    throw new ProjectScanError(
      "PACKAGE_JSON_INVALID_STRUCTURE",
      `package.json field "${field}" must be an object.`,
    );
  }

  return Object.entries(value)
    .map(([name, declaredVersion]) => {
      if (typeof declaredVersion !== "string") {
        throw new ProjectScanError(
          "PACKAGE_JSON_INVALID_STRUCTURE",
          `Version declared for "${name}" in package.json must be a string.`,
        );
      }
      return { name, declaredVersion, type };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function readPackageManifest(packageJsonPath: string): Promise<PackageManifest> {
  let contents: string;
  try {
    contents = await readFile(packageJsonPath, "utf8");
  } catch (error) {
    const errorCode = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (errorCode === "ENOENT") {
      throw new ProjectScanError(
        "PACKAGE_JSON_NOT_FOUND",
        `No package.json found in ${path.dirname(packageJsonPath)}.`,
        { cause: error },
      );
    }
    throw new ProjectScanError(
      "PACKAGE_JSON_UNREADABLE",
      `Could not read package.json in ${path.dirname(packageJsonPath)}.`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new ProjectScanError(
      "PACKAGE_JSON_INVALID",
      `Invalid JSON in ${packageJsonPath}.`,
      { cause: error },
    );
  }

  if (!isRecord(parsed)) {
    throw new ProjectScanError(
      "PACKAGE_JSON_INVALID_STRUCTURE",
      `package.json in ${path.dirname(packageJsonPath)} must contain a JSON object.`,
    );
  }
  if (parsed.name !== undefined && typeof parsed.name !== "string") {
    throw new ProjectScanError(
      "PACKAGE_JSON_INVALID_STRUCTURE",
      "package.json field \"name\" must be a string when present.",
    );
  }
  if (parsed.packageManager !== undefined && typeof parsed.packageManager !== "string") {
    throw new ProjectScanError(
      "PACKAGE_JSON_INVALID_STRUCTURE",
      "package.json field \"packageManager\" must be a string when present.",
    );
  }

  return {
    ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
    ...(typeof parsed.packageManager === "string"
      ? { declaredPackageManager: parsed.packageManager }
      : {}),
    dependencies: parseDependencies(parsed.dependencies, "dependencies", "dependency"),
    devDependencies: parseDependencies(parsed.devDependencies, "devDependencies", "devDependency"),
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    const errorCode = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (errorCode === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function packageManagerFromDeclaration(declaration: string | undefined): PackageManager {
  if (declaration === undefined) {
    return "unknown";
  }
  for (const manager of ["pnpm", "npm", "yarn"] as const) {
    if (declaration === manager || declaration.startsWith(`${manager}@`)) {
      return manager;
    }
  }
  return "unknown";
}

async function detectPackageManager(
  projectPath: string,
  declaredPackageManager: string | undefined,
): Promise<PackageManager> {
  const detected: Array<{ file: string; manager: Exclude<PackageManager, "unknown"> }> = [];

  for (const lockfile of LOCKFILES) {
    if (await pathExists(path.join(projectPath, lockfile.file))) {
      detected.push(lockfile);
    }
  }

  if (detected.length > 1) {
    throw new ProjectScanError(
      "MULTIPLE_LOCKFILES",
      `Multiple package manager lockfiles found: ${detected.map(({ file }) => file).join(", ")}. Remove the ambiguity before scanning.`,
    );
  }

  if (detected[0] !== undefined) {
    return detected[0].manager;
  }
  if (await discoverPnpmWorkspace(projectPath) !== undefined) {
    return "pnpm";
  }
  return packageManagerFromDeclaration(declaredPackageManager);
}

async function collectSourceFiles(directoryPath: string): Promise<string[]> {
  const sourceFiles: string[] = [];

  async function visit(currentPath: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      throw new ProjectScanError(
        "PROJECT_UNREADABLE",
        `Could not read directory ${currentPath}.`,
        { cause: error },
      );
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await visit(entryPath);
        }
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        sourceFiles.push(entryPath);
      }
    }
  }

  await visit(directoryPath);
  return sourceFiles;
}

function dependencyRoot(source: string): string | undefined {
  if (
    source.startsWith(".")
    || source.startsWith("/")
    || source.startsWith("#")
  ) {
    return undefined;
  }

  const segments = source.split("/");
  if (source.startsWith("@")) {
    return segments.length >= 2 && segments[0] !== "" && segments[1] !== ""
      ? `${segments[0]}/${segments[1]}`
      : undefined;
  }
  return segments[0] || undefined;
}

function relativeFilePath(projectPath: string, filePath: string): string {
  return path.relative(projectPath, filePath).split(path.sep).join("/");
}

function stringArgument(callExpression: CallExpression): string | undefined {
  const [firstArgument] = callExpression.getArguments();
  if (firstArgument === undefined) {
    return undefined;
  }
  if (Node.isStringLiteral(firstArgument) || Node.isNoSubstitutionTemplateLiteral(firstArgument)) {
    return firstArgument.getLiteralText();
  }
  return undefined;
}

function isUnshadowedRequire(expression: Node): expression is Identifier {
  if (!Node.isIdentifier(expression) || expression.getText() !== "require") {
    return false;
  }

  const symbol = expression.getSymbol();
  return symbol === undefined
    || symbol.getDeclarations().every((declaration) => declaration.getSourceFile().isDeclarationFile());
}

function bindingPropertyName(node: Node): string {
  if (Node.isStringLiteral(node) || Node.isNumericLiteral(node)) {
    return node.getLiteralText();
  }
  return node.getText();
}

function variableBindingForCall(callExpression: CallExpression): {
  importedSymbols: string[];
  localName?: string;
  bindings: Array<Omit<ImportedSymbolBinding, "dependency">>;
} {
  let current: Node = callExpression;
  const parent = current.getParent();
  if (parent !== undefined && Node.isAwaitExpression(parent)) {
    current = parent;
  }

  const declaration = current.getParent();
  if (declaration === undefined || !Node.isVariableDeclaration(declaration)) {
    return { importedSymbols: [], bindings: [] };
  }

  const nameNode = declaration.getNameNode();
  if (Node.isIdentifier(nameNode)) {
    const localName = nameNode.getText();
    return {
      importedSymbols: [],
      localName,
      bindings: [{
        localBinding: localName,
        usageBase: localName,
        declaration: nameNode,
        validFrom: current.getEnd(),
      }],
    };
  }
  if (Node.isObjectBindingPattern(nameNode)) {
    const bindings: Array<Omit<ImportedSymbolBinding, "dependency">> = [];
    const importedSymbols: string[] = [];
    for (const element of nameNode.getElements()) {
      const localNameNode = element.getNameNode();
      if (!Node.isIdentifier(localNameNode)) {
        continue;
      }
      const importedSymbol = element.getPropertyNameNode() === undefined
        ? localNameNode.getText()
        : bindingPropertyName(element.getPropertyNameNodeOrThrow());
      importedSymbols.push(importedSymbol);
      bindings.push({
        importedSymbol,
        localBinding: localNameNode.getText(),
        usageBase: importedSymbol,
        declaration: localNameNode,
        validFrom: current.getEnd(),
      });
    }
    return {
      importedSymbols,
      bindings,
    };
  }
  return { importedSymbols: [], bindings: [] };
}

function analyzeSourceFile(projectPath: string, sourceFile: SourceFile): SourceFileAnalysis {
  const imports: FoundImport[] = [];
  const bindings: ImportedSymbolBinding[] = [];
  const file = relativeFilePath(projectPath, sourceFile.getFilePath());

  for (const declaration of sourceFile.getImportDeclarations()) {
    const source = declaration.getModuleSpecifierValue();
    const dependency = dependencyRoot(source);
    if (dependency === undefined) {
      continue;
    }

    const defaultImport = declaration.getDefaultImport()?.getText();
    const namespaceImport = declaration.getNamespaceImport()?.getText();
    const namedImports = declaration.getNamedImports();
    const symbolBindings = namedImports.flatMap((namedImport) => {
      const localNameNode = namedImport.getAliasNode() ?? namedImport.getNameNode();
      return Node.isIdentifier(localNameNode)
        ? [{ importedSymbol: namedImport.getName(), localBinding: localNameNode.getText() }]
        : [];
    });
    imports.push({
      dependency,
      usage: {
        file,
        source,
        importedSymbols: namedImports.map((namedImport) => namedImport.getName()),
        ...(symbolBindings.length === 0 ? {} : { symbolBindings }),
        ...(defaultImport === undefined ? {} : { defaultImport }),
        ...(namespaceImport === undefined ? {} : { namespaceImport }),
        kind: "es-import",
      },
    });

    const defaultImportNode = declaration.getDefaultImport();
    if (defaultImportNode !== undefined) {
      bindings.push({
        dependency,
        localBinding: defaultImportNode.getText(),
        usageBase: defaultImportNode.getText(),
        declaration: defaultImportNode,
      });
    }

    const namespaceImportNode = declaration.getNamespaceImport();
    if (namespaceImportNode !== undefined) {
      bindings.push({
        dependency,
        localBinding: namespaceImportNode.getText(),
        usageBase: namespaceImportNode.getText(),
        declaration: namespaceImportNode,
      });
    }

    for (const namedImport of namedImports) {
      const importedSymbol = namedImport.getName();
      const localNameNode = namedImport.getAliasNode() ?? namedImport.getNameNode();
      if (!Node.isIdentifier(localNameNode)) {
        continue;
      }
      bindings.push({
        dependency,
        importedSymbol,
        localBinding: localNameNode.getText(),
        usageBase: importedSymbol,
        declaration: localNameNode,
      });
    }
  }

  for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = callExpression.getExpression();
    const isRequire = isUnshadowedRequire(expression);
    const isDynamicImport = expression.getKind() === SyntaxKind.ImportKeyword;
    if (!isRequire && !isDynamicImport) {
      continue;
    }

    const source = stringArgument(callExpression);
    const dependency = source === undefined ? undefined : dependencyRoot(source);
    if (source === undefined || dependency === undefined) {
      continue;
    }

    const binding = variableBindingForCall(callExpression);
    const symbolBindings = binding.bindings.flatMap((item) =>
      item.importedSymbol === undefined
        ? []
        : [{ importedSymbol: item.importedSymbol, localBinding: item.localBinding }]);
    imports.push({
      dependency,
      usage: {
        file,
        source,
        importedSymbols: binding.importedSymbols,
        ...(symbolBindings.length === 0 ? {} : { symbolBindings }),
        ...(binding.localName === undefined || isDynamicImport ? {} : { defaultImport: binding.localName }),
        ...(binding.localName === undefined || !isDynamicImport ? {} : { namespaceImport: binding.localName }),
        kind: isRequire ? "require" : "dynamic-import",
      },
    });
    const isAwaitedDynamicImport = isDynamicImport
      && Node.isAwaitExpression(callExpression.getParent());
    if (isRequire || isAwaitedDynamicImport) {
      bindings.push(...binding.bindings.map((item) => ({ dependency, ...item })));
    }
  }

  return {
    imports,
    symbolUsages: analyzeSymbolUsages(sourceFile, file, bindings),
  };
}

function buildDependencyUsage(
  projectPath: string,
  sourceFilePaths: string[],
  declaredDependencies: Set<string>,
): DependencyUsage[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths(sourceFilePaths);

  const usageByDependency = new Map<string, MutableDependencyUsage>();
  for (const sourceFile of project.getSourceFiles().sort((left, right) =>
    left.getFilePath().localeCompare(right.getFilePath()))) {
    const analysis = analyzeSourceFile(projectPath, sourceFile);
    for (const item of analysis.imports) {
      if (!declaredDependencies.has(item.dependency)) {
        continue;
      }
      const existing = usageByDependency.get(item.dependency) ?? {
        files: new Set<string>(),
        imports: [],
        symbolUsages: [],
      };
      existing.files.add(item.usage.file);
      existing.imports.push(item.usage);
      usageByDependency.set(item.dependency, existing);
    }

    for (const symbolUsage of analysis.symbolUsages) {
      if (!declaredDependencies.has(symbolUsage.dependency)) {
        continue;
      }
      const existing = usageByDependency.get(symbolUsage.dependency) ?? {
        files: new Set<string>(),
        imports: [],
        symbolUsages: [],
      };
      existing.files.add(symbolUsage.file);
      existing.symbolUsages.push(symbolUsage);
      usageByDependency.set(symbolUsage.dependency, existing);
    }
  }

  return [...usageByDependency.entries()]
    .map(([dependency, usage]) => ({
      dependency,
      files: [...usage.files].sort(),
      importCount: usage.imports.length,
      imports: usage.imports,
      symbolUsages: usage.symbolUsages,
    }))
    .sort((left, right) => left.dependency.localeCompare(right.dependency));
}

async function validateProjectDirectory(projectPath: string): Promise<void> {
  let projectStat;
  try {
    projectStat = await stat(projectPath);
  } catch (error) {
    const errorCode = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (errorCode === "ENOENT") {
      throw new ProjectScanError(
        "PROJECT_NOT_FOUND",
        `Project path does not exist: ${projectPath}.`,
        { cause: error },
      );
    }
    throw new ProjectScanError(
      "PROJECT_UNREADABLE",
      `Could not access project path: ${projectPath}.`,
      { cause: error },
    );
  }

  if (!projectStat.isDirectory()) {
    throw new ProjectScanError(
      "PROJECT_NOT_DIRECTORY",
      `Project path is not a directory: ${projectPath}.`,
    );
  }
}

export async function scanProject(projectPath: string): Promise<ProjectScanResult> {
  const absoluteProjectPath = path.resolve(projectPath);
  await validateProjectDirectory(absoluteProjectPath);

  const packageManifest = await readPackageManifest(path.join(absoluteProjectPath, "package.json"));
  const packageManager = await detectPackageManager(
    absoluteProjectPath,
    packageManifest.declaredPackageManager,
  );
  const sourceFilePaths = await collectSourceFiles(absoluteProjectPath);
  const dependencies = [
    ...packageManifest.dependencies,
    ...packageManifest.devDependencies,
  ];
  const declaredDependencies = new Set(dependencies.map(({ name }) => name));
  const dependencyResolutions = await resolveInstalledDependencies({
    projectPath: absoluteProjectPath,
    packageManager,
    dependencies,
  });

  let dependencyUsage: DependencyUsage[];
  try {
    dependencyUsage = buildDependencyUsage(
      absoluteProjectPath,
      sourceFilePaths,
      declaredDependencies,
    );
  } catch (error) {
    throw new ProjectScanError(
      "SOURCE_SCAN_FAILED",
      `Could not analyze source files in ${absoluteProjectPath}.`,
      { cause: error },
    );
  }

  return {
    projectPath: absoluteProjectPath,
    projectName: packageManifest.name ?? path.basename(absoluteProjectPath),
    projectType: {
      node: true,
      typescript:
        await pathExists(path.join(absoluteProjectPath, "tsconfig.json"))
        || sourceFilePaths.some((filePath) => TYPESCRIPT_EXTENSIONS.has(path.extname(filePath).toLowerCase())),
    },
    packageManager,
    dependencies: packageManifest.dependencies,
    devDependencies: packageManifest.devDependencies,
    dependencyUsage,
    dependencyResolutions,
  };
}

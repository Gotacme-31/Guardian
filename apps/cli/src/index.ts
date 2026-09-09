#!/usr/bin/env node

import { stat } from "node:fs/promises";
import path from "node:path";

import {
  buildDependencyContexts,
  findDependencyContext,
  ProjectScanError,
  resolveDependencyTarget,
  scanProject,
  type DependencyContext,
  type DependencyTargetResolution,
  type DependencyUsage,
  type InstalledDependencyResolution,
  type ProjectScanResult,
} from "@guardian/project-scanner";

const VERSION = "0.0.1";

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))].sort();
}

function formatUsage(usage: DependencyUsage): string[] {
  const lines = [
    usage.dependency,
    `  ${usage.files.length} ${pluralize(usage.files.length, "file")}`,
    "  imports:",
    `    ${usage.importCount} ${pluralize(usage.importCount, "import")}`,
  ];
  const defaultImports = unique(usage.imports.map((item) => item.defaultImport));
  const namespaceImports = unique(usage.imports.map((item) => item.namespaceImport));
  const symbols = unique(usage.imports.flatMap((item) => item.importedSymbols));

  if (defaultImports.length > 0) {
    lines.push(`    default: ${defaultImports.join(", ")}`);
  }
  if (namespaceImports.length > 0) {
    lines.push(`    namespace: ${namespaceImports.join(", ")}`);
  }
  if (symbols.length > 0) {
    lines.push(`    symbols: ${symbols.join(", ")}`);
  }

  lines.push("  usages:");
  if (usage.symbolUsages.length === 0) {
    lines.push("    none");
  } else {
    const labels = usage.symbolUsages.map((item) =>
      item.kind === "constructor" ? `new ${item.usagePath}` : item.usagePath);
    const labelWidth = Math.max(...labels.map((label) => label.length));
    for (const [index, symbolUsage] of usage.symbolUsages.entries()) {
      const label = labels[index] ?? symbolUsage.usagePath;
      lines.push(
        `    ${label.padEnd(labelWidth)}  ${symbolUsage.file}:${symbolUsage.line}:${symbolUsage.column}`,
      );
    }
  }

  return lines;
}

function formatResolution(resolution: InstalledDependencyResolution): string[] {
  const lines = [
    resolution.dependency,
    `  declared  ${resolution.declaredVersion}`,
  ];

  if (resolution.resolvedVersion !== undefined) {
    lines.push(`  resolved  ${resolution.resolvedVersion}`);
  }
  if (
    resolution.resolvedReference !== undefined
    && resolution.resolvedReference !== resolution.resolvedVersion
  ) {
    lines.push(`  reference ${resolution.resolvedReference}`);
  }
  lines.push(`  source    ${resolution.kind}`);
  if (resolution.status !== "resolved") {
    const issue = resolution.issue === undefined ? "" : ` (${resolution.issue})`;
    lines.push(`  status    ${resolution.status}${issue}`);
  }

  return lines;
}

function formatResult(result: ProjectScanResult): string {
  const lines = [
    `Guardian v${VERSION}`,
    "",
    "Project",
    `  ${result.projectName}`,
    "",
    "Environment",
    `  Node.js      ${result.projectType.node ? "yes" : "no"}`,
    `  TypeScript   ${result.projectType.typescript ? "yes" : "no"}`,
    `  Package mgr  ${result.packageManager}`,
    "",
    "Dependencies",
    `  ${result.dependencies.length} direct`,
    `  ${result.devDependencies.length} development`,
  ];

  for (const resolution of result.dependencyResolutions) {
    lines.push("", ...formatResolution(resolution));
  }

  lines.push("", "Usage");

  if (result.dependencyUsage.length === 0) {
    lines.push("", "  No declared dependencies are imported.");
  } else {
    for (const usage of result.dependencyUsage) {
      lines.push("", ...formatUsage(usage));
    }
  }

  return lines.join("\n");
}

function formatDependencyContext(context: DependencyContext): string {
  const lines = [
    "Guardian Dependency Context",
    "",
    "Dependency",
    `  ${context.dependency}`,
    "",
    "Declaration",
    `  type      ${context.declaration.type}`,
    `  declared  ${context.declaration.declaredVersion}`,
    "",
    "Resolution",
    `  status    ${context.resolution.status}`,
  ];

  if (context.resolution.resolvedVersion !== undefined) {
    lines.push(`  version   ${context.resolution.resolvedVersion}`);
  }
  if (context.resolution.resolvedReference !== undefined) {
    lines.push(`  reference ${context.resolution.resolvedReference}`);
  }
  lines.push(`  source    ${context.resolution.kind}`);
  if (context.resolution.issue !== undefined) {
    lines.push(`  issue     ${context.resolution.issue}`);
  }
  if (context.resolution.importer !== undefined) {
    lines.push(`  importer  ${context.resolution.importer}`);
  }

  lines.push(
    "",
    "Usage",
    `  used      ${context.usage.used ? "yes" : "no"}`,
    `  files     ${context.usage.files.length}`,
    "",
    "Files",
  );
  if (context.usage.files.length === 0) {
    lines.push("  none");
  } else {
    lines.push(...context.usage.files.map((file) => `  ${file}`));
  }

  lines.push("", "Imports");
  const unboundImports = context.usage.imports.filter((item) =>
    item.defaultImport === undefined
    && item.namespaceImport === undefined
    && item.importedSymbols.length === 0);
  if (context.usage.importedSymbols.length === 0 && unboundImports.length === 0) {
    lines.push("  none");
  } else {
    for (const imported of context.usage.importedSymbols) {
      const label = imported.bindingKind === "named" ? "symbol" : imported.bindingKind;
      const symbol = imported.importedSymbol;
      const binding = symbol === undefined || symbol === "default" || symbol === "*"
        ? imported.localBinding
        : symbol === imported.localBinding
          ? symbol
          : `${symbol} as ${imported.localBinding}`;
      lines.push(`  ${label.padEnd(9)} ${binding}`);
    }
    for (const importUsage of unboundImports) {
      lines.push(`  ${importUsage.kind.padEnd(14)} ${importUsage.source}`);
    }
  }

  lines.push("", "APIs");
  if (context.usage.apiUsages.length === 0) {
    lines.push("  none");
  } else {
    for (const apiUsage of context.usage.apiUsages) {
      const label = apiUsage.canonicalPath ?? apiUsage.localUsagePaths.join(", ");
      lines.push(`  ${label}`);
      if (
        apiUsage.canonicalPath !== undefined
        && apiUsage.localUsagePaths.some((path) => path !== apiUsage.canonicalPath)
      ) {
        lines.push(`    local       ${apiUsage.localUsagePaths.join(", ")}`);
      }
      lines.push(
        `    occurrences ${apiUsage.occurrenceCount}`,
        `    evidence    ${apiUsage.evidence.join(", ")}`,
      );
      for (const occurrence of apiUsage.occurrences) {
        lines.push(`    ${occurrence.file}:${occurrence.line}:${occurrence.column}`);
      }
    }
  }

  return lines.join("\n");
}

function formatTargetResolution(resolution: DependencyTargetResolution): string {
  const lines = [
    "Guardian Target Resolution",
    "",
    "Dependency",
    `  ${resolution.dependency}`,
    "",
    "Installed",
    `  ${resolution.installedVersion ?? "unknown"}`,
    "",
    "Requested",
    `  ${resolution.requestedTarget}`,
  ];

  if (resolution.status === "resolved") {
    lines.push(
      "",
      "Resolved",
      `  ${resolution.resolvedVersion}`,
      "",
      "Upgrade",
      `  ${resolution.upgradeType}`,
    );
    if (resolution.distTag !== undefined) {
      lines.push("", "Dist-tag", `  ${resolution.distTag}`);
    }
  } else {
    lines.push("", "Status", `  ${resolution.status}`);
    if (resolution.issue !== undefined) {
      lines.push("", "Issue", `  ${resolution.issue}`);
    }
    if (resolution.httpStatus !== undefined) {
      lines.push("", "HTTP", `  ${resolution.httpStatus}`);
    }
  }

  return lines.join("\n");
}

function printUsage(): void {
  console.error([
    "Usage:",
    "  pnpm guardian scan <project-path>",
    "  pnpm guardian inspect <project-path> <dependency>",
    "  pnpm guardian target <project-path> <dependency> <target>",
  ].join("\n"));
}

async function validateProjectPath(projectPath: string): Promise<string> {
  const absolutePath = path.resolve(projectPath);

  try {
    const projectStat = await stat(absolutePath);
    if (!projectStat.isDirectory()) {
      throw new Error(`Path is not a directory: ${absolutePath}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Path is not a directory:")) {
      throw error;
    }
    throw new Error(`Project path does not exist or cannot be read: ${absolutePath}`, {
      cause: error,
    });
  }

  return absolutePath;
}

async function main(args: string[]): Promise<void> {
  const [command, projectPath, dependency, target, ...extraArguments] = args;
  const isScan = command === "scan"
    && projectPath !== undefined
    && dependency === undefined
    && target === undefined;
  const isInspect = command === "inspect"
    && projectPath !== undefined
    && dependency !== undefined
    && target === undefined;
  const isTarget = command === "target"
    && projectPath !== undefined
    && dependency !== undefined
    && target !== undefined;
  if ((!isScan && !isInspect && !isTarget) || extraArguments.length > 0) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  try {
    const absolutePath = await validateProjectPath(projectPath);
    const result = await scanProject(absolutePath);
    if (isInspect || isTarget) {
      const context = findDependencyContext(buildDependencyContexts(result), dependency);
      if (context === undefined) {
        throw new Error(`Dependency "${dependency}" is not declared by this project.`);
      }
      if (isTarget) {
        const targetResolution = await resolveDependencyTarget(context, target);
        console.log(formatTargetResolution(targetResolution));
        if (targetResolution.status !== "resolved") {
          process.exitCode = 1;
        }
      } else {
        console.log(formatDependencyContext(context));
      }
    } else {
      console.log(formatResult(result));
    }
  } catch (error) {
    const message = error instanceof ProjectScanError || error instanceof Error
      ? error.message
      : "An unknown error occurred while scanning the project.";
    console.error(`Guardian: ${message}`);
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));

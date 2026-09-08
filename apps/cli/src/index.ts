#!/usr/bin/env node

import { stat } from "node:fs/promises";
import path from "node:path";

import {
  ProjectScanError,
  scanProject,
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

function printUsage(): void {
  console.error("Usage: pnpm guardian scan <project-path>");
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
  const [command, projectPath, ...extraArguments] = args;
  if (command !== "scan" || projectPath === undefined || extraArguments.length > 0) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  try {
    const absolutePath = await validateProjectPath(projectPath);
    const result = await scanProject(absolutePath);
    console.log(formatResult(result));
  } catch (error) {
    const message = error instanceof ProjectScanError || error instanceof Error
      ? error.message
      : "An unknown error occurred while scanning the project.";
    console.error(`Guardian: ${message}`);
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));

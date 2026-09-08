import { resolvePnpmDependencies } from "./pnpm.js";
import type {
  DependencyResolutionRequest,
  InstalledDependencyResolution,
} from "./types.js";

function compareResolutions(
  left: InstalledDependencyResolution,
  right: InstalledDependencyResolution,
): number {
  return left.dependency.localeCompare(right.dependency)
    || left.dependencyType.localeCompare(right.dependencyType);
}

export async function resolveInstalledDependencies(
  request: DependencyResolutionRequest,
): Promise<InstalledDependencyResolution[]> {
  if (request.packageManager === "pnpm") {
    return (await resolvePnpmDependencies(request.projectPath, request.dependencies))
      .sort(compareResolutions);
  }

  if (request.dependencies.length === 0) {
    return [];
  }

  const unsupported = request.dependencies.map((dependency): InstalledDependencyResolution => ({
    dependency: dependency.name,
    dependencyType: dependency.type,
    declaredVersion: dependency.declaredVersion,
    kind: "unknown",
    status: "unsupported",
    issue: "package-manager-unsupported",
  }));
  return unsupported.sort(compareResolutions);
}

export { discoverPnpmWorkspace } from "./pnpm.js";

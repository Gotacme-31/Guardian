import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  scanProject,
  type InstalledDependencyResolution,
} from "../src/index.js";

const sampleWorkspacePath = fileURLToPath(
  new URL("../../../test-projects/sample-pnpm-workspace", import.meta.url),
);
const temporaryProjects: string[] = [];

interface TemporaryProjectOptions {
  packageJson: Record<string, unknown>;
  files?: Record<string, string>;
}

async function createTemporaryProject(options: TemporaryProjectOptions): Promise<string> {
  const projectPath = await mkdtemp(path.join(tmpdir(), "guardian-resolution-"));
  temporaryProjects.push(projectPath);
  await writeFile(path.join(projectPath, "package.json"), JSON.stringify(options.packageJson));

  for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
    const filePath = path.join(projectPath, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
  return projectPath;
}

function pnpmLockfile(importers: Record<string, unknown>, lockfileVersion: string | number = "9.0"): string {
  return JSON.stringify({ lockfileVersion, importers });
}

async function scanRootPnpm(
  packageJson: Record<string, unknown>,
  importer: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof scanProject>>> {
  const projectPath = await createTemporaryProject({
    packageJson,
    files: { "pnpm-lock.yaml": pnpmLockfile({ ".": importer }) },
  });
  return scanProject(projectPath);
}

function resolutionFor(
  resolutions: InstalledDependencyResolution[],
  dependency: string,
): InstalledDependencyResolution {
  const resolution = resolutions.find((item) => item.dependency === dependency);
  expect(resolution, `Expected resolution for ${dependency}`).toBeDefined();
  return resolution as InstalledDependencyResolution;
}

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((projectPath) =>
    rm(projectPath, { recursive: true, force: true })));
});

describe("pnpm dependency resolution", () => {
  it("resolves a registry dependency from the root importer", async () => {
    const result = await scanRootPnpm(
      { dependencies: { axios: "^1.7.0" } },
      { dependencies: { axios: { specifier: "^1.7.0", version: "1.7.9" } } },
    );

    expect(resolutionFor(result.dependencyResolutions, "axios")).toMatchObject({
      dependencyType: "dependency",
      declaredVersion: "^1.7.0",
      lockfileSpecifier: "^1.7.0",
      resolvedVersion: "1.7.9",
      resolvedReference: "1.7.9",
      kind: "registry",
      status: "resolved",
      importer: ".",
    });
  });

  it("resolves a registry development dependency", async () => {
    const result = await scanRootPnpm(
      { devDependencies: { vitest: "^3.0.0" } },
      { devDependencies: { vitest: { specifier: "^3.0.0", version: "3.2.7" } } },
    );

    expect(resolutionFor(result.dependencyResolutions, "vitest")).toMatchObject({
      dependencyType: "devDependency",
      declaredVersion: "^3.0.0",
      resolvedVersion: "3.2.7",
      status: "resolved",
    });
  });

  it("keeps the declared range separate from the exact version", async () => {
    const result = await scanRootPnpm(
      { dependencies: { zod: "^3.23.0" } },
      { dependencies: { zod: { specifier: "^3.23.0", version: "3.23.8" } } },
    );
    const resolution = resolutionFor(result.dependencyResolutions, "zod");

    expect(resolution.declaredVersion).toBe("^3.23.0");
    expect(resolution.resolvedVersion).toBe("3.23.8");
  });

  it("resolves multiple direct dependencies", async () => {
    const result = await scanRootPnpm(
      { dependencies: { axios: "^1.7.0", zod: "^4.0.0" } },
      {
        dependencies: {
          axios: { specifier: "^1.7.0", version: "1.7.9" },
          zod: { specifier: "^4.0.0", version: "4.0.5" },
        },
      },
    );

    expect(result.dependencyResolutions.map(({ dependency }) => dependency)).toEqual([
      "axios",
      "zod",
    ]);
    expect(result.dependencyResolutions.every(({ status }) => status === "resolved")).toBe(true);
  });

  it("resolves a scoped registry package", async () => {
    const result = await scanRootPnpm(
      { dependencies: { "@prisma/client": "^6.0.0" } },
      {
        dependencies: {
          "@prisma/client": { specifier: "^6.0.0", version: "6.0.1" },
        },
      },
    );

    expect(resolutionFor(result.dependencyResolutions, "@prisma/client")).toMatchObject({
      resolvedVersion: "6.0.1",
      kind: "registry",
      status: "resolved",
    });
  });

  it("extracts a registry version while preserving peer suffixes", async () => {
    const reference = "1.2.3(peer-a@4.0.0)(@scope/peer@5.0.0)";
    const result = await scanRootPnpm(
      { dependencies: { package: "^1.0.0" } },
      { dependencies: { package: { specifier: "^1.0.0", version: reference } } },
    );
    const resolution = resolutionFor(result.dependencyResolutions, "package");

    expect(resolution.resolvedVersion).toBe("1.2.3");
    expect(resolution.resolvedReference).toBe(reference);
    expect(resolution.status).toBe("resolved");
  });

  it("rejects an unbalanced peer suffix conservatively", async () => {
    const result = await scanRootPnpm(
      { dependencies: { package: "^1.0.0" } },
      {
        dependencies: {
          package: { specifier: "^1.0.0", version: "1.2.3(peer-a@4.0.0" },
        },
      },
    );

    expect(resolutionFor(result.dependencyResolutions, "package")).toMatchObject({
      kind: "unknown",
      status: "unresolved",
      issue: "unrecognized-reference",
    });
  });

  it("marks a dependency absent from the importer as unresolved", async () => {
    const result = await scanRootPnpm(
      { dependencies: { axios: "^1.7.0" } },
      { dependencies: {} },
    );

    expect(resolutionFor(result.dependencyResolutions, "axios")).toMatchObject({
      status: "unresolved",
      issue: "dependency-not-found",
    });
  });

  it("throws a typed error for invalid lockfile YAML", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: {},
      files: { "pnpm-lock.yaml": "lockfileVersion: [" },
    });

    await expect(scanProject(projectPath)).rejects.toMatchObject({
      code: "PNPM_LOCKFILE_INVALID",
    });
  });

  it("throws a typed error when the lockfile has no importers", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: { dependencies: { axios: "^1.7.0" } },
      files: { "pnpm-lock.yaml": JSON.stringify({ lockfileVersion: "9.0" }) },
    });

    await expect(scanProject(projectPath)).rejects.toMatchObject({
      code: "PNPM_LOCKFILE_INVALID_STRUCTURE",
    });
  });

  it("uses the root importer key for a simple project", async () => {
    const result = await scanRootPnpm(
      { dependencies: { axios: "^1.7.0" } },
      { dependencies: { axios: { specifier: "^1.7.0", version: "1.7.9" } } },
    );

    expect(result.packageManager).toBe("pnpm");
    expect(result.dependencyResolutions[0]?.importer).toBe(".");
  });

  it("does not fall back to the root importer when a workspace importer is absent", async () => {
    const workspacePath = await createTemporaryProject({
      packageJson: { private: true },
      files: {
        "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
        "pnpm-lock.yaml": pnpmLockfile({ ".": {} }),
        "apps/api/package.json": JSON.stringify({ dependencies: { axios: "^1.7.0" } }),
      },
    });

    await expect(scanProject(path.join(workspacePath, "apps/api"))).rejects.toMatchObject({
      code: "PNPM_IMPORTER_NOT_FOUND",
    });
  });

  it("selects the app importer in the pnpm workspace fixture", async () => {
    const apiPath = path.join(sampleWorkspacePath, "apps/api");
    const result = await scanProject(apiPath);
    const axios = resolutionFor(result.dependencyResolutions, "axios");

    expect(result.packageManager).toBe("pnpm");
    expect(axios.importer).toBe("apps/api");
    expect(axios.workspaceRoot).toBe(sampleWorkspacePath);
    expect(axios.lockfilePath).toBe(path.join(sampleWorkspacePath, "pnpm-lock.yaml"));
  });

  it("selects the package importer in the pnpm workspace fixture", async () => {
    const sharedPath = path.join(sampleWorkspacePath, "packages/shared");
    const result = await scanProject(sharedPath);
    const zod = resolutionFor(result.dependencyResolutions, "zod");

    expect(zod.importer).toBe("packages/shared");
    expect(zod.resolvedVersion).toBe("4.0.5");
  });

  it("classifies a workspace dependency without inventing a version", async () => {
    const result = await scanProject(path.join(sampleWorkspacePath, "apps/api"));
    const shared = resolutionFor(result.dependencyResolutions, "@guardian/shared");

    expect(shared).toMatchObject({
      declaredVersion: "workspace:*",
      resolvedReference: "link:../../packages/shared",
      kind: "workspace",
      status: "resolved",
    });
    expect(shared.resolvedVersion).toBeUndefined();
  });

  it("classifies a link reference", async () => {
    const result = await scanRootPnpm(
      { dependencies: { local: "link:../local" } },
      {
        dependencies: {
          local: { specifier: "link:../local", version: "link:../local" },
        },
      },
    );

    expect(resolutionFor(result.dependencyResolutions, "local")).toMatchObject({
      kind: "link",
      status: "resolved",
      resolvedReference: "link:../local",
    });
  });

  it("classifies a file reference", async () => {
    const result = await scanRootPnpm(
      { dependencies: { archive: "file:../archive.tgz" } },
      {
        dependencies: {
          archive: { specifier: "file:../archive.tgz", version: "file:../archive.tgz" },
        },
      },
    );

    expect(resolutionFor(result.dependencyResolutions, "archive")).toMatchObject({
      kind: "file",
      status: "resolved",
    });
  });

  it("classifies a git reference", async () => {
    const specifier = "github:example/repository#main";
    const reference = "https://codeload.github.com/example/repository/tar.gz/abc123";
    const result = await scanRootPnpm(
      { dependencies: { repository: specifier } },
      { dependencies: { repository: { specifier, version: reference } } },
    );

    expect(resolutionFor(result.dependencyResolutions, "repository")).toMatchObject({
      kind: "git",
      status: "resolved",
      resolvedReference: reference,
    });
  });

  it("uses the final project document in a multi-document lockfile", async () => {
    const lockfile = [
      "---",
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    configDependencies: {}",
      "---",
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      axios:",
      "        specifier: ^1.7.0",
      "        version: 1.7.9",
    ].join("\n");
    const projectPath = await createTemporaryProject({
      packageJson: { dependencies: { axios: "^1.7.0" } },
      files: { "pnpm-lock.yaml": lockfile },
    });
    const result = await scanProject(projectPath);

    expect(resolutionFor(result.dependencyResolutions, "axios")).toMatchObject({
      resolvedVersion: "1.7.9",
      kind: "registry",
      status: "resolved",
    });
  });

  it("classifies an URL reference", async () => {
    const reference = "https://example.com/archive.tgz";
    const result = await scanRootPnpm(
      { dependencies: { archive: reference } },
      { dependencies: { archive: { specifier: reference, version: reference } } },
    );

    expect(resolutionFor(result.dependencyResolutions, "archive")).toMatchObject({
      kind: "url",
      status: "resolved",
      resolvedReference: reference,
    });
  });

  it("marks an unknown reference as unresolved", async () => {
    const result = await scanRootPnpm(
      { dependencies: { custom: "custom:value" } },
      {
        dependencies: {
          custom: { specifier: "custom:value", version: "custom:value" },
        },
      },
    );

    expect(resolutionFor(result.dependencyResolutions, "custom")).toMatchObject({
      kind: "unknown",
      status: "unresolved",
      issue: "unrecognized-reference",
    });
  });

  it("reports npm dependency resolution as unsupported", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: { dependencies: { axios: "^1.7.0" } },
      files: { "package-lock.json": "{}" },
    });
    const result = await scanProject(projectPath);

    expect(resolutionFor(result.dependencyResolutions, "axios")).toMatchObject({
      kind: "unknown",
      status: "unsupported",
      issue: "package-manager-unsupported",
    });
  });

  it("reports yarn dependency resolution as unsupported", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: { dependencies: { zod: "^4.0.0" } },
      files: { "yarn.lock": "" },
    });
    const result = await scanProject(projectPath);

    expect(resolutionFor(result.dependencyResolutions, "zod").status).toBe("unsupported");
  });

  it("reports a pnpm project without a lockfile as unresolved", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: {
        packageManager: "pnpm@10.28.1",
        dependencies: { axios: "^1.7.0" },
      },
    });
    const result = await scanProject(projectPath);

    expect(result.packageManager).toBe("pnpm");
    expect(resolutionFor(result.dependencyResolutions, "axios")).toMatchObject({
      status: "unresolved",
      issue: "lockfile-not-found",
    });
  });

  it("normalizes nested importer paths to POSIX separators", async () => {
    const result = await scanProject(path.join(sampleWorkspacePath, "apps/api"));
    const importer = resolutionFor(result.dependencyResolutions, "axios").importer;

    expect(importer).toBe("apps/api");
    expect(importer).not.toContain("\\");
  });

  it("marks a stale lockfile specifier as unresolved", async () => {
    const result = await scanRootPnpm(
      { dependencies: { axios: "^2.0.0" } },
      { dependencies: { axios: { specifier: "^1.7.0", version: "1.7.9" } } },
    );

    expect(resolutionFor(result.dependencyResolutions, "axios")).toMatchObject({
      status: "unresolved",
      issue: "specifier-mismatch",
      resolvedReference: "1.7.9",
    });
  });

  it("rejects unsupported pnpm lockfile versions", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: { dependencies: { axios: "^1.7.0" } },
      files: { "pnpm-lock.yaml": pnpmLockfile({ ".": {} }, "8.0") },
    });

    await expect(scanProject(projectPath)).rejects.toMatchObject({
      code: "PNPM_LOCKFILE_UNSUPPORTED_VERSION",
    });
  });

  it("does not modify the target project while resolving dependencies", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: { dependencies: { axios: "^1.7.0" } },
      files: {
        "pnpm-lock.yaml": pnpmLockfile({
          ".": {
            dependencies: {
              axios: { specifier: "^1.7.0", version: "1.7.9" },
            },
          },
        }),
        "src/index.ts": "import axios from 'axios';\naxios.get('/users');",
      },
    });
    const beforeFiles = (await readdir(projectPath, { recursive: true })).sort();
    const beforePackageJson = await readFile(path.join(projectPath, "package.json"), "utf8");
    const beforeLockfile = await readFile(path.join(projectPath, "pnpm-lock.yaml"), "utf8");

    await scanProject(projectPath);

    expect((await readdir(projectPath, { recursive: true })).sort()).toEqual(beforeFiles);
    await expect(readFile(path.join(projectPath, "package.json"), "utf8"))
      .resolves.toBe(beforePackageJson);
    await expect(readFile(path.join(projectPath, "pnpm-lock.yaml"), "utf8"))
      .resolves.toBe(beforeLockfile);
  });
});

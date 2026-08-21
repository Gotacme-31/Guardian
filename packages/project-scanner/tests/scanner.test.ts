import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { scanProject, type DependencyUsage } from "../src/index.js";

const sampleProjectPath = fileURLToPath(
  new URL("../../../test-projects/sample-typescript-app", import.meta.url),
);
const temporaryProjects: string[] = [];

interface TemporaryProjectOptions {
  packageJson?: unknown;
  files?: Record<string, string>;
}

async function createTemporaryProject(options: TemporaryProjectOptions = {}): Promise<string> {
  const projectPath = await mkdtemp(path.join(tmpdir(), "guardian-scanner-"));
  temporaryProjects.push(projectPath);

  if (options.packageJson !== null) {
    await writeFile(
      path.join(projectPath, "package.json"),
      JSON.stringify(options.packageJson ?? { name: "temporary-project" }),
    );
  }

  for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
    const filePath = path.join(projectPath, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }

  return projectPath;
}

function usageFor(dependencyUsage: DependencyUsage[], dependency: string): DependencyUsage {
  const usage = dependencyUsage.find((item) => item.dependency === dependency);
  expect(usage, `Expected usage for ${dependency}`).toBeDefined();
  return usage as DependencyUsage;
}

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((projectPath) =>
    rm(projectPath, { recursive: true, force: true })));
});

describe("package manifest", () => {
  it("reads project metadata, dependencies, and development dependencies", async () => {
    const result = await scanProject(sampleProjectPath);

    expect(result.projectName).toBe("sample-typescript-app");
    expect(result.projectPath).toBe(path.resolve(sampleProjectPath));
    expect(result.projectType.node).toBe(true);
    expect(result.dependencies).toContainEqual({
      name: "axios",
      declaredVersion: "^1.7.0",
      type: "dependency",
    });
    expect(result.devDependencies).toContainEqual({
      name: "vitest",
      declaredVersion: "^3.0.0",
      type: "devDependency",
    });
  });

  it("reports a missing package.json with a scanner error", async () => {
    const projectPath = await createTemporaryProject({ packageJson: null });

    await expect(scanProject(projectPath)).rejects.toMatchObject({
      code: "PACKAGE_JSON_NOT_FOUND",
    });
  });

  it("reports invalid package.json content", async () => {
    const projectPath = await createTemporaryProject();
    await writeFile(path.join(projectPath, "package.json"), "{ invalid");

    await expect(scanProject(projectPath)).rejects.toMatchObject({
      code: "PACKAGE_JSON_INVALID",
    });
  });
});

describe("environment detection", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
  ] as const)("detects %s as %s", async (lockfile, expectedManager) => {
    const projectPath = await createTemporaryProject({ files: { [lockfile]: "" } });

    await expect(scanProject(projectPath)).resolves.toMatchObject({
      packageManager: expectedManager,
    });
  });

  it("returns unknown when there is no supported lockfile", async () => {
    const projectPath = await createTemporaryProject();

    await expect(scanProject(projectPath)).resolves.toMatchObject({
      packageManager: "unknown",
    });
  });

  it("rejects ambiguous package managers", async () => {
    const projectPath = await createTemporaryProject({
      files: { "pnpm-lock.yaml": "", "package-lock.json": "{}" },
    });

    await expect(scanProject(projectPath)).rejects.toMatchObject({
      code: "MULTIPLE_LOCKFILES",
    });
  });

  it("detects TypeScript from tsconfig.json", async () => {
    const projectPath = await createTemporaryProject({
      files: { "tsconfig.json": "{}", "src/index.js": "export {};" },
    });

    await expect(scanProject(projectPath)).resolves.toMatchObject({
      projectType: { node: true, typescript: true },
    });
  });

  it.each(["ts", "tsx", "mts", "cts"])("detects TypeScript from a .%s file", async (extension) => {
    const projectPath = await createTemporaryProject({
      files: { [`src/index.${extension}`]: "export {};" },
    });

    await expect(scanProject(projectPath)).resolves.toMatchObject({
      projectType: { typescript: true },
    });
  });

  it("does not classify a JavaScript-only project as TypeScript", async () => {
    const projectPath = await createTemporaryProject({
      files: { "src/index.js": "export {};" },
    });

    await expect(scanProject(projectPath)).resolves.toMatchObject({
      projectType: { typescript: false },
    });
  });
});

describe("dependency usage", () => {
  it("detects default and named ES imports, including repeated imports", async () => {
    const result = await scanProject(sampleProjectPath);
    const axios = usageFor(result.dependencyUsage, "axios");

    expect(axios.files).toEqual(["src/http.ts", "src/second-http.ts"]);
    expect(axios.importCount).toBe(3);
    expect(axios.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: "src/http.ts",
        source: "axios",
        defaultImport: "axios",
        importedSymbols: [],
        kind: "es-import",
      }),
      expect.objectContaining({
        file: "src/http.ts",
        source: "axios",
        importedSymbols: ["AxiosError"],
        kind: "es-import",
      }),
    ]));
  });

  it("detects namespace imports", async () => {
    const result = await scanProject(sampleProjectPath);
    const react = usageFor(result.dependencyUsage, "react");

    expect(react.imports).toContainEqual({
      file: "src/react-view.tsx",
      source: "react",
      importedSymbols: [],
      namespaceImport: "React",
      kind: "es-import",
    });
  });

  it("detects require calls and their local binding", async () => {
    const result = await scanProject(sampleProjectPath);
    const express = usageFor(result.dependencyUsage, "express");

    expect(express.imports).toContainEqual({
      file: "src/server.cjs",
      source: "express",
      importedSymbols: [],
      defaultImport: "express",
      kind: "require",
    });
  });

  it("detects dynamic imports and their local binding", async () => {
    const result = await scanProject(sampleProjectPath);
    const dynamicUsage = usageFor(result.dependencyUsage, "some-package");

    expect(dynamicUsage.imports).toContainEqual({
      file: "src/lazy.ts",
      source: "some-package",
      importedSymbols: [],
      namespaceImport: "lazyModule",
      kind: "dynamic-import",
    });
  });

  it("maps scoped package subpaths to the declared package root", async () => {
    const result = await scanProject(sampleProjectPath);
    const prisma = usageFor(result.dependencyUsage, "@prisma/client");

    expect(prisma.files).toEqual(["src/database.ts"]);
    expect(prisma.importCount).toBe(2);
    expect(prisma.imports.map(({ source }) => source)).toEqual([
      "@prisma/client",
      "@prisma/client/runtime/library",
    ]);
    expect(prisma.imports[0]?.importedSymbols).toEqual(["PrismaClient"]);
  });

  it("maps unscoped package subpaths to the declared package root", async () => {
    const result = await scanProject(sampleProjectPath);
    const lodash = usageFor(result.dependencyUsage, "lodash");

    expect(lodash.imports).toContainEqual({
      file: "src/http.ts",
      source: "lodash/map",
      importedSymbols: [],
      defaultImport: "map",
      kind: "es-import",
    });
  });

  it("ignores relative imports and undeclared internal aliases", async () => {
    const result = await scanProject(sampleProjectPath);

    expect(result.dependencyUsage.map(({ dependency }) => dependency)).not.toContain("@app/helper");
    expect(result.dependencyUsage.flatMap(({ imports }) => imports.map(({ source }) => source)))
      .not.toEqual(expect.arrayContaining(["./relative.js", "@app/helper"]));
  });

  it("ignores source files under node_modules and generated directories", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: { dependencies: { axios: "^1.0.0" } },
      files: {
        "src/index.ts": "import axios from 'axios';",
        "node_modules/fake/index.ts": "import axios from 'axios';",
        "dist/index.js": "import axios from 'axios';",
      },
    });

    const result = await scanProject(projectPath);
    const axios = usageFor(result.dependencyUsage, "axios");

    expect(axios.files).toEqual(["src/index.ts"]);
    expect(axios.importCount).toBe(1);
  });

  it("records destructured require and dynamic import symbols", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: { dependencies: { zod: "^4.0.0" } },
      files: {
        "src/index.ts": [
          "const { z: schemaBuilder } = require('zod');",
          "const { ZodError } = await import('zod');",
        ].join("\n"),
      },
    });

    const result = await scanProject(projectPath);
    const zod = usageFor(result.dependencyUsage, "zod");

    expect(zod.importCount).toBe(2);
    expect(zod.imports.map(({ importedSymbols }) => importedSymbols)).toEqual([
      ["z"],
      ["ZodError"],
    ]);
  });

  it("reports POSIX-style paths relative to the scanned project", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: { dependencies: { zod: "^4.0.0" } },
      files: { "src/nested/schema.ts": "import { z } from 'zod';" },
    });

    const result = await scanProject(projectPath);

    expect(usageFor(result.dependencyUsage, "zod").files).toEqual([
      "src/nested/schema.ts",
    ]);
  });
});

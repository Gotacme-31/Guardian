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

async function scanTemporaryDependency(
  dependency: string,
  source: string,
  file = "src/index.ts",
): Promise<DependencyUsage> {
  const projectPath = await createTemporaryProject({
    packageJson: { dependencies: { [dependency]: "^1.0.0" } },
    files: { [file]: source },
  });
  const result = await scanProject(projectPath);
  return usageFor(result.dependencyUsage, dependency);
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
    const lockfileContents = lockfile === "pnpm-lock.yaml"
      ? "lockfileVersion: '9.0'\nimporters:\n  .: {}\n"
      : "";
    const projectPath = await createTemporaryProject({
      files: { [lockfile]: lockfileContents },
    });

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

describe("symbol usage", () => {
  it("detects a member call on a default import", async () => {
    const axios = await scanTemporaryDependency(
      "axios",
      "import axios from 'axios';\naxios.get('/users');",
    );

    expect(axios.symbolUsages).toEqual([{
      dependency: "axios",
      file: "src/index.ts",
      localBinding: "axios",
      usagePath: "axios.get",
      kind: "call",
      line: 2,
      column: 1,
    }]);
  });

  it("detects multiple methods on a default import", async () => {
    const axios = await scanTemporaryDependency(
      "axios",
      [
        "import axios from 'axios';",
        "axios.get('/users');",
        "axios.post('/orders');",
        "axios.create();",
      ].join("\n"),
    );

    expect(axios.symbolUsages.map(({ usagePath }) => usagePath)).toEqual([
      "axios.get",
      "axios.post",
      "axios.create",
    ]);
    expect(axios.symbolUsages.every(({ kind }) => kind === "call")).toBe(true);
  });

  it("detects a direct call to a named import", async () => {
    const dateFns = await scanTemporaryDependency(
      "date-fns",
      "import { format } from 'date-fns';\nformat(new Date(), 'yyyy-MM-dd');",
    );

    expect(dateFns.symbolUsages).toContainEqual(expect.objectContaining({
      importedSymbol: "format",
      localBinding: "format",
      usagePath: "format",
      kind: "call",
    }));
  });

  it("detects a member call on a named import", async () => {
    const zod = await scanTemporaryDependency(
      "zod",
      "import { z } from 'zod';\nz.string();",
    );

    expect(zod.symbolUsages).toContainEqual(expect.objectContaining({
      importedSymbol: "z",
      localBinding: "z",
      usagePath: "z.string",
      kind: "call",
    }));
  });

  it("preserves imported and local identities for an aliased named import", async () => {
    const dateFns = await scanTemporaryDependency(
      "date-fns",
      "import { format as formatDate } from 'date-fns';\nformatDate(new Date(), 'yyyy');",
    );

    expect(dateFns.symbolUsages).toContainEqual(expect.objectContaining({
      importedSymbol: "format",
      localBinding: "formatDate",
      usagePath: "format",
      kind: "call",
    }));
  });

  it("detects member calls on a namespace import", async () => {
    const react = await scanTemporaryDependency(
      "react",
      "import * as React from 'react';\nReact.createElement('div');",
      "src/view.tsx",
    );

    expect(react.symbolUsages).toContainEqual(expect.objectContaining({
      localBinding: "React",
      usagePath: "React.createElement",
      kind: "call",
    }));
  });

  it("detects a require default-like binding", async () => {
    const express = await scanTemporaryDependency(
      "express",
      "const express = require('express');\nexpress.json();",
      "src/server.cjs",
    );

    expect(express.symbolUsages).toContainEqual(expect.objectContaining({
      localBinding: "express",
      usagePath: "express.json",
      kind: "call",
    }));
  });

  it("detects a direct call from a destructured require", async () => {
    const express = await scanTemporaryDependency(
      "express",
      "const { Router } = require('express');\nRouter();",
      "src/server.cjs",
    );

    expect(express.symbolUsages).toContainEqual(expect.objectContaining({
      importedSymbol: "Router",
      localBinding: "Router",
      usagePath: "Router",
      kind: "call",
    }));
  });

  it("detects a member call on a dynamic import binding", async () => {
    const dynamicUsage = await scanTemporaryDependency(
      "some-package",
      "const module = await import('some-package');\nmodule.doSomething();",
    );

    expect(dynamicUsage.symbolUsages).toContainEqual(expect.objectContaining({
      localBinding: "module",
      usagePath: "module.doSomething",
      kind: "call",
    }));
  });

  it("records the complete chained member access", async () => {
    const axios = await scanTemporaryDependency(
      "axios",
      "import axios from 'axios';\nconst headers = axios.defaults.headers.common;",
    );

    expect(axios.symbolUsages).toEqual([expect.objectContaining({
      usagePath: "axios.defaults.headers.common",
      kind: "member-access",
    })]);
  });

  it("records the source file relative to the project", async () => {
    const zod = await scanTemporaryDependency(
      "zod",
      "import { z } from 'zod';\nz.object({});",
      "src/nested/schema.ts",
    );

    expect(zod.symbolUsages[0]?.file).toBe("src/nested/schema.ts");
  });

  it("records one-based source lines", async () => {
    const axios = await scanTemporaryDependency(
      "axios",
      "import axios from 'axios';\n\n\naxios.get('/users');",
    );

    expect(axios.symbolUsages[0]?.line).toBe(4);
  });

  it("records one-based source columns", async () => {
    const axios = await scanTemporaryDependency(
      "axios",
      "import axios from 'axios';\n    axios.get('/users');",
    );

    expect(axios.symbolUsages[0]?.column).toBe(5);
  });

  it("emits one terminal usage for a member call", async () => {
    const axios = await scanTemporaryDependency(
      "axios",
      "import axios from 'axios';\naxios.get('/users');",
    );

    expect(axios.symbolUsages).toHaveLength(1);
    expect(axios.symbolUsages.map(({ usagePath, kind }) => [usagePath, kind])).toEqual([
      ["axios.get", "call"],
    ]);
  });

  it("does not attribute a shadowing function parameter to an import", async () => {
    const axios = await scanTemporaryDependency(
      "axios",
      [
        "import axios from 'axios';",
        "axios.post('/orders');",
        "function test(axios: { get(): void }) {",
        "  axios.get();",
        "}",
      ].join("\n"),
    );

    expect(axios.symbolUsages.map(({ usagePath }) => usagePath)).toEqual(["axios.post"]);
  });

  it("does not attribute a shadowing local variable to an import", async () => {
    const zod = await scanTemporaryDependency(
      "zod",
      [
        "import { z } from 'zod';",
        "z.string();",
        "function run(localThing: { execute(): void }) {",
        "  const z = localThing;",
        "  z.execute();",
        "}",
      ].join("\n"),
    );

    expect(zod.symbolUsages.map(({ usagePath }) => usagePath)).toEqual(["z.string"]);
  });

  it("keeps same-named imports associated with their dependencies", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: { dependencies: { "package-a": "^1.0.0", "package-b": "^1.0.0" } },
      files: {
        "src/index.ts": [
          "import { foo } from 'package-a';",
          "import { foo as otherFoo } from 'package-b';",
          "foo();",
          "otherFoo();",
        ].join("\n"),
      },
    });
    const result = await scanProject(projectPath);

    expect(usageFor(result.dependencyUsage, "package-a").symbolUsages)
      .toContainEqual(expect.objectContaining({ localBinding: "foo", usagePath: "foo" }));
    expect(usageFor(result.dependencyUsage, "package-b").symbolUsages)
      .toContainEqual(expect.objectContaining({ localBinding: "otherFoo", usagePath: "foo" }));
  });

  it("classifies construction of an imported class", async () => {
    const prisma = await scanTemporaryDependency(
      "@prisma/client",
      "import { PrismaClient } from '@prisma/client';\nnew PrismaClient();",
    );

    expect(prisma.symbolUsages).toContainEqual(expect.objectContaining({
      importedSymbol: "PrismaClient",
      localBinding: "PrismaClient",
      usagePath: "PrismaClient",
      kind: "constructor",
    }));
  });

  it("tracks a simple instance created from an imported class", async () => {
    const sdk = await scanTemporaryDependency(
      "some-sdk",
      [
        "import { SomeClient } from 'some-sdk';",
        "const client = new SomeClient();",
        "client.connect();",
      ].join("\n"),
    );

    expect(sdk.symbolUsages).toContainEqual(expect.objectContaining({
      importedSymbol: "SomeClient",
      localBinding: "client",
      usagePath: "client.connect",
      kind: "call",
    }));
  });

  it("tracks a member chain on a simple imported-class instance", async () => {
    const prisma = await scanTemporaryDependency(
      "@prisma/client",
      [
        "import { PrismaClient } from '@prisma/client';",
        "const prisma = new PrismaClient();",
        "prisma.user.findMany();",
      ].join("\n"),
    );

    expect(prisma.symbolUsages).toContainEqual(expect.objectContaining({
      importedSymbol: "PrismaClient",
      localBinding: "prisma",
      usagePath: "prisma.user.findMany",
      kind: "call",
    }));
  });

  it("tracks multiple simple instances of one imported class", async () => {
    const sdk = await scanTemporaryDependency(
      "some-sdk",
      [
        "import { SomeClient } from 'some-sdk';",
        "const first = new SomeClient();",
        "const second = new SomeClient();",
        "first.users.list();",
        "second.orders.list();",
      ].join("\n"),
    );

    expect(sdk.symbolUsages.filter(({ localBinding }) => localBinding === "first"))
      .toContainEqual(expect.objectContaining({ usagePath: "first.users.list" }));
    expect(sdk.symbolUsages.filter(({ localBinding }) => localBinding === "second"))
      .toContainEqual(expect.objectContaining({ usagePath: "second.orders.list" }));
  });

  it("does not emit symbol usages for an unused import", async () => {
    const axios = await scanTemporaryDependency("axios", "import axios from 'axios';");

    expect(axios.symbolUsages).toEqual([]);
  });

  it("records symbol usages in different source files", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: { dependencies: { axios: "^1.0.0" } },
      files: {
        "src/users.ts": "import axios from 'axios';\naxios.get('/users');",
        "src/orders.ts": "import axios from 'axios';\naxios.post('/orders');",
      },
    });
    const result = await scanProject(projectPath);

    expect(usageFor(result.dependencyUsage, "axios").symbolUsages.map(({ file }) => file).sort())
      .toEqual(["src/orders.ts", "src/users.ts"]);
  });

  it("continues to ignore relative imports when analyzing symbols", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: { dependencies: { axios: "^1.0.0" } },
      files: {
        "src/index.ts": "import { helper } from './helper.js';\nhelper.run();",
        "src/helper.ts": "export const helper = { run() {} };",
      },
    });
    const result = await scanProject(projectPath);

    expect(result.dependencyUsage).toEqual([]);
  });

  it("stops attributing calls after a direct binding reassignment", async () => {
    const axios = await scanTemporaryDependency(
      "axios",
      [
        "let client = require('axios');",
        "client.get('/users');",
        "client = { post() {} };",
        "client.post('/orders');",
      ].join("\n"),
    );

    expect(axios.symbolUsages.map(({ usagePath }) => usagePath)).toEqual(["client.get"]);
  });

  it("classifies a bare imported binding as a reference", async () => {
    const axios = await scanTemporaryDependency(
      "axios",
      "import axios from 'axios';\nexport const client = axios;",
    );

    expect(axios.symbolUsages).toContainEqual(expect.objectContaining({
      localBinding: "axios",
      usagePath: "axios",
      kind: "reference",
    }));
  });

  it("does not treat a shadowed require function as a dependency import", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: { dependencies: { axios: "^1.0.0" } },
      files: {
        "src/index.ts": [
          "function load(require: (name: string) => unknown) {",
          "  const client = require('axios');",
          "  return client;",
          "}",
        ].join("\n"),
      },
    });
    const result = await scanProject(projectPath);

    expect(result.dependencyUsage).toEqual([]);
  });

  it("does not attribute Promise methods from an unawaited dynamic import", async () => {
    const dynamicUsage = await scanTemporaryDependency(
      "some-package",
      "const modulePromise = import('some-package');\nmodulePromise.then(() => undefined);",
    );

    expect(dynamicUsage.symbolUsages).toEqual([]);
  });

  it("does not attribute runtime binding references before initialization", async () => {
    const axios = await scanTemporaryDependency(
      "axios",
      "client.get('/users');\nvar client = require('axios');",
      "src/index.js",
    );

    expect(axios.symbolUsages).toEqual([]);
  });

  it("avoids attribution when repeated declarations share one compiler symbol", async () => {
    const projectPath = await createTemporaryProject({
      packageJson: { dependencies: { "package-a": "^1.0.0", "package-b": "^1.0.0" } },
      files: {
        "src/index.js": [
          "var client = require('package-a');",
          "client.first();",
          "var client = require('package-b');",
          "client.second();",
        ].join("\n"),
      },
    });
    const result = await scanProject(projectPath);

    expect(usageFor(result.dependencyUsage, "package-a").symbolUsages).toEqual([]);
    expect(usageFor(result.dependencyUsage, "package-b").symbolUsages).toEqual([]);
  });
});

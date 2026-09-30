import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyVersionBump,
  checkVersionBumpEligibility,
  composeVersionBump,
  type MigrationProposalSummary,
} from "../src/index.js";

const temporaryProjects: string[] = [];

async function createTemporaryProject(packageJsonText: string): Promise<string> {
  const projectPath = await mkdtemp(path.join(tmpdir(), "guardian-version-bump-"));
  temporaryProjects.push(projectPath);
  await writeFile(path.join(projectPath, "package.json"), packageJsonText, "utf8");
  return projectPath;
}

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((projectPath) =>
    rm(projectPath, { recursive: true, force: true })));
});

function summary(overrides: Partial<MigrationProposalSummary> = {}): MigrationProposalSummary {
  return {
    breaking: 0,
    needsReview: 0,
    safe: 1,
    unaffected: 0,
    unresolved: 0,
    indeterminate: 0,
    ...overrides,
  };
}

describe("checkVersionBumpEligibility", () => {
  it("blocks on breaking-changes-present", () => {
    expect(checkVersionBumpEligibility(summary({ breaking: 2 }))).toEqual({
      eligible: false,
      blockingReasons: ["breaking-changes-present"],
    });
  });

  it("blocks on needs-review-present", () => {
    expect(checkVersionBumpEligibility(summary({ needsReview: 1 }))).toEqual({
      eligible: false,
      blockingReasons: ["needs-review-present"],
    });
  });

  it("blocks on unresolved-usages-present", () => {
    expect(checkVersionBumpEligibility(summary({ unresolved: 3 }))).toEqual({
      eligible: false,
      blockingReasons: ["unresolved-usages-present"],
    });
  });

  it("blocks on indeterminate-usages-present", () => {
    expect(checkVersionBumpEligibility(summary({ indeterminate: 5 }))).toEqual({
      eligible: false,
      blockingReasons: ["indeterminate-usages-present"],
    });
  });

  it("reports every applicable blocking reason at once, not just the first", () => {
    const result = checkVersionBumpEligibility(
      summary({ breaking: 1, needsReview: 1, unresolved: 1, indeterminate: 1 }),
    );
    expect(result).toEqual({
      eligible: false,
      blockingReasons: [
        "breaking-changes-present",
        "needs-review-present",
        "unresolved-usages-present",
        "indeterminate-usages-present",
      ],
    });
  });

  it("is eligible when only safe and unaffected usages exist", () => {
    expect(checkVersionBumpEligibility(summary({ safe: 4, unaffected: 2 }))).toEqual({
      eligible: true,
      blockingReasons: [],
    });
  });

  it("never blocks on safe or unaffected counts alone, however large", () => {
    const result = checkVersionBumpEligibility({
      breaking: 0,
      needsReview: 0,
      safe: 100,
      unaffected: 100,
      unresolved: 0,
      indeterminate: 0,
    });
    expect(result.eligible).toBe(true);
  });
});

describe("composeVersionBump", () => {
  it("preserves a caret prefix", () => {
    expect(composeVersionBump("^1.7.0", "1.8.0")).toEqual({
      operator: "^",
      newDeclaredVersion: "^1.8.0",
    });
  });

  it("preserves a tilde prefix", () => {
    expect(composeVersionBump("~1.7.0", "1.7.5")).toEqual({
      operator: "~",
      newDeclaredVersion: "~1.7.5",
    });
  });

  it("preserves an exact version with no prefix", () => {
    expect(composeVersionBump("1.7.0", "1.8.0")).toEqual({
      operator: "",
      newDeclaredVersion: "1.8.0",
    });
  });

  it("rejects a compound range", () => {
    expect(composeVersionBump(">=1.0.0 <2.0.0", "1.8.0")).toEqual({
      error: "unsupported-range-format",
    });
  });

  it("rejects a wildcard range", () => {
    expect(composeVersionBump("*", "1.8.0")).toEqual({ error: "unsupported-range-format" });
  });

  it("rejects a dist-tag", () => {
    expect(composeVersionBump("latest", "1.8.0")).toEqual({ error: "unsupported-range-format" });
  });

  it("rejects an x-range", () => {
    expect(composeVersionBump("1.x", "1.8.0")).toEqual({ error: "unsupported-range-format" });
  });
});

describe("applyVersionBump", () => {
  it("replaces only the targeted version, preserving the rest of the file byte for byte", async () => {
    const original = "{\n"
      + "  \"name\": \"fixture\",\n"
      + "  \"version\": \"1.0.0\",\n"
      + "  \"dependencies\": {\n"
      + "    \"axios\": \"^1.7.0\",\n"
      + "    \"lodash\": \"^4.17.21\"\n"
      + "  },\n"
      + "  \"devDependencies\": {\n"
      + "    \"vitest\": \"^3.0.0\"\n"
      + "  }\n"
      + "}\n";
    const projectPath = await createTemporaryProject(original);

    const result = await applyVersionBump(projectPath, "axios", "dependency", "^1.7.0", "^1.8.0");

    expect(result).toEqual({
      packageJsonPath: path.join(projectPath, "package.json"),
      field: "dependencies",
      previousDeclaredVersion: "^1.7.0",
      newDeclaredVersion: "^1.8.0",
    });

    const updated = await readFile(path.join(projectPath, "package.json"), "utf8");
    expect(updated).toBe(original.replace("\"axios\": \"^1.7.0\"", "\"axios\": \"^1.8.0\""));
  });

  it("returns declared-version-mismatch when the file no longer matches what was scanned", async () => {
    const projectPath = await createTemporaryProject(JSON.stringify({
      name: "fixture",
      dependencies: { axios: "^1.9.0" },
    }, null, 2));

    const result = await applyVersionBump(projectPath, "axios", "dependency", "^1.7.0", "^1.8.0");

    expect(result).toEqual({ error: "declared-version-mismatch" });
  });

  it("returns declared-version-mismatch when the dependency is missing from that section entirely", async () => {
    const projectPath = await createTemporaryProject(JSON.stringify({
      name: "fixture",
      dependencies: {},
    }, null, 2));

    const result = await applyVersionBump(projectPath, "axios", "dependency", "^1.7.0", "^1.8.0");

    expect(result).toEqual({ error: "declared-version-mismatch" });
  });

  it("returns package-json-not-found when there is no package.json in the project", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "guardian-version-bump-"));
    temporaryProjects.push(projectPath);

    const result = await applyVersionBump(projectPath, "axios", "dependency", "^1.7.0", "^1.8.0");

    expect(result).toEqual({ error: "package-json-not-found" });
  });

  it("returns package-json-invalid for malformed JSON", async () => {
    const projectPath = await createTemporaryProject("{ not valid json");

    const result = await applyVersionBump(projectPath, "axios", "dependency", "^1.7.0", "^1.8.0");

    expect(result).toEqual({ error: "package-json-invalid" });
  });

  it("only touches the requested section when the same name appears in both with different versions", async () => {
    const original = JSON.stringify({
      name: "fixture",
      dependencies: { shared: "^1.0.0" },
      devDependencies: { shared: "^2.0.0" },
    }, null, 2) + "\n";
    const projectPath = await createTemporaryProject(original);

    const result = await applyVersionBump(projectPath, "shared", "devDependency", "^2.0.0", "^3.0.0");

    expect(result).toEqual({
      packageJsonPath: path.join(projectPath, "package.json"),
      field: "devDependencies",
      previousDeclaredVersion: "^2.0.0",
      newDeclaredVersion: "^3.0.0",
    });

    const updated = await readFile(path.join(projectPath, "package.json"), "utf8");
    expect(updated).toContain("\"shared\": \"^1.0.0\"");
    expect(updated).toContain("\"shared\": \"^3.0.0\"");
    expect(updated).not.toContain("\"shared\": \"^2.0.0\"");
  });

  it("does not touch dependencies when bumping the same name in devDependencies the other way around", async () => {
    const original = JSON.stringify({
      name: "fixture",
      dependencies: { shared: "^1.0.0" },
      devDependencies: { shared: "^2.0.0" },
    }, null, 2) + "\n";
    const projectPath = await createTemporaryProject(original);

    const result = await applyVersionBump(projectPath, "shared", "dependency", "^1.0.0", "^1.5.0");

    expect(result).toEqual({
      packageJsonPath: path.join(projectPath, "package.json"),
      field: "dependencies",
      previousDeclaredVersion: "^1.0.0",
      newDeclaredVersion: "^1.5.0",
    });

    const updated = await readFile(path.join(projectPath, "package.json"), "utf8");
    expect(updated).toContain("\"shared\": \"^1.5.0\"");
    expect(updated).toContain("\"shared\": \"^2.0.0\"");
  });
});

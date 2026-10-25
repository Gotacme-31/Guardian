import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { MigrationProposalSummary } from "@guardian/project-scanner";

import {
  buildBranchName,
  buildPullRequestContent,
  deliverVersionBumpAsPullRequest,
  sanitizeBranchComponent,
  type CommandResult,
  type GitDeliveryDependencies,
} from "../src/git-delivery.js";

const execFile = promisify(execFileCallback);
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((item) =>
    rm(item, { recursive: true, force: true })));
});

function summary(overrides: Partial<MigrationProposalSummary> = {}): MigrationProposalSummary {
  return {
    breaking: 0,
    needsReview: 0,
    safe: 3,
    unaffected: 2,
    unresolved: 0,
    indeterminate: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sanitizeBranchComponent / buildBranchName
// ---------------------------------------------------------------------------

describe("sanitizeBranchComponent", () => {
  it("leaves a simple name untouched", () => {
    expect(sanitizeBranchComponent("axios")).toBe("axios");
  });

  it("leaves a dotted version untouched", () => {
    expect(sanitizeBranchComponent("1.6.0")).toBe("1.6.0");
  });

  it("replaces a scope slash with a dash", () => {
    expect(sanitizeBranchComponent("@prisma/client")).toBe("prisma-client");
  });

  it("collapses repeated unsafe characters into a single dash and trims the ends", () => {
    expect(sanitizeBranchComponent("  weird!!name??  ")).toBe("weird-name");
  });

  it("collapses already-repeated dashes", () => {
    expect(sanitizeBranchComponent("a--b")).toBe("a-b");
  });
});

describe("buildBranchName", () => {
  it("builds a deterministic guardian/bump-<dep>-<version> name for a simple dependency", () => {
    expect(buildBranchName("axios", "^1.8.0")).toBe("guardian/bump-axios-1.8.0");
  });

  it("sanitizes a scoped dependency name", () => {
    expect(buildBranchName("@prisma/client", "6.0.1")).toBe("guardian/bump-prisma-client-6.0.1");
  });

  it("sanitizes an exact version with no range operator", () => {
    expect(buildBranchName("p-limit", "7.3.3")).toBe("guardian/bump-p-limit-7.3.3");
  });
});

// ---------------------------------------------------------------------------
// buildPullRequestContent
// ---------------------------------------------------------------------------

describe("buildPullRequestContent", () => {
  it("produces the exact deterministic title and body, verbatim", () => {
    const { title, body } = buildPullRequestContent(
      "p-limit",
      "^7.3.2",
      "^7.3.3",
      summary({ safe: 1, unaffected: 4 }),
    );

    expect(title).toBe("chore(deps): bump p-limit from ^7.3.2 to ^7.3.3");
    expect(body).toBe(
      "Guardian verified that bumping `p-limit` from `^7.3.2` to `^7.3.3` affects no usage in "
      + "this project that needs a human to look at it.\n"
      + "\n"
      + "Usage impact summary:\n"
      + "- breaking: 0\n"
      + "- needs-review: 0\n"
      + "- safe: 1\n"
      + "- unaffected: 4\n"
      + "- unresolved: 0\n"
      + "- indeterminate: 0\n"
      + "\n"
      + "No source files were modified. Only the declared version in `package.json` was changed.\n"
      + "\n"
      + "This pull request was opened automatically by Guardian after explicit authorization "
      + "(`--yes`).",
    );
  });

  it("reflects non-zero counts verbatim, not just zeros", () => {
    const { body } = buildPullRequestContent(
      "axios",
      "^1.7.0",
      "^1.8.0",
      { breaking: 1, needsReview: 2, safe: 3, unaffected: 4, unresolved: 5, indeterminate: 6 },
    );

    expect(body).toContain("- breaking: 1\n");
    expect(body).toContain("- needs-review: 2\n");
    expect(body).toContain("- safe: 3\n");
    expect(body).toContain("- unaffected: 4\n");
    expect(body).toContain("- unresolved: 5\n");
    expect(body).toContain("- indeterminate: 6\n");
  });
});

// ---------------------------------------------------------------------------
// deliverVersionBumpAsPullRequest -- fully faked runGit/runGh (item 3)
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly tool: "git" | "gh";
  readonly args: readonly string[];
}

function commandError(message: string, stdout = "", stderr = ""): Error {
  const error = new Error(message) as Error & { stdout: string; stderr: string };
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

async function createFixtureProject(dependency: string, declaredVersion: string): Promise<string> {
  const projectPath = await mkdtemp(path.join(tmpdir(), "guardian-git-delivery-fixture-"));
  temporaryPaths.push(projectPath);
  await writeFile(
    path.join(projectPath, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { [dependency]: declaredVersion } }, null, 2) + "\n",
    "utf8",
  );
  return projectPath;
}

function happyPathDoubles(prUrl: string): { deps: GitDeliveryDependencies; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runGit: GitDeliveryDependencies["runGit"] = async (args) => {
    calls.push({ tool: "git", args });
    if (args[0] === "status" && args[1] === "--porcelain") {
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse") {
      return { stdout: "main\n", stderr: "" };
    }
    if (args[0] === "show-ref") {
      throw commandError("fatal: ref does not exist");
    }
    if (args[0] === "ls-remote") {
      throw commandError("exit code 2: no matching refs");
    }
    return { stdout: "", stderr: "" };
  };
  const runGh: GitDeliveryDependencies["runGh"] = async (args) => {
    calls.push({ tool: "gh", args });
    if (args[0] === "pr" && args[1] === "create") {
      return { stdout: `${prUrl}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { deps: { runGit, runGh }, calls };
}

describe("deliverVersionBumpAsPullRequest (faked runGit/runGh)", () => {
  it("runs the full happy path with the exact expected call order and returns branch + prUrl", async () => {
    const projectPath = await createFixtureProject("fixture-dep", "^1.0.0");
    const { deps, calls } = happyPathDoubles("https://github.com/example/example/pull/42");

    const result = await deliverVersionBumpAsPullRequest(
      projectPath,
      "fixture-dep",
      "dependency",
      "^1.0.0",
      "^1.1.0",
      summary(),
      deps,
    );

    expect("code" in result).toBe(false);
    if ("code" in result) {
      throw new Error("expected a successful GitDeliveryResult");
    }
    expect(result.branch).toBe("guardian/bump-fixture-dep-1.1.0");
    expect(result.prUrl).toBe("https://github.com/example/example/pull/42");
    expect(result.warning).toBeUndefined();

    const packageJsonPath = path.join(projectPath, "package.json");
    expect(calls.map((call) => [call.tool, ...call.args].join(" "))).toEqual([
      "git --version",
      "gh --version",
      "gh auth status",
      "git status --porcelain",
      "git rev-parse --abbrev-ref HEAD",
      "git show-ref --verify --quiet refs/heads/guardian/bump-fixture-dep-1.1.0",
      "git ls-remote --exit-code --heads origin guardian/bump-fixture-dep-1.1.0",
      "git checkout -b guardian/bump-fixture-dep-1.1.0",
      `git add ${packageJsonPath}`,
      "git commit -m chore(deps): bump fixture-dep from ^1.0.0 to ^1.1.0",
      "git push -u origin guardian/bump-fixture-dep-1.1.0",
      "gh pr create --title chore(deps): bump fixture-dep from ^1.0.0 to ^1.1.0 --body "
      + buildPullRequestContent("fixture-dep", "^1.0.0", "^1.1.0", summary()).body
      + " --head guardian/bump-fixture-dep-1.1.0",
      "git checkout main",
    ]);

    const updatedPackageJson = await readFile(packageJsonPath, "utf8");
    expect(JSON.parse(updatedPackageJson)).toMatchObject({
      dependencies: { "fixture-dep": "^1.1.0" },
    });
  });

  it("returns working-tree-not-clean and touches nothing when git status is dirty", async () => {
    const projectPath = await createFixtureProject("fixture-dep", "^1.0.0");
    const { deps, calls } = happyPathDoubles("unused");
    const dirtyRunGit: GitDeliveryDependencies["runGit"] = async (args, cwd) => {
      if (args[0] === "status" && args[1] === "--porcelain") {
        calls.push({ tool: "git", args });
        return { stdout: " M some-file.ts\n", stderr: "" };
      }
      return deps.runGit(args, cwd);
    };

    const result = await deliverVersionBumpAsPullRequest(
      projectPath,
      "fixture-dep",
      "dependency",
      "^1.0.0",
      "^1.1.0",
      summary(),
      { runGit: dirtyRunGit, runGh: deps.runGh },
    );

    expect(result).toMatchObject({
      code: "working-tree-not-clean",
      step: "git status --porcelain",
    });
    expect(calls.some((call) => call.args[0] === "checkout")).toBe(false);
  });

  it("returns detached-head when HEAD is not a real branch", async () => {
    const projectPath = await createFixtureProject("fixture-dep", "^1.0.0");
    const { deps } = happyPathDoubles("unused");
    const detachedRunGit: GitDeliveryDependencies["runGit"] = async (args, cwd) => {
      if (args[0] === "rev-parse") {
        return { stdout: "HEAD\n", stderr: "" };
      }
      return deps.runGit(args, cwd);
    };

    const result = await deliverVersionBumpAsPullRequest(
      projectPath,
      "fixture-dep",
      "dependency",
      "^1.0.0",
      "^1.1.0",
      summary(),
      { runGit: detachedRunGit, runGh: deps.runGh },
    );

    expect(result).toMatchObject({
      code: "detached-head",
      step: "git rev-parse --abbrev-ref HEAD",
    });
  });

  it("returns branch-already-exists-locally without creating or reusing it", async () => {
    const projectPath = await createFixtureProject("fixture-dep", "^1.0.0");
    const { deps, calls } = happyPathDoubles("unused");
    const existingLocalRunGit: GitDeliveryDependencies["runGit"] = async (args, cwd) => {
      if (args[0] === "show-ref") {
        calls.push({ tool: "git", args });
        return { stdout: "", stderr: "" };
      }
      return deps.runGit(args, cwd);
    };

    const result = await deliverVersionBumpAsPullRequest(
      projectPath,
      "fixture-dep",
      "dependency",
      "^1.0.0",
      "^1.1.0",
      summary(),
      { runGit: existingLocalRunGit, runGh: deps.runGh },
    );

    expect(result).toMatchObject({ code: "branch-already-exists-locally" });
    expect(calls.some((call) => call.args[0] === "checkout")).toBe(false);
  });

  it("returns branch-already-exists-remotely without creating or reusing it", async () => {
    const projectPath = await createFixtureProject("fixture-dep", "^1.0.0");
    const { deps, calls } = happyPathDoubles("unused");
    const existingRemoteRunGit: GitDeliveryDependencies["runGit"] = async (args, cwd) => {
      if (args[0] === "ls-remote") {
        calls.push({ tool: "git", args });
        return { stdout: "abc123\trefs/heads/guardian/bump-fixture-dep-1.1.0\n", stderr: "" };
      }
      return deps.runGit(args, cwd);
    };

    const result = await deliverVersionBumpAsPullRequest(
      projectPath,
      "fixture-dep",
      "dependency",
      "^1.0.0",
      "^1.1.0",
      summary(),
      { runGit: existingRemoteRunGit, runGh: deps.runGh },
    );

    expect(result).toMatchObject({ code: "branch-already-exists-remotely" });
    expect(calls.some((call) => call.args[0] === "checkout")).toBe(false);
  });

  it("returns gh-not-authenticated before touching the repository", async () => {
    const projectPath = await createFixtureProject("fixture-dep", "^1.0.0");
    const { deps, calls } = happyPathDoubles("unused");
    const unauthenticatedRunGh: GitDeliveryDependencies["runGh"] = async (args, cwd) => {
      if (args[0] === "auth") {
        throw commandError("gh: not logged in", "", "You are not logged into any GitHub hosts.");
      }
      return deps.runGh(args, cwd);
    };

    const result = await deliverVersionBumpAsPullRequest(
      projectPath,
      "fixture-dep",
      "dependency",
      "^1.0.0",
      "^1.1.0",
      summary(),
      { runGit: deps.runGit, runGh: unauthenticatedRunGh },
    );

    expect(result).toMatchObject({
      code: "gh-not-authenticated",
      step: "gh auth status",
    });
    expect(result).toMatchObject({ message: expect.stringContaining("not logged in") });
    // "nothing touched yet" means no *mutating* git command ran -- the two read-only
    // `--version` probes (step 1) legitimately happen before the `gh auth status` check (step 2)
    // that fails here.
    expect(calls).toEqual([
      { tool: "git", args: ["--version"] },
      { tool: "gh", args: ["--version"] },
    ]);
  });

  it("reports the manual cleanup command when push fails after the branch was already pushed-to-be", async () => {
    const projectPath = await createFixtureProject("fixture-dep", "^1.0.0");
    const { deps } = happyPathDoubles("unused");
    const pushFailsRunGit: GitDeliveryDependencies["runGit"] = async (args, cwd) => {
      if (args[0] === "push") {
        throw commandError("fatal: unable to access origin", "", "Could not resolve host: origin");
      }
      return deps.runGit(args, cwd);
    };

    const result = await deliverVersionBumpAsPullRequest(
      projectPath,
      "fixture-dep",
      "dependency",
      "^1.0.0",
      "^1.1.0",
      summary(),
      { runGit: pushFailsRunGit, runGh: deps.runGh },
    );

    expect(result).toMatchObject({ code: "git-command-failed", step: "git push" });
    if (!("code" in result)) {
      throw new Error("expected a GitDeliveryError");
    }
    expect(result.message).toContain("guardian/bump-fixture-dep-1.1.0");
    expect(result.message).toContain(
      "git checkout main && git branch -D guardian/bump-fixture-dep-1.1.0",
    );
  });

  it("reports the manual cleanup command when gh pr create fails after a real push", async () => {
    const projectPath = await createFixtureProject("fixture-dep", "^1.0.0");
    const { deps } = happyPathDoubles("unused");
    const prCreateFailsRunGh: GitDeliveryDependencies["runGh"] = async (args, cwd) => {
      if (args[0] === "pr" && args[1] === "create") {
        throw commandError("gh: pull request create failed", "", "HTTP 422: Validation Failed");
      }
      return deps.runGh(args, cwd);
    };

    const result = await deliverVersionBumpAsPullRequest(
      projectPath,
      "fixture-dep",
      "dependency",
      "^1.0.0",
      "^1.1.0",
      summary(),
      { runGit: deps.runGit, runGh: prCreateFailsRunGh },
    );

    expect(result).toMatchObject({ code: "gh-command-failed", step: "gh pr create" });
    if (!("code" in result)) {
      throw new Error("expected a GitDeliveryError");
    }
    expect(result.message).toContain(
      "git push origin --delete guardian/bump-fixture-dep-1.1.0",
    );
  });
});

// ---------------------------------------------------------------------------
// deliverVersionBumpAsPullRequest -- real git repo, faked runGh only (item 4)
// ---------------------------------------------------------------------------

async function realGit(args: readonly string[], cwd: string): Promise<CommandResult> {
  const { stdout, stderr } = await execFile("git", [...args], { cwd });
  return { stdout, stderr };
}

async function createRealGitRepo(): Promise<string> {
  const projectPath = await mkdtemp(path.join(tmpdir(), "guardian-git-delivery-real-"));
  temporaryPaths.push(projectPath);
  await execFile("git", ["init", "--initial-branch=main"], { cwd: projectPath });
  await execFile("git", ["config", "user.email", "guardian-test@example.com"], { cwd: projectPath });
  await execFile("git", ["config", "user.name", "Guardian Test"], { cwd: projectPath });
  await writeFile(
    path.join(projectPath, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { "fixture-dep": "^1.0.0" } }, null, 2) + "\n",
    "utf8",
  );
  await execFile("git", ["add", "package.json"], { cwd: projectPath });
  await execFile("git", ["commit", "-m", "initial commit"], { cwd: projectPath });
  return projectPath;
}

function fakeGhAlwaysSucceeds(prUrl = "https://github.com/example/example/pull/1"): GitDeliveryDependencies["runGh"] {
  return async (args) => {
    if (args[0] === "pr" && args[1] === "create") {
      return { stdout: `${prUrl}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

describe("deliverVersionBumpAsPullRequest (real git, faked gh)", () => {
  it("returns working-tree-not-clean against a real dirty working tree", async () => {
    const projectPath = await createRealGitRepo();
    await writeFile(path.join(projectPath, "untracked.txt"), "scratch", "utf8");

    const result = await deliverVersionBumpAsPullRequest(
      projectPath,
      "fixture-dep",
      "dependency",
      "^1.0.0",
      "^1.1.0",
      summary(),
      { runGit: realGit, runGh: fakeGhAlwaysSucceeds() },
    );

    expect(result).toMatchObject({ code: "working-tree-not-clean" });
  });

  it("returns detached-head against a real detached HEAD", async () => {
    const projectPath = await createRealGitRepo();
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: projectPath });
    await execFile("git", ["checkout", stdout.trim()], { cwd: projectPath });

    const result = await deliverVersionBumpAsPullRequest(
      projectPath,
      "fixture-dep",
      "dependency",
      "^1.0.0",
      "^1.1.0",
      summary(),
      { runGit: realGit, runGh: fakeGhAlwaysSucceeds() },
    );

    expect(result).toMatchObject({ code: "detached-head" });
  });

  it("returns branch-already-exists-locally against a real pre-existing local branch", async () => {
    const projectPath = await createRealGitRepo();
    const branchName = buildBranchName("fixture-dep", "^1.1.0");
    await execFile("git", ["branch", branchName], { cwd: projectPath });

    const result = await deliverVersionBumpAsPullRequest(
      projectPath,
      "fixture-dep",
      "dependency",
      "^1.0.0",
      "^1.1.0",
      summary(),
      { runGit: realGit, runGh: fakeGhAlwaysSucceeds() },
    );

    expect(result).toMatchObject({ code: "branch-already-exists-locally" });
    const { stdout: branchAfter } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectPath,
    });
    expect(branchAfter.trim()).toBe("main");
  });

  it(
    "runs the real checkout/add/commit/push sequence against a local bare origin and returns to the original branch",
    async () => {
      const bareOriginPath = await mkdtemp(path.join(tmpdir(), "guardian-git-delivery-origin-"));
      temporaryPaths.push(bareOriginPath);
      await execFile("git", ["init", "--bare", "--initial-branch=main"], { cwd: bareOriginPath });

      const projectPath = await createRealGitRepo();
      await execFile("git", ["remote", "add", "origin", bareOriginPath], { cwd: projectPath });

      const result = await deliverVersionBumpAsPullRequest(
        projectPath,
        "fixture-dep",
        "dependency",
        "^1.0.0",
        "^1.1.0",
        summary(),
        { runGit: realGit, runGh: fakeGhAlwaysSucceeds("https://github.com/example/example/pull/7") },
      );

      expect("code" in result).toBe(false);
      if ("code" in result) {
        throw new Error(`expected success, got ${JSON.stringify(result)}`);
      }
      expect(result.branch).toBe("guardian/bump-fixture-dep-1.1.0");
      expect(result.prUrl).toBe("https://github.com/example/example/pull/7");
      expect(result.warning).toBeUndefined();

      const { stdout: currentBranch } = await execFile(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: projectPath },
      );
      expect(currentBranch.trim()).toBe("main");

      const { stdout: remoteBranches } = await execFile(
        "git",
        ["ls-remote", "--heads", "origin"],
        { cwd: projectPath },
      );
      expect(remoteBranches).toContain(`refs/heads/${result.branch}`);

      // The working tree is back on "main" (checked above), where package.json was never
      // touched -- the bump lives on the pushed branch, so read it from there via `git show`.
      const { stdout: bumpedPackageJson } = await execFile(
        "git",
        ["show", `origin/${result.branch}:package.json`],
        { cwd: projectPath },
      );
      expect(JSON.parse(bumpedPackageJson)).toMatchObject({
        dependencies: { "fixture-dep": "^1.1.0" },
      });

      const originalPackageJsonStillOnMain = await readFile(
        path.join(projectPath, "package.json"),
        "utf8",
      );
      expect(JSON.parse(originalPackageJsonStillOnMain)).toMatchObject({
        dependencies: { "fixture-dep": "^1.0.0" },
      });
    },
  );
});

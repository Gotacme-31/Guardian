import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { DependencyType, MigrationProposalSummary } from "@guardian/project-scanner";
import { applyVersionBump } from "@guardian/project-scanner";

const execFile = promisify(execFileCallback);

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitDeliveryDependencies {
  readonly runGit: (args: readonly string[], cwd: string) => Promise<CommandResult>;
  readonly runGh: (args: readonly string[], cwd: string) => Promise<CommandResult>;
}

/**
 * Real `git`/`gh` invocations always go through `execFile` with the command's argv as an array —
 * never through a shell, and never through string interpolation. A dependency name, branch name,
 * or commit message is attacker-influenceable input (it comes from a package name or a composed
 * version string); passing it as one array element of `execFile`'s `args` means it is handed to
 * the OS as a single argv entry, never parsed by a shell, so there is no command-injection
 * surface here regardless of what characters it contains.
 */
async function runCommand(command: "git" | "gh", args: readonly string[], cwd: string): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFile(command, [...args], { cwd });
    return { stdout, stderr };
  } catch (error) {
    // execFile's rejection already carries the real stdout/stderr/exit code on the error object;
    // re-throwing it (rather than swallowing it behind a generic message) is what lets callers —
    // and ultimately the person running the CLI — see exactly what `git`/`gh` printed.
    throw error;
  }
}

export function runGit(args: readonly string[], cwd: string): Promise<CommandResult> {
  return runCommand("git", args, cwd);
}

export function runGh(args: readonly string[], cwd: string): Promise<CommandResult> {
  return runCommand("gh", args, cwd);
}

export const defaultGitDeliveryDependencies: GitDeliveryDependencies = { runGit, runGh };

const BRANCH_COMPONENT_PATTERN = /[^a-zA-Z0-9.-]+/g;
const REPEATED_DASHES_PATTERN = /-+/g;
const LEADING_TRAILING_DASHES_PATTERN = /^-+|-+$/g;

export function sanitizeBranchComponent(value: string): string {
  return value
    .replace(BRANCH_COMPONENT_PATTERN, "-")
    .replace(REPEATED_DASHES_PATTERN, "-")
    .replace(LEADING_TRAILING_DASHES_PATTERN, "");
}

export function buildBranchName(dependency: string, newDeclaredVersion: string): string {
  return `guardian/bump-${sanitizeBranchComponent(dependency)}-${sanitizeBranchComponent(newDeclaredVersion)}`;
}

export function buildPullRequestContent(
  dependency: string,
  previousDeclaredVersion: string,
  newDeclaredVersion: string,
  summary: MigrationProposalSummary,
): { readonly title: string; readonly body: string } {
  const title = `chore(deps): bump ${dependency} from ${previousDeclaredVersion} to ${newDeclaredVersion}`;
  const body = [
    `Guardian verified that bumping \`${dependency}\` from \`${previousDeclaredVersion}\` to `
    + `\`${newDeclaredVersion}\` affects no usage in this project that needs a human to look at it.`,
    "",
    "Usage impact summary:",
    `- breaking: ${summary.breaking}`,
    `- needs-review: ${summary.needsReview}`,
    `- safe: ${summary.safe}`,
    `- unaffected: ${summary.unaffected}`,
    `- unresolved: ${summary.unresolved}`,
    `- indeterminate: ${summary.indeterminate}`,
    "",
    "No source files were modified. Only the declared version in `package.json` was changed.",
    "",
    "This pull request was opened automatically by Guardian after explicit authorization (`--yes`).",
  ].join("\n");
  return { title, body };
}

export type GitDeliveryErrorCode =
  | "working-tree-not-clean"
  | "detached-head"
  | "branch-already-exists-locally"
  | "branch-already-exists-remotely"
  | "git-not-available"
  | "gh-not-available"
  | "gh-not-authenticated"
  | "git-command-failed"
  | "gh-command-failed";

export interface GitDeliveryError {
  readonly code: GitDeliveryErrorCode;
  readonly step: string;
  readonly message: string;
}

export interface GitDeliveryResult {
  readonly branch: string;
  readonly prUrl: string;
  /**
   * Set only when step 12 (best-effort `git checkout <originalBranch>` after opening the PR)
   * fails. The PR was already opened successfully by that point, so this is deliberately not a
   * `GitDeliveryError` -- it is additive context on an otherwise-successful result, carrying the
   * one piece of information the spec's literal `{ branch, prUrl }` shape has no field for.
   * Flagged here explicitly as an intentional, documented extension of the given type, not a
   * silent change to it.
   */
  readonly warning?: string;
}

function commandErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const withStreams = error as Error & { stdout?: unknown; stderr?: unknown };
    const stderr = typeof withStreams.stderr === "string" ? withStreams.stderr.trim() : "";
    const stdout = typeof withStreams.stdout === "string" ? withStreams.stdout.trim() : "";
    const detail = stderr.length > 0 ? stderr : stdout;
    return detail.length > 0 ? `${error.message}\n${detail}` : error.message;
  }
  return String(error);
}

async function tryRunGit(
  deps: GitDeliveryDependencies,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult | { readonly error: string }> {
  try {
    return await deps.runGit(args, cwd);
  } catch (error) {
    return { error: commandErrorMessage(error) };
  }
}

async function tryRunGh(
  deps: GitDeliveryDependencies,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult | { readonly error: string }> {
  try {
    return await deps.runGh(args, cwd);
  } catch (error) {
    return { error: commandErrorMessage(error) };
  }
}

function failure(code: GitDeliveryErrorCode, step: string, message: string): GitDeliveryError {
  return { code, step, message };
}

/**
 * Orchestrates the full "write the version bump, then deliver it as a reviewable pull request"
 * flow. Every step before step 6 (the first mutation, `git checkout -b`) only reads state; if any
 * of them fails, nothing about the repository has changed yet, so the error can simply be
 * returned. From step 6 onward, each failure path documents exactly what already happened and
 * the exact manual command to undo it — Guardian itself never force-reverses a commit or a push,
 * since that is a destructive decision that belongs to the human running it, not to this tool.
 */
export async function deliverVersionBumpAsPullRequest(
  projectPath: string,
  dependency: string,
  dependencyType: DependencyType,
  previousDeclaredVersion: string,
  newDeclaredVersion: string,
  summary: MigrationProposalSummary,
  deps: GitDeliveryDependencies,
): Promise<GitDeliveryResult | GitDeliveryError> {
  // Step 1: git/gh must exist.
  const gitVersion = await tryRunGit(deps, ["--version"], projectPath);
  if ("error" in gitVersion) {
    return failure("git-not-available", "git --version", gitVersion.error);
  }
  const ghVersion = await tryRunGh(deps, ["--version"], projectPath);
  if ("error" in ghVersion) {
    return failure("gh-not-available", "gh --version", ghVersion.error);
  }

  // Step 2: gh must be authenticated.
  const authStatus = await tryRunGh(deps, ["auth", "status"], projectPath);
  if ("error" in authStatus) {
    return failure("gh-not-authenticated", "gh auth status", authStatus.error);
  }

  // Step 3: the working tree must be clean -- Guardian never commits someone else's in-progress
  // changes.
  const statusResult = await tryRunGit(deps, ["status", "--porcelain"], projectPath);
  if ("error" in statusResult) {
    return failure("git-command-failed", "git status --porcelain", statusResult.error);
  }
  if (statusResult.stdout.trim().length > 0) {
    return failure(
      "working-tree-not-clean",
      "git status --porcelain",
      "The working tree has uncommitted changes. Commit, stash, or discard them before asking "
      + "Guardian to open a pull request.",
    );
  }

  // Step 4: must be on a real branch, not detached HEAD.
  const headResult = await tryRunGit(deps, ["rev-parse", "--abbrev-ref", "HEAD"], projectPath);
  if ("error" in headResult) {
    return failure("git-command-failed", "git rev-parse --abbrev-ref HEAD", headResult.error);
  }
  const originalBranch = headResult.stdout.trim();
  if (originalBranch === "HEAD") {
    return failure(
      "detached-head",
      "git rev-parse --abbrev-ref HEAD",
      "HEAD is detached. Check out a real branch before asking Guardian to open a pull request.",
    );
  }

  // Step 5: the target branch name must not already exist, locally or on origin.
  const branchName = buildBranchName(dependency, newDeclaredVersion);
  const localRefResult = await tryRunGit(
    deps,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    projectPath,
  );
  if (!("error" in localRefResult)) {
    return failure(
      "branch-already-exists-locally",
      "git show-ref --verify --quiet",
      `Branch "${branchName}" already exists locally. Delete it (if you no longer need it: `
      + `"git branch -D ${branchName}") or let Guardian pick a different target version.`,
    );
  }
  const remoteRefResult = await tryRunGit(
    deps,
    ["ls-remote", "--exit-code", "--heads", "origin", branchName],
    projectPath,
  );
  if (!("error" in remoteRefResult) && remoteRefResult.stdout.trim().length > 0) {
    return failure(
      "branch-already-exists-remotely",
      "git ls-remote --exit-code --heads origin",
      `Branch "${branchName}" already exists on origin. Delete it (if you no longer need it: `
      + `"git push origin --delete ${branchName}") or let Guardian pick a different target `
      + "version.",
    );
  }

  // Step 6: create and check out the branch. This is the first mutation.
  const checkoutNewResult = await tryRunGit(deps, ["checkout", "-b", branchName], projectPath);
  if ("error" in checkoutNewResult) {
    return failure("git-command-failed", "git checkout -b", checkoutNewResult.error);
  }

  // Step 7: write the version bump. If this fails, the branch exists but carries no changes --
  // best-effort return to the original branch before reporting the error.
  const writeResult = await applyVersionBump(
    projectPath,
    dependency,
    dependencyType,
    previousDeclaredVersion,
    newDeclaredVersion,
  );
  if ("error" in writeResult) {
    const revertResult = await tryRunGit(deps, ["checkout", originalBranch], projectPath);
    const revertNote = "error" in revertResult
      ? ` Additionally, Guardian could not check "${originalBranch}" back out: ${revertResult.error}`
      + ` -- run "git checkout ${originalBranch}" manually.`
      : ` Guardian checked "${originalBranch}" back out; branch "${branchName}" exists locally `
      + `with no changes and can be deleted with "git branch -D ${branchName}" if you do not `
      + "need it.";
    return failure(
      "git-command-failed",
      "applyVersionBump",
      `Could not write the version bump: ${writeResult.error}.${revertNote}`,
    );
  }

  const { title, body } = buildPullRequestContent(
    dependency,
    previousDeclaredVersion,
    newDeclaredVersion,
    summary,
  );

  // Step 8: stage only the file Guardian itself changed -- never "." or "-A".
  const addResult = await tryRunGit(deps, ["add", writeResult.packageJsonPath], projectPath);
  if ("error" in addResult) {
    return failure(
      "git-command-failed",
      "git add",
      `Could not stage "${writeResult.packageJsonPath}": ${addResult.error}. Branch `
      + `"${branchName}" exists locally with the file already modified on disk; review it, then `
      + `either commit it yourself or discard the branch with "git checkout ${originalBranch} `
      + `&& git branch -D ${branchName}" (this also discards the uncommitted file change).`,
    );
  }

  // Step 9: commit.
  const commitResult = await tryRunGit(deps, ["commit", "-m", title], projectPath);
  if ("error" in commitResult) {
    return failure(
      "git-command-failed",
      "git commit",
      `Could not commit the version bump: ${commitResult.error}. Branch "${branchName}" exists `
      + "locally with the change staged but not committed; review it, then either commit it "
      + `yourself or discard the branch with "git checkout ${originalBranch} && git branch -D `
      + `${branchName}" (this also discards the uncommitted file change).`,
    );
  }

  // Step 10: push.
  const pushResult = await tryRunGit(deps, ["push", "-u", "origin", branchName], projectPath);
  if ("error" in pushResult) {
    return failure(
      "git-command-failed",
      "git push",
      `Could not push branch "${branchName}": ${pushResult.error}. The branch and its commit `
      + `exist locally; if you do not want to continue, delete them with "git checkout `
      + `${originalBranch} && git branch -D ${branchName}".`,
    );
  }

  // Step 11: open the pull request. Deliberately no --base: gh resolves the repository's default
  // branch on its own, Guardian never guesses it.
  const prCreateResult = await tryRunGh(
    deps,
    ["pr", "create", "--title", title, "--body", body, "--head", branchName],
    projectPath,
  );
  if ("error" in prCreateResult) {
    return failure(
      "gh-command-failed",
      "gh pr create",
      `Could not open a pull request: ${prCreateResult.error}. Branch "${branchName}" was `
      + `already pushed to origin; if you do not want to continue, delete it with "git push `
      + `origin --delete ${branchName}" (and locally with "git checkout ${originalBranch} && git `
      + `branch -D ${branchName}").`,
    );
  }
  const prUrl = prCreateResult.stdout.trim().split("\n").pop() ?? "";

  // Step 12: best-effort return to the original branch. A failure here is not a GitDeliveryError
  // -- the PR already exists and is the operation's real outcome -- so the caller surfaces it as
  // a warning alongside the success result instead.
  const checkoutBackResult = await tryRunGit(deps, ["checkout", originalBranch], projectPath);
  const warning = "error" in checkoutBackResult
    ? `Could not check "${originalBranch}" back out after opening the pull request: `
    + `${checkoutBackResult.error}. You are still on branch "${branchName}"; run "git checkout `
    + `${originalBranch}" to return.`
    : undefined;

  return {
    branch: branchName,
    prUrl,
    ...(warning === undefined ? {} : { warning }),
  };
}

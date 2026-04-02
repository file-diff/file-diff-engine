#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { Command } from "commander";
import { createPullRequest } from "../../services/githubApi";
import { OperationLogEntry } from "../../types";
import { getCommitShort } from "../../utils/commit";
import { createLogger } from "../../utils/logger";

const execFileAsync = promisify(execFile);
const logger = createLogger("github-revert");
const GITHUB_HOSTNAME = "github.com";
const CACHE_COLLISION_MAX_ATTEMPTS = 3;
const CACHE_COLLISION_RETRY_DELAY_MS = 100;

export interface RevertToCommitOptions {
  repo: string;
  commit: string;
  branch?: string;
  githubKey?: string;
  workDir?: string;
}

export interface RevertToCommitResult {
  repo: string;
  branch: string;
  commit: string;
  commitShort: string;
  revertBranch: string;
  revertCommit: string;
  revertCommitShort: string;
  pullRequest: {
    number: number;
    title: string;
    url: string;
  } | null;
  log: OperationLogEntry[];
}

export async function revertToCommit(
  options: RevertToCommitOptions
): Promise<RevertToCommitResult> {
  const repo = options.repo.trim();
  const commit = normalizeCommit(options.commit);
  const branch = normalizeRef(options.branch?.trim() || "main", "Branch");
  const githubKey =
    options.githubKey?.trim() ||
    process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
    process.env.PUBLIC_GITHUB_TOKEN?.trim() ||
    undefined;
  const repoUrl = getRepositoryUrl(repo);
  assertSafeGitRepositoryUrl(repoUrl);
  const githubRepo = getGitHubRepoName(repo) ?? getGitHubRepoName(repoUrl);
  const workDir =
    options.workDir && options.workDir.trim()
      ? path.resolve(options.workDir)
      : fs.mkdtempSync(
          path.join(path.resolve(process.env.TMP_DIR || "tmp"), "fde-github-revert-")
        );
  const cloneDir = path.join(workDir, "repo");
  const cacheDir = getRepositoryCacheDir(repoUrl, workDir);
  const gitEnv = getGitCommandEnv(githubKey);
  const log: OperationLogEntry[] = [];

  logger.debug("Starting revert-to-commit operation", {
    repo,
    branch,
    commit,
    workDir,
    cacheDir,
  });

  try {
    fs.rmSync(cloneDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });

    if (!fs.existsSync(path.join(cacheDir, ".git"))) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      await runGitCommandWithRetry(
        path.dirname(cacheDir),
        ["clone", "--no-checkout", "--", repoUrl, cacheDir],
        gitEnv
      );
      appendOperationLog(log, `Created repository cache for '${repoUrl}'.`);
    }

    await runGitCommandWithRetry(
      cacheDir,
      ["fetch", "--depth=1", "origin", commit],
      gitEnv
    );
    appendOperationLog(log, `Fetched commit '${commit}' into repository cache.`);

    fs.cpSync(cacheDir, cloneDir, { recursive: true });
    await runGitCommand(cloneDir, ["fetch", "origin", branch], gitEnv);
    await runGitCommand(cloneDir, ["checkout", "-B", branch, `origin/${branch}`], gitEnv);
    appendOperationLog(log, `Checked out branch '${branch}' from '${repoUrl}' into the temporary workspace.`);

    const resolvedCommit = await runGitCommand(cloneDir, ["rev-parse", commit], gitEnv);
    appendOperationLog(log, `Resolved requested commit to '${resolvedCommit}'.`);
    const revertBranch = buildRevertBranchName(resolvedCommit);

    await configureCommitAuthor(cloneDir, gitEnv);
    appendOperationLog(log, "Configured git author for the generated restore commit.");
    await runGitCommand(cloneDir, ["switch", "-c", revertBranch], gitEnv);
    appendOperationLog(log, `Created branch '${revertBranch}' from '${branch}'.`);
    await runGitCommand(cloneDir, ["read-tree", "--reset", "-u", resolvedCommit], gitEnv);
    appendOperationLog(log, `Reset branch contents to match commit '${resolvedCommit}'.`);

    const commitMessage = `Restore repository to commit ${getCommitShort(resolvedCommit)}`;
    await runGitCommand(
      cloneDir,
      ["commit", "--allow-empty", "-m", commitMessage],
      gitEnv
    );
    appendOperationLog(log, `Created restore commit '${commitMessage}'.`);
    const revertCommit = await runGitCommand(cloneDir, ["rev-parse", "HEAD"], gitEnv);
    appendOperationLog(log, `Resolved generated restore commit to '${revertCommit}'.`);
    await runGitCommand(
      cloneDir,
      ["push", "--set-upstream", "origin", revertBranch],
      gitEnv
    );
    appendOperationLog(log, `Pushed branch '${revertBranch}' to 'origin'.`);

    const pullRequest =
      githubKey && githubRepo
        ? await createPullRequest(githubRepo, revertBranch, branch, {
            token: githubKey,
            title: `Restore ${branch} to ${getCommitShort(resolvedCommit)}`,
            body: [
              `Restore \`${branch}\` to the repository state from commit \`${resolvedCommit}\`.`,
              "",
              `- Source commit: \`${resolvedCommit}\``,
              `- Generated branch: \`${revertBranch}\``,
            ].join("\n"),
          })
        : null;
    if (pullRequest) {
      appendOperationLog(
        log,
        `Created pull request #${pullRequest.number} (${pullRequest.url}) targeting '${branch}'.`
      );
    }

    return {
      repo,
      branch,
      commit: resolvedCommit,
      commitShort: getCommitShort(resolvedCommit),
      revertBranch,
      revertCommit,
      revertCommitShort: getCommitShort(revertCommit),
      pullRequest,
      log,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export async function runRevertToCommitCli(argv: string[] = process.argv): Promise<void> {
  const options = parseCliArgs(argv);
  const result = await revertToCommit(options);
  process.stdout.write(formatRevertToCommitCliOutput(result));
}

if (require.main === module) {
  runRevertToCommitCli().catch((error) => {
    const message = error instanceof Error ? error.message : "Revert to commit failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

function parseCliArgs(argv: string[]): RevertToCommitOptions {
  const program = new Command();

  program
    .name("revertToCommit")
    .description("Revert a repository to a specific commit and create a pull request")
    .requiredOption("--repo <repository>", "Repository URL or owner/repo format")
    .requiredOption("--commit <sha>", "Full 40-character commit SHA to revert to")
    .option("--branch <branch>", "Target branch to revert", "main")
    .option("--github-key <token>", "GitHub personal access token")
    .option("--work-dir <directory>", "Working directory for clone operations")
    .parse(argv);

  const opts = program.opts();

  return {
    repo: opts.repo,
    commit: opts.commit,
    branch: opts.branch,
    githubKey: opts.githubKey,
    workDir: opts.workDir,
  };
}

async function runGitCommandWithRetry(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= CACHE_COLLISION_MAX_ATTEMPTS; attempt++) {
    try {
      return await runGitCommand(cwd, args, env);
    } catch (error) {
      lastError = error;
      if (attempt >= CACHE_COLLISION_MAX_ATTEMPTS || !isRetryableGitLockError(error)) {
        throw error;
      }

      logger.warn("Git cache operation collided with another process, retrying", {
        cwd,
        command: `git ${args.join(" ")}`,
        attempt,
        maxAttempts: CACHE_COLLISION_MAX_ATTEMPTS,
      });
      await wait(CACHE_COLLISION_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Git command failed after retries: git ${args.join(" ")}`);
}

function isRetryableGitLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return (
    message.includes(".lock") ||
    message.includes("another git process seems to be running") ||
    message.includes("cannot lock ref")
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function configureCommitAuthor(
  cloneDir: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  await runGitCommand(cloneDir, ["config", "user.name", "file-diff-engine"], env);
  await runGitCommand(
    cloneDir,
    ["config", "user.email", "file-diff-engine@users.noreply.github.com"],
    env
  );
}

async function runGitCommand(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<string> {
  const command = `git ${args.join(" ")}`;
  logger.debug("Running git command", { cwd, command });

  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, env });
    const stdoutText = (stdout ?? "").toString().trim();
    const stderrText = (stderr ?? "").toString().trim();
    if (stderrText) {
      logger.debug("Git command emitted stderr", { cwd, command, stderr: stderrText });
    }
    return stdoutText;
  } catch (error) {
    const gitError = error as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stdoutText = (gitError.stdout ?? "").toString().trim();
    const stderrText = (gitError.stderr ?? "").toString().trim();
    throw new Error(
      [
        `Git command failed: ${command}`,
        `cwd: ${cwd}`,
        gitError.message ? `error: ${gitError.message}` : undefined,
        stderrText ? `stderr: ${stderrText}` : undefined,
        stdoutText ? `stdout: ${stdoutText}` : undefined,
      ]
        .filter(Boolean)
        .join(" | ")
    );
  }
}

function getRepositoryUrl(repo: string): string {
  if (repo.includes("://") || path.isAbsolute(repo)) {
    return repo;
  }

  return `https://github.com/${repo}.git`;
}

function getGitCommandEnv(tokenOverride?: string): NodeJS.ProcessEnv {
  const token =
    tokenOverride?.trim() ||
    process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
    process.env.PUBLIC_GITHUB_TOKEN?.trim();
  if (!token) {
    return process.env;
  }

  const env = { ...process.env };
  const existingCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const configCount = Number.isNaN(existingCount) || existingCount < 0 ? 0 : existingCount;
  const authHeader = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");

  env.GIT_CONFIG_COUNT = String(configCount + 1);
  env[`GIT_CONFIG_KEY_${configCount}`] = `http.https://${GITHUB_HOSTNAME}/.extraHeader`;
  env[`GIT_CONFIG_VALUE_${configCount}`] = `Authorization: Basic ${authHeader}`;

  return env;
}

function assertSafeGitRepositoryUrl(repoUrl: string): void {
  const trimmedRepoUrl = repoUrl.trim();
  if (!trimmedRepoUrl) {
    throw new Error("Repository URL is required.");
  }

  if (trimmedRepoUrl.startsWith("-")) {
    throw new Error("Repository URL cannot start with '-'.");
  }

  if (/[\0\r\n]/.test(trimmedRepoUrl)) {
    throw new Error("Repository URL contains unsupported control characters.");
  }
}

function normalizeCommit(commit: string): string {
  const trimmedCommit = commit.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(trimmedCommit)) {
    throw new Error("Field 'commit' must be a full 40-character commit SHA.");
  }

  return trimmedCommit;
}

function normalizeRef(ref: string, label: string): string {
  const trimmedRef = ref.trim();
  if (!trimmedRef) {
    throw new Error(`${label} is required.`);
  }

  if (trimmedRef.startsWith("-")) {
    throw new Error(`${label} cannot start with '-'.`);
  }

  if (/[\0\r\n]/.test(trimmedRef)) {
    throw new Error(`${label} contains unsupported control characters.`);
  }

  return trimmedRef;
}

function buildRevertBranchName(commit: string): string {
  return `revert-to-${getCommitShort(commit)}-${Date.now()}`;
}

function getRepositoryCacheDir(repoUrl: string, workDir: string): string {
  const cacheKey = createHash("sha256").update(repoUrl).digest("hex");
  return path.join(path.dirname(path.resolve(workDir)), "repo-cache", cacheKey);
}

function getGitHubRepoName(repoValue: string): string | null {
  const match = repoValue.match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

function appendOperationLog(log: OperationLogEntry[], message: string): void {
  log.push({ message });
}

export function formatRevertToCommitCliOutput(result: RevertToCommitResult): string {
  const lines = [
    "Revert completed successfully.",
    `Repository: ${result.repo}`,
    `Base branch: ${result.branch}`,
    `Source commit: ${result.commit}`,
    `Generated branch: ${result.revertBranch}`,
    `Generated commit: ${result.revertCommit}`,
    result.pullRequest
      ? `Pull request: #${result.pullRequest.number} ${result.pullRequest.url}`
      : "Pull request: not created",
  ];

  if (result.log.length > 0) {
    lines.push("", "Operation log:");
    result.log.forEach((entry, index) => {
      lines.push(`  ${index + 1}. ${entry.message}`);
    });
  }

  return `${lines.join("\n")}\n`;
}

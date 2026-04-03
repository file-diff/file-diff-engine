import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { createPullRequest } from "../../services/githubApi";
import { OperationLogEntry } from "../../types";
import { getCommitShort } from "../../utils/commit";
import { createLogger } from "../../utils/logger";

const execFileAsync = promisify(execFile);
const logger = createLogger("github-merge-branch");
const GITHUB_HOSTNAME = "github.com";
const CACHE_COLLISION_MAX_ATTEMPTS = 3;
const CACHE_COLLISION_RETRY_DELAY_MS = 100;

export interface MergeBranchOptions {
  repo: string;
  baseBranch?: string;
  otherBranch: string;
  githubKey?: string;
  workDir?: string;
}

export interface MergeBranchResult {
  repo: string;
  baseBranch: string;
  otherBranch: string;
  mergeBranch: string;
  mergeCommit: string;
  mergeCommitShort: string;
  created: boolean;
  pullRequest: {
    number: number;
    title: string;
    url: string;
  } | null;
  log: OperationLogEntry[];
}

export async function mergeBranch(
  options: MergeBranchOptions
): Promise<MergeBranchResult> {
  const repo = options.repo.trim();
  const baseBranch = normalizeRef(options.baseBranch?.trim() || "main", "Base branch");
  const otherBranch = normalizeRef(options.otherBranch.trim(), "Other branch");
  const githubKey =
    options.githubKey?.trim() ||
    process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
    process.env.PUBLIC_GITHUB_TOKEN?.trim() ||
    undefined;
  if (!githubKey) {
    logger.warn(
      "No GitHub token provided; pull request creation will be skipped. Set the --github-key option or provide a token via environment variables."
    );
  }
  const repoUrl = getRepositoryUrl(repo);
  assertSafeGitRepositoryUrl(repoUrl);
  const githubRepo = getGitHubRepoName(repo) ?? getGitHubRepoName(repoUrl);
  const workDir =
    options.workDir && options.workDir.trim()
      ? path.resolve(options.workDir)
      : fs.mkdtempSync(
          path.join(path.resolve(process.env.TMP_DIR || "tmp"), "fde-github-merge-")
        );
  const cloneDir = path.join(workDir, "repo");
  const cacheDir = getRepositoryCacheDir(repoUrl, workDir);
  const gitEnv = getGitCommandEnv(githubKey);
  const log: OperationLogEntry[] = [];
  const mergeBranchName = buildMergeBranchName(baseBranch, otherBranch);

  logger.debug("Starting merge-branch operation", {
    repo,
    baseBranch,
    otherBranch,
    mergeBranch: mergeBranchName,
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

    // Fetch both branches into the cache
    await runGitCommandWithRetry(
      cacheDir,
      ["fetch", "origin", baseBranch, otherBranch],
      gitEnv
    );
    appendOperationLog(log, `Fetched branches '${baseBranch}' and '${otherBranch}' into repository cache.`);

    fs.cpSync(cacheDir, cloneDir, { recursive: true });

    // Check if the merge branch already exists on origin
    let branchCreated: boolean;
    const remoteBranchExists = await remoteBranchExistsCheck(cloneDir, mergeBranchName, gitEnv);

    if (remoteBranchExists) {
      // Merge branch already exists – check it out and merge otherBranch into it
      await runGitCommand(cloneDir, ["fetch", "origin", mergeBranchName], gitEnv);
      await runGitCommand(cloneDir, ["checkout", "-B", mergeBranchName, `origin/${mergeBranchName}`], gitEnv);
      appendOperationLog(log, `Checked out existing branch '${mergeBranchName}'.`);
      branchCreated = false;
    } else {
      // Create a new branch from baseBranch
      await runGitCommand(cloneDir, ["checkout", "-b", mergeBranchName, `origin/${baseBranch}`], gitEnv);
      appendOperationLog(log, `Created branch '${mergeBranchName}' from '${baseBranch}'.`);
      branchCreated = true;
    }

    await configureCommitAuthor(cloneDir, gitEnv);
    appendOperationLog(log, "Configured git author for the merge commit.");

    // Merge otherBranch into the merge branch
    await runGitCommand(
      cloneDir,
      ["merge", "--no-edit", `origin/${otherBranch}`],
      gitEnv
    );
    appendOperationLog(log, `Merged '${otherBranch}' into '${mergeBranchName}'.`);

    const mergeCommit = await runGitCommand(cloneDir, ["rev-parse", "HEAD"], gitEnv);
    appendOperationLog(log, `Resolved merge commit to '${mergeCommit}'.`);

    await runGitCommand(
      cloneDir,
      ["push", "--set-upstream", "origin", mergeBranchName],
      gitEnv
    );
    appendOperationLog(log, `Pushed branch '${mergeBranchName}' to 'origin'.`);

    const pullRequest =
      githubKey && githubRepo
        ? await createOrFindPullRequest(githubRepo, mergeBranchName, baseBranch, otherBranch, repoUrl, githubKey)
        : null;
    if (pullRequest) {
      appendOperationLog(
        log,
        `Pull request #${pullRequest.number} (${pullRequest.url}) targeting '${baseBranch}'.`
      );
    }

    return {
      repo,
      baseBranch,
      otherBranch,
      mergeBranch: mergeBranchName,
      mergeCommit,
      mergeCommitShort: getCommitShort(mergeCommit),
      created: branchCreated,
      pullRequest,
      log,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function createOrFindPullRequest(
  githubRepo: string,
  mergeBranch: string,
  baseBranch: string,
  otherBranch: string,
  repoUrl: string,
  token: string,
): Promise<{ number: number; title: string; url: string } | null> {
  const title = `Merge ${otherBranch} into ${baseBranch}`;
  const body = buildMergePullRequestBody(repoUrl, baseBranch, otherBranch, mergeBranch);

  try {
    return await createPullRequest(githubRepo, mergeBranch, baseBranch, {
      title,
      body,
      token,
    });
  } catch (error) {
    // GitHub returns 422 when a pull request already exists for the head/base pair
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("A pull request already exists")) {
      logger.debug("Pull request already exists, skipping creation.", {
        mergeBranch,
        baseBranch,
      });
      return null;
    }
    throw error;
  }
}

async function remoteBranchExistsCheck(
  cwd: string,
  branchName: string,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  try {
    const result = await runGitCommand(
      cwd,
      ["ls-remote", "--heads", "origin", branchName],
      env
    );
    return result.length > 0;
  } catch {
    return false;
  }
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

/**
 * Build a deterministic branch name from the two input branches.
 * Given the same two branch names, the output is always the same.
 */
export function buildMergeBranchName(baseBranch: string, otherBranch: string): string {
  const sanitize = (name: string): string =>
    name.replace(/[^A-Za-z0-9._-]/g, "-");

  return `merge/${sanitize(otherBranch)}-into-${sanitize(baseBranch)}`;
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

export function buildMergePullRequestBody(
  repoUrl: string,
  baseBranch: string,
  otherBranch: string,
  mergeBranch: string,
): string {
  const normalizedRepoUrl = normalizeGitHubHttpsUrl(repoUrl);
  const compareUrl = `${normalizedRepoUrl}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(mergeBranch)}`;

  return [
    `Merge changes from \`${otherBranch}\` into \`${baseBranch}\`.`,
    "",
    `[View diff](${compareUrl})`,
  ].join("\n");
}

function normalizeGitHubHttpsUrl(repoUrl: string): string {
  const httpsUrl = repoUrl
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/")
    .replace(/\.git$/i, "");

  return httpsUrl.endsWith("/") ? httpsUrl.slice(0, -1) : httpsUrl;
}

import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { createPullRequest } from "../../services/githubApi";
import { OperationLogEntry } from "../../types";
import { getCommitShort } from "../../utils/commit";
import { createLogger } from "../../utils/logger";

const execFileAsync = promisify(execFile);
const logger = createLogger("github-revert");
const GITHUB_HOSTNAME = "github.com";

export interface RevertToCommitOptions {
  repo: string;
  commit: string;
  branch?: string;
  githubKey?: string;
  cacheRootDir?: string;
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
  const githubKey = options.githubKey?.trim() || undefined;
  const repoUrl = getRepositoryUrl(repo);
  assertSafeGitRepositoryUrl(repoUrl);
  const githubRepo = getGitHubRepoName(repo) ?? getGitHubRepoName(repoUrl);
  const workDir =
    options.workDir && options.workDir.trim()
      ? path.resolve(options.workDir)
      : fs.mkdtempSync(path.join(os.tmpdir(), "fde-github-revert-"));
  const cloneDir = path.join(workDir, "repo");
  const cacheDir = getCacheDir(repoUrl, options.cacheRootDir);
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

    if (cacheDir) {
      await ensureMirrorCache(repoUrl, cacheDir, gitEnv, log);
    }

    await runGitCommand(
      process.cwd(),
      [
        "clone",
        "--branch",
        branch,
        "--single-branch",
        ...(cacheDir ? ["--reference-if-able", cacheDir] : []),
        "--",
        repoUrl,
        cloneDir,
      ],
      gitEnv
    );
    appendOperationLog(log, `Cloned branch '${branch}' from '${repoUrl}' into the temporary workspace.`);
    await runGitCommand(cloneDir, ["fetch", "--depth=1", "origin", commit], gitEnv);
    appendOperationLog(log, `Fetched commit '${commit}' from 'origin'.`);
    const resolvedCommit = await runGitCommand(cloneDir, ["rev-parse", "FETCH_HEAD"], gitEnv);
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

export async function runRevertToCommitCli(argv: string[] = process.argv.slice(2)): Promise<void> {
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
  const options: RevertToCommitOptions = {
    repo: "",
    commit: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--repo" && value) {
      options.repo = value;
      index += 1;
      continue;
    }

    if (arg === "--commit" && value) {
      options.commit = value;
      index += 1;
      continue;
    }

    if (arg === "--branch" && value) {
      options.branch = value;
      index += 1;
      continue;
    }

    if (arg === "--github-key" && value) {
      options.githubKey = value;
      index += 1;
      continue;
    }

    if (arg === "--cache-root" && value) {
      options.cacheRootDir = value;
      index += 1;
      continue;
    }

    if (arg === "--work-dir" && value) {
      options.workDir = value;
      index += 1;
      continue;
    }

    throw new Error(`Unsupported argument '${arg}'.`);
  }

  if (!options.repo || !options.commit) {
    throw new Error("Both '--repo' and '--commit' are required.");
  }

  return options;
}

async function ensureMirrorCache(
  repoUrl: string,
  cacheDir: string,
  env: NodeJS.ProcessEnv,
  log: OperationLogEntry[]
): Promise<void> {
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true });

  if (!fs.existsSync(path.join(cacheDir, "HEAD"))) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    await runGitCommand(
      process.cwd(),
      ["clone", "--mirror", "--", repoUrl, cacheDir],
      env
    );
    appendOperationLog(log, `Created mirror cache for '${repoUrl}'.`);
    return;
  }

  await runGitCommand(cacheDir, ["remote", "update", "--prune"], env);
  appendOperationLog(log, `Updated mirror cache for '${repoUrl}'.`);
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
  const token = tokenOverride ?? process.env.PUBLIC_GITHUB_TOKEN?.trim();
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

function getCacheDir(repoUrl: string, cacheRootDir?: string): string | null {
  if (!cacheRootDir?.trim()) {
    return null;
  }

  const cacheKey = createHash("sha256").update(repoUrl).digest("hex");
  return path.join(path.resolve(cacheRootDir), cacheKey);
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

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { createPullRequest } from "./githubApi";
import type { AgentTaskModel } from "../types";
import { createLogger } from "../utils/logger";

const execFileAsync = promisify(execFile);
const logger = createLogger("opencode-task");
const TWO_HOURS_IN_SECONDS = 2 * 60 * 60;
const DEFAULT_OPENCODE_TIMEOUT_MS = TWO_HOURS_IN_SECONDS * 1_000;
const DEFAULT_OUTPUT_LIMIT = 1_000_000;
const DEFAULT_GIT_AUTHOR_NAME = "file-diff-agent";
const DEFAULT_GIT_AUTHOR_EMAIL = "file-diff-agent@users.noreply.github.com";

export interface OpencodeTaskOptions {
  jobId: string;
  repo: string;
  baseRef: string;
  problemStatement: string;
  model: AgentTaskModel;
  githubKey?: string;
  deepseekApiKey?: string;
  workDir?: string;
}

export interface OpencodePreparedTask {
  branch: string;
  pullRequest: {
    number: number;
    url: string;
    title: string;
  };
}

export interface OpencodeTaskResult extends OpencodePreparedTask {
  output: string;
}

export async function runOpencodeTask(
  options: OpencodeTaskOptions
): Promise<OpencodeTaskResult> {
  const prepared = await prepareOpencodeTaskBranch(options);
  const output = await executeOpencodeOnPreparedBranch(options, prepared.branch);
  return { ...prepared, output };
}

export async function executeOpencodeOnPreparedBranch(
  options: OpencodeTaskOptions,
  branch: string
): Promise<string> {
  const cloneDir = getCloneDir(options);
  const output = await runOpencode(options, branch, cloneDir);
  await commitAndPushFinalChanges(cloneDir, options, branch);
  return output;
}

export async function prepareOpencodeTaskBranch(
  options: OpencodeTaskOptions
): Promise<OpencodePreparedTask> {
  const repo = options.repo.trim();
  const baseRef = normalizeGitRef(options.baseRef, "base_ref");
  const githubKey = resolveGitHubToken(options.githubKey);
  if (!githubKey) {
    throw new Error(
      "GitHub token is required. Set PRIVATE_GITHUB_TOKEN/PUBLIC_GITHUB_TOKEN or pass githubKey."
    );
  }

  const workDir = getWorkDir(options);
  const cloneDir = getCloneDir(options);
  const repoUrl = getRepositoryUrl(repo);
  const branch = buildTaskBranchName(options.jobId);
  const gitEnv = getGitCommandEnv(githubKey);

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  await runGit(
    workDir,
    [
      "clone",
      "--no-checkout",
      "--depth=1",
      "--single-branch",
      "--branch",
      baseRef,
      "--",
      repoUrl,
      cloneDir,
    ],
    gitEnv
  );
  await runGit(cloneDir, ["checkout", "-B", branch, `origin/${baseRef}`], gitEnv);
  await configureCommitAuthor(cloneDir, gitEnv);
  await runGit(
    cloneDir,
    [
      "commit",
      "--allow-empty",
      "-m",
      buildInitCommitSubject(options.problemStatement),
      "-m",
      options.problemStatement,
    ],
    gitEnv
  );
  await runGit(cloneDir, ["push", "--set-upstream", "origin", branch], gitEnv);

  const pullRequest = await createPullRequest(repo, branch, baseRef, {
    token: githubKey,
    title: buildPullRequestTitle(options.problemStatement),
    body: buildPullRequestBody(options.problemStatement, branch, options.model),
    draft: true,
  });

  return {
    branch,
    pullRequest: {
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
    },
  };
}

function getWorkDir(options: OpencodeTaskOptions): string {
  return path.resolve(
    options.workDir ||
      path.join(process.env.TMP_DIR || "tmp", "opencode-tasks", options.jobId)
  );
}

function getCloneDir(options: OpencodeTaskOptions): string {
  return path.join(getWorkDir(options), "repo");
}

async function runOpencode(
  options: OpencodeTaskOptions,
  branch: string,
  cwd: string
): Promise<string> {
  const deepseekApiKey =
    options.deepseekApiKey?.trim() || process.env.DEEPSEEK_API_KEY?.trim();
  if (!deepseekApiKey) {
    throw new Error("DEEPSEEK_API_KEY is required to run opencode.");
  }

  const prompt = buildOpencodePrompt(options.problemStatement, branch);
  // Write prompt to .opencode/commands/command.md in the repository so the
  // opencode CLI can pick it up from the working directory instead of passing
  // it via the command line. Ensure the directory exists first.
  const commandFile = path.join(cwd, ".opencode", "command", "command.md");
  fs.mkdirSync(path.dirname(commandFile), { recursive: true });
  fs.writeFileSync(commandFile, prompt, { encoding: "utf8" });

  let model = options.model.toString();

  if (model == "deepseek-v4-flash") {
    model = "deepseek/deepseek-v4-flash";
  } else if (model == "deepseek-v4-pro") {
    model = "deepseek/deepseek-v4-pro";
  }

  const args = ["run", "--model", model, "--dangerously-skip-permissions"];
  const timeout = parsePositiveInteger(
    process.env.OPENCODE_TIMEOUT_MS,
    DEFAULT_OPENCODE_TIMEOUT_MS
  );
  const outputLimit = parsePositiveInteger(
    process.env.OPENCODE_OUTPUT_LIMIT,
    DEFAULT_OUTPUT_LIMIT
  );

  logger.info("Starting opencode task", {
    jobId: options.jobId,
    repo: options.repo,
    branch,
    model: options.model,
    timeout,
  });

  const result = await execFileAsync(getOpencodeBin(), args, {
    cwd,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: deepseekApiKey,
    },
    maxBuffer: outputLimit,
    timeout,
  });

  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

async function commitAndPushFinalChanges(
  cwd: string,
  options: OpencodeTaskOptions,
  branch: string
): Promise<void> {
  const gitEnv = getGitCommandEnv(resolveGitHubToken(options.githubKey));
  await runGit(cwd, ["add", "--all"], gitEnv);
  const status = await runGit(cwd, ["status", "--porcelain"], gitEnv);
  if (status.trim()) {
    await runGit(cwd, ["commit", "-m", "Apply agent task changes"], gitEnv);
  }
  await runGit(cwd, ["push", "origin", branch], gitEnv);
}

async function configureCommitAuthor(
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const author = getGitAuthorConfig();
  await runGit(cwd, ["config", "user.name", author.name], env);
  await runGit(cwd, ["config", "user.email", author.email], env);
}

function getGitAuthorConfig(): { name: string; email: string } {
  return {
    name: process.env.GIT_AUTHOR_NAME || DEFAULT_GIT_AUTHOR_NAME,
    email: process.env.GIT_AUTHOR_EMAIL || DEFAULT_GIT_AUTHOR_EMAIL,
  };
}

async function runGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

function normalizeGitRef(value: string, fieldName: string): string {
  const ref = value.trim();
  if (
    !ref ||
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    /[\u0000-\u001F\u007F\\]/.test(ref)
  ) {
    throw new Error(
      `Field '${fieldName}' must be a non-empty git ref, cannot start with '-' or '/', cannot contain '..', '@{', backslashes, or control characters.`
    );
  }
  return ref;
}

function getOpencodeBin(): string {
  return (process.env.OPENCODE_BIN || "opencode").trim();
}

function resolveGitHubToken(githubKey?: string): string | undefined {
  return (
    githubKey?.trim() ||
    process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
    process.env.PUBLIC_GITHUB_TOKEN?.trim() ||
    undefined
  );
}

function getGitCommandEnv(githubKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (githubKey) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `url.https://x-access-token:${githubKey}@github.com/.insteadOf`;
    env.GIT_CONFIG_VALUE_0 = "https://github.com/";
  }
  return env;
}

function getRepositoryUrl(repo: string): string {
  return repo.startsWith("https://github.com/")
    ? repo
    : `https://github.com/${repo.replace(/\.git$/, "")}.git`;
}

function buildTaskBranchName(jobId: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  return `fde-agent/${timestamp}-${jobId.slice(0, 8)}`;
}

function buildInitCommitSubject(problemStatement: string): string {
  return `Initialize agent task: ${problemStatement.replace(/\s+/g, " ").trim().slice(0, 72)}`;
}

function buildPullRequestTitle(problemStatement: string): string {
  return `Agent task: ${problemStatement.replace(/\s+/g, " ").trim().slice(0, 80)}`;
}

function buildPullRequestBody(
  problemStatement: string,
  branch: string,
  model: AgentTaskModel
): string {
  return [
    "This pull request was initialized by file-diff-engine for an opencode-backed agent task.",
    "",
    `Branch: \`${branch}\``,
    `Model: \`${model}\``,
    "",
    "Task:",
    problemStatement,
  ].join("\n");
}

function buildOpencodePrompt(problemStatement: string, branch: string): string {
  return [
    `You are already on branch '${branch}'.`,
    "Implement the requested changes in this repository.",
    "Commit coherent changes and push the branch as you make progress.",
    "Do not create another branch or pull request; the pull request already exists.",
    "",
    problemStatement,
  ].join("\n");
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

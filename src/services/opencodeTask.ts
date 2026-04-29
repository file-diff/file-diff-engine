import fs from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { createPullRequest } from "./githubApi";
import type { AgentTaskModel } from "../types";
import { createLogger } from "../utils/logger";

const execFileAsync = promisify(execFile);
const logger = createLogger("opencode-task");
const TWO_HOURS_IN_SECONDS = 2 * 60 * 60;
const DEFAULT_OPENCODE_TIMEOUT_MS = TWO_HOURS_IN_SECONDS * 1_000;
const DEFAULT_OUTPUT_LIMIT = 1_000_000;
const DEFAULT_LOG_FLUSH_INTERVAL_MS = 15_000;
const DEFAULT_SESSION_EXPORT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_GIT_AUTHOR_NAME = "file-diff-agent";
const DEFAULT_GIT_AUTHOR_EMAIL = "file-diff-agent@users.noreply.github.com";

export interface OpencodeCapturedLogs {
  output: string;
  stdout: string;
  stderr: string;
  opencodeSessionId?: string;
  opencodeSessionExport?: unknown;
}

export interface OpencodeExecutionCallbacks {
  onLogsUpdated?: (logs: OpencodeCapturedLogs) => Promise<void> | void;
}

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
  stdout: string;
  stderr: string;
}

export class OpencodeExecutionError extends Error {
  constructor(
    message: string,
    public readonly logs: OpencodeCapturedLogs
  ) {
    super(message);
    this.name = "OpencodeExecutionError";
  }
}

export async function runOpencodeTask(
  options: OpencodeTaskOptions,
  callbacks?: OpencodeExecutionCallbacks
): Promise<OpencodeTaskResult> {
  const prepared = await prepareOpencodeTaskBranch(options);
  const logs = await executeOpencodeOnPreparedBranch(
    options,
    prepared.branch,
    callbacks
  );
  return { ...prepared, ...logs };
}

export async function executeOpencodeOnPreparedBranch(
  options: OpencodeTaskOptions,
  branch: string,
  callbacks?: OpencodeExecutionCallbacks
): Promise<OpencodeCapturedLogs> {
  const cloneDir = getCloneDir(options);
  const logs = await runOpencode(options, branch, cloneDir, callbacks);

  try {
    await commitAndPushFinalChanges(cloneDir, options, branch);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to commit and push final agent changes.";
    throw new OpencodeExecutionError(message, logs);
  }

  return logs;
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
  cwd: string,
  callbacks?: OpencodeExecutionCallbacks
): Promise<OpencodeCapturedLogs> {
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

  const args = ["run", "--model", model, "--dangerously-skip-permissions", "--command", "command"];
  const timeout = parsePositiveInteger(
    process.env.OPENCODE_TIMEOUT_MS,
    DEFAULT_OPENCODE_TIMEOUT_MS
  );
  const outputLimit = parsePositiveInteger(
    process.env.OPENCODE_OUTPUT_LIMIT,
    DEFAULT_OUTPUT_LIMIT
  );
  const logFlushIntervalMs = parsePositiveInteger(
    process.env.OPENCODE_LOG_FLUSH_INTERVAL_MS,
    DEFAULT_LOG_FLUSH_INTERVAL_MS
  );
  const sessionExportPollIntervalMs = parsePositiveInteger(
    process.env.OPENCODE_SESSION_EXPORT_POLL_INTERVAL_MS,
    DEFAULT_SESSION_EXPORT_POLL_INTERVAL_MS
  );
  const opencodeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DEEPSEEK_API_KEY: deepseekApiKey,
  };
  let sessionIdsBefore: string[] = [];
  try {
    sessionIdsBefore = await listOpencodeSessionIds(cwd, opencodeEnv);
  } catch (error) {
    logger.warn("Failed to list opencode sessions before starting the task.", {
      jobId: options.jobId,
      repo: options.repo,
      branch,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info("Starting opencode task", {
    jobId: options.jobId,
    repo: options.repo,
    branch,
    model: options.model,
    timeout,
    logFlushIntervalMs,
    sessionExportPollIntervalMs,
  });

  const child = spawn(getOpencodeBin(), args, {
    cwd,
    env: opencodeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const outputChunks: string[] = [];
  let capturedBytes = 0;
  let outputTruncated = false;
  let dirty = false;
  let timedOut = false;
  let opencodeSessionId: string | null = null;
  let opencodeSessionExport: unknown = undefined;
  let lastSerializedSessionExport: string | null = null;
  let lastObservedSessionCount = sessionIdsBefore.length;
  let spawnError: Error | undefined;
  let flushError: Error | undefined;
  let intervalFlushPending = false;
  let flushChain = Promise.resolve();
  let sessionSyncPending = false;
  let sessionSyncChain = Promise.resolve();

  const buildLogs = (): OpencodeCapturedLogs => ({
    output: outputChunks.join(""),
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    opencodeSessionId: opencodeSessionId ?? undefined,
    opencodeSessionExport,
  });

  const queueFlush = (force = false): Promise<void> => {
    flushChain = flushChain
      .catch(() => undefined)
      .then(async () => {
        if (flushError || !callbacks?.onLogsUpdated || (!force && !dirty)) {
          return;
        }

        dirty = false;
        await callbacks.onLogsUpdated(buildLogs());
      })
      .catch((error) => {
        flushError = error instanceof Error ? error : new Error(String(error));
        if (!child.killed) {
          child.kill();
        }
      });

    return flushChain;
  };

  const syncSessionState = async (): Promise<void> => {
    if (flushError) {
      return;
    }

    if (!opencodeSessionId) {
      try {
        const sessionIdsAfter = await listOpencodeSessionIds(cwd, opencodeEnv);
        lastObservedSessionCount = sessionIdsAfter.length;
        const detectedSessionId = findNewOpencodeSessionId(
          sessionIdsBefore,
          sessionIdsAfter
        );
        if (detectedSessionId) {
          opencodeSessionId = detectedSessionId;
          dirty = true;
          logger.info("Detected opencode session", {
            jobId: options.jobId,
            repo: options.repo,
            branch,
            opencodeSessionId,
          });
        }
      } catch (error) {
        logger.warn("Failed to list opencode sessions", {
          jobId: options.jobId,
          repo: options.repo,
          branch,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }

    if (!opencodeSessionId) {
      return;
    }

    try {
      const exportedSession = await exportOpencodeSession(
        cwd,
        opencodeSessionId,
        opencodeEnv
      );
      const serializedSession = JSON.stringify(exportedSession);
      if (serializedSession !== lastSerializedSessionExport) {
        opencodeSessionExport = exportedSession;
        lastSerializedSessionExport = serializedSession;
        dirty = true;
      }
    } catch (error) {
      logger.warn("Failed to export opencode session", {
        jobId: options.jobId,
        repo: options.repo,
        branch,
        opencodeSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const queueSessionSync = (): Promise<void> => {
    sessionSyncChain = sessionSyncChain
      .catch(() => undefined)
      .then(async () => {
        await syncSessionState();
      });

    return sessionSyncChain;
  };

  const flushInterval = setInterval(() => {
    if (intervalFlushPending || flushError) {
      return;
    }

    intervalFlushPending = true;
    void queueFlush().finally(() => {
      intervalFlushPending = false;
    });
  }, logFlushIntervalMs);
  flushInterval.unref?.();

  const sessionExportInterval = setInterval(() => {
    if (sessionSyncPending || flushError) {
      return;
    }

    sessionSyncPending = true;
    void queueSessionSync().finally(() => {
      sessionSyncPending = false;
    });
  }, sessionExportPollIntervalMs);
  sessionExportInterval.unref?.();

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    if (!child.killed) {
      child.kill();
    }
  }, timeout);
  timeoutHandle.unref?.();

  const appendChunk = (target: "stdout" | "stderr", chunk: string): void => {
    if (!chunk || flushError) {
      return;
    }

    const remaining = outputLimit - capturedBytes;
    if (remaining <= 0) {
      outputTruncated = true;
      return;
    }

    const limitedChunk = truncateUtf8(chunk, remaining);
    if (!limitedChunk) {
      outputTruncated = true;
      return;
    }

    capturedBytes += Buffer.byteLength(limitedChunk, "utf8");
    if (target === "stdout") {
      stdoutChunks.push(limitedChunk);
    } else {
      stderrChunks.push(limitedChunk);
    }
    outputChunks.push(limitedChunk);
    dirty = true;

    if (limitedChunk.length < chunk.length) {
      outputTruncated = true;
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    appendChunk("stdout", chunk);
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    appendChunk("stderr", chunk);
  });

  void queueSessionSync();

  child.on("error", (error) => {
    spawnError = error;
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    }
  );

  clearInterval(flushInterval);
  clearInterval(sessionExportInterval);
  clearTimeout(timeoutHandle);
  await queueSessionSync();
  await queueFlush(true);

  const logs = buildLogs();
  if (flushError) {
    throw new OpencodeExecutionError(flushError.message, logs);
  }

  if (spawnError) {
    throw new OpencodeExecutionError(spawnError.message, logs);
  }

  if (timedOut) {
    throw new OpencodeExecutionError(
      `opencode timed out after ${timeout}ms.`,
      logs
    );
  }

  if (exit.code === 0 && !opencodeSessionId) {
    throw new OpencodeExecutionError(
      `Unable to determine the opencode session id for the completed run. No new session was detected (sessions before start: ${sessionIdsBefore.length}, last observed during polling: ${lastObservedSessionCount}). The session may not have been created or session detection may have failed.`,
      logs
    );
  }

  if (exit.code !== 0) {
    throw new OpencodeExecutionError(
      buildOpencodeExitMessage(exit.code, exit.signal, logs),
      logs
    );
  }

  if (outputTruncated) {
    logger.warn("Opencode output truncated", {
      jobId: options.jobId,
      repo: options.repo,
      branch,
      outputLimit,
    });
  }

  return logs;
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

async function runOpencodeCommand(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<string> {
  const result = await execFileAsync(getOpencodeBin(), args, {
    cwd,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function listOpencodeSessionIds(
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<string[]> {
  const output = await runOpencodeCommand(cwd, ["session", "list"], env);
  return parseOpencodeSessionIds(output);
}

async function exportOpencodeSession(
  cwd: string,
  sessionId: string,
  env: NodeJS.ProcessEnv
): Promise<unknown> {
  const output = await runOpencodeCommand(cwd, ["export", sessionId], env);
  if (!output) {
    throw new Error(
      `opencode export returned no output for session '${sessionId}'. The session may not exist yet or the CLI may have failed to export it.`
    );
  }

  try {
    return JSON.parse(output) as unknown;
  } catch (error) {
    throw new Error(
      `Failed to parse opencode export JSON for session '${sessionId}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function parseOpencodeSessionIds(output: string): string[] {
  const sessionIds: string[] = [];
  const seen = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/\b(ses_[A-Za-z0-9]+)\b/);
    if (!match) {
      continue;
    }

    const sessionId = match[1];
    if (!seen.has(sessionId)) {
      seen.add(sessionId);
      sessionIds.push(sessionId);
    }
  }

  return sessionIds;
}

export function findNewOpencodeSessionId(
  beforeSessionIds: readonly string[],
  afterSessionIds: readonly string[]
): string | null {
  const knownSessionIds = new Set(beforeSessionIds);
  return afterSessionIds.find((sessionId) => !knownSessionIds.has(sessionId)) ?? null;
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

function buildOpencodeExitMessage(
  code: number | null,
  signal: NodeJS.Signals | null,
  logs: OpencodeCapturedLogs
): string {
  const details = logs.stderr.trim() || logs.output.trim();
  if (details) {
    return details;
  }

  if (signal) {
    return `opencode exited due to signal ${signal}.`;
  }

  return `opencode exited with code ${code ?? "unknown"}.`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) {
    return value;
  }

  return buffer.subarray(0, maxBytes).toString("utf8");
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

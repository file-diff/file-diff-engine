import fs from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import {
  AgentTaskCanceledError,
  signalChildProcessTree,
} from "./agentTaskControl";
import { createPullRequest } from "./githubApi";
import type {
  AgentTaskModel,
  AgentTaskRunner,
  CodexReasoningEffort,
  CodexReasoningSummary,
  CodexVerbosity,
  PullRequestCompletionMode,
} from "../types";
import { createLogger } from "../utils/logger";

const execFileAsync = promisify(execFile);
const logger = createLogger("opencode-task");
const TWO_HOURS_IN_SECONDS = 2 * 60 * 60;
const DEFAULT_OPENCODE_TIMEOUT_MS = TWO_HOURS_IN_SECONDS * 1_000;
const DEFAULT_OUTPUT_LIMIT = 1_000_000;
const DEFAULT_LOG_FLUSH_INTERVAL_MS = 15_000;
const DEFAULT_SESSION_EXPORT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_GIT_AUTHOR_NAME = "file-diff-agent";
const DEFAULT_GIT_AUTHOR_EMAIL = "file-diff-agent@users.noreply.github.com";
const AGENT_BOOTSTRAP_SCRIPT = path.join(".fd-agent", "agent-bootstrap.sh");

export interface OpencodeCapturedLogs {
  output: string;
  stdout: string;
  stderr: string;
  opencodeSessionId?: string;
  opencodeSessionExport?: unknown;
  codexSessionId?: string;
  codexSessionFilePath?: string;
  codexSessionExport?: unknown;
}

export interface OpencodeExecutionCallbacks {
  onLogsUpdated?: (logs: OpencodeCapturedLogs) => Promise<void> | void;
  isCancellationRequested?: () => Promise<boolean> | boolean;
}

export interface OpencodeTaskOptions {
  jobId: string;
  repo: string;
  baseRef: string;
  branch?: string;
  problemStatement: string;
  model: AgentTaskModel;
  taskRunner?: AgentTaskRunner;
  reasoningEffort?: CodexReasoningEffort;
  reasoningSummary?: CodexReasoningSummary;
  verbosity?: CodexVerbosity;
  codexWebSearch?: boolean;
  pullRequestCompletionMode?: PullRequestCompletionMode;
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
    prepared.pullRequest.number,
    callbacks
  );
  return { ...prepared, ...logs };
}

export async function executeOpencodeOnPreparedBranch(
  options: OpencodeTaskOptions,
  branch: string,
  pullRequestNumber: number,
  callbacks?: OpencodeExecutionCallbacks
): Promise<OpencodeCapturedLogs> {
  const cloneDir = getOpencodeTaskCloneDir(options);
  const logs = await runOpencode(
    options,
    branch,
    pullRequestNumber,
    cloneDir,
    callbacks
  );
  if (await callbacks?.isCancellationRequested?.()) {
    throw new AgentTaskCanceledError("Task canceled by request.", logs);
  }

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
  const requestedBranch = options.branch?.trim()
    ? normalizeGitRef(options.branch, "branch")
    : undefined;
  const githubKey = resolveGitHubToken(options.githubKey);
  if (!githubKey) {
    throw new Error(
      "GitHub token is required. Set PRIVATE_GITHUB_TOKEN or pass githubKey."
    );
  }

  const workDir = getOpencodeTaskWorkDir(options);
  const cloneDir = getOpencodeTaskCloneDir(options);
  const repoUrl = getRepositoryUrl(repo);
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
  const branch = requestedBranch
    ? await resolveUniqueRemoteBranchName(cloneDir, requestedBranch, gitEnv)
    : buildTaskBranchName(options.jobId);
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
    body: buildPullRequestBody(options, branch),
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

export function getOpencodeTaskWorkDir(options: OpencodeTaskOptions): string {
  const taskRunner = options.taskRunner ?? "opencode";
  return path.resolve(
    options.workDir ||
      path.join(process.env.TMP_DIR || "tmp", `${taskRunner}-tasks`, options.jobId)
  );
}

export function getOpencodeTaskCloneDir(options: OpencodeTaskOptions): string {
  return path.join(getOpencodeTaskWorkDir(options), "repo");
}

async function runOpencode(
  options: OpencodeTaskOptions,
  branch: string,
  pullRequestNumber: number,
  cwd: string,
  callbacks?: OpencodeExecutionCallbacks
): Promise<OpencodeCapturedLogs> {
  const deepseekApiKey =
    options.deepseekApiKey?.trim() || process.env.DEEPSEEK_API_KEY?.trim();
  if (!deepseekApiKey) {
    throw new Error("DEEPSEEK_API_KEY is required to run opencode.");
  }

  const prompt = buildOpencodePrompt(
    options.problemStatement,
    branch,
    pullRequestNumber
  );
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
  const cancellationPollIntervalMs = parsePositiveInteger(
    process.env.AGENT_TASK_CANCELLATION_POLL_INTERVAL_MS,
    DEFAULT_CANCELLATION_POLL_INTERVAL_MS
  );
  const opencodeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DEEPSEEK_API_KEY: deepseekApiKey,
  };
  await runAgentBootstrapIfAvailable(cwd, opencodeEnv, {
    jobId: options.jobId,
    repo: options.repo,
    branch,
    taskRunner: "opencode",
  });

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
    detached: true,
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const outputChunks: string[] = [];
  let capturedBytes = 0;
  let outputTruncated = false;
  let dirty = false;
  let timedOut = false;
  let cancellationRequested = false;
  let terminationStarted = false;
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

  const requestTermination = (reason: "cancel" | "timeout" | "flush-error"): void => {
    if (terminationStarted) {
      return;
    }

    terminationStarted = true;
    logger.info("Terminating opencode process", {
      jobId: options.jobId,
      repo: options.repo,
      branch,
      reason,
      pid: child.pid,
    });

    try {
      signalChildProcessTree(child, "SIGTERM");
    } catch (error) {
      logger.warn("Failed to send SIGTERM to opencode process", {
        jobId: options.jobId,
        repo: options.repo,
        branch,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const killHandle = setTimeout(() => {
      try {
        signalChildProcessTree(child, "SIGKILL");
      } catch (error) {
        logger.warn("Failed to send SIGKILL to opencode process", {
          jobId: options.jobId,
          repo: options.repo,
          branch,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, DEFAULT_TERMINATION_GRACE_MS);
    killHandle.unref?.();
  };

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
        requestTermination("flush-error");
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
    requestTermination("timeout");
  }, timeout);
  timeoutHandle.unref?.();

  const cancellationInterval = setInterval(() => {
    if (!callbacks?.isCancellationRequested || cancellationRequested) {
      return;
    }

    void Promise.resolve(callbacks.isCancellationRequested())
      .then((requested) => {
        if (!requested || cancellationRequested) {
          return;
        }

        cancellationRequested = true;
        requestTermination("cancel");
      })
      .catch((error) => {
        flushError = error instanceof Error ? error : new Error(String(error));
        requestTermination("flush-error");
      });
  }, cancellationPollIntervalMs);
  cancellationInterval.unref?.();

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
  clearInterval(cancellationInterval);
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

  if (cancellationRequested) {
    throw new AgentTaskCanceledError("Task canceled by request.", logs);
  }

  if (timedOut) {
    throw new OpencodeExecutionError(
      `opencode timed out after ${timeout}ms.`,
      logs
    );
  }

  if (exit.code === 0 && !opencodeSessionId) {
    throw new OpencodeExecutionError(
      `Failed to detect an opencode session for a successful run. Sessions before start: ${sessionIdsBefore.length}. Last observed during polling: ${lastObservedSessionCount}. Verify that the opencode CLI created a session and that session list/export commands are available in this environment.`,
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

export async function commitAndPushFinalChanges(
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

export async function runAgentBootstrapIfAvailable(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  context?: {
    jobId?: string;
    repo?: string;
    branch?: string;
    taskRunner?: AgentTaskRunner;
  }
): Promise<void> {
  const bootstrapPath = path.join(cwd, AGENT_BOOTSTRAP_SCRIPT);
  if (!fs.existsSync(bootstrapPath)) {
    logger.info("Agent bootstrap script not found; skipping.", {
      ...context,
      bootstrapScript: AGENT_BOOTSTRAP_SCRIPT,
    });
    return;
  }

  const stat = fs.statSync(bootstrapPath);
  if (!stat.isFile()) {
    logger.info("Agent bootstrap path is not a file; skipping.", {
      ...context,
      bootstrapScript: AGENT_BOOTSTRAP_SCRIPT,
    });
    return;
  }

  logger.info("Running agent bootstrap script.", {
    ...context,
    bootstrapScript: AGENT_BOOTSTRAP_SCRIPT,
  });

  try {
    await execFileAsync("bash", [`./${AGENT_BOOTSTRAP_SCRIPT}`], {
      cwd,
      env,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const details = getExecErrorDetails(error);
    throw new Error(
      `Agent bootstrap script failed: ${details || "bash exited unsuccessfully."}`
    );
  }

  logger.info("Agent bootstrap script completed.", {
    ...context,
    bootstrapScript: AGENT_BOOTSTRAP_SCRIPT,
  });
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

function getExecErrorDetails(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const candidate = error as {
    message?: unknown;
    stderr?: unknown;
    stdout?: unknown;
  };
  const stderr = typeof candidate.stderr === "string" ? candidate.stderr.trim() : "";
  if (stderr) {
    return stderr;
  }

  const stdout = typeof candidate.stdout === "string" ? candidate.stdout.trim() : "";
  if (stdout) {
    return stdout;
  }

  return typeof candidate.message === "string" ? candidate.message : String(error);
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

export function normalizeGitRef(value: string, fieldName: string): string {
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

export function incrementBranchName(branch: string): string {
  const match = branch.match(/^(.*)-(\d+)$/);
  if (!match) {
    return `${branch}-1`;
  }

  const [, prefix, suffix] = match;
  const incremented = String(Number.parseInt(suffix, 10) + 1).padStart(
    suffix.length,
    "0"
  );
  return `${prefix}-${incremented}`;
}

async function resolveUniqueRemoteBranchName(
  cwd: string,
  branch: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  let candidate = branch;
  while (await remoteBranchExists(cwd, candidate, env)) {
    candidate = incrementBranchName(candidate);
  }
  return candidate;
}

async function remoteBranchExists(
  cwd: string,
  branch: string,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  const output = await runGit(cwd, ["ls-remote", "--heads", "origin", branch], env);
  return output.length > 0;
}

function getOpencodeBin(): string {
  return (process.env.OPENCODE_BIN || "opencode").trim();
}

function resolveGitHubToken(githubKey?: string): string | undefined {
  return (
    githubKey?.trim() ||
    process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
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
    : `https://github.com/${repo.replace(/\.git$/, "")}`;
}

export function buildTaskBranchName(jobId: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  return `fd-agent/${timestamp}-${jobId.slice(0, 8)}`;
}

function buildInitCommitSubject(problemStatement: string): string {
  return `Initialize agent task: ${problemStatement.replace(/\s+/g, " ").trim().slice(0, 72)}`;
}

function buildPullRequestTitle(problemStatement: string): string {
  return `Agent task: ${problemStatement.replace(/\s+/g, " ").trim().slice(0, 80)}`;
}

export function buildPullRequestBody(
  options: Pick<
    OpencodeTaskOptions,
    | "baseRef"
    | "problemStatement"
    | "model"
    | "taskRunner"
    | "reasoningEffort"
    | "reasoningSummary"
    | "verbosity"
    | "codexWebSearch"
    | "pullRequestCompletionMode"
  >,
  branch: string
): string {
  const taskRunner = options.taskRunner ?? "opencode";
  const details = [
    `Branch: \`${branch}\``,
    `Base branch: \`${options.baseRef}\``,
    `Task runner: \`${taskRunner}\``,
    `Model: \`${options.model}\``,
  ];

  if (options.reasoningEffort) {
    details.push(`Reasoning effort: \`${options.reasoningEffort}\``);
  }

  if (options.reasoningSummary) {
    details.push(`Reasoning summary: \`${options.reasoningSummary}\``);
  }

  if (options.verbosity) {
    details.push(`Verbosity: \`${options.verbosity}\``);
  }

  if (options.codexWebSearch !== undefined) {
    details.push(`Web search: \`${options.codexWebSearch ? "enabled" : "disabled"}\``);
  }

  if (options.pullRequestCompletionMode) {
    details.push(
      `Pull request completion mode: \`${options.pullRequestCompletionMode}\``
    );
    if (options.pullRequestCompletionMode === "AutoMerge") {
      details.push(
        "Completion behavior: this task pull request starts as a draft. After the agent run completes successfully, it will be marked ready and the pull request will be merged directly. If the base branch is protected or required checks are not satisfied, the pull request will be left open and a notice posted instead."
      );
    } else if (options.pullRequestCompletionMode === "AutoReady") {
      details.push(
        "Completion behavior: this task pull request starts as a draft and will be marked ready for review after the agent run completes successfully."
      );
    }
  }

  return [
    `This pull request was initialized by file-diff-engine for a ${taskRunner}-backed agent task.`,
    "",
    ...details,
    "",
    "Task:",
    options.problemStatement,
  ].join("\n");
}

export function buildOpencodePrompt(
  problemStatement: string,
  branch: string,
  pullRequestNumber: number
): string {
  return [
    `You are already on branch '${branch}' with pull request #${pullRequestNumber} created.`,
    "1. Create plan of the given instructions.",
    "2. Comment on pull request with created plan.",
    "3. Follow the plan, commit and push the changes as you go.",
    "4. Do not create another branch or pull request.",
    "5. After done comment on pull request with detailed summary report",
    "User instructions starts here:",
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

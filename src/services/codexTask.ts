import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import {
  AgentTaskCanceledError,
  signalChildProcessTree,
} from "./agentTaskControl";
import {
  commitAndPushFinalChanges,
  getOpencodeTaskCloneDir,
  type OpencodeCapturedLogs,
  type OpencodeExecutionCallbacks,
  type OpencodeTaskOptions,
  runAgentBootstrapIfAvailable,
} from "./opencodeTask";
import { createLogger } from "../utils/logger";

const logger = createLogger("codex-task");
const TWO_HOURS_IN_SECONDS = 2 * 60 * 60;
const DEFAULT_CODEX_MODEL = "gpt-5.2-codex";
const DEFAULT_CODEX_TIMEOUT_MS = TWO_HOURS_IN_SECONDS * 1_000;
const DEFAULT_OUTPUT_LIMIT = 1_000_000;
const DEFAULT_LOG_FLUSH_INTERVAL_MS = 15_000;
const DEFAULT_CODEX_SESSION_SYNC_INTERVAL_MS = 15_000;
const DEFAULT_CODEX_SESSION_TEST_DETAIL_LIMIT = 200;
const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const CODEX_SESSION_TEST_PATTERN =
  /\b(test|tests|testing|vitest|jest|mocha|npm test|pnpm test|yarn test|passed|failed|failures?)\b/i;

export class CodexExecutionError extends Error {
  constructor(
    message: string,
    public readonly logs: OpencodeCapturedLogs
  ) {
    super(message);
    this.name = "CodexExecutionError";
  }
}

export async function executeCodexOnPreparedBranch(
  options: OpencodeTaskOptions,
  branch: string,
  pullRequestNumber: number,
  callbacks?: OpencodeExecutionCallbacks
): Promise<OpencodeCapturedLogs> {
  const cloneDir = getOpencodeTaskCloneDir(options);
  const logs = await runCodex(options, branch, pullRequestNumber, cloneDir, callbacks);
  if (await callbacks?.isCancellationRequested?.()) {
    throw new AgentTaskCanceledError("Task canceled by request.", logs);
  }

  try {
    await commitAndPushFinalChanges(cloneDir, options, branch);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to commit and push final agent changes.";
    throw new CodexExecutionError(message, logs);
  }

  return logs;
}

async function runCodex(
  options: OpencodeTaskOptions,
  branch: string,
  pullRequestNumber: number,
  cwd: string,
  callbacks?: OpencodeExecutionCallbacks
): Promise<OpencodeCapturedLogs> {
  const prompt = buildCodexPrompt(options.problemStatement, branch, pullRequestNumber);
  const model = resolveCodexModel(options.model);
  const timeout = parsePositiveInteger(
    process.env.CODEX_TIMEOUT_MS,
    DEFAULT_CODEX_TIMEOUT_MS
  );
  const outputLimit = parsePositiveInteger(
    process.env.CODEX_OUTPUT_LIMIT,
    DEFAULT_OUTPUT_LIMIT
  );
  const logFlushIntervalMs = parsePositiveInteger(
    process.env.CODEX_LOG_FLUSH_INTERVAL_MS,
    DEFAULT_LOG_FLUSH_INTERVAL_MS
  );
  const sessionSyncIntervalMs = parsePositiveInteger(
    process.env.CODEX_SESSION_SYNC_INTERVAL_MS,
    DEFAULT_CODEX_SESSION_SYNC_INTERVAL_MS
  );
  const cancellationPollIntervalMs = parsePositiveInteger(
    process.env.AGENT_TASK_CANCELLATION_POLL_INTERVAL_MS,
    DEFAULT_CANCELLATION_POLL_INTERVAL_MS
  );
  const args = buildCodexArgs(options, model, cwd);
  await runAgentBootstrapIfAvailable(cwd, process.env, {
    jobId: options.jobId,
    repo: options.repo,
    branch,
    taskRunner: "codex",
  });

  logger.info("Starting codex task", {
    args,
    jobId: options.jobId,
    repo: options.repo,
    branch,
    model,
    reasoningEffort: options.reasoningEffort,
    reasoningSummary: options.reasoningSummary,
    verbosity: options.verbosity,
    codexWebSearch: options.codexWebSearch === true,
    timeout,
    logFlushIntervalMs,
    sessionSyncIntervalMs,
  });

  const child = spawn(getCodexBin(), args, {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  child.stdin?.end(prompt);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const outputChunks: string[] = [];
  let capturedBytes = 0;
  let outputTruncated = false;
  let dirty = false;
  let timedOut = false;
  let cancellationRequested = false;
  let terminationStarted = false;
  let spawnError: Error | undefined;
  let flushError: Error | undefined;
  let intervalFlushPending = false;
  let sessionSyncPending = false;
  let flushChain = Promise.resolve();
  let sessionSyncChain = Promise.resolve();
  let codexSessionId: string | null = null;
  let codexSessionFilePath: string | null = null;
  let codexSessionExport: unknown = undefined;
  let lastSerializedSessionExport: string | undefined;

  const buildLogs = (): OpencodeCapturedLogs => ({
    output: outputChunks.join(""),
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    codexSessionId: codexSessionId ?? undefined,
    codexSessionFilePath: codexSessionFilePath ?? undefined,
    codexSessionExport,
  });

  const requestTermination = (reason: "cancel" | "timeout" | "flush-error"): void => {
    if (terminationStarted) {
      return;
    }

    terminationStarted = true;
    logger.info("Terminating codex process", {
      jobId: options.jobId,
      repo: options.repo,
      branch,
      reason,
      pid: child.pid,
    });

    try {
      signalChildProcessTree(child, "SIGTERM");
    } catch (error) {
      logger.warn("Failed to send SIGTERM to codex process", {
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
        logger.warn("Failed to send SIGKILL to codex process", {
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

  const detectSessionIdFromOutput = (): void => {
    if (codexSessionId) {
      return;
    }

    const detectedSessionId = parseCodexSessionId(outputChunks.join(""));
    if (!detectedSessionId) {
      return;
    }

    codexSessionId = detectedSessionId;
    dirty = true;
    logger.info("Detected codex session", {
      jobId: options.jobId,
      repo: options.repo,
      branch,
      codexSessionId,
    });
  };

  const syncSessionState = async (): Promise<void> => {
    if (flushError) {
      return;
    }

    detectSessionIdFromOutput();
    if (!codexSessionId) {
      return;
    }

    try {
      const sessionFilePath =
        codexSessionFilePath ?? await findCodexSessionJsonlPath(codexSessionId);
      if (sessionFilePath && sessionFilePath !== codexSessionFilePath) {
        codexSessionFilePath = sessionFilePath;
        dirty = true;
      }

      const exportedSession = await exportCodexSessionDetails(
        codexSessionId,
        sessionFilePath ?? codexSessionFilePath
      );
      const serializedSession = JSON.stringify(exportedSession);
      if (serializedSession !== lastSerializedSessionExport) {
        codexSessionExport = exportedSession;
        lastSerializedSessionExport = serializedSession;
        dirty = true;
      }
    } catch (error) {
      logger.warn("Failed to export codex session details", {
        jobId: options.jobId,
        repo: options.repo,
        branch,
        codexSessionId,
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

  const sessionSyncInterval = setInterval(() => {
    if (sessionSyncPending || flushError) {
      return;
    }

    sessionSyncPending = true;
    void queueSessionSync().finally(() => {
      sessionSyncPending = false;
    });
  }, sessionSyncIntervalMs);
  sessionSyncInterval.unref?.();

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
    detectSessionIdFromOutput();

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
  clearInterval(sessionSyncInterval);
  clearInterval(cancellationInterval);
  clearTimeout(timeoutHandle);
  await queueSessionSync();
  await queueFlush(true);

  const logs = buildLogs();
  if (flushError) {
    throw new CodexExecutionError(flushError.message, logs);
  }

  if (spawnError) {
    throw new CodexExecutionError(spawnError.message, logs);
  }

  if (cancellationRequested) {
    throw new AgentTaskCanceledError("Task canceled by request.", logs);
  }

  if (timedOut) {
    throw new CodexExecutionError(`codex timed out after ${timeout}ms.`, logs);
  }

  if (exit.code !== 0) {
    throw new CodexExecutionError(buildCodexExitMessage(exit.code, exit.signal, logs), logs);
  }

  if (outputTruncated) {
    logger.warn("Codex output truncated", {
      jobId: options.jobId,
      repo: options.repo,
      branch,
      outputLimit,
    });
  }

  return logs;
}

function getCodexBin(): string {
  return (process.env.CODEX_BIN || "codex").trim();
}

export function resolveCodexModel(model: string | null | undefined): string {
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  if (normalizedModel) {
    return normalizedModel;
  }

  const configuredModel = process.env.CODEX_MODEL?.trim();
  if (configuredModel) {
    return configuredModel;
  }

  return DEFAULT_CODEX_MODEL;
}

export function buildCodexArgs(
  options: Pick<
    OpencodeTaskOptions,
    "reasoningEffort" | "reasoningSummary" | "verbosity" | "codexWebSearch"
  >,
  model: string,
  cwd: string
): string[] {
  const args = ["exec", "--model", model];

  if (options.reasoningEffort) {
    args.push("--config", `model_reasoning_effort=${options.reasoningEffort}`);
  }

  if (options.reasoningSummary) {
    args.push("--config", `model_reasoning_summary=${options.reasoningSummary}`);
  }

  if (options.verbosity) {
    args.push("--config", `model_verbosity=${options.verbosity}`);
  }

  args.push("--cd", cwd, "--dangerously-bypass-approvals-and-sandbox");

  if (options.codexWebSearch) {
    args.push("--search");
  }

  args.push("-");

  return args;
}

export function buildCodexPrompt(
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
    '5. After done comment on pull request with detailed summary report',
    "User instructions starts here:",
    problemStatement,
  ].join("\n");
}

export function parseCodexSessionId(output: string): string | null {
  const match = output.match(/^session id:\s*([^\s]+)\s*$/im);
  return match?.[1] ?? null;
}

export async function findCodexSessionJsonlPath(
  sessionId: string,
  rootDir = getCodexSessionsRoot()
): Promise<string | null> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return null;
  }

  const candidates = await listCodexRolloutFiles(rootDir);
  for (const filePath of candidates) {
    if (await fileContains(filePath, normalizedSessionId)) {
      return filePath;
    }
  }

  return null;
}

async function exportCodexSessionDetails(
  sessionId: string,
  sessionFilePath: string | null
): Promise<unknown> {
  if (!sessionFilePath) {
    return {
      sessionId,
      sessionFilePath: null,
      testDetails: [],
    };
  }

  return {
    sessionId,
    sessionFilePath,
    testDetails: await grepCodexSessionTestDetails(sessionFilePath),
  };
}

async function grepCodexSessionTestDetails(
  sessionFilePath: string
): Promise<string[]> {
  const contents = await fs.promises.readFile(sessionFilePath, "utf8");
  const limit = parsePositiveInteger(
    process.env.CODEX_SESSION_TEST_DETAIL_LIMIT,
    DEFAULT_CODEX_SESSION_TEST_DETAIL_LIMIT
  );

  const matches: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line || !CODEX_SESSION_TEST_PATTERN.test(line)) {
      continue;
    }

    matches.push(line);
    if (matches.length >= limit) {
      break;
    }
  }

  return matches;
}

async function listCodexRolloutFiles(rootDir: string): Promise<string[]> {
  try {
    const stats = await fs.promises.stat(rootDir);
    if (!stats.isDirectory()) {
      return [];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  await collectCodexRolloutFiles(rootDir, files);
  return files.sort((a, b) => b.localeCompare(a));
}

async function collectCodexRolloutFiles(
  dirPath: string,
  files: string[]
): Promise<void> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await collectCodexRolloutFiles(entryPath, files);
      continue;
    }

    if (entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
}

async function fileContains(filePath: string, value: string): Promise<boolean> {
  const contents = await fs.promises.readFile(filePath, "utf8");
  return contents.includes(value);
}

function getCodexSessionsRoot(): string {
  return (
    process.env.CODEX_SESSIONS_DIR?.trim() ||
    path.join(os.homedir(), ".codex", "sessions")
  );
}

function buildCodexExitMessage(
  code: number | null,
  signal: NodeJS.Signals | null,
  logs: OpencodeCapturedLogs
): string {
  const details = logs.stderr.trim() || logs.output.trim();
  if (details) {
    return details;
  }

  if (signal) {
    return `codex exited due to signal ${signal}.`;
  }

  return `codex exited with code ${code ?? "unknown"}.`;
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

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

export type { OpencodeCapturedLogs, OpencodeExecutionCallbacks };

const DEFAULT_OUTPUT_LIMIT = 1_000_000;
const DEFAULT_LOG_FLUSH_INTERVAL_MS = 15_000;
const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;

export class AgentCliExecutionError extends Error {
  constructor(
    message: string,
    public readonly logs: OpencodeCapturedLogs
  ) {
    super(message);
    this.name = "AgentCliExecutionError";
  }
}

export interface AgentCliSessionState {
  codexSessionId?: string;
  codexSessionFilePath?: string;
  codexSessionExport?: unknown;
}

export interface AgentCliRunnerConfig {
  runner: "codex" | "claude";
  commandLabel: string;
  bin: string;
  args: string[] | ((cwd: string) => string[]);
  prompt: string;
  cwd: string;
  branch: string;
  defaultTimeoutMs: number;
  timeoutEnvVar: string;
  outputLimitEnvVar: string;
  logFlushIntervalEnvVar?: string;
  sessionSyncIntervalEnvVar?: string;
  defaultSessionSyncIntervalMs?: number;
  loggerName: string;
  onOutputUpdated?: (output: string) => void;
  syncSessionState?: () => Promise<void>;
  getSessionState?: () => AgentCliSessionState;
  logContext?: Record<string, unknown>;
}

export async function executeAgentCliOnPreparedBranch(
  options: OpencodeTaskOptions,
  config: AgentCliRunnerConfig,
  callbacks?: OpencodeExecutionCallbacks
): Promise<OpencodeCapturedLogs> {
  const cloneDir = getOpencodeTaskCloneDir(options);
  const logs = await runAgentCli(options, { ...config, cwd: cloneDir }, callbacks);
  if (await callbacks?.isCancellationRequested?.()) {
    throw new AgentTaskCanceledError("Task canceled by request.", logs);
  }

  try {
    await commitAndPushFinalChanges(cloneDir, options, config.branch);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to commit and push final agent changes.";
    throw new AgentCliExecutionError(message, logs);
  }

  return logs;
}

export async function runAgentCli(
  options: OpencodeTaskOptions,
  config: AgentCliRunnerConfig,
  callbacks?: OpencodeExecutionCallbacks
): Promise<OpencodeCapturedLogs> {
  const logger = createLogger(config.loggerName);
  const args =
    typeof config.args === "function" ? config.args(config.cwd) : config.args;
  const timeout = parsePositiveInteger(
    process.env[config.timeoutEnvVar],
    config.defaultTimeoutMs
  );
  const outputLimit = parsePositiveInteger(
    process.env[config.outputLimitEnvVar],
    DEFAULT_OUTPUT_LIMIT
  );
  const logFlushIntervalMs = parsePositiveInteger(
    config.logFlushIntervalEnvVar
      ? process.env[config.logFlushIntervalEnvVar]
      : undefined,
    DEFAULT_LOG_FLUSH_INTERVAL_MS
  );
  const sessionSyncIntervalMs = parsePositiveInteger(
    config.sessionSyncIntervalEnvVar
      ? process.env[config.sessionSyncIntervalEnvVar]
      : undefined,
    config.defaultSessionSyncIntervalMs ?? DEFAULT_LOG_FLUSH_INTERVAL_MS
  );
  const cancellationPollIntervalMs = parsePositiveInteger(
    process.env.AGENT_TASK_CANCELLATION_POLL_INTERVAL_MS,
    DEFAULT_CANCELLATION_POLL_INTERVAL_MS
  );

  await runAgentBootstrapIfAvailable(config.cwd, process.env, {
    jobId: options.jobId,
    repo: options.repo,
    branch: config.branch,
    taskRunner: config.runner,
  });

  logger.info(`Starting ${config.commandLabel} task`, {
    args,
    jobId: options.jobId,
    repo: options.repo,
    branch: config.branch,
    timeout,
    logFlushIntervalMs,
    ...(config.syncSessionState ? { sessionSyncIntervalMs } : {}),
    ...config.logContext,
  });

  const child = spawn(config.bin, args, {
    cwd: config.cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  child.stdin?.end(config.prompt);

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

  const buildLogs = (): OpencodeCapturedLogs => ({
    output: outputChunks.join(""),
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    ...config.getSessionState?.(),
  });

  const requestTermination = (reason: "cancel" | "timeout" | "flush-error"): void => {
    if (terminationStarted) {
      return;
    }

    terminationStarted = true;
    logger.info(`Terminating ${config.commandLabel} process`, {
      jobId: options.jobId,
      repo: options.repo,
      branch: config.branch,
      reason,
      pid: child.pid,
    });

    try {
      signalChildProcessTree(child, "SIGTERM");
    } catch (error) {
      logger.warn(`Failed to send SIGTERM to ${config.commandLabel} process`, {
        jobId: options.jobId,
        repo: options.repo,
        branch: config.branch,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const killHandle = setTimeout(() => {
      try {
        signalChildProcessTree(child, "SIGKILL");
      } catch (error) {
        logger.warn(`Failed to send SIGKILL to ${config.commandLabel} process`, {
          jobId: options.jobId,
          repo: options.repo,
          branch: config.branch,
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

  const queueSessionSync = (): Promise<void> => {
    if (!config.syncSessionState) {
      return sessionSyncChain;
    }

    sessionSyncChain = sessionSyncChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await config.syncSessionState?.();
          dirty = true;
        } catch (error) {
          logger.warn(`Failed to sync ${config.commandLabel} session state`, {
            jobId: options.jobId,
            repo: options.repo,
            branch: config.branch,
            error: error instanceof Error ? error.message : String(error),
          });
        }
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

  const sessionSyncInterval = config.syncSessionState
    ? setInterval(() => {
        if (sessionSyncPending || flushError) {
          return;
        }

        sessionSyncPending = true;
        void queueSessionSync().finally(() => {
          sessionSyncPending = false;
        });
      }, sessionSyncIntervalMs)
    : undefined;
  sessionSyncInterval?.unref?.();

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
    config.onOutputUpdated?.(outputChunks.join(""));

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
  if (sessionSyncInterval) {
    clearInterval(sessionSyncInterval);
  }
  clearInterval(cancellationInterval);
  clearTimeout(timeoutHandle);
  await queueSessionSync();
  await queueFlush(true);

  const logs = buildLogs();
  if (flushError) {
    throw new AgentCliExecutionError(flushError.message, logs);
  }

  if (spawnError) {
    throw new AgentCliExecutionError(spawnError.message, logs);
  }

  if (cancellationRequested) {
    throw new AgentTaskCanceledError("Task canceled by request.", logs);
  }

  if (timedOut) {
    throw new AgentCliExecutionError(
      `${config.commandLabel} timed out after ${timeout}ms.`,
      logs
    );
  }

  if (exit.code !== 0) {
    throw new AgentCliExecutionError(
      buildAgentExitMessage(config.commandLabel, exit.code, exit.signal, logs),
      logs
    );
  }

  if (outputTruncated) {
    logger.warn(`${config.commandLabel} output truncated`, {
      jobId: options.jobId,
      repo: options.repo,
      branch: config.branch,
      outputLimit,
    });
  }

  return logs;
}

export function buildAgentTaskPrompt(
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

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildAgentExitMessage(
  commandLabel: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  logs: OpencodeCapturedLogs
): string {
  const details = logs.stderr.trim() || logs.output.trim();
  if (details) {
    return details;
  }

  if (signal) {
    return `${commandLabel} exited due to signal ${signal}.`;
  }

  return `${commandLabel} exited with code ${code ?? "unknown"}.`;
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

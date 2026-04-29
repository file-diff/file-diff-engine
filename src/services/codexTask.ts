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
} from "./opencodeTask";
import { createLogger } from "../utils/logger";

const logger = createLogger("codex-task");
const TWO_HOURS_IN_SECONDS = 2 * 60 * 60;
const DEFAULT_CODEX_MODEL = "gpt-5.2-codex";
const DEFAULT_CODEX_TIMEOUT_MS = TWO_HOURS_IN_SECONDS * 1_000;
const DEFAULT_OUTPUT_LIMIT = 1_000_000;
const DEFAULT_LOG_FLUSH_INTERVAL_MS = 15_000;
const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;

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
  callbacks?: OpencodeExecutionCallbacks
): Promise<OpencodeCapturedLogs> {
  const cloneDir = getOpencodeTaskCloneDir(options);
  const logs = await runCodex(options, branch, cloneDir, callbacks);
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
  cwd: string,
  callbacks?: OpencodeExecutionCallbacks
): Promise<OpencodeCapturedLogs> {
  const prompt = buildCodexPrompt(options.problemStatement, branch);
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
  const cancellationPollIntervalMs = parsePositiveInteger(
    process.env.AGENT_TASK_CANCELLATION_POLL_INTERVAL_MS,
    DEFAULT_CANCELLATION_POLL_INTERVAL_MS
  );
  const args = buildCodexArgs(options, model, cwd);

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
  let flushChain = Promise.resolve();

  const buildLogs = (): OpencodeCapturedLogs => ({
    output: outputChunks.join(""),
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
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
  clearInterval(cancellationInterval);
  clearTimeout(timeoutHandle);
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

export function buildCodexPrompt(problemStatement: string, branch: string): string {
  return [
    `You are already on branch '${branch}'.`,
    "Implement the requested changes in this repository.",
    "Commit coherent changes and push the branch as you make progress.",
    "Do not create another branch or pull request; the pull request already exists.",
    'After done comment report about task to current pull request.',
    "",
    problemStatement,
  ].join("\n");
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

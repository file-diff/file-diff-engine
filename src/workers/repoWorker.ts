import { Worker, Job } from "bullmq";
import path from "path";
import fs from "fs";
import { getDatabase, type DatabaseClient } from "../db/database";
import { JobRepository } from "../db/repository";
import type {
  AgentTaskModel,
  AgentTaskMode,
  AgentTaskRunner,
  CodexReasoningEffort,
  CodexReasoningSummary,
  CodexVerbosity,
  PullRequestCompletionMode,
} from "../types";
import { executeClaudeOnPreparedBranch } from "../services/claudeTask";
import { executeCodexOnPreparedBranch } from "../services/codexTask";
import { processRepository } from "../services/repoProcessor";
import {
  executeOpencodeOnPreparedBranch,
  prepareOpencodeTaskBranch,
  preparePullRequestReviewTaskBranch,
  type OpencodeCapturedLogs,
} from "../services/opencodeTask";
import { applyPullRequestCompletionMode } from "../services/pullRequestCompletion";
import {
  MAX_CONCURRENCY_PER_TASK_KIND,
  QUEUE_NAMES,
  type ManagedQueue,
  type QueueJobName,
} from "../services/queue";
import {
  sendAgentTaskFinishedSlackNotification,
  type AgentTaskSlackNotification,
} from "../services/slack";
import { isAgentTaskCanceledError } from "../services/agentTaskControl";
import { createLogger } from "../utils/logger";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);

const TMP_DIR = process.env.TMP_DIR || "tmp";
const logger = createLogger("repo-worker");

export interface WorkerManager {
  workers: Worker[];
  close(): Promise<void>;
}

export async function createWorker(db?: DatabaseClient): Promise<WorkerManager> {
  const database = db ?? (await getDatabase());
  const repo = new JobRepository(database);
  logger.info("Worker connected to database, ready to process jobs.");

  const workers = [
    createNamedWorker(QUEUE_NAMES.repo, repo, "process-repo", true),
    createNamedWorker(QUEUE_NAMES.opencode, repo, "create-opencode-task"),
    createNamedWorker(QUEUE_NAMES.codex, repo, "create-codex-task"),
    createNamedWorker(QUEUE_NAMES.claude, repo, "create-claude-task"),
  ];

  return {
    workers,
    async close() {
      await Promise.all(workers.map((worker) => worker.close()));
    },
  };
}

function createNamedWorker(
  queueName: string,
  repo: JobRepository,
  expectedJobName: QueueJobName,
  allowLegacyAgentTasks = false
): Worker {
  const worker = new Worker(
    queueName,
    async (job: Job) => {
      if (job.name !== expectedJobName) {
        if (!allowLegacyAgentTasks || !isAgentTaskJobName(job.name)) {
          throw new Error(
            `Worker for '${expectedJobName}' received unexpected job '${job.name}'.`
          );
        }

        logger.warn("Processing legacy agent task from repo queue", {
          queueName,
          expectedJobName,
          jobName: job.name,
          jobId: job.id,
        });
      }

      await processQueuedJob(job, repo);
    },
    {
      connection: {
        host: REDIS_HOST,
        port: REDIS_PORT,
        maxRetriesPerRequest: null,
      },
      concurrency: MAX_CONCURRENCY_PER_TASK_KIND,
    }
  );

  registerWorkerEventHandlers(worker);
  return worker;
}

function registerWorkerEventHandlers(worker: Worker): void {
  worker.on("error", (error) => {
    logger.error("Worker emitted error", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  worker.on("failed", (job, error) => {
    logger.warn("Worker reported job failure", {
      jobId: job?.id,
      jobName: job?.name,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  worker.on("stalled", (jobId) => {
    logger.warn("Worker reported stalled job", { jobId });
  });
}

async function processQueuedJob(job: Job, repo: JobRepository): Promise<void> {
  if (isAgentTaskJobName(job.name)) {
    await handleAgentTaskJob(job, repo);
    return;
  }

  logger.debug("Job started", { jobId: job.id });
  const { jobId, repoName, commit } = job.data as {
    jobId: string;
    repoName: string;
    commit: string;
  };

  const workDir = path.join(TMP_DIR, `fde-${jobId}`);
  fs.mkdirSync(workDir, { recursive: true });
  logger.debug("Prepared work directory", { jobId, workDir });

  try {
    await repo.updateJobStatus(jobId, "active");
    logger.info("Job marked as active", { jobId, repoName, commit });

    const files = await processRepository(
      repoName,
      commit,
      workDir,
      {
        onFilesDiscovered: async (files) => {
          await repo.insertFiles(jobId, files);
          await repo.updateJobProgress(jobId, 0, files.length);
        },
        onFileProcessed: async (file, processed, total) => {
          await repo.updateFile(jobId, file);
          logger.debug("Job progress updated", { jobId, processed, total });
          await repo.updateJobProgress(jobId, processed, total);
        },
      }
    );

    await repo.updateJobStatus(jobId, "completed");
    logger.info("Job completed", { jobId, processedFiles: files.length });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error";
    logger.error("Job failed", { jobId, repoName, commit, error: message });
    await repo.updateJobStatus(jobId, "failed", message);
    throw err;
  } finally {
    //fs.rmSync(workDir, { recursive: true, force: true });
    //logger.debug("Cleaned up work directory", { jobId, workDir });
  }
}

function isAgentTaskJobName(name: string): boolean {
  return (
    name === "create-opencode-task" ||
    name === "create-codex-task" ||
    name === "create-claude-task"
  );
}

export async function recoverOrphanedWaitingJobs(
  db: DatabaseClient,
  queue: ManagedQueue
): Promise<number> {
  const repo = new JobRepository(db);
  const waiting = await repo.listWaitingJobs();
  if (waiting.length === 0) {
    return 0;
  }

  let recovered = 0;
  for (const job of waiting) {
    let queuedJob;
    try {
      queuedJob = await queue.getJob(job.id, "process-repo");
    } catch (error) {
      logger.warn("Failed to look up BullMQ job during recovery; skipping", {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (queuedJob) {
      continue;
    }

    // The DB row says 'waiting' but no BullMQ counterpart exists. This happens
    // when queue.add() failed after the row was inserted, or when Redis state
    // was lost (restart with ephemeral Redis, manual flush). Re-enqueue with a
    // fresh BullMQ jobId so an old completed/failed entry with the same id
    // cannot dedupe us out.
    const recoveryId = `${job.id}:recover-${Date.now()}`;
    try {
      await queue.add(
        "process-repo",
        { jobId: job.id, repoName: job.repo, commit: job.commit },
        { jobId: recoveryId }
      );
      recovered += 1;
      logger.warn("Recovered orphaned waiting job", {
        jobId: job.id,
        recoveryBullJobId: recoveryId,
      });
    } catch (error) {
      logger.error("Failed to re-enqueue orphaned waiting job", {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return recovered;
}

async function handleAgentTaskJob(job: Job, repo: JobRepository): Promise<void> {
  const {
    jobId,
    repoName,
    baseRef,
    branch,
    problemStatement,
    model,
    task = resolveAgentTaskRunnerFromJobName(job.name),
    reasoningEffort,
    reasoningSummary,
    verbosity,
    codexWebSearch,
    taskMode = "task",
    pullRequestNumber,
    pullRequestUrl,
    pullRequestTitle,
    pullRequestHeadRepo,
    pullRequestHeadSha,
    pullRequestCompletionMode,
    githubKey,
    deepseekApiKey,
  } = job.data as {
    jobId: string;
    repoName: string;
    baseRef: string;
    branch?: string;
    problemStatement: string;
    model: AgentTaskModel;
    task?: AgentTaskRunner;
    reasoningEffort?: CodexReasoningEffort;
    reasoningSummary?: CodexReasoningSummary;
    verbosity?: CodexVerbosity;
    codexWebSearch?: boolean;
    taskMode?: AgentTaskMode;
    pullRequestNumber?: number;
    pullRequestUrl?: string;
    pullRequestTitle?: string;
    pullRequestHeadRepo?: string;
    pullRequestHeadSha?: string;
    pullRequestCompletionMode?: PullRequestCompletionMode;
    githubKey?: string;
    deepseekApiKey?: string;
  };

  const tag = `AgentTask ${jobId}:`;
  logger.info(`${tag} Started ${task} processing repo=${repoName} base=${baseRef} model=${model}`);
  const startedAt = Date.now();
  const taskCreatedAt = typeof job.timestamp === "number" ? job.timestamp : startedAt;
  let lastKnownBranchName: string | null = null;
  let lastKnownPullRequestUrl: string | undefined;
  let lastCapturedLogs: OpencodeCapturedLogs | null = null;
  let pullRequestActions: string[] = [];
  const [owner, repoNameOnly] = splitRepoName(repoName);

  try {
    const existingJob = await repo.getAgentTaskJob(jobId);
    lastKnownPullRequestUrl = existingJob?.pullRequestUrl;
    if (existingJob?.status === "canceled" || existingJob?.cancelRequestedAt) {
      logger.info(`${tag} Skipping canceled task job`);
      await repo.updateAgentTaskStatus(jobId, "canceled");
      await repo.updateAgentTaskJobStatus(jobId, "canceled", "Task canceled by request.");
      return;
    }

    await repo.updateAgentTaskJobStatus(jobId, "active");
    await repo.updateAgentTaskStatus(jobId, "preparing");

    const taskOptions = {
      jobId,
      repo: repoName,
      baseRef,
      branch,
      problemStatement,
      model,
      taskRunner: task,
      reasoningEffort,
      reasoningSummary,
      verbosity,
      codexWebSearch,
      taskMode,
      pullRequestNumber,
      pullRequestUrl,
      pullRequestTitle,
      pullRequestHeadRepo,
      pullRequestHeadSha,
      pullRequestCompletionMode,
      githubKey,
      deepseekApiKey,
    };
    const prepared = taskMode === "review"
      ? await preparePullRequestReviewTaskBranch(taskOptions)
      : await prepareOpencodeTaskBranch(taskOptions);
    lastKnownBranchName = prepared.branch;
    lastKnownPullRequestUrl = prepared.pullRequest.url;
    if (await repo.isAgentTaskCancellationRequested(jobId)) {
      throw new Error("Task canceled by request.");
    }

    await repo.updateAgentTaskBootstrap(
      jobId,
      prepared.branch,
      prepared.pullRequest.url,
      prepared.pullRequest.number
    );
    await repo.updateAgentTaskStatus(jobId, "working", prepared.branch);
    const persistLogs = async (logs: OpencodeCapturedLogs): Promise<void> => {
      lastCapturedLogs = logs;
      await repo.updateAgentTaskLogs(jobId, logs);
    };
    const isCancellationRequested = async (): Promise<boolean> =>
      repo.isAgentTaskCancellationRequested(jobId);
    const executionCallbacks = {
      onLogsUpdated: persistLogs,
      isCancellationRequested,
    };
    const logs = task === "opencode"
      ? await executeOpencodeOnPreparedBranch(
          taskOptions,
          prepared.branch,
          prepared.pullRequest.number,
          executionCallbacks
        )
      : task === "claude"
        ? await executeClaudeOnPreparedBranch(
            taskOptions,
            prepared.branch,
            prepared.pullRequest.number,
            executionCallbacks
          )
        : await executeCodexOnPreparedBranch(
            taskOptions,
            prepared.branch,
            prepared.pullRequest.number,
            executionCallbacks
          );
    lastCapturedLogs = logs;
    if (await repo.isAgentTaskCancellationRequested(jobId)) {
      throw new Error("Task canceled by request.");
    }
    if (taskMode !== "review") {
      pullRequestActions = await applyPullRequestCompletionMode({
        repo: repoName,
        branch: prepared.branch,
        pullNumber: prepared.pullRequest.number,
        mode: pullRequestCompletionMode ?? existingJob?.pullRequestCompletionMode,
        token: githubKey,
      });
    }
    await repo.updateAgentTaskStatus(jobId, "completed", prepared.branch);
    await repo.updateAgentTaskLogs(jobId, logs);
    await repo.updateAgentTaskJobStatus(jobId, "completed");
    logger.info(`${tag} Completed branch=${prepared.branch} pr=${prepared.pullRequest.url}`);
    await sendTerminalTaskNotification(
      owner,
      repoNameOnly,
      jobId,
      "completed",
      lastKnownBranchName,
      Date.now() - taskCreatedAt,
      undefined,
      pullRequestActions,
      lastKnownPullRequestUrl,
      logs
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const logs = isOpencodeExecutionError(err) ? err.logs : lastCapturedLogs;
    const cancellationRequested =
      isAgentTaskCanceledError(err) ||
      message === "Task canceled by request." ||
      await repo.isAgentTaskCancellationRequested(jobId);
    if (cancellationRequested) {
      const cancelMessage = "Task canceled by request.";
      logger.warn(`${tag} Job canceled for repo=${repoName}: ${cancelMessage}`);
      await repo.updateAgentTaskStatus(jobId, "canceled", lastKnownBranchName ?? undefined);
      await repo.updateAgentTaskJobStatus(jobId, "canceled", cancelMessage);
      if (logs) {
        lastCapturedLogs = logs;
        await repo.updateAgentTaskLogs(jobId, logs);
      } else {
        await repo.updateAgentTaskOutput(jobId, cancelMessage);
      }
      await sendTerminalTaskNotification(
        owner,
        repoNameOnly,
        jobId,
        "canceled",
        lastKnownBranchName,
        Date.now() - taskCreatedAt,
        cancelMessage,
        pullRequestActions,
        lastKnownPullRequestUrl,
        logs
      );
      return;
    }

    logger.error(`${tag} Job failed for repo=${repoName}: ${message}`);
    await repo.updateAgentTaskJobStatus(jobId, "failed", message);
    if (logs) {
      lastCapturedLogs = logs;
      await repo.updateAgentTaskLogs(jobId, logs);
    } else {
      await repo.updateAgentTaskOutput(jobId, message);
    }
    await sendTerminalTaskNotification(
      owner,
      repoNameOnly,
      jobId,
      "failed",
      lastKnownBranchName,
      Date.now() - taskCreatedAt,
      message,
      pullRequestActions,
      lastKnownPullRequestUrl,
      logs
    );
    throw err;
  }
}

function resolveAgentTaskRunnerFromJobName(jobName: string): AgentTaskRunner {
  if (jobName === "create-opencode-task") {
    return "opencode";
  }

  if (jobName === "create-claude-task") {
    return "claude";
  }

  return "codex";
}

function isOpencodeExecutionError(
  error: unknown
): error is Error & { logs: OpencodeCapturedLogs } {
  if (!(error instanceof Error) || !("logs" in error)) {
    return false;
  }

  const logs = (error as { logs?: unknown }).logs;
  return isOpencodeCapturedLogs(logs);
}

function isOpencodeCapturedLogs(value: unknown): value is OpencodeCapturedLogs {
  if (!value || typeof value !== "object") {
    return false;
  }

  const logs = value as Record<string, unknown>;
  return (
    typeof logs.output === "string" &&
    typeof logs.stdout === "string" &&
    typeof logs.stderr === "string" &&
    (logs.opencodeSessionId === undefined ||
      logs.opencodeSessionId === null ||
      typeof logs.opencodeSessionId === "string") &&
    (logs.codexSessionId === undefined ||
      logs.codexSessionId === null ||
      typeof logs.codexSessionId === "string") &&
    (logs.codexSessionFilePath === undefined ||
      logs.codexSessionFilePath === null ||
      typeof logs.codexSessionFilePath === "string")
  );
}

function splitRepoName(repoName: string): [string, string] {
  const [owner, name] = repoName.split("/", 2);
  return [owner ?? repoName, name ?? ""];
}

async function sendTerminalTaskNotification(
  owner: string,
  repoName: string,
  taskId: string,
  status: string,
  branch: string | null,
  durationMs: number,
  details?: string,
  pullRequestActions?: string[],
  pullRequestUrl?: string,
  logs?: OpencodeCapturedLogs | null
): Promise<void> {
  try {
    logger.info(`AgentTask ${taskId}: Sending Slack notification status=${status} branch=${branch ?? "none"} duration=${Math.round(durationMs / 1000)}s`);
    await sendAgentTaskFinishedSlackNotification({
      owner,
      repoName,
      taskId,
      status,
      branch,
      durationMs,
      pullRequestUrl,
      pullRequestActions,
      details,
      codexSession: buildCodexSessionSlackInfo(logs),
    });
    logger.info(`AgentTask ${taskId}: Slack notification sent`);
  } catch (error) {
    logger.warn(`AgentTask ${taskId}: Failed to send Slack notification for status=${status}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildCodexSessionSlackInfo(
  logs: OpencodeCapturedLogs | null | undefined
): AgentTaskSlackNotification["codexSession"] {
  if (!logs) {
    return undefined;
  }

  const tokenUsage = extractCodexTokenUsage(logs.codexSessionExport);
  if (!logs.codexSessionId && !logs.codexSessionFilePath && !tokenUsage) {
    return undefined;
  }

  return {
    ...(logs.codexSessionId ? { sessionId: logs.codexSessionId } : {}),
    ...(logs.codexSessionFilePath
      ? { sessionFilePath: logs.codexSessionFilePath }
      : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
  };
}

function extractCodexTokenUsage(
  codexSessionExport: unknown
): NonNullable<AgentTaskSlackNotification["codexSession"]>["tokenUsage"] {
  const tokenUsage = asRecord(codexSessionExport)?.tokenUsage;
  const tokenUsageRecord = asRecord(tokenUsage);
  if (!tokenUsageRecord) {
    return undefined;
  }

  const summary = {
    inputTokens: readFiniteNumber(tokenUsageRecord, "inputTokens"),
    cachedInputTokens: readFiniteNumber(tokenUsageRecord, "cachedInputTokens"),
    outputTokens: readFiniteNumber(tokenUsageRecord, "outputTokens"),
    reasoningOutputTokens: readFiniteNumber(tokenUsageRecord, "reasoningOutputTokens"),
    totalTokens: readFiniteNumber(tokenUsageRecord, "totalTokens"),
    modelContextWindow: readFiniteNumber(tokenUsageRecord, "modelContextWindow"),
  };

  return Object.values(summary).some((value) => value !== undefined)
    ? summary
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readFiniteNumber(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

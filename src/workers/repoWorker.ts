import { Worker, Job } from "bullmq";
import path from "path";
import fs from "fs";
import { getDatabase, type DatabaseClient } from "../db/database";
import { JobRepository } from "../db/repository";
import type { PullRequestCompletionMode, TaskInfoResponse } from "../types";
import { processRepository } from "../services/repoProcessor";
import * as githubApi from "../services/githubApi";
import { QUEUE_NAME } from "../services/queue";
import { sendAgentTaskFinishedSlackNotification } from "../services/slack";
import { createLogger } from "../utils/logger";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);
const DEFAULT_AGENT_TASK_POLL_INTERVAL_MS = 5_000;
const DEFAULT_AGENT_TASK_MAX_POLL_DURATION_MS = 30 * 60 * 1_000;

const TMP_DIR = process.env.TMP_DIR || "tmp";
const logger = createLogger("repo-worker");
type AgentTaskLogLevel = "debug" | "info" | "warn" | "error";

type AgentTaskLogContext = {
  jobId: string;
  owner: string;
  repoName: string;
  taskId: string;
};

export async function createWorker(db?: DatabaseClient): Promise<Worker> {
  const database = db ?? (await getDatabase());
  const repo = new JobRepository(database);
  logger.info("Worker connected to database, ready to process jobs.");

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name === "create-agent-task") {
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
    },
    {
      connection: {
        host: REDIS_HOST,
        port: REDIS_PORT,
        maxRetriesPerRequest: null,
      },
      concurrency: 2,
    }
  );

  return worker;
}

async function handleAgentTaskJob(job: Job, repo: JobRepository): Promise<void> {
  const { jobId, owner, repoName, taskId, pullRequestCompletionMode } = job.data as {
    jobId: string;
    owner: string;
    repoName: string;
    taskId: string;
    pullRequestCompletionMode?: PullRequestCompletionMode;
  };

  const logContext: AgentTaskLogContext = { jobId, owner, repoName, taskId };
  logAgentTask("info", logContext, "started monitoring", {
    queueJobId: job.id ?? null,
    pullRequestCompletionMode: pullRequestCompletionMode ?? "None",
  });
  const startedAt = Date.now();
  const taskCreatedAt = typeof job.timestamp === "number" ? job.timestamp : startedAt;
  let lastKnownBranchName: string | null = null;
  let pollCount = 0;

  try {
    await repo.updateAgentTaskJobStatus(jobId, "active");
    logAgentTask("debug", logContext, "marked job active");

    const authorizationHeader =
      await githubApi.fetchCopilotAuthorizationHeader();
    logAgentTask("debug", logContext, "acquired copilot authorization");

    while (true) {
      pollCount += 1;
      const taskInfo = await githubApi.getTask(
        owner,
        repoName,
        taskId,
        authorizationHeader
      );
      const taskState = getTaskState(taskInfo);
      const branchName = getTaskBranchName(taskInfo);
      if (branchName) {
        lastKnownBranchName = branchName;
      }
      await repo.updateAgentTaskStatus(jobId, taskState, branchName);
      logAgentTask("info", logContext, "observed state", {
        poll: pollCount,
        state: taskState,
        branch: branchName ?? lastKnownBranchName,
        elapsedMs: Date.now() - taskCreatedAt,
      });

      if (!isTerminalTaskState(taskState)) {
        if (Date.now() - startedAt >= getAgentTaskMaxPollDurationMs()) {
          const message = "Agent task monitoring timed out before reaching a terminal state.";
          await repo.updateAgentTaskStatus(jobId, "timeout");
          await repo.updateAgentTaskJobStatus(jobId, "failed", message);
          await sendTerminalTaskNotification(
            owner,
            repoName,
            taskId,
            "timeout",
            lastKnownBranchName,
            Date.now() - taskCreatedAt,
            [],
            message
          );
          logAgentTask("warn", logContext, "timed out before terminal state", {
            poll: pollCount,
            state: taskState,
            branch: lastKnownBranchName,
            elapsedMs: Date.now() - taskCreatedAt,
          });
          return;
        }

        await wait(getAgentTaskPollIntervalMs());
        continue;
      }

      if (taskState.toLowerCase() === "completed") {
        if (pullRequestCompletionMode && pullRequestCompletionMode !== "None") {
          logAgentTask("info", logContext, "running pull request completion mode", {
            mode: pullRequestCompletionMode,
            branch: lastKnownBranchName,
          });
        }
        const pullRequestActions = await runPullRequestCompletionMode(
          `${owner}/${repoName}`,
          lastKnownBranchName,
          pullRequestCompletionMode
        );
        await repo.updateAgentTaskJobStatus(jobId, "completed");
        await sendTerminalTaskNotification(
          owner,
          repoName,
          taskId,
          taskState,
          lastKnownBranchName,
          Date.now() - taskCreatedAt,
          pullRequestActions
        );
        logAgentTask("info", logContext, "completed successfully", {
          state: taskState,
          branch: lastKnownBranchName,
          elapsedMs: Date.now() - taskCreatedAt,
          pullRequestActions: summarizePullRequestActions(pullRequestActions),
        });
        return;
      }

      const message = `Agent task finished with state '${taskState}'.`;
      await repo.updateAgentTaskJobStatus(jobId, "failed", message);
      await sendTerminalTaskNotification(
        owner,
        repoName,
        taskId,
        taskState,
        lastKnownBranchName,
        Date.now() - taskCreatedAt,
        [],
        message
      );
      logAgentTask("warn", logContext, "finished with non-success terminal state", {
        poll: pollCount,
        state: taskState,
        branch: lastKnownBranchName,
        elapsedMs: Date.now() - taskCreatedAt,
      });
      return;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logAgentTask("error", logContext, "failed unexpectedly", {
      branch: lastKnownBranchName,
      elapsedMs: Date.now() - taskCreatedAt,
      error: message,
    });
    await repo.updateAgentTaskJobStatus(jobId, "failed", message);
    await sendTerminalTaskNotification(
      owner,
      repoName,
      taskId,
      "failed",
      lastKnownBranchName,
      Date.now() - taskCreatedAt,
      [],
      message
    );
    throw err;
  }
}

function logAgentTask(
  level: AgentTaskLogLevel,
  context: AgentTaskLogContext,
  message: string,
  details: Record<string, string | number | boolean | null | undefined> = {}
): void {
  const serializedDetails = Object.entries(details)
    .filter(
      (
        entry
      ): entry is [string, string | number | boolean | null] => entry[1] !== undefined
    )
    .map(([key, value]) => `${key}=${formatAgentTaskLogValue(value)}`)
    .join(" ");
  const formattedMessage =
    `AgentTask job=${context.jobId} task=${context.taskId} repo=${context.owner}/${context.repoName}: ${message}` +
    (serializedDetails ? ` ${serializedDetails}` : "");
  logger[level](formattedMessage);
}

function formatAgentTaskLogValue(value: string | number | boolean | null): string {
  if (value === null) {
    return "null";
  }

  return String(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

function summarizePullRequestActions(actions: string[]): string {
  if (actions.length === 0) {
    return "none";
  }

  return actions.join(", ");
}

function getTaskState(taskInfo: TaskInfoResponse): string {
  const state = taskInfo.state;
  return typeof state === "string" && state.trim() ? state.trim() : "unknown";
}

function getTaskBranchName(taskInfo: TaskInfoResponse): string | undefined {
  const topLevelHeadRef = normalizeTaskBranchName(taskInfo.head_ref);
  if (topLevelHeadRef) {
    return topLevelHeadRef;
  }

  if (!Array.isArray(taskInfo.sessions)) {
    return undefined;
  }

  for (let i = taskInfo.sessions.length - 1; i >= 0; i -= 1) {
    const session = taskInfo.sessions[i];
    if (!session || typeof session !== "object") {
      continue;
    }

    const branchName = normalizeTaskBranchName(session.head_ref);
    if (branchName) {
      return branchName;
    }
  }

  return undefined;
}

function normalizeTaskBranchName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return undefined;
  }

  return normalizedValue.startsWith("refs/heads/")
    ? normalizedValue.slice("refs/heads/".length)
    : normalizedValue;
}

async function runPullRequestCompletionMode(
  repo: string,
  branchName: string | null,
  mode?: PullRequestCompletionMode
): Promise<string[]> {
  if (!mode || mode === "None") {
    return [];
  }

  if (!branchName) {
    throw new Error(
      `Unable to locate a pull request for completion mode '${mode}' because the task did not report a branch name.`
    );
  }

  const pullRequest = await githubApi.findOpenPullRequestByHeadBranch(repo, branchName);
  if (!pullRequest) {
    throw new Error(
      `Unable to locate an open pull request for branch '${branchName}' in repository '${repo}'.`
    );
  }

  if (pullRequest.draft) {
    await githubApi.markPullRequestReady(repo, pullRequest.number);
  }

  const actions = pullRequest.draft
    ? [`Marked pull request #${pullRequest.number} ready for review`]
    : [];

  if (mode !== "AutoMerge") {
    return actions;
  }

  try {
    const mergeResult = await githubApi.mergePullRequest(repo, pullRequest.number);
    if (!mergeResult.merged) {
      logger.warn("Pull request was marked ready but not merged", {
        repo,
        branchName,
        pullNumber: pullRequest.number,
        message: mergeResult.message,
      });
      return actions;
    }

    actions.push(`Merged pull request #${pullRequest.number}`);
    await deleteMergedBranch(repo, branchName, pullRequest.number);
    return actions;
  } catch (error) {
    if (
      error instanceof githubApi.GitHubApiError &&
      [405, 409, 422].includes(error.statusCode)
    ) {
      logger.warn("Pull request was marked ready but merge was not possible", {
        repo,
        branchName,
        pullNumber: pullRequest.number,
        statusCode: error.statusCode,
        error: error.message,
      });
      return actions;
    }

    throw error;
  }
}

async function deleteMergedBranch(
  repo: string,
  branchName: string,
  pullNumber: number
): Promise<void> {
  try {
    await githubApi.deleteRemoteBranch(repo, branchName);
  } catch (error) {
    if (
      error instanceof githubApi.GitHubApiError &&
      error.statusCode === 404
    ) {
      logger.info("Merged pull request branch was already deleted", {
        repo,
        branchName,
        pullNumber,
      });
      return;
    }

    logger.warn("Failed to delete merged pull request branch", {
      repo,
      branchName,
      pullNumber,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isTerminalTaskState(state: string): boolean {
  const normalizedState = state.toLowerCase();
  return (
    normalizedState === "completed" ||
    normalizedState === "failed" ||
    normalizedState === "cancelled" ||
    normalizedState === "canceled" ||
    normalizedState === "error"
  );
}

function getAgentTaskPollIntervalMs(): number {
  const rawValue = process.env.AGENT_TASK_POLL_INTERVAL_MS;
  if (!rawValue) {
    return DEFAULT_AGENT_TASK_POLL_INTERVAL_MS;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_AGENT_TASK_POLL_INTERVAL_MS;
  }

  return parsed;
}

function getAgentTaskMaxPollDurationMs(): number {
  const rawValue = process.env.AGENT_TASK_MAX_POLL_DURATION_MS;
  if (!rawValue) {
    return DEFAULT_AGENT_TASK_MAX_POLL_DURATION_MS;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AGENT_TASK_MAX_POLL_DURATION_MS;
  }

  return parsed;
}

async function wait(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTerminalTaskNotification(
  owner: string,
  repoName: string,
  taskId: string,
  status: string,
  branch: string | null,
  durationMs: number,
  pullRequestActions: string[] = [],
  details?: string
): Promise<void> {
  try {
    await sendAgentTaskFinishedSlackNotification({
      owner,
      repoName,
      taskId,
      status,
      branch,
      durationMs,
      pullRequestActions,
      details,
    });
  } catch (error) {
    logger.warn("Failed to send Slack notification for agent task", {
      owner,
      repoName,
      taskId,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

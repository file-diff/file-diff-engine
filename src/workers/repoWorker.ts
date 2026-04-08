import { Worker, Job } from "bullmq";
import path from "path";
import fs from "fs";
import { getDatabase, type DatabaseClient } from "../db/database";
import { JobRepository } from "../db/repository";
import type { TaskInfoResponse } from "../types";
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
  const { jobId, owner, repoName, taskId } = job.data as {
    jobId: string;
    owner: string;
    repoName: string;
    taskId: string;
  };

  logger.debug("Agent task job started", { jobId, owner, repoName, taskId });

  try {
    const startedAt = Date.now();
    const taskCreatedAt = typeof job.timestamp === "number" ? job.timestamp : startedAt;
    let lastKnownBranchName: string | null = null;
    await repo.updateAgentTaskJobStatus(jobId, "active");

    const authorizationHeader =
      await githubApi.fetchCopilotAuthorizationHeader();

    while (true) {
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

      if (!isTerminalTaskState(taskState)) {
        if (Date.now() - startedAt >= getAgentTaskMaxPollDurationMs()) {
          const message = "Agent task monitoring timed out before reaching a terminal state.";
          await repo.updateAgentTaskStatus(jobId, "timeout");
          await repo.updateAgentTaskJobStatus(jobId, "failed", message);
          logger.warn("Agent task monitoring timed out", {
            jobId,
            taskId,
            taskState,
          });
          return;
        }

        await wait(getAgentTaskPollIntervalMs());
        continue;
      }

      if (taskState.toLowerCase() === "completed") {
        await repo.updateAgentTaskJobStatus(jobId, "completed");
        await sendTerminalTaskNotification(
          owner,
          repoName,
          taskId,
          taskState,
          lastKnownBranchName,
          Date.now() - taskCreatedAt
        );
        logger.info("Agent task completed", {
          jobId,
          taskId,
          taskState,
        });
        logger.info("TODO: trigger follow-up action for completed agent task", {
          jobId,
          taskId,
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
        Date.now() - taskCreatedAt
      );
      logger.warn("Agent task completed with non-success terminal state", {
        jobId,
        taskId,
        taskState,
      });
      return;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Agent task job failed", { jobId, owner, repoName, error: message });
    await repo.updateAgentTaskJobStatus(jobId, "failed", message);
    throw err;
  }
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
  durationMs: number
): Promise<void> {
  try {
    await sendAgentTaskFinishedSlackNotification({
      owner,
      repoName,
      taskId,
      status,
      branch,
      durationMs,
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

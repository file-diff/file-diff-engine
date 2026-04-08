import { Worker, Job } from "bullmq";
import path from "path";
import fs from "fs";
import { getDatabase, type DatabaseClient } from "../db/database";
import { JobRepository } from "../db/repository";
import type { TaskInfoResponse } from "../types";
import { processRepository } from "../services/repoProcessor";
import * as githubApi from "../services/githubApi";
import { QUEUE_NAME } from "../services/queue";
import { createLogger } from "../utils/logger";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);
const DEFAULT_AGENT_TASK_POLL_INTERVAL_MS = 5_000;

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
  const { jobId, owner, repoName, body } = job.data as {
    jobId: string;
    owner: string;
    repoName: string;
    body: Record<string, unknown>;
  };

  logger.debug("Agent task job started", { jobId, owner, repoName });

  try {
    await repo.updateAgentTaskJobStatus(jobId, "active");

    const authorizationHeader =
      await githubApi.fetchCopilotAuthorizationHeader();
    const createdTask = await githubApi.createTask(
      owner,
      repoName,
      body,
      authorizationHeader
    );

    await repo.attachAgentTaskToJob(jobId, createdTask.id, "queued");

    while (true) {
      const taskInfo = await githubApi.getTask(
        owner,
        repoName,
        createdTask.id,
        authorizationHeader
      );
      const taskState = getTaskState(taskInfo);
      await repo.updateAgentTaskStatus(jobId, taskState);

      if (!isTerminalTaskState(taskState)) {
        await wait(getAgentTaskPollIntervalMs());
        continue;
      }

      if (taskState.toLowerCase() === "completed") {
        await repo.updateAgentTaskJobStatus(jobId, "completed");
        logger.info("Agent task completed", {
          jobId,
          taskId: createdTask.id,
          taskState,
        });
        logger.info("TODO: trigger follow-up action for completed agent task", {
          jobId,
          taskId: createdTask.id,
        });
        return;
      }

      const message = `Agent task finished with state '${taskState}'.`;
      await repo.updateAgentTaskJobStatus(jobId, "failed", message);
      logger.warn("Agent task completed with non-success terminal state", {
        jobId,
        taskId: createdTask.id,
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

async function wait(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

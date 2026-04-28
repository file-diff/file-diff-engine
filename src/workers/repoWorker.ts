import { Worker, Job } from "bullmq";
import path from "path";
import fs from "fs";
import { getDatabase, type DatabaseClient } from "../db/database";
import { JobRepository } from "../db/repository";
import type { AgentTaskModel } from "../types";
import { processRepository } from "../services/repoProcessor";
import {
  executeOpencodeOnPreparedBranch,
  prepareOpencodeTaskBranch,
} from "../services/opencodeTask";
import { QUEUE_NAME } from "../services/queue";
import { sendAgentTaskFinishedSlackNotification } from "../services/slack";
import { createLogger } from "../utils/logger";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);

const TMP_DIR = process.env.TMP_DIR || "tmp";
const logger = createLogger("repo-worker");

interface OpencodeCapturedLogs {
  output: string;
  stdout: string;
  stderr: string;
}

export async function createWorker(db?: DatabaseClient): Promise<Worker> {
  const database = db ?? (await getDatabase());
  const repo = new JobRepository(database);
  logger.info("Worker connected to database, ready to process jobs.");

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name === "create-opencode-task") {
        await handleOpencodeTaskJob(job, repo);
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

async function handleOpencodeTaskJob(job: Job, repo: JobRepository): Promise<void> {
  const {
    jobId,
    repoName,
    baseRef,
    problemStatement,
    model,
    githubKey,
    deepseekApiKey,
  } = job.data as {
    jobId: string;
    repoName: string;
    baseRef: string;
    problemStatement: string;
    model: AgentTaskModel;
    githubKey?: string;
    deepseekApiKey?: string;
  };

  const tag = `OpencodeTask ${jobId}:`;
  logger.info(`${tag} Started processing repo=${repoName} base=${baseRef} model=${model}`);
  const startedAt = Date.now();
  const taskCreatedAt = typeof job.timestamp === "number" ? job.timestamp : startedAt;
  let lastKnownBranchName: string | null = null;
  let lastCapturedLogs: OpencodeCapturedLogs | null = null;
  const [owner, repoNameOnly] = splitRepoName(repoName);

  try {
    const existingJob = await repo.getAgentTaskJob(jobId);
    if (existingJob?.status === "canceled") {
      logger.info(`${tag} Skipping canceled task job`);
      return;
    }

    await repo.updateAgentTaskJobStatus(jobId, "active");
    await repo.updateAgentTaskStatus(jobId, "preparing");

    const taskOptions = {
      jobId,
      repo: repoName,
      baseRef,
      problemStatement,
      model,
      githubKey,
      deepseekApiKey,
    };
    const prepared = await prepareOpencodeTaskBranch(taskOptions);
    lastKnownBranchName = prepared.branch;

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
    const runPreparedBranch = executeOpencodeOnPreparedBranch as unknown as ((
      options: typeof taskOptions,
      branch: string,
      callbacks?: {
        onLogsUpdated?: (logs: OpencodeCapturedLogs) => Promise<void> | void;
      }
    ) => Promise<OpencodeCapturedLogs>);
    const logs = await runPreparedBranch(
      taskOptions,
      prepared.branch,
      { onLogsUpdated: persistLogs }
    );
    lastCapturedLogs = logs;
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
      Date.now() - taskCreatedAt
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const logs = isOpencodeExecutionError(err) ? err.logs : lastCapturedLogs;
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
      message
    );
    throw err;
  }
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
    typeof logs.stderr === "string"
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
  details?: string
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
      pullRequestActions: [],
      details,
    });
    logger.info(`AgentTask ${taskId}: Slack notification sent`);
  } catch (error) {
    logger.warn(`AgentTask ${taskId}: Failed to send Slack notification for status=${status}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

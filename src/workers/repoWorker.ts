import { Worker, Job } from "bullmq";
import path from "path";
import fs from "fs";
import { getDatabase, type DatabaseClient } from "../db/database";
import { JobRepository } from "../db/repository";
import type { PullRequestCompletionMode, TaskInfoResponse } from "../types";
import { processRepository } from "../services/repoProcessor";
import * as githubApi from "../services/githubApi";
import { runOpenCodeAgent } from "../services/opencodeAgent";
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

      if (job.name === "create-opencode-task") {
        await handleOpenCodeTaskJob(job, repo);
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
  const { jobId, owner, repoName, taskId, createTaskBody, pullRequestCompletionMode } = job.data as {
    jobId: string;
    owner: string;
    repoName: string;
    taskId?: string;
    createTaskBody?: Record<string, unknown>;
    pullRequestCompletionMode?: PullRequestCompletionMode;
  };

  const tag = `AgentTask ${jobId}:`;
  logger.info(`${tag} Started processing repo=${owner}/${repoName}`);
  const startedAt = Date.now();
  const taskCreatedAt = typeof job.timestamp === "number" ? job.timestamp : startedAt;
  let lastKnownBranchName: string | null = null;
  let pollCount = 0;
  let githubTaskId = taskId;

  try {
    const existingJob = await repo.getAgentTaskJob(jobId);
    if (existingJob?.status === "canceled") {
      logger.info(`${tag} Skipping canceled task job`);
      return;
    }

    await repo.updateAgentTaskJobStatus(jobId, "active");
    logger.info(`${tag} Job status set to active`);

    const authorizationHeader =
      await githubApi.fetchCopilotAuthorizationHeader();
    logger.info(`${tag} Copilot authorization header obtained`);

    if (!githubTaskId) {
      if (!createTaskBody) {
        throw new Error("Agent task job payload is missing createTaskBody.");
      }

      const createTaskResult = await githubApi.createTask(
        owner,
        repoName,
        createTaskBody,
        authorizationHeader
      );
      githubTaskId = createTaskResult.id;
      await repo.attachAgentTaskToJob(jobId, githubTaskId, "queued");
      logger.info(`${tag} Created remote task=${githubTaskId}`);
    }

    while (true) {
      pollCount += 1;
      const taskInfo = await githubApi.getTask(
        owner,
        repoName,
        githubTaskId,
        authorizationHeader
      );
      const taskState = getTaskState(taskInfo);
      const branchName = getTaskBranchName(taskInfo);
      if (branchName) {
        lastKnownBranchName = branchName;
      }
      logger.info(`${tag} Poll #${pollCount} state=${taskState} branch=${branchName ?? "none"}`);
      await repo.updateAgentTaskStatus(jobId, taskState, branchName);

      if (!isTerminalTaskState(taskState)) {
        if (Date.now() - startedAt >= getAgentTaskMaxPollDurationMs()) {
          const message = "Agent task monitoring timed out before reaching a terminal state.";
          await repo.updateAgentTaskStatus(jobId, "timeout");
          await repo.updateAgentTaskJobStatus(jobId, "failed", message);
          await sendTerminalTaskNotification(
            owner,
            repoName,
            githubTaskId,
            "timeout",
            lastKnownBranchName,
            Date.now() - taskCreatedAt,
            [],
            message
          );
          logger.warn(`${tag} Monitoring timed out after ${pollCount} polls, last state=${taskState}`);
          return;
        }

        await wait(getAgentTaskPollIntervalMs());
        continue;
      }

      if (taskState.toLowerCase() === "completed") {
        logger.info(`${tag} Task completed successfully, running PR completion mode=${pullRequestCompletionMode ?? "None"}`);

        const token =
          process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
          process.env.PUBLIC_GITHUB_TOKEN?.trim() ||
          undefined;

        if (!token) {
          throw new Error(
            "GitHub token is required to complete pull request. Please set PRIVATE_GITHUB_TOKEN or PUBLIC_GITHUB_TOKEN environment variable.");
        }

        const pullRequestActions = await runPullRequestCompletionMode(
          `${owner}/${repoName}`,
          lastKnownBranchName,
          pullRequestCompletionMode,
          tag,
          token,
          {
            owner,
            repoName,
            taskId: githubTaskId,
            authorizationHeader,
          }
        );
        await repo.updateAgentTaskJobStatus(jobId, "completed");
        await sendTerminalTaskNotification(
          owner,
          repoName,
          githubTaskId,
          taskState,
          lastKnownBranchName,
          Date.now() - taskCreatedAt,
          pullRequestActions
        );
        logger.info(`${tag} Finished successfully after ${pollCount} polls, branch=${lastKnownBranchName ?? "none"}`);
        return;
      }

      const message = `Agent task finished with state '${taskState}'.`;
      await repo.updateAgentTaskJobStatus(jobId, "failed", message);
      await sendTerminalTaskNotification(
        owner,
        repoName,
        githubTaskId,
        taskState,
        lastKnownBranchName,
        Date.now() - taskCreatedAt,
        [],
        message
      );
      logger.warn(`${tag} Finished with non-success terminal state=${taskState} after ${pollCount} polls`);
      return;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error(`${tag} Job failed for repo=${owner}/${repoName}: ${message}`);
    await repo.updateAgentTaskJobStatus(jobId, "failed", message);
    await sendTerminalTaskNotification(
      owner,
      repoName,
      githubTaskId ?? jobId,
      "failed",
      lastKnownBranchName,
      Date.now() - taskCreatedAt,
      [],
      message
    );
    throw err;
  }
}

async function handleOpenCodeTaskJob(job: Job, repo: JobRepository): Promise<void> {
  const { jobId, owner, repoName, prompt, baseRef, model, createPullRequest } = job.data as {
    jobId: string;
    owner: string;
    repoName: string;
    prompt: string;
    baseRef: string;
    model?: string;
    createPullRequest?: boolean;
  };

  const tag = `OpenCodeTask ${jobId}:`;
  logger.info(`${tag} Starting processing repo=${owner}/${repoName}`);

  try {
    await repo.updateAgentTaskJobStatus(jobId, "active");

    const workDir = path.join(process.env.TMP_DIR || "tmp", "opencode-tasks", jobId);
    const result = await runOpenCodeAgent({
      owner,
      repoName,
      baseRef,
      prompt,
      model,
      createPullRequest,
      workDir,
    });

    await repo.attachAgentTaskToJob(jobId, result.commitHash, "completed", result.branchName);
    await repo.updateAgentTaskJobStatus(jobId, "completed");
    logger.info(`${tag} Finished successfully branch=${result.branchName} commit=${result.commitShort}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error(`${tag} Job failed: ${message}`);
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

async function runPullRequestCompletionMode(
  repo: string,
  branchName: string | null,
  mode: PullRequestCompletionMode | undefined,
  tag: string,
  token: string,
  taskContext: {
    owner: string;
    repoName: string;
    taskId: string;
    authorizationHeader: string;
  }
): Promise<string[]> {
  const prefix = tag;
  if (!mode || mode === "None") {
    logger.info(`${prefix} PR completion mode=None, skipping`);
    return [];
  }

  if (!branchName) {
    throw new Error(
      `Unable to locate a pull request for completion mode '${mode}' because the task did not report a branch name.`
    );
  }

  logger.info(`${prefix} Looking up open PR for branch=${branchName} in repo=${repo}`);
  const pullRequest = await githubApi.findOpenPullRequestByHeadBranch(repo, branchName);
  if (!pullRequest) {
    throw new Error(
      `Unable to locate an open pull request for branch '${branchName}' in repository '${repo}'.`
    );
  }

  logger.info(`${prefix} Found PR #${pullRequest.number} draft=${pullRequest.draft}`);

  if (pullRequest.draft) {
    logger.info(`${prefix} Marking PR #${pullRequest.number} ready for review`);
    await githubApi.markPullRequestReady(repo, pullRequest.number, token);
  }

  const actions = pullRequest.draft
    ? [`Marked pull request #${pullRequest.number} ready for review`]
    : [];

  if (mode !== "AutoMerge") {
    logger.info(`${prefix} PR completion mode=${mode}, done`);
    return actions;
  }

  try {
    const mergeResult = await githubApi.mergePullRequest(repo, pullRequest.number, {
      token
    });
    if (!mergeResult.merged) {
      logger.warn(`${prefix} PR #${pullRequest.number} was not merged: ${mergeResult.message}`);
      return actions;
    }

    logger.info(`${prefix} PR #${pullRequest.number} merged successfully`);
    actions.push(
      pullRequest.baseBranch
        ? `Merged pull request #${pullRequest.number}, target branch: ${pullRequest.baseBranch}`
        : `Merged pull request #${pullRequest.number}`
    );
    await deleteMergedBranch(repo, branchName, pullRequest.number, token, prefix);
    await archiveCompletedTask(
      taskContext.owner,
      taskContext.repoName,
      taskContext.taskId,
      taskContext.authorizationHeader,
      prefix
    );
    return actions;
  } catch (error) {
    if (
      error instanceof githubApi.GitHubApiError &&
      [405, 409, 422].includes(error.statusCode)
    ) {
      logger.warn(`${prefix} PR #${pullRequest.number} merge not possible, status=${error.statusCode}: ${error.message}`);
      return actions;
    }

    throw error;
  }
}

async function archiveCompletedTask(
  owner: string,
  repoName: string,
  taskId: string,
  authorizationHeader: string,
  tag: string
): Promise<void> {
  const prefix = tag;
  try {
    logger.info(`${prefix} Archiving completed task=${taskId} for repo=${owner}/${repoName}`);
    await githubApi.archiveTask(owner, repoName, taskId, authorizationHeader);
  } catch (error) {
    if (
      error instanceof githubApi.GitHubApiError &&
      error.statusCode === 404
    ) {
      logger.info(`${prefix} Completed task=${taskId} already archived or not found for repo=${owner}/${repoName}`);
      return;
    }

    logger.warn(`${prefix} Failed to archive completed task=${taskId} for repo=${owner}/${repoName}; no automatic retry is scheduled: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function deleteMergedBranch(
  repo: string,
  branchName: string,
  pullNumber: number,
  token: string,
  tag: string
): Promise<void> {
  const prefix = tag;
  try {
    logger.info(`${prefix} Deleting merged branch=${branchName} for PR #${pullNumber}`);
    await githubApi.deleteRemoteBranch(repo, branchName, token);
  } catch (error) {
    if (
      error instanceof githubApi.GitHubApiError &&
      error.statusCode === 404
    ) {
      logger.info(`${prefix} Merged branch=${branchName} already deleted for PR #${pullNumber}`);
      return;
    }

    logger.warn(`${prefix} Failed to delete branch=${branchName} for PR #${pullNumber}: ${error instanceof Error ? error.message : String(error)}`);
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
    logger.info(`AgentTask ${taskId}: Sending Slack notification status=${status} branch=${branch ?? "none"} duration=${Math.round(durationMs / 1000)}s`);
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
    logger.info(`AgentTask ${taskId}: Slack notification sent`);
  } catch (error) {
    logger.warn(`AgentTask ${taskId}: Failed to send Slack notification for status=${status}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

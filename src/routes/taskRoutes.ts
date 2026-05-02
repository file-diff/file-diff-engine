import rateLimit from "@fastify/rate-limit";
import type { Queue } from "bullmq";
import type { FastifyPluginAsync } from "fastify";
import { JobRepository } from "../db/repository";
import type { AgentTaskJobInfo, ErrorResponse } from "../types";
import { deleteAgentTaskJob } from "../services/agentTaskActions";
import { createLogger } from "../utils/logger";
import {
  isValidRepo,
  requireAdminBearerToken,
} from "./jobs/shared";

const TASK_ROUTE_RATE_LIMIT_MAX = 60;
const TASK_ROUTE_RATE_LIMIT_WINDOW_MS = 60_000;

const logger = createLogger("task-routes");

/**
 * Routes for inspecting locally-managed agent task jobs (Codex/opencode/Claude based).
 *
 * The legacy GitHub Copilot remote-task endpoints have been removed; these routes
 * now read from the local `agent_task_jobs` table via {@link JobRepository}.
 */
export function createTaskRoutes(
  jobRepo: JobRepository,
  queue: Queue
): FastifyPluginAsync {
  return async function registerTaskRoutes(app) {
    await app.register(rateLimit, { global: false });

    /**
     * GET /agents/repos/:owner/:repo/tasks
     * Lists currently active (waiting or active) agent task jobs for a repository.
     */
    app.get<{
      Params: {
        owner: string;
        repo: string;
      };
    }>(
      "/agents/repos/:owner/:repo/tasks",
      {
        preHandler: [
          requireAdminBearerToken,
          app.rateLimit({
            max: TASK_ROUTE_RATE_LIMIT_MAX,
            timeWindow: TASK_ROUTE_RATE_LIMIT_WINDOW_MS,
          }),
        ],
      },
      async (request, reply) => {
        const { owner, repo } = request.params;
        const fullRepo = `${owner}/${repo}`;

        if (!isValidRepo(fullRepo)) {
          const response: ErrorResponse = {
            error:
              "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
          };
          return reply.code(400).send(response);
        }

        logger.info("Listing active agent task jobs for repo", { owner, repo });

        try {
          const tasks = await jobRepo.listActiveAgentTaskJobs(fullRepo);
          return reply.code(200).send(tasks satisfies AgentTaskJobInfo[]);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unable to list tasks.";
          const response: ErrorResponse = { error: message };
          return reply.code(500).send(response);
        }
      }
    );

    /**
     * GET /agents/tasks
     * Lists currently active (waiting or active) agent task jobs across all repositories.
     */
    app.get(
      "/agents/tasks",
      {
        preHandler: [
          requireAdminBearerToken,
          app.rateLimit({
            max: TASK_ROUTE_RATE_LIMIT_MAX,
            timeWindow: TASK_ROUTE_RATE_LIMIT_WINDOW_MS,
          }),
        ],
      },
      async (_request, reply) => {
        logger.info("Listing all active agent task jobs");

        try {
          const tasks = await jobRepo.listActiveAgentTaskJobs();
          return reply.code(200).send(tasks satisfies AgentTaskJobInfo[]);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unable to list tasks.";
          const response: ErrorResponse = { error: message };
          return reply.code(500).send(response);
        }
      }
    );

    /**
     * GET /agents/repos/:owner/:repo/tasks/:task_id
     * Returns the details of a single agent task job (looked up by job id).
     */
    app.get<{
      Params: {
        owner: string;
        repo: string;
        task_id: string;
      };
    }>(
      "/agents/repos/:owner/:repo/tasks/:task_id",
      {
        preHandler: [
          requireAdminBearerToken,
          app.rateLimit({
            max: TASK_ROUTE_RATE_LIMIT_MAX,
            timeWindow: TASK_ROUTE_RATE_LIMIT_WINDOW_MS,
          }),
        ],
      },
      async (request, reply) => {
        const { owner, repo, task_id: rawTaskId } = request.params;
        const taskId = rawTaskId.trim();
        if (!taskId) {
          const response: ErrorResponse = { error: "Task id is required." };
          return reply.code(400).send(response);
        }

        const fullRepo = `${owner}/${repo}`;
        if (!isValidRepo(fullRepo)) {
          const response: ErrorResponse = {
            error:
              "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
          };
          return reply.code(400).send(response);
        }

        try {
          const job = await jobRepo.getAgentTaskJobByIdOrCodexSessionId(taskId);
          if (!job || job.repo !== fullRepo) {
            const response: ErrorResponse = {
              error: `Agent task job '${taskId}' was not found in repository '${fullRepo}'.`,
            };
            return reply.code(404).send(response);
          }
          return reply.code(200).send(job satisfies AgentTaskJobInfo);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unable to get task info.";
          const response: ErrorResponse = { error: message };
          return reply.code(500).send(response);
        }
      }
    );

    /**
     * DELETE /agents/repos/:owner/:repo/tasks/:task_id
     * Soft-deletes a task job. Waiting/running jobs are canceled first.
     */
    app.delete<{
      Params: {
        owner: string;
        repo: string;
        task_id: string;
      };
    }>(
      "/agents/repos/:owner/:repo/tasks/:task_id",
      {
        preHandler: [
          requireAdminBearerToken,
          app.rateLimit({
            max: TASK_ROUTE_RATE_LIMIT_MAX,
            timeWindow: TASK_ROUTE_RATE_LIMIT_WINDOW_MS,
          }),
        ],
      },
      async (request, reply) => {
        const { owner, repo, task_id: rawTaskId } = request.params;
        const taskId = rawTaskId.trim();
        if (!taskId) {
          const response: ErrorResponse = { error: "Task id is required." };
          return reply.code(400).send(response);
        }

        const fullRepo = `${owner}/${repo}`;
        if (!isValidRepo(fullRepo)) {
          const response: ErrorResponse = {
            error:
              "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
          };
          return reply.code(400).send(response);
        }

        const existingJob = await jobRepo.getAgentTaskJob(taskId);
        if (!existingJob || existingJob.repo !== fullRepo) {
          const response: ErrorResponse = {
            error: `Agent task job '${taskId}' was not found in repository '${fullRepo}'.`,
          };
          return reply.code(404).send(response);
        }

        try {
          const updatedJob = await deleteAgentTaskJob(jobRepo, queue, taskId);
          if (!updatedJob) {
            const response: ErrorResponse = {
              error: `Agent task job '${taskId}' was not found in repository '${fullRepo}'.`,
            };
            return reply.code(404).send(response);
          }

          return reply.code(200).send(updatedJob satisfies AgentTaskJobInfo);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unable to delete task.";
          const response: ErrorResponse = { error: message };
          return reply.code(500).send(response);
        }
      }
    );
  };
}

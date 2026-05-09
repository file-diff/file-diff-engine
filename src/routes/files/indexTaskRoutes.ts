import type { FastifyInstance } from "fastify";
import { JobRepository, AmbiguousHashError } from "../../db/repository";
import * as repoProcessor from "../../services/repoProcessor";
import type { ManagedQueue } from "../../services/queue";
import type {
  ErrorResponse,
  IndexFilesTaskRequest,
  JobFilesResponse,
  JobSummary,
} from "../../types";
import { getCommitShort } from "../../utils/commit";
import {
  isValidRepo,
  logger,
  normalizeRepo,
  POSTGRES_UNIQUE_VIOLATION,
  requireViewerBearerToken,
} from "../jobs/shared";

const FULL_COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export function registerIndexTaskRoutes(
  app: FastifyInstance,
  queue: ManagedQueue,
  jobRepo: JobRepository
): void {
  /**
   * POST /api/files/index-task
   * Creates a background file indexing task for one repository ref.
   */
  app.post<{ Body: IndexFilesTaskRequest }>(
    "/index-task",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
      let { repo, ref, commit } = request.body ?? {};
      if (!repo || (!ref && !commit)) {
        const response: ErrorResponse = {
          error: "Field 'repo' and one of 'ref' or 'commit' are required.",
        };
        return reply.code(400).send(response);
      }

      repo = normalizeRepo(repo);
      ref = ref?.trim();
      commit = commit?.trim().toLowerCase();

      if (!isValidRepo(repo)) {
        const response: ErrorResponse = {
          error:
            "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
        };
        return reply.code(400).send(response);
      }

      if (commit !== undefined && !FULL_COMMIT_SHA_PATTERN.test(commit)) {
        const response: ErrorResponse = {
          error:
            "Field 'commit' must be a full 40-character hexadecimal commit SHA.",
        };
        return reply.code(400).send(response);
      }

      if (ref !== undefined && !ref) {
        const response: ErrorResponse = {
          error: "Field 'ref' must be a non-empty git ref string.",
        };
        return reply.code(400).send(response);
      }

      let resolvedCommit = commit;
      if (!resolvedCommit) {
        try {
          resolvedCommit = await repoProcessor.resolveRefToCommitHash(
            repoProcessor.getRepositoryUrl(repo),
            ref ?? ""
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unable to resolve git ref.";
          const response: ErrorResponse = { error: message };
          const statusCode =
            message === "Git ref is required."
              ? 400
              : message.startsWith("Unable to resolve git ref")
                ? 404
                : 500;
          return reply.code(statusCode).send(response);
        }
      }

      return enqueueIndexTask(reply, queue, jobRepo, repo, resolvedCommit);
    }
  );

  /**
   * GET /api/files/index-task/:id
   * Returns index task status and progress.
   */
  app.get<{ Params: { id: string } }>(
    "/index-task/:id",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
      const job = await getJobById(jobRepo, request.params.id, reply);
      if (!job) {
        return;
      }

      return reply.send(job);
    }
  );

  /**
   * GET /api/files/index-task/:id/files
   * Returns processed file metadata for an index task.
   */
  app.get<{ Params: { id: string } }>(
    "/index-task/:id/files",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
      const job = await getJobById(jobRepo, request.params.id, reply);
      if (!job) {
        return;
      }

      const files = await jobRepo.getFiles(job.id);
      const response: JobFilesResponse = {
        jobId: job.id,
        commit: job.commit,
        commitShort: job.commitShort,
        status: job.status,
        progress: job.progress,
        files: files.map((file) => ({
          t: file.file_type,
          path: file.file_name,
          s: file.file_size,
          update: file.file_update_date,
          commit: file.file_last_commit,
          hash: file.file_git_hash,
        })),
      };
      return reply.send(response);
    }
  );
}

async function enqueueIndexTask(
  reply: {
    code(statusCode: number): {
      send(payload: unknown): unknown;
    };
  },
  queue: ManagedQueue,
  jobRepo: JobRepository,
  repo: string,
  commit: string
): Promise<unknown> {
  const jobId = commit;
  const existingJob = await jobRepo.getJob(jobId);
  if (existingJob) {
    if (existingJob.status === "failed") {
      await jobRepo.resetJobForRetry(jobId);
      await removeQueuedJob(queue, jobId);
      try {
        await enqueueJob(queue, existingJob.id, existingJob.repo, existingJob.commit, {
          bullJobId: `${existingJob.id}-retry-${Date.now()}`,
        });
      } catch (error) {
        await markEnqueueFailure(jobRepo, existingJob.id, error);
        throw error;
      }

      const response: JobSummary = {
        id: existingJob.id,
        status: "waiting",
        commit: existingJob.commit,
        commitShort: existingJob.commitShort,
      };
      return reply.code(200).send(response);
    }

    const response: JobSummary = {
      id: existingJob.id,
      status: existingJob.status,
      commit: existingJob.commit,
      commitShort: existingJob.commitShort,
    };
    return reply.code(200).send(response);
  }

  try {
    await jobRepo.createJob(jobId, repo, commit);
  } catch (error: unknown) {
    if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
      const duplicateJob = await jobRepo.getJob(jobId);
      if (duplicateJob) {
        const response: JobSummary = {
          id: duplicateJob.id,
          status: duplicateJob.status,
          commit: duplicateJob.commit,
          commitShort: duplicateJob.commitShort,
        };
        return reply.code(200).send(response);
      }
    }

    throw error;
  }

  try {
    await enqueueJob(queue, jobId, repo, commit);
  } catch (error) {
    await markEnqueueFailure(jobRepo, jobId, error);
    throw error;
  }

  const response: JobSummary = {
    id: jobId,
    status: "waiting",
    commit,
    commitShort: getCommitShort(commit),
  };
  return reply.code(201).send(response);
}

async function enqueueJob(
  queue: ManagedQueue,
  jobId: string,
  repoName: string,
  commit: string,
  options: { bullJobId?: string } = {}
): Promise<void> {
  await queue.add(
    "process-repo",
    {
      jobId,
      repoName,
      commit,
    },
    {
      jobId: options.bullJobId ?? jobId,
    }
  );
}

async function getJobById(
  jobRepo: JobRepository,
  id: string,
  reply: {
    code(statusCode: number): {
      send(payload: unknown): unknown;
    };
  }
) {
  try {
    const job = await jobRepo.getJob(id);
    if (!job) {
      const response: ErrorResponse = { error: "Index task not found." };
      reply.code(404).send(response);
      return null;
    }

    return job;
  } catch (error) {
    if (error instanceof AmbiguousHashError) {
      const response: ErrorResponse = { error: error.message };
      reply.code(400).send(response);
      return null;
    }
    throw error;
  }
}

async function markEnqueueFailure(
  jobRepo: JobRepository,
  jobId: string,
  error: unknown
): Promise<void> {
  const reason =
    error instanceof Error ? error.message : "Unknown enqueue failure";
  try {
    await jobRepo.updateJobStatus(jobId, "failed", `Failed to enqueue index task: ${reason}`);
  } catch (rollbackError) {
    logger.error(
      `Failed to mark index task ${jobId} as failed after enqueue error: ${
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      }`
    );
  }
}

async function removeQueuedJob(
  queue: ManagedQueue,
  jobId: string
): Promise<void> {
  let queuedJob;
  try {
    queuedJob = await queue.getJob(jobId, "process-repo");
  } catch (error) {
    logger.warn(
      `Failed to look up queued index task ${jobId} during retry; proceeding with enqueue: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return;
  }

  if (!queuedJob) {
    return;
  }

  try {
    await queuedJob.remove();
  } catch (error) {
    logger.warn(
      `Failed to remove queued index task ${jobId} before retry; proceeding with fresh enqueue: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

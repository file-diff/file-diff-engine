import type { FastifyInstance } from "fastify";
import { JobRepository, AmbiguousHashError } from "../../db/repository";
import type { ManagedQueue } from "../../services/queue";
import type {
  ErrorResponse,
  JobFilesResponse,
  JobRequest,
  JobSummary,
} from "../../types";
import { getCommitShort } from "../../utils/commit";
import {
  isValidRepo,
  logger,
  normalizeRepo,
  POSTGRES_UNIQUE_VIOLATION,
  requireViewerBearerToken,
} from "./shared";

export function registerJobManagementRoutes(
  app: FastifyInstance,
  queue: ManagedQueue,
  jobRepo: JobRepository
): void {
  /**
   * POST /api/jobs
   * Body: { "repo": "owner/repo", "commit": "0123456789abcdef0123456789abcdef01234567" }
   * Creates a new processing job and enqueues it.
   */
  app.post<{ Body: JobRequest }>(
    "/",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
    let { repo, commit } = request.body ?? {};
    if (!repo || !commit) {
      const response: ErrorResponse = {
        error: "Both 'repo' and 'commit' are required.",
      };
      return reply.code(400).send(response);
    }

    repo = normalizeRepo(repo);
    commit = commit.trim().toLowerCase();

    // Basic validation: repo should look like owner/repo
    if (!isValidRepo(repo)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    if (!/^[a-f0-9]{40}$/.test(commit)) {
      const response: ErrorResponse = {
        error:
          "Invalid commit format. Expected a 40-character hexadecimal commit SHA.",
      };
      return reply.code(400).send(response);
    }

    const jobId = commit;
    const existingJob = await jobRepo.getJob(jobId);
    if (existingJob) {
      if (existingJob.status === "failed") {
        await jobRepo.resetJobForRetry(jobId);
        await removeQueuedJob(queue, jobId);
        // Use a unique BullMQ jobId for retries so the worker always picks
        // up a fresh job even if the prior failed job could not be removed
        // from BullMQ (e.g. stale lock, Redis cleanup race). DB-level
        // dedup on the commit-keyed row prevents duplicate processing.
        try {
          await enqueueJob(
            queue,
            existingJob.id,
            existingJob.repo,
            existingJob.commit,
            { bullJobId: `${existingJob.id}-retry-${Date.now()}` }
          );
        } catch (error) {
          // Without this rollback the row would sit in 'waiting' forever
          // because no BullMQ counterpart exists to consume it.
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
  );

  /**
   * GET /api/jobs/:id
   * Returns job status and progress.
   */
  app.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
    const { id } = request.params;
    let job;
    try {
      job = await jobRepo.getJob(id);
    } catch (error) {
      if (error instanceof AmbiguousHashError) {
        const response: ErrorResponse = { error: error.message };
        return reply.code(400).send(response);
      }
      throw error;
    }
    if (!job) {
      const response: ErrorResponse = { error: "Job not found." };
      return reply.code(404).send(response);
    }
    return reply.send(job);
    }
  );

  /**
   * GET /api/jobs/:id/files
   * Returns processed file metadata for a completed job.
   */
  app.get<{ Params: { id: string } }>(
    "/:id/files",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
    const { id } = request.params;
    let job;
    try {
      job = await jobRepo.getJob(id);
    } catch (error) {
      if (error instanceof AmbiguousHashError) {
        const response: ErrorResponse = { error: error.message };
        return reply.code(400).send(response);
      }
      throw error;
    }
    if (!job) {
      const response: ErrorResponse = { error: "Job not found." };
      return reply.code(404).send(response);
    }

    const files = await jobRepo.getFiles(job.id);
    // Do not change the structure of the response, as the frontend relies on it
    const response: JobFilesResponse = {
      jobId: job.id,
      commit: job.commit,
      commitShort: job.commitShort,
      status: job.status,
      progress: job.progress,
      files: files.map((f) => ({
        t: f.file_type,
        path: f.file_name,
        s: f.file_size,
        update: f.file_update_date,
        commit: f.file_last_commit,
        hash: f.file_git_hash,
      })),
    };
    return reply.send(response);
    }
  );
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

async function markEnqueueFailure(
  jobRepo: JobRepository,
  jobId: string,
  error: unknown
): Promise<void> {
  const reason =
    error instanceof Error ? error.message : "Unknown enqueue failure";
  try {
    await jobRepo.updateJobStatus(jobId, "failed", `Failed to enqueue job: ${reason}`);
  } catch (rollbackError) {
    logger.error(
      `Failed to mark job ${jobId} as failed after enqueue error: ${
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
      `Failed to look up queued job ${jobId} during retry; proceeding with enqueue: ${
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
      `Failed to remove queued job ${jobId} during retry; proceeding with enqueue: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

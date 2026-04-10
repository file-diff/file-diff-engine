import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Queue } from "bullmq";
import { JobRepository, AmbiguousHashError } from "../../db/repository";
import type {
  ErrorResponse,
  JobFilesResponse,
  JobRequest,
  JobSummary,
} from "../../types";
import { getCommitShort } from "../../utils/commit";
import {
  authorizeViewerBearerToken,
  isValidRepo,
  normalizeRepo,
  POSTGRES_UNIQUE_VIOLATION,
} from "./shared";

async function requireViewerBearerToken(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authorization = authorizeViewerBearerToken(request.headers.authorization);
  if (!authorization.ok) {
    await reply.code(authorization.statusCode).send(authorization.response);
  }
}

export function registerJobManagementRoutes(
  app: FastifyInstance,
  queue: Queue,
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
        await enqueueJob(queue, existingJob.id, existingJob.repo, existingJob.commit);

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

    await enqueueJob(queue, jobId, repo, commit);

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
  queue: Queue,
  jobId: string,
  repoName: string,
  commit: string
): Promise<void> {
  await queue.add(
    "process-repo",
    {
      jobId,
      repoName,
      commit,
    },
    {
      jobId,
    }
  );
}

async function removeQueuedJob(queue: Queue, jobId: string): Promise<void> {
  const queuedJob = await queue.getJob(jobId);
  if (queuedJob) {
    await queuedJob.remove();
  }
}

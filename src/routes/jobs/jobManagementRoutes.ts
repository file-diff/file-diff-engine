import type { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import { JobRepository } from "../../db/repository";
import type {
  ErrorResponse,
  JobFilesResponse,
  JobRequest,
  JobSummary,
} from "../../types";
import { getCommitShort } from "../../utils/commit";
import {
  isValidRepo,
  normalizeRepo,
  POSTGRES_UNIQUE_VIOLATION,
} from "./shared";

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
  app.post<{ Body: JobRequest }>("/", async (request, reply) => {
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

    await queue.add(
      "process-repo",
      {
        jobId,
        repoName: repo,
        commit: jobId,
      },
      {
        jobId,
      }
    );

    const response: JobSummary = {
      id: jobId,
      status: "waiting",
      commit: jobId,
      commitShort: getCommitShort(jobId),
    };
    return reply.code(201).send(response);
  });

  /**
   * GET /api/jobs/:id
   * Returns job status and progress.
   */
  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const { id } = request.params;
    const job = await jobRepo.getJob(id);
    if (!job) {
      const response: ErrorResponse = { error: "Job not found." };
      return reply.code(404).send(response);
    }
    return reply.send(job);
  });

  /**
   * GET /api/jobs/:id/files
   * Returns processed file metadata for a completed job.
   */
  app.get<{ Params: { id: string } }>("/:id/files", async (request, reply) => {
    const { id } = request.params;
    const job = await jobRepo.getJob(id);
    if (!job) {
      const response: ErrorResponse = { error: "Job not found." };
      return reply.code(404).send(response);
    }

    const files = await jobRepo.getFiles(id);
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
  });
}

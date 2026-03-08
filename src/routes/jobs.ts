import { Queue } from "bullmq";
import type { FastifyPluginAsync } from "fastify";
import { JobRepository } from "../db/repository";
import { JobRequest } from "../types";
import {
  getRepositoryUrl,
  resolveRefToCommitHash,
} from "../services/repoProcessor";

interface JobRouteOptions {
  resolveCommitHash?: (repoUrl: string, ref: string) => Promise<string>;
}

const POSTGRES_UNIQUE_VIOLATION = "23505";

export function createJobRoutes(
  queue: Queue,
  jobRepo: JobRepository,
  options: JobRouteOptions = {}
): FastifyPluginAsync {
  const resolveCommitHash =
    options.resolveCommitHash ?? resolveRefToCommitHash;

  return async function registerJobRoutes(app) {
    /**
     * POST /api/jobs
     * Body: { "repo": "owner/repo", "ref": "v1.0.0" }
     * Creates a new processing job and enqueues it.
     */
    app.post<{ Body: JobRequest }>("/", async (request, reply) => {
      let { repo, ref } = request.body ?? {};
      if (!repo || !ref) {
        return reply
          .code(400)
          .send({ error: "Both 'repo' and 'ref' are required." });
      }

      repo = repo.replace("https://github.com/", "").replace(".git", "").trim();

      // Basic validation: repo should look like owner/repo
      if (!/^[\w.\-]+\/[\w.\-]+$/.test(repo)) {
        return reply.code(400).send({
          error:
            "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
        });
      }

      const jobId = await resolveCommitHash(getRepositoryUrl(repo), ref);
      const existingJob = await jobRepo.getJob(jobId);
      if (existingJob) {
        return reply
          .code(200)
          .send({ id: existingJob.id, status: existingJob.status });
      }

      try {
        await jobRepo.createJob(jobId, repo, ref);
      } catch (error: unknown) {
        if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
          const duplicateJob = await jobRepo.getJob(jobId);
          if (duplicateJob) {
            return reply
              .code(200)
              .send({ id: duplicateJob.id, status: duplicateJob.status });
          }
        }

        throw error;
      }

      await queue.add(
        "process-repo",
        {
          jobId,
          repoName: repo,
          ref: jobId,
        },
        {
          jobId,
        }
      );

      return reply.code(201).send({ id: jobId, status: "waiting" });
    });

    /**
     * GET /api/jobs/:id
     * Returns job status and progress.
     */
    app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
      const { id } = request.params;
      const job = await jobRepo.getJob(id);
      if (!job) {
        return reply.code(404).send({ error: "Job not found." });
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
        return reply.code(404).send({ error: "Job not found." });
      }

      const files = await jobRepo.getFiles(id);
      // Do not change the structure of the response, as the frontend relies on it
      return reply.send({
        job_id: job.id,
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
      });
    });
  };
}

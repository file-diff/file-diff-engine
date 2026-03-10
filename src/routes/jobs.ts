import { Queue } from "bullmq";
import type { FastifyPluginAsync } from "fastify";
import { JobRepository } from "../db/repository";
import { JobRequest } from "../types";
import { getCommitShort } from "../utils/commit";

const POSTGRES_UNIQUE_VIOLATION = "23505";

export function createJobRoutes(
  queue: Queue,
  jobRepo: JobRepository
): FastifyPluginAsync {
  return async function registerJobRoutes(app) {
    /**
     * POST /api/jobs
     * Body: { "repo": "owner/repo", "commit": "0123456789abcdef0123456789abcdef01234567" }
     * Creates a new processing job and enqueues it.
     */
    app.post<{ Body: JobRequest }>("/", async (request, reply) => {
      let { repo, commit } = request.body ?? {};
      if (!repo || !commit) {
        return reply
          .code(400)
          .send({ error: "Both 'repo' and 'commit' are required." });
      }

      repo = repo.replace("https://github.com/", "").replace(".git", "").trim();
      commit = commit.trim().toLowerCase();

      // Basic validation: repo should look like owner/repo
      if (!/^[\w.\-]+\/[\w.\-]+$/.test(repo)) {
        return reply.code(400).send({
          error:
            "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
        });
      }

      if (!/^[a-f0-9]{40}$/.test(commit)) {
        return reply.code(400).send({
          error:
            "Invalid commit format. Expected a 40-character hexadecimal commit SHA.",
        });
      }

      const jobId = commit;
      const existingJob = await jobRepo.getJob(jobId);
      if (existingJob) {
        return reply.code(200).send({
          id: existingJob.id,
          status: existingJob.status,
          commit: existingJob.commit,
          commitShort: existingJob.commitShort,
        });
      }

      try {
        await jobRepo.createJob(jobId, repo, commit);
      } catch (error: unknown) {
        if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
          const duplicateJob = await jobRepo.getJob(jobId);
          if (duplicateJob) {
            return reply.code(200).send({
              id: duplicateJob.id,
              status: duplicateJob.status,
              commit: duplicateJob.commit,
              commitShort: duplicateJob.commitShort,
            });
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

      return reply.code(201).send({
        id: jobId,
        status: "waiting",
        commit: jobId,
        commitShort: getCommitShort(jobId),
      });
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
      });
    });
  };
}

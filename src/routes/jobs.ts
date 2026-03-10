import { Queue } from "bullmq";
import type { FastifyPluginAsync } from "fastify";
import { JobRepository } from "../db/repository";
import type {
  ErrorResponse,
  ListRefsRequest,
  ListRefsResponse,
  JobFilesResponse,
  JobRequest,
  ResolveCommitRequest,
  ResolveCommitResponse,
  JobSummary,
} from "../types";
import * as repoProcessor from "../services/repoProcessor";
import { getCommitShort } from "../utils/commit";
import {
  getJobId,
  getJobPermalink,
  normalizeJobRef,
} from "../utils/jobIdentity";

const POSTGRES_UNIQUE_VIOLATION = "23505";

function normalizeRepo(repo: string): string {
  return repo.replace("https://github.com/", "").replace(".git", "").trim();
}

function isValidRepo(repo: string): boolean {
  return /^[\w.\-]+\/[\w.\-]+$/.test(repo);
}

export function createJobRoutes(
  queue: Queue,
  jobRepo: JobRepository
): FastifyPluginAsync {
  return async function registerJobRoutes(app) {
    /**
     * POST /api/jobs/resolve
     * Body: { "repo": "owner/repo", "ref": "main" }
     * Resolves a Git ref to a full commit SHA.
     */
    app.post<{ Body: ResolveCommitRequest }>("/resolve", async (request, reply) => {
      let { repo, ref } = request.body ?? {};
      if (!repo || !ref) {
        const response: ErrorResponse = {
          error: "Both 'repo' and 'ref' are required.",
        };
        return reply.code(400).send(response);
      }

      repo = normalizeRepo(repo);
      ref = ref.trim();

      if (!isValidRepo(repo)) {
        const response: ErrorResponse = {
          error:
            "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
        };
        return reply.code(400).send(response);
      }

      try {
        const commit = await repoProcessor.resolveRefToCommitHash(
          repoProcessor.getRepositoryUrl(repo),
          ref
        );
        const response: ResolveCommitResponse = {
          repo,
          ref,
          commit,
          commitShort: getCommitShort(commit),
        };
        return reply.code(200).send(response);
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
    });

    /**
     * POST /api/jobs/refs
     * Body: { "repo": "owner/repo" }
     * Lists available branch and tag refs for a repository.
     */
    app.post<{ Body: ListRefsRequest }>("/refs", async (request, reply) => {
      let { repo } = request.body ?? {};
      if (!repo) {
        const response: ErrorResponse = {
          error: "Field 'repo' is required.",
        };
        return reply.code(400).send(response);
      }

      repo = normalizeRepo(repo);

      if (!isValidRepo(repo)) {
        const response: ErrorResponse = {
          error:
            "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
        };
        return reply.code(400).send(response);
      }

      try {
        const refs = await repoProcessor.listRepositoryRefs(
          repoProcessor.getRepositoryUrl(repo)
        );
        const response: ListRefsResponse = {
          repo,
          refs,
        };
        return reply.code(200).send(response);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to list git refs.";
        const response: ErrorResponse = { error: message };
        return reply.code(500).send(response);
      }
    });

    /**
     * POST /api/jobs
     * Body: { "repo": "owner/repo", "commit": "0123456789abcdef0123456789abcdef01234567" }
     * Creates a new processing job and enqueues it.
     */
    app.post<{ Body: JobRequest }>("/", async (request, reply) => {
      let { repo, ref, commit } = request.body ?? {};
      if (!repo || !commit) {
        const response: ErrorResponse = {
          error: "Both 'repo' and 'commit' are required.",
        };
        return reply
          .code(400)
          .send(response);
      }

      repo = normalizeRepo(repo);
      ref = normalizeJobRef(ref);
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

      const jobId = getJobId(repo, commit);
      const permalink = getJobPermalink(repo, commit, ref);
      const existingJob = await jobRepo.findJob(repo, commit);
      if (existingJob) {
        if (ref && !existingJob.ref) {
          await jobRepo.updateJobPermalink(existingJob.id, ref, permalink);
          existingJob.ref = ref;
          existingJob.permalink = permalink;
        }
        const response: JobSummary = {
          id: existingJob.id,
          status: existingJob.status,
          repo: existingJob.repo,
          ref: existingJob.ref,
          commit: existingJob.commit,
          commitShort: existingJob.commitShort,
          permalink: existingJob.permalink,
        };
        return reply.code(200).send(response);
      }

      try {
        await jobRepo.createJob(jobId, repo, commit, ref, permalink);
      } catch (error: unknown) {
        if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
          const duplicateJob = await jobRepo.findJob(repo, commit);
          if (duplicateJob) {
            if (ref && !duplicateJob.ref) {
              await jobRepo.updateJobPermalink(duplicateJob.id, ref, permalink);
              duplicateJob.ref = ref;
              duplicateJob.permalink = permalink;
            }
            const response: JobSummary = {
              id: duplicateJob.id,
              status: duplicateJob.status,
              repo: duplicateJob.repo,
              ref: duplicateJob.ref,
              commit: duplicateJob.commit,
              commitShort: duplicateJob.commitShort,
              permalink: duplicateJob.permalink,
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
          ref,
          commit,
        },
        {
          jobId,
        }
      );

      const response: JobSummary = {
        id: jobId,
        status: "waiting",
        repo,
        ref,
        commit,
        commitShort: getCommitShort(commit),
        permalink,
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
  };
}

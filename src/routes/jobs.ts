import { Queue } from "bullmq";
import fs from "fs";
import path from "path";
import type { FastifyPluginAsync } from "fastify";
import { createGzip } from "zlib";
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
import { createLogger } from "../utils/logger";

const POSTGRES_UNIQUE_VIOLATION = "23505";
const logger = createLogger("job-routes");

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
      let { repo, commit } = request.body ?? {};
      if (!repo || !commit) {
        const response: ErrorResponse = {
          error: "Both 'repo' and 'commit' are required.",
        };
        return reply
          .code(400)
          .send(response);
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

    app.get<{ Params: { id: string; hash: string } }>(
      "/:id/files/hash/:hash/download",
      async (request, reply) => {
        const { id, hash } = request.params;
        const job = await jobRepo.getJob(id);
        if (!job) {
          const response: ErrorResponse = { error: "Job not found." };
          return reply.code(404).send(response);
        }

        const file = await jobRepo.getFileByHash(id, hash);
        if (!file) {
          const response: ErrorResponse = {
            error: `File with hash '${hash}' was not found for job '${id}' in the database.`,
          };
          return reply.code(404).send(response);
        }

        let filePath: string;
        try {
          filePath = resolveJobFilePath(id, file.fileDiskPath);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Invalid stored file path.";
          const response: ErrorResponse = { error: message };
          return reply.code(500).send(response);
        }

        try {
          await fs.promises.access(filePath, fs.constants.R_OK);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown file system error.";
          const response: ErrorResponse = {
            error:
              `File with hash '${hash}' was found in the database for job '${id}', ` +
              `but the file is missing or unreadable on disk at '${filePath}'. ${message}`,
          };
          return reply.code(404).send(response);
        }

        logger.info("Streaming gzipped file download", {
          jobId: id,
          hash,
          fileName: file.fileName,
          filePath,
        });

        reply.header("Content-Type", "application/octet-stream");
        reply.header("Content-Encoding", "gzip");
        reply.header(
          "Content-Disposition",
          `attachment; filename="${path.basename(file.fileName)}.gz"`
        );
        return reply.send(fs.createReadStream(filePath).pipe(createGzip()));
      }
    );
  };
}

function resolveJobFilePath(jobId: string, storedPath: string): string {
  const tmpDir = process.env.TMP_DIR || "tmp";
  const jobRoot = path.resolve(tmpDir, `fde-${jobId}`, "tree");
  const resolvedPath = path.resolve(jobRoot, storedPath);
  const relativePath = path.relative(jobRoot, resolvedPath);

  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      `Stored file path '${storedPath}' for job '${jobId}' resolves outside the job directory.`
    );
  }

  return resolvedPath;
}

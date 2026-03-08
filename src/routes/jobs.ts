import { Router, Request, Response } from "express";
import { Queue } from "bullmq";
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
): Router {
  const router = Router();
  const resolveCommitHash =
    options.resolveCommitHash ?? resolveRefToCommitHash;

  /**
   * POST /api/jobs
   * Body: { "repo": "owner/repo", "ref": "v1.0.0" }
   * Creates a new processing job and enqueues it.
   */
  router.post("/", async (req: Request, res: Response) => {
    const { repo, ref } = req.body as JobRequest;
    if (!repo || !ref) {
      res.status(400).json({ error: "Both 'repo' and 'ref' are required." });
      return;
    }

    // Basic validation: repo should look like owner/repo
    if (!/^[\w.\-]+\/[\w.\-]+$/.test(repo)) {
      res.status(400).json({
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      });
      return;
    }

    const jobId = await resolveCommitHash(getRepositoryUrl(repo), ref);
    const existingJob = await jobRepo.getJob(jobId);
    if (existingJob) {
      res.status(200).json({ id: existingJob.id, status: existingJob.status });
      return;
    }

    try {
      await jobRepo.createJob(jobId, repo, ref);
    } catch (error: unknown) {
      if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
        const duplicateJob = await jobRepo.getJob(jobId);
        if (duplicateJob) {
          res.status(200).json({ id: duplicateJob.id, status: duplicateJob.status });
          return;
        }
      }

      throw error;
    }

    await queue.add("process-repo", {
      jobId,
      repoName: repo,
      ref: jobId,
    }, {
      jobId,
    });

    res.status(201).json({ id: jobId, status: "waiting" });
  });

  /**
   * GET /api/jobs/:id
   * Returns job status and progress.
   */
  router.get("/:id", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const job = await jobRepo.getJob(id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    res.json(job);
  });

  /**
   * GET /api/jobs/:id/files
   * Returns processed file metadata for a completed job.
   */
  router.get("/:id/files", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const job = await jobRepo.getJob(id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }

    const files = await jobRepo.getFiles(id);
    // Do not change the structure of the response, as the frontend relies on it
    res.json({
      job_id: job.id,
      status: job.status,
      progress: job.progress,
      files: files.map(f => ({
        t: f.file_type,
        path: f.file_name,
        s: f.file_size,
        update: f.file_update_date,
        commit: f.file_last_commit,
        hash: f.file_git_hash,
      }))
    });
  });

  return router;
}

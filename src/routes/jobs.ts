import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { Queue } from "bullmq";
import { JobRepository } from "../db/repository";
import { JobRequest } from "../types";

export function createJobRoutes(
  queue: Queue,
  jobRepo: JobRepository
): Router {
  const router = Router();

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

    const jobId = uuidv4();
    await jobRepo.createJob(jobId, repo, ref);

    await queue.add("process-repo", {
      jobId,
      repoName: repo,
      ref,
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

import { Worker, Job } from "bullmq";
import path from "path";
import fs from "fs";
import os from "os";
import { getDatabase } from "../db/database";
import { JobRepository } from "../db/repository";
import { processRepository } from "../services/repoProcessor";
import { QUEUE_NAME } from "../services/queue";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);

const TMP_DIR = process.env.TMP_DIR || "tmp";

export function createWorker(dbPath?: string): Worker {
  const db = getDatabase(dbPath);
  const repo = new JobRepository(db);
  console.log("Worker connected to database, ready to process jobs.");

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      console.log("Job started:", job.id);
      const { jobId, repoName, ref } = job.data as {
        jobId: string;
        repoName: string;
        ref: string;
      };

      const workDir = path.join(TMP_DIR, `fde-${jobId}`);
      fs.mkdirSync(workDir, { recursive: true });

      try {
        repo.updateJobStatus(jobId, "active");

        const files = await processRepository(
          repoName,
          ref,
          workDir,
          (processed, total) => {
            repo.updateJobProgress(jobId, processed, total);
          }
        );

        repo.insertFiles(jobId, files);
        repo.updateJobProgress(jobId, files.length, files.length);
        repo.updateJobStatus(jobId, "completed");
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Unknown error";
        repo.updateJobStatus(jobId, "failed", message);
        throw err;
      } finally {
        // Clean up temporary directory
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    },
    {
      connection: {
        host: REDIS_HOST,
        port: REDIS_PORT,
        maxRetriesPerRequest: null,
      },
      concurrency: 2,
    }
  );

  return worker;
}

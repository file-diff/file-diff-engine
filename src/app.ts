import express from "express";
import { Queue } from "bullmq";
import { getDatabase } from "./db/database";
import { JobRepository } from "./db/repository";
import { createJobRoutes } from "./routes/jobs";
import { createQueue } from "./services/queue";

export interface AppDependencies {
  queue: Queue;
  dbPath?: string;
}

export function createApp(deps?: Partial<AppDependencies>): { app: express.Express; queue: Queue; db: ReturnType<typeof getDatabase>; jobRepo: JobRepository } {
  const app = express();
  app.use(express.json());

  const queue = deps?.queue ?? createQueue();
  const db = getDatabase(deps?.dbPath);
  const jobRepo = new JobRepository(db);

  app.use("/api/jobs", createJobRoutes(queue, jobRepo));

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return { app, queue, db, jobRepo };
}

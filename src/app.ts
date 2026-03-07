import express from "express";
import { Queue } from "bullmq";
import {
  getDatabase,
  type DatabaseClient,
  type DatabaseConfig,
} from "./db/database";
import { JobRepository } from "./db/repository";
import { createJobRoutes } from "./routes/jobs";
import { createQueue } from "./services/queue";

export interface AppDependencies {
  queue: Queue;
  db: DatabaseClient;
  dbConfig?: DatabaseConfig;
}

export interface AppContext {
  app: express.Express;
  queue: Queue;
  db: DatabaseClient;
  jobRepo: JobRepository;
}

export async function createApp(
  deps?: Partial<AppDependencies>
): Promise<AppContext> {
  const app = express();
  app.use(express.json());

  const queue = deps?.queue ?? createQueue();
  const db = deps?.db ?? (await getDatabase(deps?.dbConfig));
  const jobRepo = new JobRepository(db);

  app.use("/api/jobs", createJobRoutes(queue, jobRepo));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return { app, queue, db, jobRepo };
}

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

  // Maximally permissive CORS middleware
  app.use((req, res, next) => {
    const origin = (req.headers.origin as string) || "*";
    res.header("Access-Control-Allow-Origin", origin);
    res.header(
      "Access-Control-Allow-Methods",
      "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS"
    );
    const reqHeaders = req.headers["access-control-request-headers"] as
      | string
      | undefined;
    res.header(
      "Access-Control-Allow-Headers",
      reqHeaders || "Content-Type, Authorization"
    );
    // Allow credentials when origin is provided (browsers will reject wildcard + credentials)
    res.header("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      // Respond to preflight immediately
      res.sendStatus(204);
      return;
    }

    next();
  });

  const queue = deps?.queue ?? createQueue();
  const db = deps?.db ?? (await getDatabase(deps?.dbConfig));
  const jobRepo = new JobRepository(db);

  app.use("/api/jobs", createJobRoutes(queue, jobRepo));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return { app, queue, db, jobRepo };
}

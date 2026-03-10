import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
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
  app: FastifyInstance;
  queue: Queue;
  db: DatabaseClient;
  jobRepo: JobRepository;
}

export async function createApp(
  deps?: Partial<AppDependencies>
): Promise<AppContext> {
  const app = Fastify();
  const buildVersion = process.env.BUILD_VERSION || "dev";
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  });

  const queue = deps?.queue ?? createQueue();
  const db = deps?.db ?? (await getDatabase(deps?.dbConfig));
  const jobRepo = new JobRepository(db);

  await app.register(createJobRoutes(queue, jobRepo), { prefix: "/api/jobs" });

  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/version", async () => ({ version: buildVersion }));

  return { app, queue, db, jobRepo };
}

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
import type { HealthResponse, VersionResponse } from "./types";

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
  const healthHandler = async (): Promise<HealthResponse> => ({
    status: "ok",
    message: "API is healthy",
  });
  const versionHandler = async (): Promise<VersionResponse> => ({
    version: buildVersion,
  });

  await app.register(createJobRoutes(queue, jobRepo), { prefix: "/api/jobs" });

  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);
  app.get("/version", versionHandler);
  app.get("/api/version", versionHandler);

  return { app, queue, db, jobRepo };
}

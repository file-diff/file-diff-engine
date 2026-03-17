import rateLimit from "@fastify/rate-limit";
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
import type { HealthResponse, StatsResponse, VersionResponse } from "./types";

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

const DEFAULT_STATS_RATE_LIMIT_MAX = 60;
const DEFAULT_STATS_RATE_LIMIT_WINDOW_MS = 60_000;

export async function createApp(
  deps?: Partial<AppDependencies>
): Promise<AppContext> {
  const app = Fastify();
  const buildVersion = process.env.BUILD_VERSION || "dev";

  const queue = deps?.queue ?? createQueue();
  const db = deps?.db ?? (await getDatabase(deps?.dbConfig));
  const jobRepo = new JobRepository(db);

  await app.register(createJobRoutes(queue, jobRepo), { prefix: "/api/jobs" });

  app.get("/api/health", async () => {
    const response: HealthResponse = {
      status: "ok",
      message: "API is healthy",
    };
    return response;
  });
  app.get("/api/version", async () => {
    const response: VersionResponse = { version: buildVersion };
    return response;
  });
  await app.register(async (statsApp) => {
    await statsApp.register(rateLimit, {
      max: DEFAULT_STATS_RATE_LIMIT_MAX,
      timeWindow: DEFAULT_STATS_RATE_LIMIT_WINDOW_MS,
    });

    statsApp.get("/api/stats", async () => {
      const response: StatsResponse = await jobRepo.getStats();
      return response;
    });
  });

  return { app, queue, db, jobRepo };
}

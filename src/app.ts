import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import {
  getDatabase,
  type DatabaseClient,
  type DatabaseConfig,
} from "./db/database";
import { JobRepository, AmbiguousHashError } from "./db/repository";
import { createJobRoutes } from "./routes/jobs";
import { createQueue } from "./services/queue";
import type {
  ErrorResponse,
  HealthResponse,
  JobFilesResponse,
  StatsResponse,
  VersionResponse,
} from "./types";
import { createLogger } from "./utils/logger";

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
const DEFAULT_REQUEST_DELAY_MS = 0;
const logger = createLogger("app");

function getRequestDelayMs(): number {
  const rawDelay = process.env.REQUEST_DELAY_MS;

  if (!rawDelay) {
    return DEFAULT_REQUEST_DELAY_MS;
  }

  const parsedDelay = Number.parseInt(rawDelay, 10);
  if (!Number.isFinite(parsedDelay) || parsedDelay < 0) {
    return DEFAULT_REQUEST_DELAY_MS;
  }

  return parsedDelay;
}

export async function createApp(
  deps?: Partial<AppDependencies>
): Promise<AppContext> {
  const app = Fastify();
  const buildVersion = process.env.BUILD_VERSION || "dev";
  const requestDelayMs = getRequestDelayMs();

  const queue = deps?.queue ?? createQueue();
  const db = deps?.db ?? (await getDatabase(deps?.dbConfig));
  const jobRepo = new JobRepository(db);

  if (requestDelayMs > 0) {
    logger.warn("Request delay hook is enabled.", { requestDelayMs });
    app.addHook("onRequest", async () => {
      await new Promise((resolve) => setTimeout(resolve, requestDelayMs));
    });
  } else {
    logger.info("Request delay hook is not enabled.");
  }

  await app.register(createJobRoutes(queue, jobRepo), { prefix: "/api/jobs" });

  app.get<{ Params: { id: string } }>("/api/commit/:id/files", async (request, reply) => {
    const { id } = request.params;
    let job;
    try {
      job = await jobRepo.getJobByCommit(id);
    } catch (error) {
      if (error instanceof AmbiguousHashError) {
        const response: ErrorResponse = { error: error.message };
        return reply.code(400).send(response);
      }
      throw error;
    }
    if (!job) {
      const response: ErrorResponse = { error: "Job not found." };
      return reply.code(404).send(response);
    }

    const files = await jobRepo.getFiles(job.id);
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
        commit: f.file_last_commit.slice(0, 8),
        hash: f.file_git_hash.slice(0, 8),
      })),
    };
    return reply.send(response);
  });

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

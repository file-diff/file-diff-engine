import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import { zstdCompressSync } from "node:zlib";
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
import { serializeFiles } from "./utils/binarySerializer";
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

function acceptsZstdEncoding(acceptEncodingHeader?: string): boolean {
  if (!acceptEncodingHeader) {
    return false;
  }

  return acceptEncodingHeader.split(",").some((encodingEntry) => {
    const [encoding, ...params] = encodingEntry.trim().toLowerCase().split(";");

    if (encoding !== "zstd") {
      return false;
    }

    const qValue = params
      .map((param) => param.trim())
      .find((param) => param.startsWith("q="));

    if (!qValue) {
      return true;
    }

    const quality = Number.parseFloat(qValue.slice(2));
    return Number.isFinite(quality) && quality > 0;
  });
}

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

  app.get<{
    Params: { id: string };
    Querystring: { format?: string };
  }>("/api/commit/:id/files", async (request, reply) => {
    const { id } = request.params;
    const format = (request.query?.format || "json").toLowerCase();
    const allowed = new Set(["json", "csv", "binary"]);

    if (!allowed.has(format)) {
      const response: ErrorResponse = { error: "Invalid format. Allowed: json, csv, binary." };
      return reply.code(400).send(response);
    }

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
    const jsonResponse: JobFilesResponse = {
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

    let payload: string | Buffer;
    let contentType: string;

    if (format === "json") {
      payload = JSON.stringify(jsonResponse);
      contentType = "application/json; charset=utf-8";
    } else if (format === "csv") {
      // Build CSV header and rows. Include job-level fields on each row for completeness.
      const headers = [
        "jobId",
        "commit",
        "commitShort",
        "status",
        "progress",
        "file_type",
        "file_name",
        "file_size",
        "file_update_date",
        "file_last_commit",
        "file_git_hash",
      ];

      const escape = (v: unknown) => {
        if (v === null || v === undefined) return "";
        const s = String(v);
        // If string contains quote, comma, or newline, wrap in quotes and escape quotes.
        if (/[",\n]/.test(s)) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      };

      const rows = files.map((f) => [
        jsonResponse.jobId,
        jsonResponse.commit,
        jsonResponse.commitShort,
        jsonResponse.status,
        jsonResponse.progress,
        f.file_type,
        f.file_name,
        f.file_size,
        f.file_update_date,
        f.file_last_commit.slice(0, 8),
        f.file_git_hash.slice(0, 8),
      ]);

      const csvLines = [headers.map(escape).join(",")].concat(rows.map((r) => r.map(escape).join(",")));
      payload = csvLines.join("\n");
      contentType = "text/csv; charset=utf-8";
    } else {
      payload = serializeFiles(files);
      contentType = "application/octet-stream";
    }

    reply.header("Content-Type", contentType);
    reply.header("Vary", "Accept-Encoding");

    if (acceptsZstdEncoding(request.headers["accept-encoding"])) {
      const content = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
      reply.header("Content-Encoding", "zstd");
      return reply.send(zstdCompressSync(content));
    }

    return reply.send(payload);
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

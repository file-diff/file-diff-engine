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

    if (format === "json") {
      return reply.send(jsonResponse);
    }

    if (format === "csv") {
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
      const csv = csvLines.join("\n");

      reply.header("Content-Type", "text/csv; charset=utf-8");
      return reply.send(csv);
    }

    // binary
    // Return concatenated per-file binary records as application/octet-stream.
    // Record layout per file:
    // 1 byte  - file type (number) or char code
    // 2 bytes - name length (uint16 BE)
    // N bytes - name UTF-8
    // 4 bytes - update timestamp (uint32 BE, seconds)
    // 4 bytes - file size (uint32 BE)
    // 4 bytes - commit prefix (first 4 bytes of hex)
    // 4 bytes - hash prefix (first 4 bytes of hex)
    {
      // Helper to safely get a 4-byte buffer from a hex string (first 8 hex chars -> 4 bytes)
      const hexPrefixTo4Bytes = (hex?: string) => {
        if (!hex) return Buffer.alloc(4, 0);
        const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
        const prefix = clean.slice(0, 8).padEnd(8, "0");
        try {
          return Buffer.from(prefix, "hex");
        } catch (e) {
          return Buffer.alloc(4, 0);
        }
      };

      // Precompute per-file buffers and total length
      const fileBuffers: Buffer[] = [];
      let totalLength = 0;

      for (const f of files) {
        // type: 1 byte
        let typeByte = 0;
        if (typeof f.file_type === "number") {
          typeByte = f.file_type & 0xff;
        } else if (typeof f.file_type === "string" && f.file_type.length > 0) {
          typeByte = f.file_type.charCodeAt(0) & 0xff;
        }

        // name UTF-8 bytes, length as uint16 BE
        const name = f.file_name ?? "";
        const nameBuf = Buffer.from(String(name), "utf8");
        // clamp name length to 65535
        const nameLen = Math.min(0xffff, nameBuf.length);
        const nameTrunc = nameBuf.slice(0, nameLen);

        // update date -> unix seconds (4 bytes). Accept string or number.
        let updateTs = 0;
        if (f.file_update_date) {
          const d = typeof f.file_update_date === "number" ? new Date(f.file_update_date) : new Date(String(f.file_update_date));
          if (!Number.isNaN(d.getTime())) {
            updateTs = Math.floor(d.getTime() / 1000);
          }
        }
        updateTs = updateTs >>> 0; // ensure uint32

        // size -> uint32
        let size = 0;
        if (typeof f.file_size === "number") {
          size = Math.max(0, Math.floor(f.file_size));
        } else if (typeof f.file_size === "string") {
          const parsed = Number.parseInt(f.file_size, 10);
          if (Number.isFinite(parsed)) size = Math.max(0, Math.floor(parsed));
        }
        size = size >>> 0;

        const commitBuf = hexPrefixTo4Bytes(f.file_last_commit);
        const hashBuf = hexPrefixTo4Bytes(f.file_git_hash);

        const recordLen = 1 + 2 + nameTrunc.length + 4 + 4 + 4 + 4;
        const buf = Buffer.allocUnsafe(recordLen);
        let offset = 0;
        buf.writeUInt8(typeByte, offset);
        offset += 1;
        buf.writeUInt16BE(nameTrunc.length, offset);
        offset += 2;
        nameTrunc.copy(buf, offset);
        offset += nameTrunc.length;
        buf.writeUInt32BE(updateTs >>> 0, offset);
        offset += 4;
        buf.writeUInt32BE(size >>> 0, offset);
        offset += 4;
        commitBuf.copy(buf, offset, 0, 4);
        offset += 4;
        hashBuf.copy(buf, offset, 0, 4);
        offset += 4;

        fileBuffers.push(buf);
        totalLength += buf.length;
      }

      const out = Buffer.concat(fileBuffers, totalLength);
      reply.header("Content-Type", "application/octet-stream");
      return reply.send(out);
    }
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

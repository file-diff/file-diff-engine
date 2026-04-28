import fs from "fs";
import readline from "readline";
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
import { createTaskRoutes } from "./routes/taskRoutes";
import { getGitHubRateLimit } from "./services/githubApi";
import { createQueue } from "./services/queue";
import type {
  CommitGrepMatch,
  CommitGrepResponse,
  ErrorResponse,
  FileRecord,
  HealthResponse,
  JobFilesResponse,
  StatsResponse,
  VersionResponse,
} from "./types";
import { serializeJobFilesResponse } from "./utils/binarySerializer";
import { createLogger } from "./utils/logger";
import {
  requireViewerBearerToken,
  resolveJobFilePath,
} from "./routes/jobs/shared";

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

function isGrepableFileType(fileType: FileRecord["file_type"]): boolean {
  return fileType === "t" || fileType === "x";
}

async function grepFilesForJob(
  jobId: string,
  files: FileRecord[],
  query: string
): Promise<CommitGrepMatch[]> {
  const matches: CommitGrepMatch[] = [];

  for (const file of files) {
    if (!isGrepableFileType(file.file_type)) {
      continue;
    }

    const storedPath = file.file_disk_path ?? file.file_name;
    let filePath: string;
    try {
      filePath = resolveJobFilePath(jobId, storedPath);
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to access file on disk.";
      throw new Error(
        `File '${file.file_name}' for job '${jobId}' is missing or unreadable on disk. ${message}`
      );
    }

    const lineReader = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    let lineNumber = 0;
    try {
      for await (const line of lineReader) {
        lineNumber += 1;
        if (line.includes(query)) {
          matches.push({
            path: file.file_name,
            lineNumber,
            line,
          });
        }
      }
    } finally {
      lineReader.close();
    }
  }

  return matches;
}

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
      .find((param) => /^q\s*=/.test(param));

    if (!qValue) {
      return true;
    }

    const quality = Number.parseFloat(qValue.split("=")[1]?.trim() ?? "");
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

  await app.register(rateLimit, { global: false });
  await app.register(createJobRoutes(queue, jobRepo), { prefix: "/api/jobs" });
  await app.register(createTaskRoutes(jobRepo), { prefix: "/api" });

  app.get<{
    Params: { id: string };
    Querystring: { format?: string };
  }>(
    "/api/commit/:id/files",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
    const { id } = request.params;
    const format = (request.query?.format || "json").toLowerCase();
    const allowed = new Set(["json", "binary"]);

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

    let responsePayload;

    if (format === "json") {
      responsePayload = {
        payload: JSON.stringify(jsonResponse),
        contentType: "application/json; charset=utf-8"
      }
    } else {
      responsePayload = {
        payload: serializeJobFilesResponse(jsonResponse),
        contentType: "application/octet-stream",
      }
    }

    reply.header("Content-Type", responsePayload.contentType);
    reply.header("Vary", "Accept-Encoding");

    if (acceptsZstdEncoding(request.headers["accept-encoding"])) {
      const content =
        typeof responsePayload.payload === "string"
          ? Buffer.from(responsePayload.payload, "utf8")
          : responsePayload.payload;
      reply.header("Content-Encoding", "zstd");
      return reply.send(zstdCompressSync(content));
    }

    return reply.send(responsePayload.payload);
    }
  );

  app.get<{
    Params: { id: string };
    Querystring: { query?: string };
  }>(
    "/api/commit/:id/grep",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
    const { id } = request.params;
    const query = request.query?.query?.trim();

    if (!query) {
      const response: ErrorResponse = { error: "Query parameter 'query' is required." };
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

    try {
      const files = await jobRepo.getFilesWithDiskPaths(job.id);
      const response: CommitGrepResponse = {
        jobId: job.id,
        commit: job.commit,
        commitShort: job.commitShort,
        status: job.status,
        progress: job.progress,
        query,
        matches: await grepFilesForJob(job.id, files, query),
      };
      return reply.send(response);
    } catch (error) {
      const response: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to grep commit files.",
      };
      return reply.code(500).send(response);
    }
    }
  );

  app.get("/api/health", { preHandler: requireViewerBearerToken }, async () => {
    const githubConfigured = Boolean(process.env.PRIVATE_GITHUB_TOKEN?.trim() || process.env.PUBLIC_GITHUB_TOKEN?.trim());
    let github: HealthResponse["github"];

    try {
      github = {
        configured: githubConfigured,
        status: "ok",
        rateLimit: await getGitHubRateLimit(),
      };
    } catch (error) {
      github = {
        configured: githubConfigured,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const response: HealthResponse = {
      status: "ok",
      message: "API is healthy",
      github,
    };
    return response;
  });
  app.get("/api/version", { preHandler: requireViewerBearerToken }, async () => {
    const response: VersionResponse = { version: buildVersion };
    return response;
  });
  app.get(
    "/api/stats",
    {
      preHandler: [
        requireViewerBearerToken,
        app.rateLimit({
          max: DEFAULT_STATS_RATE_LIMIT_MAX,
          timeWindow: DEFAULT_STATS_RATE_LIMIT_WINDOW_MS,
        }),
      ],
    },
    async () => {
      const response: StatsResponse = await jobRepo.getStats();
      return response;
    }
  );

  return { app, queue, db, jobRepo };
}

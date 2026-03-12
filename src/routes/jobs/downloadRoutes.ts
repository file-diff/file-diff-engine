import fs from "fs";
import { pipeline } from "stream/promises";
import type { FastifyInstance } from "fastify";
import { JobRepository } from "../../db/repository";
import type { ErrorResponse } from "../../types";
import {
  DEFAULT_DOWNLOAD_RATE_LIMIT_MAX,
  DEFAULT_DOWNLOAD_RATE_LIMIT_WINDOW_MS,
  getDownloadFilename,
  logger,
  parsePositiveInteger,
  resolveJobFilePath,
} from "./shared";

export function registerDownloadRoutes(
  app: FastifyInstance,
  jobRepo: JobRepository
): void {
  const downloadRateLimit = app.rateLimit({
    max: parsePositiveInteger(
      process.env.DOWNLOAD_BY_HASH_RATE_LIMIT_MAX,
      DEFAULT_DOWNLOAD_RATE_LIMIT_MAX
    ),
    timeWindow: parsePositiveInteger(
      process.env.DOWNLOAD_BY_HASH_RATE_LIMIT_WINDOW_MS,
      DEFAULT_DOWNLOAD_RATE_LIMIT_WINDOW_MS
    ),
  });

  app.get<{ Params: { id: string; hash: string } }>(
    "/:id/files/hash/:hash/download",
    {
      preHandler: downloadRateLimit,
    },
    async (request, reply) => {
      const { id, hash } = request.params;
      const job = await jobRepo.getJob(id);
      if (!job) {
        const response: ErrorResponse = { error: "Job not found." };
        return reply.code(404).send(response);
      }

      const file = await jobRepo.getFileByHash(id, hash);
      if (!file) {
        const response: ErrorResponse = {
          error: `File with hash '${hash}' was not found for job '${id}' in the database.`,
        };
        return reply.code(404).send(response);
      }

      let filePath: string;
      try {
        filePath = resolveJobFilePath(id, file.fileDiskPath);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Invalid stored file path.";
        const response: ErrorResponse = { error: message };
        return reply.code(500).send(response);
      }

      try {
        await fs.promises.access(filePath, fs.constants.R_OK);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to check file accessibility on disk.";
        const response: ErrorResponse = {
          error:
            `File with hash '${hash}' was found in the database for job '${id}', ` +
            `but the file is missing or unreadable on disk at '${filePath}'. ${message}`,
        };
        return reply.code(404).send(response);
      }

      logger.info("Streaming file download", {
        jobId: id,
        hash,
        fileName: file.fileName,
        filePath,
      });

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${getDownloadFilename(file.fileName)}"`,
      });

      try {
        await pipeline(fs.createReadStream(filePath), reply.raw);
      } catch (error) {
        logger.error("Failed to stream file download", {
          jobId: id,
          hash,
          fileName: file.fileName,
          filePath,
          error,
        });
        if (!reply.raw.destroyed) {
          reply.raw.destroy(error instanceof Error ? error : undefined);
        }
      }
      return reply;
    }
  );
}

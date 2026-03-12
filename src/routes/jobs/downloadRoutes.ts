import fs from "fs";
import * as childProcess from "child_process";
import { pipeline } from "stream/promises";
import type { FastifyInstance } from "fastify";
import { JobRepository, type FileLookupRecord } from "../../db/repository";
import type { ErrorResponse, JobInfo } from "../../types";
import {
  DEFAULT_DOWNLOAD_RATE_LIMIT_MAX,
  DEFAULT_DOWNLOAD_RATE_LIMIT_WINDOW_MS,
  getDownloadFilename,
  logger,
  parsePositiveInteger,
  resolveJobFilePath,
} from "./shared";

interface ResolvedJobFile {
  job: JobInfo;
  file: FileLookupRecord;
  filePath: string;
}

interface FileLookupErrorResult {
  statusCode: number;
  response: ErrorResponse;
}

export const difftCommandRunner = {
  execFile: childProcess.execFile,
};

export function registerDownloadRoutes(
  app: FastifyInstance,
  jobRepo: JobRepository
): void {
  app.get<{ Params: { id: string; hash: string } }>(
    "/:id/files/hash/:hash/download",
    {
      config: {
        rateLimit: {
          max: parsePositiveInteger(
            process.env.DOWNLOAD_BY_HASH_RATE_LIMIT_MAX,
            DEFAULT_DOWNLOAD_RATE_LIMIT_MAX
          ),
          timeWindow: parsePositiveInteger(
            process.env.DOWNLOAD_BY_HASH_RATE_LIMIT_WINDOW_MS,
            DEFAULT_DOWNLOAD_RATE_LIMIT_WINDOW_MS
          ),
        },
      },
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

  app.get<{ Params: { id: string; leftHash: string; rightHash: string } }>(
    "/:id/files/hash/:leftHash/diff/:rightHash",
    async (request, reply) => {
      const { id, leftHash, rightHash } = request.params;
      const leftFileResult = await resolveAccessibleJobFile(jobRepo, id, leftHash);
      if ("statusCode" in leftFileResult) {
        return reply.code(leftFileResult.statusCode).send(leftFileResult.response);
      }

      const rightFileResult = await resolveAccessibleJobFile(jobRepo, id, rightHash);
      if ("statusCode" in rightFileResult) {
        return reply.code(rightFileResult.statusCode).send(rightFileResult.response);
      }

      logger.info("Running difft for job files", {
        jobId: id,
        leftHash,
        rightHash,
        leftFileName: leftFileResult.file.fileName,
        rightFileName: rightFileResult.file.fileName,
      });

      try {
        const diff = await runDifftJson(leftFileResult.filePath, rightFileResult.filePath);
        return reply.send(diff);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to run difft command.";
        const response: ErrorResponse = { error: message };
        return reply.code(500).send(response);
      }
    }
  );
}

async function resolveAccessibleJobFile(
  jobRepo: JobRepository,
  jobId: string,
  hash: string
): Promise<ResolvedJobFile | FileLookupErrorResult> {
  const job = await jobRepo.getJob(jobId);
  if (!job) {
    return {
      statusCode: 404,
      response: { error: "Job not found." },
    };
  }

  const file = await jobRepo.getFileByHash(jobId, hash);
  if (!file) {
    return {
      statusCode: 404,
      response: {
        error: `File with hash '${hash}' was not found for job '${jobId}' in the database.`,
      },
    };
  }

  let filePath: string;
  try {
    filePath = resolveJobFilePath(jobId, file.fileDiskPath);
  } catch (error) {
    return {
      statusCode: 500,
      response: {
        error: error instanceof Error ? error.message : "Invalid stored file path.",
      },
    };
  }

  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to check file accessibility on disk.";
    return {
      statusCode: 404,
      response: {
        error:
          `File with hash '${hash}' was found in the database for job '${jobId}', ` +
          `but the file is missing or unreadable on disk at '${filePath}'. ${message}`,
      },
    };
  }

  return { job, file, filePath };
}

async function runDifftJson(leftFilePath: string, rightFilePath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    difftCommandRunner.execFile(
      "difft",
      ["--display", "json", leftFilePath, rightFilePath],
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const stderrText = (stderr ?? "").toString().trim();
        if (stderrText) {
          logger.debug("difft emitted stderr", {
            leftFilePath,
            rightFilePath,
            stderr: stderrText,
          });
        }

        const errorWithOutput = error as
          | (Error & {
              code?: number | string;
              stdout?: string | Buffer;
              stderr?: string | Buffer;
            })
          | null;
        const stdoutValue = errorWithOutput?.stdout ?? stdout;

        if (error && errorWithOutput?.code !== 1 && errorWithOutput?.code !== "1") {
          const details = [
            "Failed to run difft command.",
            error.message,
            stderrText ? `stderr: ${stderrText}` : undefined,
          ]
            .filter(Boolean)
            .join(" ");
          reject(new Error(details));
          return;
        }

        try {
          resolve(parseDifftJson(stdoutValue, leftFilePath, rightFilePath));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

function parseDifftJson(
  stdout: string | Buffer | undefined,
  leftFilePath: string,
  rightFilePath: string
): unknown {
  const stdoutText = (stdout ?? "").toString().trim();
  if (!stdoutText) {
    throw new Error(
      `difft returned no JSON output for '${leftFilePath}' and '${rightFilePath}'.`
    );
  }

  try {
    return JSON.parse(stdoutText) as unknown;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown JSON parsing error.";
    throw new Error(`Failed to parse difft JSON output. ${message}`);
  }
}

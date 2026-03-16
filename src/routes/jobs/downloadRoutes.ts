import fs from "fs";
import path from "path";
import * as childProcess from "child_process";
import { pipeline } from "stream/promises";
import type { FastifyInstance } from "fastify";
import {
  bundledLanguagesInfo,
  codeToTokens,
  type BundledLanguage,
  type SpecialLanguage,
} from "shiki";
import { JobRepository, type FileLookupRecord } from "../../db/repository";
import type { ErrorResponse } from "../../types";
import {
  DEFAULT_DOWNLOAD_RATE_LIMIT_MAX,
  DEFAULT_DOWNLOAD_RATE_LIMIT_WINDOW_MS,
  getDownloadFilename,
  logger,
  parsePositiveInteger,
  resolveJobFilePath,
} from "./shared";

interface ResolvedJobFile {
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

export const shikiTokenizer = {
  codeToTokens,
};

const SHIKI_THEME = "github-light";
const shikiLanguagesByAlias = new Map<string, BundledLanguage>();

for (const language of bundledLanguagesInfo) {
  const languageId = language.id as BundledLanguage;
  shikiLanguagesByAlias.set(language.id.toLowerCase(), languageId);
  for (const alias of language.aliases ?? []) {
    shikiLanguagesByAlias.set(alias.toLowerCase(), languageId);
  }
}

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

  app.get<{ Params: { leftHash: string; rightHash: string } }>(
    "/files/hash/:leftHash/diff/:rightHash",
    async (request, reply) => {
      const { leftHash, rightHash } = request.params;
      const leftFileResult = await resolveAccessibleFileByHash(jobRepo, leftHash);
      if ("statusCode" in leftFileResult) {
        return reply.code(leftFileResult.statusCode).send(leftFileResult.response);
      }

      const rightFileResult = await resolveAccessibleFileByHash(jobRepo, rightHash);
      if ("statusCode" in rightFileResult) {
        return reply.code(rightFileResult.statusCode).send(rightFileResult.response);
      }

      logger.info("Running difft for files by hash", {
        leftHash,
        rightHash,
        leftJobId: leftFileResult.file.jobId,
        rightJobId: rightFileResult.file.jobId,
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

  app.get<{ Params: { hash: string } }>(
    "/files/hash/:hash/tokenize",
    async (request, reply) => {
      const { hash } = request.params;
      const fileResult = await resolveAccessibleFileByHash(jobRepo, hash);
      if ("statusCode" in fileResult) {
        return reply.code(fileResult.statusCode).send(fileResult.response);
      }

      logger.info("Running shiki tokenization for file by hash", {
        hash,
        jobId: fileResult.file.jobId,
        fileName: fileResult.file.fileName,
      });

      try {
        const tokens = await runShikiTokenization(
          fileResult.filePath,
          fileResult.file.fileName
        );
        return reply.send(tokens);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to tokenize file with shiki.";
        const response: ErrorResponse = { error: message };
        return reply.code(500).send(response);
      }
    }
  );
}

async function resolveAccessibleFileByHash(
  jobRepo: JobRepository,
  hash: string
): Promise<ResolvedJobFile | FileLookupErrorResult> {
  const files = await jobRepo.getFilesByHash(hash);
  if (files.length === 0) {
    return {
      statusCode: 404,
      response: {
        error: `File with hash '${hash}' was not found in the database.`,
      },
    };
  }

  let fileAccessFailure: FileLookupErrorResult | undefined;

  for (const file of files) {
    let filePath: string;
    try {
      filePath = resolveJobFilePath(file.jobId, file.fileDiskPath);
    } catch (error) {
      if (!fileAccessFailure) {
        fileAccessFailure = {
          statusCode: 500,
          response: {
            error: error instanceof Error ? error.message : "Invalid stored file path.",
          },
        };
      }
      continue;
    }

    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
      return { file, filePath };
    } catch (error) {
      if (!fileAccessFailure) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to check file accessibility on disk.";
        fileAccessFailure = {
          statusCode: 404,
          response: {
            error:
              `File with hash '${hash}' was found in the database for job '${file.jobId}', ` +
              `but the file is missing or unreadable on disk at '${filePath}'. ${message}`,
          },
        };
      }
    }
  }

  return fileAccessFailure ?? {
    statusCode: 500,
    response: {
      error: `Unexpected file lookup state for hash '${hash}'.`,
    },
  };
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

async function runShikiTokenization(
  filePath: string,
  fileName: string
): Promise<unknown> {
  const fileContents = await fs.promises.readFile(filePath, "utf8");
  return shikiTokenizer.codeToTokens(fileContents, {
    lang: inferShikiLanguage(fileName),
    theme: SHIKI_THEME,
  });
}

function inferShikiLanguage(fileName: string): BundledLanguage | SpecialLanguage {
  const baseName = path.basename(fileName).toLowerCase();
  const extension = path.extname(baseName).slice(1);
  const dotfileName = baseName.startsWith(".") ? baseName.slice(1) : "";

  return (
    shikiLanguagesByAlias.get(baseName) ??
    shikiLanguagesByAlias.get(extension) ??
    shikiLanguagesByAlias.get(dotfileName) ??
    "text"
  );
}

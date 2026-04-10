import fs from "fs";
import path from "path";
import * as childProcess from "child_process";
import { pipeline } from "stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  bundledLanguagesInfo,
  bundledThemesInfo,
  codeToTokens,
  type BundledLanguage,
  type BundledTheme,
  type SpecialLanguage,
} from "shiki";
import { JobRepository, AmbiguousHashError, type FileLookupRecord } from "../../db/repository";
import type { ErrorResponse } from "../../types";
import {
  DEFAULT_DOWNLOAD_RATE_LIMIT_MAX,
  DEFAULT_DOWNLOAD_RATE_LIMIT_WINDOW_MS,
  getDownloadFilename,
  logger,
  parsePositiveInteger,
  requireViewerBearerToken,
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

interface ShikiTokenizationOptions {
  language: BundledLanguage | SpecialLanguage;
  theme: BundledTheme;
}

interface TokenizeQuerystring {
  language?: string;
  theme?: string;
}

const AUTO_SHIKI_LANGUAGE = "auto";
const DEFAULT_SHIKI_THEME = "github-dark";
const shikiLanguagesByAlias = new Map<string, BundledLanguage>();
const shikiThemesByAlias = new Map<string, BundledTheme>();

for (const language of bundledLanguagesInfo) {
  const languageId = language.id as BundledLanguage;
  shikiLanguagesByAlias.set(language.id.toLowerCase(), languageId);
  for (const alias of language.aliases ?? []) {
    shikiLanguagesByAlias.set(alias.toLowerCase(), languageId);
  }
}

for (const theme of bundledThemesInfo) {
  shikiThemesByAlias.set(theme.id.toLowerCase(), theme.id as BundledTheme);
}

export function registerDownloadRoutes(
  app: FastifyInstance,
  jobRepo: JobRepository
): void {
  app.get<{ Params: { hash: string } }>(
    "/files/hash/:hash/download",
    {
      preHandler: requireViewerBearerToken,
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
      const { hash } = request.params;
      const fileResult = await resolveAccessibleFileByHash(jobRepo, hash);
      if ("statusCode" in fileResult) {
        return reply.code(fileResult.statusCode).send(fileResult.response);
      }

      return streamFileDownload(reply, fileResult, hash);
    }
  );

  app.get<{ Params: { id: string; hash: string } }>(
    "/:id/files/hash/:hash/download",
    {
      preHandler: requireViewerBearerToken,
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

      let job;
      try {
        job = await jobRepo.getJob(id);
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

      let file;
      try {
        file = await jobRepo.getFileByHash(job.id, hash);
      } catch (error) {
        if (error instanceof AmbiguousHashError) {
          const response: ErrorResponse = { error: error.message };
          return reply.code(400).send(response);
        }
        throw error;
      }
      if (!file) {
        const response: ErrorResponse = {
          error: `File with hash '${hash}' was not found for job '${job.id}' in the database.`,
        };
        return reply.code(404).send(response);
      }

      let filePath: string;
      try {
        filePath = resolveJobFilePath(job.id, file.fileDiskPath);
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
            `File with hash '${hash}' was found in the database for job '${job.id}', ` +
            `but the file is missing or unreadable on disk at '${filePath}'. ${message}`,
        };
        return reply.code(404).send(response);
      }

      return streamFileDownload(reply, { file, filePath }, hash);
    }
  );

  app.get<{ Params: { leftHash: string; rightHash: string } }>(
    "/files/hash/:leftHash/diff/:rightHash",
    { preHandler: requireViewerBearerToken },
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

  app.get<{ Params: { hash: string }; Querystring: TokenizeQuerystring }>(
    "/files/hash/:hash/tokenize",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
      const { hash } = request.params;
      const fileResult = await resolveAccessibleFileByHash(jobRepo, hash);
      if ("statusCode" in fileResult) {
        return reply.code(fileResult.statusCode).send(fileResult.response);
      }

      let tokenizationOptions: ShikiTokenizationOptions;
      try {
        tokenizationOptions = resolveShikiTokenizationOptions(
          fileResult.file.fileName,
          request.query
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Invalid shiki tokenization options.";
        const response: ErrorResponse = { error: message };
        return reply.code(400).send(response);
      }

      logger.info("Running shiki tokenization for file by hash", {
        hash,
        jobId: fileResult.file.jobId,
        fileName: fileResult.file.fileName,
        language: tokenizationOptions.language,
        theme: tokenizationOptions.theme,
      });

      try {
        const tokens = await runShikiTokenization(fileResult.filePath, tokenizationOptions);
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
  let files: FileLookupRecord[];
  try {
    files = await jobRepo.getFilesByHash(hash);
  } catch (error) {
    if (error instanceof AmbiguousHashError) {
      return {
        statusCode: 400,
        response: { error: error.message },
      };
    }
    throw error;
  }

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

async function streamFileDownload(
  reply: FastifyReply,
  resolvedFile: ResolvedJobFile,
  hash: string
) {
  logger.info("Streaming file download", {
    jobId: resolvedFile.file.jobId,
    hash,
    fileName: resolvedFile.file.fileName,
    filePath: resolvedFile.filePath,
  });

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${getDownloadFilename(resolvedFile.file.fileName)}"`,
  });

  try {
    await pipeline(fs.createReadStream(resolvedFile.filePath), reply.raw);
  } catch (error) {
    logger.error("Failed to stream file download", {
      jobId: resolvedFile.file.jobId,
      hash,
      fileName: resolvedFile.file.fileName,
      filePath: resolvedFile.filePath,
      error,
    });
    if (!reply.raw.destroyed) {
      reply.raw.destroy(error instanceof Error ? error : undefined);
    }
  }
  return reply;
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
  tokenizationOptions: ShikiTokenizationOptions
): Promise<unknown> {
  const fileContents = await fs.promises.readFile(filePath, "utf8");
  return shikiTokenizer.codeToTokens(fileContents, {
    lang: tokenizationOptions.language,
    theme: tokenizationOptions.theme,
  });
}

function resolveShikiTokenizationOptions(
  fileName: string,
  query: TokenizeQuerystring
): ShikiTokenizationOptions {
  return {
    language: resolveShikiLanguage(fileName, query.language),
    theme: resolveShikiTheme(query.theme),
  };
}

function resolveShikiTheme(theme: string | undefined): BundledTheme {
  const normalizedTheme = theme?.trim().toLowerCase();
  if (!normalizedTheme) {
    return DEFAULT_SHIKI_THEME;
  }

  const bundledTheme = shikiThemesByAlias.get(normalizedTheme);
  if (!bundledTheme) {
    throw new Error(`Unsupported shiki theme '${theme}'.`);
  }

  return bundledTheme;
}

function resolveShikiLanguage(
  fileName: string,
  language: string | undefined
): BundledLanguage | SpecialLanguage {
  const normalizedLanguage = language?.trim().toLowerCase();
  if (!normalizedLanguage || normalizedLanguage === AUTO_SHIKI_LANGUAGE) {
    return inferShikiLanguage(fileName);
  }

  if (normalizedLanguage === "text") {
    return "text";
  }

  const bundledLanguage = shikiLanguagesByAlias.get(normalizedLanguage);
  if (!bundledLanguage) {
    throw new Error(`Unsupported shiki language '${language}'.`);
  }

  return bundledLanguage;
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

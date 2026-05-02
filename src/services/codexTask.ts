import fs from "fs";
import os from "os";
import path from "path";
import {
  AgentCliExecutionError,
  buildAgentTaskPrompt,
  executeAgentCliOnPreparedBranch,
  parsePositiveInteger,
  type OpencodeCapturedLogs,
  type OpencodeExecutionCallbacks,
} from "./agentCliTask";
import type { OpencodeTaskOptions } from "./opencodeTask";

const TWO_HOURS_IN_SECONDS = 2 * 60 * 60;
const DEFAULT_CODEX_MODEL = "gpt-5.2-codex";
const DEFAULT_CODEX_TIMEOUT_MS = TWO_HOURS_IN_SECONDS * 1_000;
const DEFAULT_CODEX_SESSION_SYNC_INTERVAL_MS = 15_000;
const DEFAULT_CODEX_SESSION_TEST_DETAIL_LIMIT = 200;
const CODEX_SESSION_TEST_PATTERN =
  /\b(test|tests|testing|vitest|jest|mocha|npm test|pnpm test|yarn test|passed|failed|failures?)\b/i;

export class CodexExecutionError extends AgentCliExecutionError {}

export async function executeCodexOnPreparedBranch(
  options: OpencodeTaskOptions,
  branch: string,
  pullRequestNumber: number,
  callbacks?: OpencodeExecutionCallbacks
): Promise<OpencodeCapturedLogs> {
  const prompt = buildCodexPrompt(options.problemStatement, branch, pullRequestNumber);
  const model = resolveCodexModel(options.model);
  let codexSessionId: string | null = null;
  let codexSessionFilePath: string | null = null;
  let codexSessionExport: unknown = undefined;
  let lastSerializedSessionExport: string | undefined;
  const detectSessionIdFromOutput = (output: string): void => {
    if (codexSessionId) {
      return;
    }

    const detectedSessionId = parseCodexSessionId(output);
    if (!detectedSessionId) {
      return;
    }

    codexSessionId = detectedSessionId;
  };

  const syncSessionState = async (): Promise<void> => {
    if (!codexSessionId) {
      return;
    }

    const sessionFilePath =
      codexSessionFilePath ?? await findCodexSessionJsonlPath(codexSessionId);
    if (sessionFilePath && sessionFilePath !== codexSessionFilePath) {
      codexSessionFilePath = sessionFilePath;
    }

    const exportedSession = await exportCodexSessionDetails(
      codexSessionId,
      sessionFilePath ?? codexSessionFilePath
    );
    const serializedSession = JSON.stringify(exportedSession);
    if (serializedSession !== lastSerializedSessionExport) {
      codexSessionExport = exportedSession;
      lastSerializedSessionExport = serializedSession;
    }
  };

  return executeAgentCliOnPreparedBranch(
    options,
    {
      runner: "codex",
      commandLabel: "codex",
      bin: getCodexBin(),
      args: (cwd) => buildCodexArgs(options, model, cwd),
      prompt,
      cwd: "",
      branch,
      defaultTimeoutMs: DEFAULT_CODEX_TIMEOUT_MS,
      timeoutEnvVar: "CODEX_TIMEOUT_MS",
      outputLimitEnvVar: "CODEX_OUTPUT_LIMIT",
      logFlushIntervalEnvVar: "CODEX_LOG_FLUSH_INTERVAL_MS",
      sessionSyncIntervalEnvVar: "CODEX_SESSION_SYNC_INTERVAL_MS",
      defaultSessionSyncIntervalMs: DEFAULT_CODEX_SESSION_SYNC_INTERVAL_MS,
      loggerName: "codex-task",
      onOutputUpdated: detectSessionIdFromOutput,
      syncSessionState,
      getSessionState: () => ({
        codexSessionId: codexSessionId ?? undefined,
        codexSessionFilePath: codexSessionFilePath ?? undefined,
        codexSessionExport,
      }),
      logContext: {
        model,
        reasoningEffort: options.reasoningEffort,
        reasoningSummary: options.reasoningSummary,
        verbosity: options.verbosity,
        codexWebSearch: options.codexWebSearch === true,
      },
    },
    callbacks
  );
}

function getCodexBin(): string {
  return (process.env.CODEX_BIN || "codex").trim();
}

export function resolveCodexModel(model: string | null | undefined): string {
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  if (normalizedModel) {
    return normalizedModel;
  }

  const configuredModel = process.env.CODEX_MODEL?.trim();
  if (configuredModel) {
    return configuredModel;
  }

  return DEFAULT_CODEX_MODEL;
}

export function buildCodexArgs(
  options: Pick<
    OpencodeTaskOptions,
    "reasoningEffort" | "reasoningSummary" | "verbosity" | "codexWebSearch"
  >,
  model: string,
  cwd: string
): string[] {
  const args = ["exec", "--model", model];

  if (options.reasoningEffort) {
    args.push("--config", `model_reasoning_effort=${options.reasoningEffort}`);
  }

  if (options.reasoningSummary) {
    args.push("--config", `model_reasoning_summary=${options.reasoningSummary}`);
  }

  if (options.verbosity) {
    args.push("--config", `model_verbosity=${options.verbosity}`);
  }

  args.push("--cd", cwd, "--dangerously-bypass-approvals-and-sandbox");

  if (options.codexWebSearch) {
    args.push("--search");
  }

  args.push("-");

  return args;
}

export function buildCodexPrompt(
  problemStatement: string,
  branch: string,
  pullRequestNumber: number
): string {
  return buildAgentTaskPrompt(problemStatement, branch, pullRequestNumber);
}

export function parseCodexSessionId(output: string): string | null {
  const match = output.match(/^session id:\s*([^\s]+)\s*$/im);
  return match?.[1] ?? null;
}

export async function findCodexSessionJsonlPath(
  sessionId: string,
  rootDir = getCodexSessionsRoot()
): Promise<string | null> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return null;
  }

  const candidates = await listCodexRolloutFiles(rootDir);
  for (const filePath of candidates) {
    if (await fileContains(filePath, normalizedSessionId)) {
      return filePath;
    }
  }

  return null;
}

async function exportCodexSessionDetails(
  sessionId: string,
  sessionFilePath: string | null
): Promise<unknown> {
  if (!sessionFilePath) {
    return {
      sessionId,
      sessionFilePath: null,
      testDetails: [],
    };
  }

  return {
    sessionId,
    sessionFilePath,
    testDetails: await grepCodexSessionTestDetails(sessionFilePath),
  };
}

async function grepCodexSessionTestDetails(
  sessionFilePath: string
): Promise<string[]> {
  const contents = await fs.promises.readFile(sessionFilePath, "utf8");
  const limit = parsePositiveInteger(
    process.env.CODEX_SESSION_TEST_DETAIL_LIMIT,
    DEFAULT_CODEX_SESSION_TEST_DETAIL_LIMIT
  );

  const matches: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line || !CODEX_SESSION_TEST_PATTERN.test(line)) {
      continue;
    }

    matches.push(line);
    if (matches.length >= limit) {
      break;
    }
  }

  return matches;
}

async function listCodexRolloutFiles(rootDir: string): Promise<string[]> {
  try {
    const stats = await fs.promises.stat(rootDir);
    if (!stats.isDirectory()) {
      return [];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  await collectCodexRolloutFiles(rootDir, files);
  return files.sort((a, b) => b.localeCompare(a));
}

async function collectCodexRolloutFiles(
  dirPath: string,
  files: string[]
): Promise<void> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await collectCodexRolloutFiles(entryPath, files);
      continue;
    }

    if (entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
}

async function fileContains(filePath: string, value: string): Promise<boolean> {
  const contents = await fs.promises.readFile(filePath, "utf8");
  return contents.includes(value);
}

function getCodexSessionsRoot(): string {
  return (
    process.env.CODEX_SESSIONS_DIR?.trim() ||
    path.join(os.homedir(), ".codex", "sessions")
  );
}

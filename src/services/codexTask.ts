import fs from "fs";
import os from "os";
import path from "path";
import {
  AgentCliExecutionError,
  buildAgentTaskPrompt,
  parsePositiveInteger,
  runAgentCli,
  type AgentCliRunnerConfig,
  type AgentCliSessionState,
  type OpencodeCapturedLogs,
  type OpencodeExecutionCallbacks,
} from "./agentCliTask";
import { AgentTaskCanceledError } from "./agentTaskControl";
import {
  buildAgentReviewPrompt,
  commitAndPushFinalChanges,
  getOpencodeTaskCloneDir,
  type OpencodeTaskOptions,
} from "./opencodeTask";

const TWO_HOURS_IN_SECONDS = 2 * 60 * 60;
const DEFAULT_CODEX_MODEL = "gpt-5.2-codex";
const DEFAULT_CODEX_TIMEOUT_MS = TWO_HOURS_IN_SECONDS * 1_000;
const DEFAULT_CODEX_SESSION_SYNC_INTERVAL_MS = 15_000;
const DEFAULT_CODEX_SESSION_TEST_DETAIL_LIMIT = 200;
const CODEX_SESSION_TEST_PATTERN =
  /\b(test|tests|testing|vitest|jest|mocha|npm test|pnpm test|yarn test|passed|failed|failures?)\b/i;

export class CodexExecutionError extends AgentCliExecutionError {}

export interface CodexSessionTokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  modelContextWindow?: number;
}

export interface CodexSessionExport {
  sessionId: string;
  sessionFilePath: string | null;
  testDetails: string[];
  tokenUsage?: CodexSessionTokenUsage;
}

type CodexPhaseLabel = "plan" | "implement" | "summary" | "review";

interface CodexPhase {
  label: CodexPhaseLabel;
  args: AgentCliRunnerConfig["args"];
  prompt: string;
}

export async function executeCodexOnPreparedBranch(
  options: OpencodeTaskOptions,
  branch: string,
  pullRequestNumber: number,
  callbacks?: OpencodeExecutionCallbacks
): Promise<OpencodeCapturedLogs> {
  const cloneDir = getOpencodeTaskCloneDir(options);
  const model = resolveCodexModel(options.model);

  let codexSessionId: string | null = null;
  let codexSessionFilePath: string | null = null;
  let codexSessionExport: unknown = undefined;
  let lastSerializedSessionExport: string | undefined;

  let priorOutput = "";
  let priorStdout = "";
  let priorStderr = "";

  const detectSessionIdFromOutput = (output: string): void => {
    if (codexSessionId) {
      return;
    }
    const detectedSessionId = parseCodexSessionId(output);
    if (detectedSessionId) {
      codexSessionId = detectedSessionId;
    }
  };

  const syncSessionState = async (): Promise<void> => {
    if (!codexSessionId) {
      return;
    }

    const sessionFilePath =
      codexSessionFilePath ?? (await findCodexSessionJsonlPath(codexSessionId));
    if (sessionFilePath && sessionFilePath !== codexSessionFilePath) {
      codexSessionFilePath = sessionFilePath;
    }

    const exportedSession = await exportCodexSessionDetails(
      codexSessionId,
      sessionFilePath ?? codexSessionFilePath
    );
    const serialized = JSON.stringify(exportedSession);
    if (serialized !== lastSerializedSessionExport) {
      codexSessionExport = exportedSession;
      lastSerializedSessionExport = serialized;
    }
  };

  const getSessionState = (): AgentCliSessionState => ({
    codexSessionId: codexSessionId ?? undefined,
    codexSessionFilePath: codexSessionFilePath ?? undefined,
    codexSessionExport,
  });

  const buildCumulativeLogs = (
    phaseLogs?: Pick<OpencodeCapturedLogs, "output" | "stdout" | "stderr">
  ): OpencodeCapturedLogs => ({
    output: priorOutput + (phaseLogs?.output ?? ""),
    stdout: priorStdout + (phaseLogs?.stdout ?? ""),
    stderr: priorStderr + (phaseLogs?.stderr ?? ""),
    ...getSessionState(),
  });

  const wrappedCallbacks: OpencodeExecutionCallbacks | undefined = callbacks
    ? {
        isCancellationRequested: callbacks.isCancellationRequested,
        onLogsUpdated: callbacks.onLogsUpdated
          ? async (logs) => {
              await callbacks.onLogsUpdated!(buildCumulativeLogs(logs));
            }
          : undefined,
      }
    : undefined;

  const baseLogContext = {
    model,
    reasoningEffort: options.reasoningEffort,
    reasoningSummary: options.reasoningSummary,
    verbosity: options.verbosity,
    codexWebSearch: options.codexWebSearch === true,
  };

  if (options.systemPrompt) {
    const phaseConfig: AgentCliRunnerConfig = {
      runner: "codex",
      commandLabel: "codex",
      bin: getCodexBin(),
      args: (cwd) => buildCodexArgs(options, model, cwd),
      prompt: options.systemPrompt,
      cwd: cloneDir,
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
      getSessionState,
      logContext: { ...baseLogContext, customSystemPrompt: true },
    };

    let phaseLogs: OpencodeCapturedLogs;
    try {
      phaseLogs = await runAgentCli(options, phaseConfig, wrappedCallbacks);
    } catch (error) {
      if (error instanceof AgentTaskCanceledError) {
        throw new AgentTaskCanceledError(
          error.message,
          buildCumulativeLogs(error.logs)
        );
      }
      if (error instanceof AgentCliExecutionError) {
        throw new CodexExecutionError(
          error.message,
          buildCumulativeLogs(error.logs)
        );
      }
      throw error;
    }

    priorOutput += phaseLogs.output;
    priorStdout += phaseLogs.stdout;
    priorStderr += phaseLogs.stderr;

    if (await wrappedCallbacks?.isCancellationRequested?.()) {
      throw new AgentTaskCanceledError(
        "Task canceled by request.",
        buildCumulativeLogs()
      );
    }

    if (options.taskMode === "review") {
      return buildCumulativeLogs();
    }

    try {
      await commitAndPushFinalChanges(cloneDir, options, branch);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to commit and push final agent changes.";
      throw new CodexExecutionError(message, buildCumulativeLogs());
    }

    return buildCumulativeLogs();
  }

  const phases: CodexPhase[] = options.taskMode === "review"
    ? [
        {
          label: "review",
          args: (cwd) => buildCodexArgs(options, model, cwd),
          prompt: buildCodexReviewPrompt(
            options.problemStatement,
            branch,
            pullRequestNumber
          ),
        },
      ]
    : [
        {
          label: "plan",
          args: (cwd) => buildCodexArgs(options, model, cwd),
          prompt: buildCodexPlanPrompt(
            options.problemStatement,
            branch,
            pullRequestNumber
          ),
        },
        {
          label: "implement",
          args: () => buildCodexResumeArgs(options, model, codexSessionId ?? ""),
          prompt: buildCodexImplementationPrompt(branch, pullRequestNumber),
        },
        {
          label: "summary",
          args: () => buildCodexResumeArgs(options, model, codexSessionId ?? ""),
          prompt: buildCodexSummaryPrompt(branch, pullRequestNumber),
        },
      ];

  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    const isFirstPhase = index === 0;

    if (!isFirstPhase && !codexSessionId) {
      throw new CodexExecutionError(
        `Cannot start codex ${phase.label} phase: session id was not captured from the plan phase output.`,
        buildCumulativeLogs()
      );
    }

    const phaseConfig: AgentCliRunnerConfig = {
      runner: "codex",
      commandLabel: `codex (${phase.label})`,
      bin: getCodexBin(),
      args: phase.args,
      prompt: phase.prompt,
      cwd: cloneDir,
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
      getSessionState,
      logContext: { ...baseLogContext, phase: phase.label },
      skipBootstrap: !isFirstPhase,
    };

    let phaseLogs: OpencodeCapturedLogs;
    try {
      phaseLogs = await runAgentCli(options, phaseConfig, wrappedCallbacks);
    } catch (error) {
      if (error instanceof AgentTaskCanceledError) {
        throw new AgentTaskCanceledError(
          error.message,
          buildCumulativeLogs(error.logs)
        );
      }
      if (error instanceof AgentCliExecutionError) {
        throw new CodexExecutionError(
          error.message,
          buildCumulativeLogs(error.logs)
        );
      }
      throw error;
    }

    priorOutput += phaseLogs.output;
    priorStdout += phaseLogs.stdout;
    priorStderr += phaseLogs.stderr;

    if (await wrappedCallbacks?.isCancellationRequested?.()) {
      throw new AgentTaskCanceledError(
        "Task canceled by request.",
        buildCumulativeLogs()
      );
    }

    if (isFirstPhase && options.taskMode !== "review" && !codexSessionId) {
      throw new CodexExecutionError(
        "Failed to detect codex session id from the plan phase output. Cannot resume the session for the implementation phase.",
        buildCumulativeLogs()
      );
    }
  }

  if (options.taskMode === "review") {
    return buildCumulativeLogs();
  }

  try {
    await commitAndPushFinalChanges(cloneDir, options, branch);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to commit and push final agent changes.";
    throw new CodexExecutionError(message, buildCumulativeLogs());
  }

  return buildCumulativeLogs();
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
  appendCodexConfigFlags(args, options);
  args.push("--cd", cwd, "--dangerously-bypass-approvals-and-sandbox");

  if (options.codexWebSearch) {
    args.push("--search");
  }

  args.push("-");

  return args;
}

export function buildCodexResumeArgs(
  options: Pick<
    OpencodeTaskOptions,
    "reasoningEffort" | "reasoningSummary" | "verbosity" | "codexWebSearch"
  >,
  model: string,
  sessionId: string
): string[] {
  const args = ["exec", "resume", sessionId, "--model", model];
  appendCodexConfigFlags(args, options);
  args.push("--dangerously-bypass-approvals-and-sandbox");

  if (options.codexWebSearch) {
    args.push("--search");
  }

  args.push("-");

  return args;
}

function appendCodexConfigFlags(
  args: string[],
  options: Pick<
    OpencodeTaskOptions,
    "reasoningEffort" | "reasoningSummary" | "verbosity"
  >
): void {
  if (options.reasoningEffort) {
    args.push("--config", `model_reasoning_effort=${options.reasoningEffort}`);
  }

  if (options.reasoningSummary) {
    args.push("--config", `model_reasoning_summary=${options.reasoningSummary}`);
  }

  if (options.verbosity) {
    args.push("--config", `model_verbosity=${options.verbosity}`);
  }
}

export function buildCodexPrompt(
  problemStatement: string,
  branch: string,
  pullRequestNumber: number
): string {
  return buildAgentTaskPrompt(problemStatement, branch, pullRequestNumber);
}

export function buildCodexPlanPrompt(
  problemStatement: string,
  branch: string,
  pullRequestNumber: number
): string {
  return [
    `You are already on branch '${branch}' with pull request #${pullRequestNumber} created.`,
    "This is step 1 of 3 (PLAN). Read the user's task carefully and produce a concrete plan.",
    `Then post the plan as a comment on pull request #${pullRequestNumber}.`,
    "Do NOT start implementing in this step — only create and post the plan.",
    "Do not create another branch or pull request.",
    "Be maximally proactive and make your own decisions; do not ask the user for help.",
    "User instructions starts here:",
    problemStatement,
  ].join("\n");
}

export function buildCodexReviewPrompt(
  problemStatement: string,
  branch: string,
  pullRequestNumber: number
): string {
  return buildAgentReviewPrompt(problemStatement, branch, pullRequestNumber);
}

export function buildCodexImplementationPrompt(
  branch: string,
  pullRequestNumber: number
): string {
  return [
    "This is step 2 of 3 (IMPLEMENT). The same codex session is being resumed; you have just posted a plan.",
    `You are on branch '${branch}' for pull request #${pullRequestNumber}.`,
    "Now follow that plan. Edit files, run tests as needed, and commit and push your changes as you go.",
    "Do not create another branch or pull request.",
    "Do not post a final summary in this step — that is step 3.",
    "Be maximally proactive, do your own research, and make your own decisions.",
    "Make sure all your changes are committed and pushed before you finish — do not leave work uncommitted.",
  ].join("\n");
}

export function buildCodexSummaryPrompt(
  branch: string,
  pullRequestNumber: number
): string {
  return [
    "This is step 3 of 3 (SUMMARY). The same codex session is being resumed; the implementation is complete.",
    `You are on branch '${branch}' for pull request #${pullRequestNumber}.`,
    `Post a detailed summary report as a comment on pull request #${pullRequestNumber}.`,
    "Cover: what changed, why, the key files touched, and any tests run with their results.",
    "Do not edit code or create new commits in this step — only post the summary comment.",
    "Do not create another branch or pull request.",
  ].join("\n");
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
): Promise<CodexSessionExport> {
  if (!sessionFilePath) {
    return {
      sessionId,
      sessionFilePath: null,
      testDetails: [],
    };
  }

  const contents = await fs.promises.readFile(sessionFilePath, "utf8");
  const tokenUsage = parseCodexSessionTokenUsage(contents);
  return {
    sessionId,
    sessionFilePath,
    testDetails: grepCodexSessionTestDetails(contents),
    ...(tokenUsage ? { tokenUsage } : {}),
  };
}

function grepCodexSessionTestDetails(contents: string): string[] {
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

export function parseCodexSessionTokenUsage(
  contents: string
): CodexSessionTokenUsage | undefined {
  let latestUsage: CodexSessionTokenUsage | undefined;

  for (const line of contents.split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    const event = parseJsonRecord(line);
    const payload = asRecord(event?.payload);
    if (payload?.type !== "token_count") {
      continue;
    }

    const info = asRecord(payload.info);
    const totalTokenUsage = asRecord(info?.total_token_usage);
    const usage = buildCodexSessionTokenUsage(
      totalTokenUsage,
      readFiniteNumber(info, "model_context_window")
    );
    if (usage) {
      latestUsage = usage;
    }
  }

  return latestUsage;
}

function buildCodexSessionTokenUsage(
  usage: Record<string, unknown> | null,
  modelContextWindow: number | undefined
): CodexSessionTokenUsage | undefined {
  if (!usage) {
    return modelContextWindow === undefined
      ? undefined
      : { modelContextWindow };
  }

  const summary: CodexSessionTokenUsage = {
    ...(readFiniteNumber(usage, "input_tokens") !== undefined
      ? { inputTokens: readFiniteNumber(usage, "input_tokens") }
      : {}),
    ...(readFiniteNumber(usage, "cached_input_tokens") !== undefined
      ? { cachedInputTokens: readFiniteNumber(usage, "cached_input_tokens") }
      : {}),
    ...(readFiniteNumber(usage, "output_tokens") !== undefined
      ? { outputTokens: readFiniteNumber(usage, "output_tokens") }
      : {}),
    ...(readFiniteNumber(usage, "reasoning_output_tokens") !== undefined
      ? { reasoningOutputTokens: readFiniteNumber(usage, "reasoning_output_tokens") }
      : {}),
    ...(readFiniteNumber(usage, "total_tokens") !== undefined
      ? { totalTokens: readFiniteNumber(usage, "total_tokens") }
      : {}),
    ...(modelContextWindow !== undefined ? { modelContextWindow } : {}),
  };

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readFiniteNumber(
  record: Record<string, unknown> | null | undefined,
  key: string
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
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

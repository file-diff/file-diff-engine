import {
  AgentCliExecutionError,
  buildAgentTaskPrompt,
  executeAgentCliOnPreparedBranch,
  type OpencodeCapturedLogs,
  type OpencodeExecutionCallbacks,
} from "./agentCliTask";
import type { OpencodeTaskOptions } from "./opencodeTask";

const TWO_HOURS_IN_SECONDS = 2 * 60 * 60;
const DEFAULT_CLAUDE_MODEL = "sonnet";
const DEFAULT_CLAUDE_TIMEOUT_MS = TWO_HOURS_IN_SECONDS * 1_000;

export class ClaudeExecutionError extends AgentCliExecutionError {}

export async function executeClaudeOnPreparedBranch(
  options: OpencodeTaskOptions,
  branch: string,
  pullRequestNumber: number,
  callbacks?: OpencodeExecutionCallbacks
): Promise<OpencodeCapturedLogs> {
  const model = resolveClaudeModel(options.model);
  return executeAgentCliOnPreparedBranch(
    options,
    {
      runner: "claude",
      commandLabel: "claude",
      bin: getClaudeBin(),
      args: buildClaudeArgs(model),
      prompt: buildClaudePrompt(options.problemStatement, branch, pullRequestNumber),
      cwd: "",
      branch,
      defaultTimeoutMs: DEFAULT_CLAUDE_TIMEOUT_MS,
      timeoutEnvVar: "CLAUDE_TIMEOUT_MS",
      outputLimitEnvVar: "CLAUDE_OUTPUT_LIMIT",
      logFlushIntervalEnvVar: "CLAUDE_LOG_FLUSH_INTERVAL_MS",
      loggerName: "claude-task",
      logContext: {
        model,
      },
    },
    callbacks
  );
}

function getClaudeBin(): string {
  return (process.env.CLAUDE_BIN || "claude").trim();
}

export function resolveClaudeModel(model: string | null | undefined): string {
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  if (normalizedModel) {
    return normalizedModel;
  }

  const configuredModel = process.env.CLAUDE_MODEL?.trim();
  if (configuredModel) {
    return configuredModel;
  }

  return DEFAULT_CLAUDE_MODEL;
}

export function buildClaudeArgs(model: string): string[] {
  return [
    "-p",
    "--model",
    model,
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
  ];
}

export function buildClaudePrompt(
  problemStatement: string,
  branch: string,
  pullRequestNumber: number
): string {
  return buildAgentTaskPrompt(problemStatement, branch, pullRequestNumber);
}

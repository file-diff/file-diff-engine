import { createLogger } from "../utils/logger";

const logger = createLogger("slack");

export interface CodexSessionSlackTokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  modelContextWindow?: number;
}

export interface CodexSessionSlackInfo {
  sessionId?: string;
  sessionFilePath?: string;
  tokenUsage?: CodexSessionSlackTokenUsage;
}

export interface AgentTaskSlackNotification {
  owner: string;
  repoName: string;
  taskId: string;
  status: string;
  branch: string | null;
  durationMs: number;
  pullRequestUrl?: string;
  pullRequestActions?: string[];
  details?: string;
  codexSession?: CodexSessionSlackInfo;
}

export async function sendAgentTaskFinishedSlackNotification(
  notification: AgentTaskSlackNotification
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    logger.info("Skipping agent task Slack notification because SLACK_WEBHOOK_URL is not configured.", {
      taskId: notification.taskId,
      repo: `${notification.owner}/${notification.repoName}`,
    });
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: buildAgentTaskFinishedSlackMessage(notification),
    }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Slack webhook returned status ${response.status}: ${responseBody || response.statusText}`
    );
  }
}

export function buildAgentTaskFinishedSlackMessage(
  notification: AgentTaskSlackNotification
): string {
  const repo = `${notification.owner}/${notification.repoName}`;
  const linkUrl = notification.pullRequestUrl?.trim() || buildAgentTaskUrl(
    notification.owner,
    notification.repoName,
    notification.taskId
  );
  const linkLabel = notification.pullRequestUrl?.trim() ? "Pull request" : "Task";
  const lines = [
    buildAgentTaskHeadline(repo, notification.status),
    `Status: ${notification.status}`,
  ];

  if (notification.details) {
    lines.push(`Details: ${notification.details}`);
  }

  if (notification.branch) {
    lines.push(`Branch: ${notification.branch}`);
  }

  lines.push(`Duration: ${formatDuration(notification.durationMs)}`);
  lines.push(`${linkLabel}: ${linkUrl}`);
  appendCodexSessionLines(lines, notification.codexSession);

  if (notification.pullRequestActions?.length) {
    lines.push("Pull request actions:");
    for (const action of notification.pullRequestActions) {
      lines.push(`- ${action}`);
    }
  }

  return lines.join("\n");
}

function appendCodexSessionLines(
  lines: string[],
  codexSession: CodexSessionSlackInfo | undefined
): void {
  if (!codexSession || !hasCodexSessionInfo(codexSession)) {
    return;
  }

  lines.push("Codex session:");
  if (codexSession.sessionId) {
    lines.push(`- ID: ${codexSession.sessionId}`);
  }

  if (codexSession.sessionFilePath) {
    lines.push(`- Session file: cached (${codexSession.sessionFilePath})`);
  } else if (codexSession.sessionId) {
    lines.push("- Session file: not found");
  }

  const tokenUsage = formatCodexTokenUsage(codexSession.tokenUsage);
  if (tokenUsage) {
    lines.push(`- Token usage: ${tokenUsage}`);
  }
}

function hasCodexSessionInfo(codexSession: CodexSessionSlackInfo): boolean {
  return Boolean(
    codexSession.sessionId ||
      codexSession.sessionFilePath ||
      formatCodexTokenUsage(codexSession.tokenUsage)
  );
}

function formatCodexTokenUsage(
  tokenUsage: CodexSessionSlackTokenUsage | undefined
): string | null {
  if (!tokenUsage) {
    return null;
  }

  const parts = [
    formatTokenCount("total", tokenUsage.totalTokens),
    formatTokenCount("input", tokenUsage.inputTokens),
    formatTokenCount("cached input", tokenUsage.cachedInputTokens),
    formatTokenCount("output", tokenUsage.outputTokens),
    formatTokenCount("reasoning output", tokenUsage.reasoningOutputTokens),
    formatTokenCount("context window", tokenUsage.modelContextWindow),
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join("; ") : null;
}

function formatTokenCount(label: string, value: number | undefined): string | null {
  return value === undefined ? null : `${label} ${value.toLocaleString("en-US")}`;
}

function buildAgentTaskHeadline(repo: string, status: string): string {
  const normalizedStatus = status.trim().toLowerCase();

  if (normalizedStatus === "completed") {
    return `GitHub agent task finished for ${repo}`;
  }

  if (normalizedStatus === "failed" || normalizedStatus === "timeout") {
    return `GitHub agent task failed for ${repo}`;
  }

  if (normalizedStatus === "canceled") {
    return `GitHub agent task canceled for ${repo}`;
  }

  return `GitHub agent task ended for ${repo}`;
}

function buildAgentTaskUrl(owner: string, repoName: string, taskId: string): string {
  return `https://github.com/${owner}/${repoName}/tasks/${encodeURIComponent(taskId)}`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }

  parts.push(`${seconds}s`);
  return parts.join(" ");
}

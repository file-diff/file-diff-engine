import { createLogger } from "../utils/logger";

const logger = createLogger("slack");

export interface AgentTaskSlackNotification {
  owner: string;
  repoName: string;
  taskId: string;
  status: string;
  branch: string | null;
  durationMs: number;
  pullRequestActions?: string[];
  details?: string;
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

function buildAgentTaskFinishedSlackMessage(
  notification: AgentTaskSlackNotification
): string {
  const repo = `${notification.owner}/${notification.repoName}`;
  const taskUrl = buildAgentTaskUrl(
    notification.owner,
    notification.repoName,
    notification.taskId
  );
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
  lines.push(`Task: ${taskUrl}`);

  if (notification.pullRequestActions?.length) {
    lines.push("Pull request actions:");
    for (const action of notification.pullRequestActions) {
      lines.push(`- ${action}`);
    }
  }

  return lines.join("\n");
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

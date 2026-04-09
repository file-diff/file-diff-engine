import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendAgentTaskFinishedSlackNotification } from "../services/slack";

describe("slack", () => {
  const originalSlackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/test";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    if (originalSlackWebhookUrl === undefined) {
      delete process.env.SLACK_WEBHOOK_URL;
    } else {
      process.env.SLACK_WEBHOOK_URL = originalSlackWebhookUrl;
    }
    vi.unstubAllGlobals();
  });

  it("includes pull request actions in the Slack message when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
    });

    await sendAgentTaskFinishedSlackNotification({
      owner: "owner",
      repoName: "repo",
      taskId: "task-123",
      status: "completed",
      branch: "copilot/fix-1",
      durationMs: 61_000,
      pullRequestActions: [
        "Marked pull request #123 ready for review",
        "Merged pull request #123",
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.test/services/test",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: [
            "GitHub agent task finished for owner/repo",
            "Status: completed",
            "Branch: copilot/fix-1",
            "Duration: 1m 1s",
            "Task: https://github.com/owner/repo/tasks/task-123",
            "Pull request actions:",
            "- Marked pull request #123 ready for review",
            "- Merged pull request #123",
          ].join("\n"),
        }),
      })
    );
  });

  it("includes failure details in the Slack message when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
    });

    await sendAgentTaskFinishedSlackNotification({
      owner: "owner",
      repoName: "repo",
      taskId: "task-123",
      status: "failed",
      branch: "copilot/fix-1",
      durationMs: 61_000,
      details: "Agent task monitoring timed out before reaching a terminal state.",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.test/services/test",
      expect.objectContaining({
        body: JSON.stringify({
          text: [
            "GitHub agent task failed for owner/repo",
            "Status: failed",
            "Details: Agent task monitoring timed out before reaching a terminal state.",
            "Branch: copilot/fix-1",
            "Duration: 1m 1s",
            "Task: https://github.com/owner/repo/tasks/task-123",
          ].join("\n"),
        }),
      })
    );
  });

  it("omits the pull request actions section when there were no pull request updates", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
    });

    await sendAgentTaskFinishedSlackNotification({
      owner: "owner",
      repoName: "repo",
      taskId: "task-123",
      status: "completed",
      branch: null,
      durationMs: 3_000,
      pullRequestActions: [],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.test/services/test",
      expect.objectContaining({
        body: JSON.stringify({
          text: [
            "GitHub agent task finished for owner/repo",
            "Status: completed",
            "Duration: 3s",
            "Task: https://github.com/owner/repo/tasks/task-123",
          ].join("\n"),
        }),
      })
    );
  });
});

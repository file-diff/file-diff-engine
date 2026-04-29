import { describe, expect, it } from "vitest";
import { buildCodexPrompt } from "./codexTask";
import { buildAgentTaskFinishedSlackMessage } from "./slack";
import { buildOpencodePrompt, buildPullRequestBody } from "./opencodeTask";

describe("task messaging helpers", () => {
  it("includes the pull request report instruction in codex prompts", () => {
    expect(buildCodexPrompt("Fix the bug", "fde-agent/test")).toContain(
      "5. After done comment on pull request with detailed summary report"
    );
  });

  it("includes the pull request number in both prompts", () => {
    expect(buildCodexPrompt("Fix the bug", "fde-agent/test", 42)).toContain(
      "pull request #42"
    );
    expect(buildOpencodePrompt("Fix the bug", "fde-agent/test", 42)).toContain(
      "pull request #42"
    );
  });

  it("keeps the opencode prompt aligned with the codex prompt", () => {
    expect(buildOpencodePrompt("Fix the bug", "fde-agent/test", 42)).toBe(
      buildCodexPrompt("Fix the bug", "fde-agent/test", 42)
    );
  });

  it("includes all task options in the initial pull request body when present", () => {
    const body = buildPullRequestBody(
      {
        baseRef: "main",
        problemStatement: "Implement the requested change",
        model: "gpt-5.2-codex",
        taskRunner: "codex",
        reasoningEffort: "high",
        reasoningSummary: "detailed",
        verbosity: "medium",
        codexWebSearch: true,
        pullRequestCompletionMode: "AutoMerge",
      },
      "fde-agent/test"
    );

    expect(body).toContain("Base branch: `main`");
    expect(body).toContain("Task runner: `codex`");
    expect(body).toContain("Model: `gpt-5.2-codex`");
    expect(body).toContain("Reasoning effort: `high`");
    expect(body).toContain("Reasoning summary: `detailed`");
    expect(body).toContain("Verbosity: `medium`");
    expect(body).toContain("Web search: `enabled`");
    expect(body).toContain("Pull request completion mode: `AutoMerge`");
    expect(body).toContain(
      'Completion behavior: this task pull request starts as a draft. After the agent run completes successfully, it will be marked ready and auto-merge will be enabled if the repository setting "Allow auto-merge" is enabled.'
    );
  });

  it("uses the pull request link in Slack notifications when available", () => {
    expect(
      buildAgentTaskFinishedSlackMessage({
        owner: "file-diff",
        repoName: "file-diff-engine",
        taskId: "task-123",
        status: "completed",
        branch: "fde-agent/test",
        durationMs: 12_000,
        pullRequestUrl: "https://github.com/file-diff/file-diff-engine/pull/42",
      })
    ).toContain(
      "Pull request: https://github.com/file-diff/file-diff-engine/pull/42"
    );
  });

  it("includes pending auto-merge context in Slack pull request actions", () => {
    expect(
      buildAgentTaskFinishedSlackMessage({
        owner: "file-diff",
        repoName: "file-diff-engine",
        taskId: "task-123",
        status: "completed",
        branch: "fde-agent/test",
        durationMs: 12_000,
        pullRequestUrl: "https://github.com/file-diff/file-diff-engine/pull/42",
        pullRequestActions: [
          "Marked pull request #42 as ready for review.",
          "Requested auto-merge for pull request #42; GitHub has not merged it yet because required checks, approvals, or branch protection requirements may still be pending.",
        ],
      })
    ).toContain(
      "- Requested auto-merge for pull request #42; GitHub has not merged it yet because required checks, approvals, or branch protection requirements may still be pending."
    );
  });
});

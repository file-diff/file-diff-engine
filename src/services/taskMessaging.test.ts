import { describe, expect, it } from "vitest";
import { buildCodexPrompt, buildCodexReviewPrompt } from "./codexTask";
import { buildAgentTaskFinishedSlackMessage } from "./slack";
import {
  buildOpencodePrompt,
  buildPullRequestBody,
  buildPullRequestReviewProblemStatement,
} from "./opencodeTask";

describe("task messaging helpers", () => {
  it("includes the pull request report instruction in codex prompts", () => {
    expect(buildCodexPrompt("Fix the bug", "fd-agent/test")).toContain(
      "5. After done comment on pull request with detailed summary report"
    );
  });

  it("includes the pull request number in both prompts", () => {
    expect(buildCodexPrompt("Fix the bug", "fd-agent/test", 42)).toContain(
      "pull request #42"
    );
    expect(buildOpencodePrompt("Fix the bug", "fd-agent/test", 42)).toContain(
      "pull request #42"
    );
  });

  it("keeps the opencode prompt aligned with the codex prompt", () => {
    expect(buildOpencodePrompt("Fix the bug", "fd-agent/test", 42)).toBe(
      buildCodexPrompt("Fix the bug", "fd-agent/test", 42)
    );
  });

  it("builds a review problem statement from the branch and pull request number", () => {
    expect(
      buildPullRequestReviewProblemStatement("feature/review-me", 155)
    ).toBe(
      "Do the review of the code changes on branch feature/review-me with the pull request 155. Put your findings in the pull request comment."
    );
  });

  it("uses review-specific prompts that forbid edits and pushes", () => {
    const problemStatement = buildPullRequestReviewProblemStatement(
      "feature/review-me",
      155
    );
    const codexPrompt = buildCodexReviewPrompt(
      problemStatement,
      "feature/review-me",
      155
    );
    const opencodePrompt = buildOpencodePrompt(
      problemStatement,
      "feature/review-me",
      155,
      "review"
    );

    expect(codexPrompt).toBe(opencodePrompt);
    expect(codexPrompt).toContain("pull request #155");
    expect(codexPrompt).toContain("Post your findings as a pull request comment.");
    expect(codexPrompt).toMatch(/Do not edit files, commit changes, push changes/);
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
      "fd-agent/test"
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
      "Completion behavior: this task pull request starts as a draft. After the agent run completes successfully, it will be marked ready and the pull request will be merged directly. If the base branch is protected or required checks are not satisfied, the pull request will be left open and a notice posted instead."
    );
  });

  it("uses the pull request link in Slack notifications when available", () => {
    expect(
      buildAgentTaskFinishedSlackMessage({
        owner: "file-diff",
        repoName: "file-diff-engine",
        taskId: "task-123",
        status: "completed",
        branch: "fd-agent/test",
        durationMs: 12_000,
        pullRequestUrl: "https://github.com/file-diff/file-diff-engine/pull/42",
      })
    ).toContain(
      "Pull request: https://github.com/file-diff/file-diff-engine/pull/42"
    );
  });

  it("includes codex session metadata and token usage in Slack notifications", () => {
    const message = buildAgentTaskFinishedSlackMessage({
      owner: "file-diff",
      repoName: "file-diff-engine",
      taskId: "task-123",
      status: "completed",
      branch: "fd-agent/test",
      durationMs: 12_000,
      pullRequestUrl: "https://github.com/file-diff/file-diff-engine/pull/42",
      codexSession: {
        sessionId: "019ddb3e-de18-7122-8c4c-8d6b9b3c4fbf",
        sessionFilePath:
          "/home/docker/.codex/sessions/2026/04/29/rollout-test.jsonl",
        tokenUsage: {
          inputTokens: 1_500,
          cachedInputTokens: 1_200,
          outputTokens: 300,
          reasoningOutputTokens: 100,
          totalTokens: 1_800,
          modelContextWindow: 121_600,
        },
      },
    });

    expect(message).toContain("Codex session:");
    expect(message).toContain(
      "- ID: 019ddb3e-de18-7122-8c4c-8d6b9b3c4fbf"
    );
    expect(message).toContain(
      "- Session file: cached (/home/docker/.codex/sessions/2026/04/29/rollout-test.jsonl)"
    );
    expect(message).toContain(
      "- Token usage: total 1,800; input 1,500; cached input 1,200; output 300; reasoning output 100; context window 121,600"
    );
  });

  it("omits codex session details from Slack notifications when absent", () => {
    expect(
      buildAgentTaskFinishedSlackMessage({
        owner: "file-diff",
        repoName: "file-diff-engine",
        taskId: "task-123",
        status: "completed",
        branch: "fd-agent/test",
        durationMs: 12_000,
        pullRequestUrl: "https://github.com/file-diff/file-diff-engine/pull/42",
      })
    ).not.toContain("Codex session:");
  });

  it("includes merge result and branch deletion in Slack pull request actions", () => {
    expect(
      buildAgentTaskFinishedSlackMessage({
        owner: "file-diff",
        repoName: "file-diff-engine",
        taskId: "task-123",
        status: "completed",
        branch: "fd-agent/test",
        durationMs: 12_000,
        pullRequestUrl: "https://github.com/file-diff/file-diff-engine/pull/42",
        pullRequestActions: [
          "Marked pull request #42 as ready for review.",
          "Merged pull request #42 (abcdef1).",
          "Deleted branch 'fd-agent/test' after successful merge.",
        ],
      })
    ).toContain("- Deleted branch 'fd-agent/test' after successful merge.");
  });

  it("includes the protected-branch notice in Slack pull request actions", () => {
    expect(
      buildAgentTaskFinishedSlackMessage({
        owner: "file-diff",
        repoName: "file-diff-engine",
        taskId: "task-123",
        status: "completed",
        branch: "fd-agent/test",
        durationMs: 12_000,
        pullRequestUrl: "https://github.com/file-diff/file-diff-engine/pull/42",
        pullRequestActions: [
          "Pull request #42 could not be merged because the base branch 'main' is protected or required checks are not satisfied: At least 1 approving review is required by reviewers with write access.. Pull request was left open.",
        ],
      })
    ).toContain(
      "- Pull request #42 could not be merged because the base branch 'main' is protected or required checks are not satisfied: At least 1 approving review is required by reviewers with write access.. Pull request was left open."
    );
  });
});

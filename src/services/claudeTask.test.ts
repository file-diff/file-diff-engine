import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeArgs, buildClaudePrompt, resolveClaudeModel } from "./claudeTask";
import { buildCodexPrompt } from "./codexTask";

describe("claude task helpers", () => {
  const originalClaudeModel = process.env.CLAUDE_MODEL;

  afterEach(() => {
    process.env.CLAUDE_MODEL = originalClaudeModel;
  });

  it("builds claude print-mode args for unattended task execution", () => {
    expect(buildClaudeArgs("sonnet")).toEqual([
      "-p",
      "--model",
      "sonnet",
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
    ]);
  });

  it("resolves request, environment, and fallback models", () => {
    process.env.CLAUDE_MODEL = "opus";

    expect(resolveClaudeModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(resolveClaudeModel(undefined)).toBe("opus");

    process.env.CLAUDE_MODEL = "";
    expect(resolveClaudeModel(undefined)).toBe("sonnet");
  });

  it("keeps claude prompts aligned with codex prompts", () => {
    expect(buildClaudePrompt("Fix the bug", "fd-agent/test", 42)).toBe(
      buildCodexPrompt("Fix the bug", "fd-agent/test", 42)
    );
  });
});

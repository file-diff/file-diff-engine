import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  buildCodexImplementationPrompt,
  buildCodexPlanPrompt,
  buildCodexResumeArgs,
  buildCodexReviewPrompt,
  buildCodexSummaryPrompt,
  findCodexSessionJsonlPath,
  parseCodexSessionId,
  parseCodexSessionTokenUsage,
} from "./codexTask";

const tempDirs: string[] = [];

describe("codex task helpers", () => {
  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parses the codex startup session id", () => {
    expect(
      parseCodexSessionId(`OpenAI Codex v0.114.0 (research preview)
--------
workdir: /home/ubuntu/file-diff/file-diff-engine
model: gpt-5.4
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp]
reasoning effort: none
reasoning summaries: none
session id: 019ddb3e-de18-7122-8c4c-8d6b9b3c4fbf`)
    ).toBe("019ddb3e-de18-7122-8c4c-8d6b9b3c4fbf");
  });

  it("returns null when codex output has no session id", () => {
    expect(parseCodexSessionId("OpenAI Codex v0.114.0")).toBeNull();
  });

  it("finds the rollout jsonl file containing the codex session id", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sessions-"));
    tempDirs.push(rootDir);

    const datedDir = path.join(rootDir, "2026", "04", "29");
    fs.mkdirSync(datedDir, { recursive: true });
    fs.writeFileSync(
      path.join(
        datedDir,
        "rollout-2026-04-29T15-39-37-019dd9e5-5025-7103-92b2-7fa24bca0602.jsonl"
      ),
      '{"type":"metadata","session_id":"019ddb3e-de18-7122-8c4c-8d6b9b3c4fbf"}\n',
      "utf8"
    );

    await expect(
      findCodexSessionJsonlPath(
        "019ddb3e-de18-7122-8c4c-8d6b9b3c4fbf",
        rootDir
      )
    ).resolves.toMatch(/rollout-2026-04-29T15-39-37-.+\.jsonl$/);
  });

  it("extracts the latest token usage from codex rollout events", () => {
    const usage = parseCodexSessionTokenUsage(
      [
        "not json",
        JSON.stringify({
          timestamp: "2026-04-29T23:40:12.206Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 80,
                output_tokens: 20,
                reasoning_output_tokens: 5,
                total_tokens: 120,
              },
              model_context_window: 121600,
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-29T23:40:19.257Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 150,
                cached_input_tokens: 120,
                output_tokens: 30,
                reasoning_output_tokens: 10,
                total_tokens: 180,
              },
              model_context_window: 121600,
            },
          },
        }),
      ].join("\n")
    );

    expect(usage).toEqual({
      inputTokens: 150,
      cachedInputTokens: 120,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      totalTokens: 180,
      modelContextWindow: 121600,
    });
  });

  it("returns undefined when codex rollout token usage is unavailable", () => {
    expect(
      parseCodexSessionTokenUsage(
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "No token usage here",
          },
        })
      )
    ).toBeUndefined();
  });

  it("builds first-phase codex args that read the prompt from stdin", () => {
    expect(
      buildCodexArgs(
        {
          reasoningEffort: "medium",
          reasoningSummary: "concise",
          verbosity: "low",
          codexWebSearch: true,
        },
        "gpt-5.2-codex",
        "/work/repo"
      )
    ).toEqual([
      "exec",
      "--model",
      "gpt-5.2-codex",
      "--config",
      "model_reasoning_effort=medium",
      "--config",
      "model_reasoning_summary=concise",
      "--config",
      "model_verbosity=low",
      "--cd",
      "/work/repo",
      "--dangerously-bypass-approvals-and-sandbox",
      "--search",
      "-",
    ]);
  });

  it("builds resume codex args with the session id and stdin prompt", () => {
    expect(
      buildCodexResumeArgs(
        {
          reasoningEffort: "high",
          reasoningSummary: undefined,
          verbosity: undefined,
          codexWebSearch: false,
        },
        "gpt-5.2-codex",
        "019ddb3e-de18-7122-8c4c-8d6b9b3c4fbf"
      )
    ).toEqual([
      "exec",
      "resume",
      "019ddb3e-de18-7122-8c4c-8d6b9b3c4fbf",
      "--model",
      "gpt-5.2-codex",
      "--config",
      "model_reasoning_effort=high",
      "--dangerously-bypass-approvals-and-sandbox",
      "-",
    ]);
  });

  it("plan prompt mentions the branch, the PR number, and asks only for a plan", () => {
    const prompt = buildCodexPlanPrompt(
      "Fix the bug in foo.ts",
      "fd-agent/test",
      42
    );
    expect(prompt).toContain("fd-agent/test");
    expect(prompt).toContain("#42");
    expect(prompt).toMatch(/step 1 of 3/i);
    expect(prompt).toMatch(/plan/i);
    expect(prompt).toContain("Fix the bug in foo.ts");
    expect(prompt).toMatch(/do not.*implement/i);
  });

  it("implementation prompt references the resumed session and asks for commits", () => {
    const prompt = buildCodexImplementationPrompt("fd-agent/test", 42);
    expect(prompt).toMatch(/step 2 of 3/i);
    expect(prompt).toMatch(/resumed/i);
    expect(prompt).toContain("fd-agent/test");
    expect(prompt).toContain("#42");
    expect(prompt).toMatch(/commit.*push/i);
    expect(prompt).toMatch(/do not.*summary|summary.*step 3/i);
  });

  it("summary prompt asks for a PR comment only and forbids further code edits", () => {
    const prompt = buildCodexSummaryPrompt("fd-agent/test", 42);
    expect(prompt).toMatch(/step 3 of 3/i);
    expect(prompt).toContain("fd-agent/test");
    expect(prompt).toContain("#42");
    expect(prompt).toMatch(/summary/i);
    expect(prompt).toMatch(/do not edit code|do not edit/i);
  });

  it("review prompt asks for findings only and forbids code changes", () => {
    const prompt = buildCodexReviewPrompt(
      "Do the review of the code changes on branch fd-agent/test with the pull request 42. Put your findings in the pull request comment.",
      "fd-agent/test",
      42
    );

    expect(prompt).toContain("fd-agent/test");
    expect(prompt).toContain("#42");
    expect(prompt).toMatch(/Review the code changes/i);
    expect(prompt).toMatch(/Post your findings as a pull request comment/i);
    expect(prompt).toMatch(/Do not edit files, commit changes, push changes/i);
  });
});

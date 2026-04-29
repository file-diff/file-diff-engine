import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findCodexSessionJsonlPath,
  parseCodexSessionId,
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
});

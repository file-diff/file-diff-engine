import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findNewOpencodeSessionId,
  incrementBranchName,
  parseOpencodeSessionIds,
  runAgentBootstrapIfAvailable,
} from "./opencodeTask";

const tempDirs: string[] = [];

describe("opencode task helpers", () => {
  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parses session ids from opencode session list output", () => {
    expect(
      parseOpencodeSessionIds(`Session ID                      Title                                   Updated
───────────────────────────────────────────────────────────────────────────────
ses_226f167d4ffeE5CmXZjCl54HYL  Creating documentation                  1:45 PM
ses_227113e87ffe85L4H52wmCHwGg  New session - 2026-04-29T11:10:19.000Z  1:10 PM`)
    ).toEqual([
      "ses_226f167d4ffeE5CmXZjCl54HYL",
      "ses_227113e87ffe85L4H52wmCHwGg",
    ]);
  });

  it("detects the newly created session id", () => {
    expect(
      findNewOpencodeSessionId(
        ["ses_existing"],
        ["ses_new", "ses_existing"]
      )
    ).toBe("ses_new");
  });

  it("returns the first newly detected session id when several are present", () => {
    expect(
      findNewOpencodeSessionId(
        ["ses_existing"],
        ["ses_new_1", "ses_new_2", "ses_existing"]
      )
    ).toBe("ses_new_1");
  });

  it("returns null when no new session id is detected", () => {
    expect(
      findNewOpencodeSessionId(
        ["ses_existing"],
        ["ses_existing"]
      )
    ).toBeNull();
  });

  it("adds a -1 suffix when a branch has no trailing number", () => {
    expect(incrementBranchName("branch")).toBe("branch-1");
  });

  it("increments an existing numeric suffix", () => {
    expect(incrementBranchName("branch-1")).toBe("branch-2");
  });

  it("preserves suffix width when incrementing", () => {
    expect(incrementBranchName("branch-03")).toBe("branch-04");
  });

  it("skips the agent bootstrap when the script is unavailable", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bootstrap-"));
    tempDirs.push(rootDir);

    await expect(runAgentBootstrapIfAvailable(rootDir)).resolves.toBeUndefined();
  });

  it("runs the agent bootstrap script with bash from the repository root", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bootstrap-"));
    tempDirs.push(rootDir);
    const bootstrapDir = path.join(rootDir, "fd-agent");
    fs.mkdirSync(bootstrapDir, { recursive: true });
    fs.writeFileSync(
      path.join(bootstrapDir, "agent-bootstrap.sh"),
      [
        "printf '%s' \"$PWD\" > bootstrap-pwd.txt",
        "printf '%s' \"$BOOTSTRAP_MARKER\" > bootstrap-env.txt",
      ].join("\n"),
      "utf8"
    );

    await runAgentBootstrapIfAvailable(rootDir, {
      ...process.env,
      BOOTSTRAP_MARKER: "ran-through-bash",
    });

    expect(fs.readFileSync(path.join(rootDir, "bootstrap-pwd.txt"), "utf8")).toBe(
      rootDir
    );
    expect(fs.readFileSync(path.join(rootDir, "bootstrap-env.txt"), "utf8")).toBe(
      "ran-through-bash"
    );
  });

  it("surfaces bootstrap script failures before starting an agent", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bootstrap-"));
    tempDirs.push(rootDir);
    const bootstrapDir = path.join(rootDir, "fd-agent");
    fs.mkdirSync(bootstrapDir, { recursive: true });
    fs.writeFileSync(
      path.join(bootstrapDir, "agent-bootstrap.sh"),
      "echo 'setup failed' >&2\nexit 7\n",
      "utf8"
    );

    await expect(runAgentBootstrapIfAvailable(rootDir)).rejects.toThrow(
      "Agent bootstrap script failed: setup failed"
    );
  });
});

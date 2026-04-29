import { describe, expect, it } from "vitest";
import {
  findNewOpencodeSessionId,
  incrementBranchName,
  parseOpencodeSessionIds,
} from "./opencodeTask";

describe("opencode task helpers", () => {
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
});

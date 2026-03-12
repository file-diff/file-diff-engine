import { describe, expect, it } from "vitest";
import { GitHubApiError, parsePullRequestUrl } from "../services/githubApi";

describe("githubApi", () => {
  it("parsePullRequestUrl extracts owner, repo, and pull number from a full GitHub URL", () => {
    expect(
      parsePullRequestUrl("https://github.com/file-diff/file-diff-engine/pull/42")
    ).toEqual({
      owner: "file-diff",
      repo: "file-diff-engine",
      pullNumber: 42,
    });
  });

  it("parsePullRequestUrl rejects non-pull-request URLs", () => {
    expect(() => parsePullRequestUrl("https://github.com/file-diff/file-diff-engine"))
      .toThrow(GitHubApiError);
    expect(() => parsePullRequestUrl("https://github.example.com/file-diff/file-diff-engine/pull/42"))
      .toThrow("Invalid pull request URL. Expected a full GitHub pull request URL.");
  });
});

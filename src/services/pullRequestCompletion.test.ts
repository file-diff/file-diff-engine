import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPullRequestCompletionMode } from "./pullRequestCompletion";
import { JobRepository } from "../db/repository";
import { createTestDatabase } from "../__tests__/helpers/testDatabase";
import { GitHubApiError } from "./githubApi";

vi.mock("./githubApi", async () => {
  const actual = await vi.importActual<typeof import("./githubApi")>("./githubApi");
  return {
    ...actual,
    findOpenPullRequestByHeadBranch: vi.fn(),
    markPullRequestReady: vi.fn(),
    mergePullRequest: vi.fn(),
    deleteRemoteBranch: vi.fn(),
  };
});

import * as githubApi from "./githubApi";

describe("applyPullRequestCompletionMode", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("marks draft pull requests ready for AutoReady", async () => {
    vi.mocked(githubApi.findOpenPullRequestByHeadBranch).mockResolvedValue({
      number: 42,
      title: "Task PR",
      url: "https://github.com/file-diff/file-diff-engine/pull/42",
      state: "open",
      draft: true,
      baseBranch: "main",
    });
    vi.mocked(githubApi.markPullRequestReady).mockResolvedValue();

    await expect(
      applyPullRequestCompletionMode({
        repo: "file-diff/file-diff-engine",
        branch: "fd-agent/test",
        pullNumber: 42,
        mode: "AutoReady",
        token: "token",
      })
    ).resolves.toEqual(["Marked pull request #42 as ready for review."]);

    expect(githubApi.findOpenPullRequestByHeadBranch).toHaveBeenCalledWith(
      "file-diff/file-diff-engine",
      "fd-agent/test",
      "token"
    );
    expect(githubApi.markPullRequestReady).toHaveBeenCalledWith(
      "file-diff/file-diff-engine",
      42,
      "token"
    );
    expect(githubApi.mergePullRequest).not.toHaveBeenCalled();
  });

  it("marks draft pull requests ready, merges them, and deletes the branch for AutoMerge", async () => {
    vi.mocked(githubApi.findOpenPullRequestByHeadBranch).mockResolvedValue({
      number: 99,
      title: "Task PR",
      url: "https://github.com/file-diff/file-diff-engine/pull/99",
      state: "open",
      draft: true,
      baseBranch: "main",
    });
    vi.mocked(githubApi.markPullRequestReady).mockResolvedValue();
    vi.mocked(githubApi.mergePullRequest).mockResolvedValue({
      merged: true,
      message: "Pull Request successfully merged",
      sha: "abcdef1234567890",
    });
    vi.mocked(githubApi.deleteRemoteBranch).mockResolvedValue();

    await expect(
      applyPullRequestCompletionMode({
        repo: "file-diff/file-diff-engine",
        branch: "fd-agent/test",
        pullNumber: 99,
        mode: "AutoMerge",
        token: "token",
      })
    ).resolves.toEqual([
      "Marked pull request #99 as ready for review.",
      "Merged pull request #99 (abcdef1).",
      "Deleted branch 'fd-agent/test' after successful merge.",
    ]);

    expect(githubApi.mergePullRequest).toHaveBeenCalledWith(
      "file-diff/file-diff-engine",
      99,
      { token: "token" }
    );
    expect(githubApi.deleteRemoteBranch).toHaveBeenCalledWith(
      "file-diff/file-diff-engine",
      "fd-agent/test",
      "token"
    );
  });

  it("reports protected branch and skips deletion when merge is blocked", async () => {
    vi.mocked(githubApi.findOpenPullRequestByHeadBranch).mockResolvedValue({
      number: 100,
      title: "Task PR",
      url: "https://github.com/file-diff/file-diff-engine/pull/100",
      state: "open",
      draft: false,
      baseBranch: "main",
    });
    vi.mocked(githubApi.mergePullRequest).mockRejectedValue(
      new GitHubApiError(
        "At least 1 approving review is required by reviewers with write access.",
        405
      )
    );

    await expect(
      applyPullRequestCompletionMode({
        repo: "file-diff/file-diff-engine",
        branch: "fd-agent/test",
        pullNumber: 100,
        mode: "AutoMerge",
      })
    ).resolves.toEqual([
      "Pull request #100 could not be merged because the base branch 'main' is protected or required checks are not satisfied: At least 1 approving review is required by reviewers with write access.. Pull request was left open.",
    ]);

    expect(githubApi.deleteRemoteBranch).not.toHaveBeenCalled();
  });

  it("does not delete branch when GitHub reports merged=false", async () => {
    vi.mocked(githubApi.findOpenPullRequestByHeadBranch).mockResolvedValue({
      number: 101,
      title: "Task PR",
      url: "https://github.com/file-diff/file-diff-engine/pull/101",
      state: "open",
      draft: false,
      baseBranch: "main",
    });
    vi.mocked(githubApi.mergePullRequest).mockResolvedValue({
      merged: false,
      message: "Base branch was modified. Review and try the merge again.",
      sha: "",
    });

    await expect(
      applyPullRequestCompletionMode({
        repo: "file-diff/file-diff-engine",
        branch: "fd-agent/test",
        pullNumber: 101,
        mode: "AutoMerge",
      })
    ).resolves.toEqual([
      "Pull request #101 was not merged: Base branch was modified. Review and try the merge again.. Pull request was left open.",
    ]);
    expect(githubApi.deleteRemoteBranch).not.toHaveBeenCalled();
  });

  it("propagates non-blocking merge errors", async () => {
    vi.mocked(githubApi.findOpenPullRequestByHeadBranch).mockResolvedValue({
      number: 102,
      title: "Task PR",
      url: "https://github.com/file-diff/file-diff-engine/pull/102",
      state: "open",
      draft: false,
      baseBranch: "main",
    });
    vi.mocked(githubApi.mergePullRequest).mockRejectedValue(
      new GitHubApiError("Bad credentials", 401)
    );

    await expect(
      applyPullRequestCompletionMode({
        repo: "file-diff/file-diff-engine",
        branch: "fd-agent/test",
        pullNumber: 102,
        mode: "AutoMerge",
      })
    ).rejects.toThrow("Bad credentials");
    expect(githubApi.deleteRemoteBranch).not.toHaveBeenCalled();
  });

  it("merges but reports a soft warning if branch deletion fails", async () => {
    vi.mocked(githubApi.findOpenPullRequestByHeadBranch).mockResolvedValue({
      number: 103,
      title: "Task PR",
      url: "https://github.com/file-diff/file-diff-engine/pull/103",
      state: "open",
      draft: false,
      baseBranch: "main",
    });
    vi.mocked(githubApi.mergePullRequest).mockResolvedValue({
      merged: true,
      message: "ok",
      sha: "deadbeefcafebabe",
    });
    vi.mocked(githubApi.deleteRemoteBranch).mockRejectedValue(
      new GitHubApiError("Reference does not exist", 422)
    );

    await expect(
      applyPullRequestCompletionMode({
        repo: "file-diff/file-diff-engine",
        branch: "fd-agent/test",
        pullNumber: 103,
        mode: "AutoMerge",
      })
    ).resolves.toEqual([
      "Merged pull request #103 (deadbee).",
      "Pull request #103 merged but branch 'fd-agent/test' could not be deleted: Reference does not exist.",
    ]);
  });

  it("persists pull request completion mode on task jobs", async () => {
    const database = await createTestDatabase();
    const repository = new JobRepository(database);

    await repository.createAgentTaskJob({
      id: "job-1",
      repo: "file-diff/file-diff-engine",
      model: "deepseek-v4-flash",
      baseRef: "main",
      pullRequestCompletionMode: "AutoMerge",
    });

    await expect(repository.getAgentTaskJob("job-1")).resolves.toMatchObject({
      id: "job-1",
      repo: "file-diff/file-diff-engine",
      pullRequestCompletionMode: "AutoMerge",
    });
  });
});

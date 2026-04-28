import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPullRequestCompletionMode } from "./pullRequestCompletion";
import { JobRepository } from "../db/repository";
import { createTestDatabase } from "../__tests__/helpers/testDatabase";

vi.mock("./githubApi", () => ({
  findOpenPullRequestByHeadBranch: vi.fn(),
  markPullRequestReady: vi.fn(),
  mergePullRequest: vi.fn(),
}));

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
        branch: "fde-agent/test",
        pullNumber: 42,
        mode: "AutoReady",
        token: "token",
      })
    ).resolves.toEqual(["Marked pull request #42 as ready for review."]);

    expect(githubApi.findOpenPullRequestByHeadBranch).toHaveBeenCalledWith(
      "file-diff/file-diff-engine",
      "fde-agent/test",
      "token"
    );
    expect(githubApi.markPullRequestReady).toHaveBeenCalledWith(
      "file-diff/file-diff-engine",
      42,
      "token"
    );
    expect(githubApi.mergePullRequest).not.toHaveBeenCalled();
  });

  it("marks draft pull requests ready and merges for AutoMerge", async () => {
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
      sha: "abc123",
    });

    await expect(
      applyPullRequestCompletionMode({
        repo: "file-diff/file-diff-engine",
        branch: "fde-agent/test",
        pullNumber: 99,
        mode: "AutoMerge",
      })
    ).resolves.toEqual([
      "Marked pull request #99 as ready for review.",
      "Merged pull request #99.",
    ]);
  });

  it("persists pull request completion mode on task jobs", async () => {
    const database = await createTestDatabase();
    const repository = new JobRepository(database);

    await repository.createAgentTaskJob(
      "job-1",
      "file-diff/file-diff-engine",
      undefined,
      undefined,
      undefined,
      0,
      null,
      "deepseek-v4-flash",
      "main",
      "AutoMerge"
    );

    await expect(repository.getAgentTaskJob("job-1")).resolves.toMatchObject({
      id: "job-1",
      repo: "file-diff/file-diff-engine",
      pullRequestCompletionMode: "AutoMerge",
    });
  });
});

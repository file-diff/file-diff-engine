import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPullRequestCompletionMode } from "./pullRequestCompletion";
import { JobRepository } from "../db/repository";
import { createTestDatabase } from "../__tests__/helpers/testDatabase";

vi.mock("./githubApi", () => ({
  findOpenPullRequestByHeadBranch: vi.fn(),
  markPullRequestReady: vi.fn(),
  enablePullRequestAutoMerge: vi.fn(),
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
    expect(githubApi.enablePullRequestAutoMerge).not.toHaveBeenCalled();
  });

  it("marks draft pull requests ready and enables auto-merge for AutoMerge", async () => {
    vi.mocked(githubApi.findOpenPullRequestByHeadBranch).mockResolvedValue({
      number: 99,
      title: "Task PR",
      url: "https://github.com/file-diff/file-diff-engine/pull/99",
      state: "open",
      draft: true,
      baseBranch: "main",
    });
    vi.mocked(githubApi.markPullRequestReady).mockResolvedValue();
    vi.mocked(githubApi.enablePullRequestAutoMerge).mockResolvedValue();

    await expect(
      applyPullRequestCompletionMode({
        repo: "file-diff/file-diff-engine",
        branch: "fde-agent/test",
        pullNumber: 99,
        mode: "AutoMerge",
      })
    ).resolves.toEqual([
      "Marked pull request #99 as ready for review.",
      "Requested auto-merge for pull request #99; GitHub has not merged it yet because required checks, approvals, or branch protection requirements may still be pending.",
    ]);
  });

  it("surfaces a clear error when repository auto-merge is disabled", async () => {
    vi.mocked(githubApi.findOpenPullRequestByHeadBranch).mockResolvedValue({
      number: 100,
      title: "Task PR",
      url: "https://github.com/file-diff/file-diff-engine/pull/100",
      state: "open",
      draft: false,
      baseBranch: "main",
    });
    vi.mocked(githubApi.enablePullRequestAutoMerge).mockRejectedValue(
      new Error("Auto merge is not allowed for this repository")
    );

    await expect(
      applyPullRequestCompletionMode({
        repo: "file-diff/file-diff-engine",
        branch: "fde-agent/test",
        pullNumber: 100,
        mode: "AutoMerge",
      })
    ).rejects.toThrow(
      'GitHub auto-merge is disabled for repository \'file-diff/file-diff-engine\'. Enable the repository setting "Allow auto-merge" before using pull request completion mode AutoMerge.'
    );
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

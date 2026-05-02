import * as githubApi from "./githubApi";
import type { PullRequestCompletionMode } from "../types";

export async function applyPullRequestCompletionMode(options: {
  repo: string;
  branch: string;
  pullNumber: number;
  mode?: PullRequestCompletionMode;
  token?: string;
}): Promise<string[]> {
  if (!options.mode || options.mode === "None") {
    return [];
  }

  const actions: string[] = [];
  const pullRequest = await githubApi.findOpenPullRequestByHeadBranch(
    options.repo,
    options.branch,
    options.token
  );

  if (!pullRequest || pullRequest.number !== options.pullNumber) {
    throw new Error(
      `Pull request #${options.pullNumber} for branch '${options.branch}' was not found in repository '${options.repo}'.`
    );
  }

  if (pullRequest.draft) {
    await githubApi.markPullRequestReady(options.repo, options.pullNumber, options.token);
    actions.push(`Marked pull request #${options.pullNumber} as ready for review.`);
  }

  if (options.mode !== "AutoMerge") {
    return actions;
  }

  const autoMergeArgs = { token: options.token };
  const throwIfConfigError = (error: unknown) => {
    if (
      error instanceof Error &&
      error.message.includes("Auto merge is not allowed for this repository")
    ) {
      throw new Error(
        `GitHub auto-merge is disabled for repository '${options.repo}'. Enable the repository setting "Allow auto-merge" before using pull request completion mode AutoMerge.`
      );
    }
  };

  try {
    await githubApi.enablePullRequestAutoMerge(options.repo, options.pullNumber, autoMergeArgs);
  } catch (error) {
    throwIfConfigError(error);
    // Wait 15 seconds and retry once — GitHub sometimes needs time after a PR is marked ready
    await new Promise((resolve) => setTimeout(resolve, 15000));
    try {
      await githubApi.enablePullRequestAutoMerge(options.repo, options.pullNumber, autoMergeArgs);
    } catch (retryError) {
      throwIfConfigError(retryError);
      throw retryError;
    }
  }
  actions.push(
    `Requested auto-merge for pull request #${options.pullNumber}; GitHub has not merged it yet because required checks, approvals, or branch protection requirements may still be pending.`
  );
  return actions;
}

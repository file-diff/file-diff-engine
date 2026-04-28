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

  const result = await githubApi.mergePullRequest(options.repo, options.pullNumber, {
    token: options.token,
  });
  if (!result.merged) {
    throw new Error(
      result.message || `GitHub did not merge pull request #${options.pullNumber}.`
    );
  }

  actions.push(`Merged pull request #${options.pullNumber}.`);
  return actions;
}

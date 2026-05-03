import * as githubApi from "./githubApi";
import { GitHubApiError } from "./githubApi";
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

  let mergeResult: githubApi.MergePullRequestResult;
  try {
    mergeResult = await githubApi.mergePullRequest(options.repo, options.pullNumber, {
      token: options.token,
    });
  } catch (error) {
    if (isMergeBlockedError(error)) {
      const reason = error instanceof Error ? error.message : String(error);
      actions.push(
        `Pull request #${options.pullNumber} could not be merged because the base branch '${pullRequest.baseBranch}' is protected or required checks are not satisfied: ${reason}. Pull request was left open.`
      );
      return actions;
    }
    throw error;
  }

  if (!mergeResult.merged) {
    actions.push(
      `Pull request #${options.pullNumber} was not merged: ${mergeResult.message || "GitHub did not merge the pull request."}. Pull request was left open.`
    );
    return actions;
  }

  const mergedSha = mergeResult.sha ? ` (${mergeResult.sha.slice(0, 7)})` : "";
  actions.push(`Merged pull request #${options.pullNumber}${mergedSha}.`);

  try {
    await githubApi.deleteRemoteBranch(options.repo, options.branch, options.token);
    actions.push(`Deleted branch '${options.branch}' after successful merge.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    actions.push(
      `Pull request #${options.pullNumber} merged but branch '${options.branch}' could not be deleted: ${reason}.`
    );
  }

  return actions;
}

function isMergeBlockedError(error: unknown): boolean {
  if (!(error instanceof GitHubApiError)) {
    return false;
  }
  return error.statusCode === 405 || error.statusCode === 409 || error.statusCode === 422;
}

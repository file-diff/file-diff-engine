import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import { JobRepository } from "../../db/repository";
import type {
  AgentTaskJobInfo,
  BranchPermissionsRequest,
  BranchPermissionsResponse,
  CommitGraphItem,
  ErrorResponse,
  ListBranchesRequest,
  ListBranchesResponse,
  ListCommitsRequest,
  ListCommitsGraphResponse,
  ListCommitsResponse,
  ListRefsRequest,
  ListRefsResponse,
  ListOrganizationRepositoriesResponse,
  GitCacheStatsResponse,
  MergeBranchRequest,
  MergeBranchResponse,
  RevertToCommitRequest,
  RevertToCommitResponse,
  ResolveCommitRequest,
  ResolveCommitResponse,
  ResolvePullRequestRequest,
  ResolvePullRequestResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  CodexReasoningEffort,
  CodexReasoningSummary,
  CodexVerbosity,
  CreateTagRequest,
  CreateTagResponse,
  DeleteActionRunRequest,
  DeleteActionRunResponse,
  DeleteRemoteBranchRequest,
  DeleteRemoteBranchResponse,
  DeleteRepositoryRequest,
  DeleteRepositoryResponse,
  DeleteTagRequest,
  DeleteTagResponse,
  ListActionsRequest,
  ListActionsResponse,
  ListTagsRequest,
  ListTagsResponse,
  MarkPullRequestReadyRequest,
  MarkPullRequestReadyResponse,
  MergePullRequestRequest,
  MergePullRequestResponse,
  OpenPullRequestRequest,
  OpenPullRequestResponse,
  AgentTaskRunner,
  PullRequestCompletionMode,
} from "../../types";
import { revertToCommit, mergeBranch } from "../../github/operations";
import * as githubApi from "../../services/githubApi";
import {
  AgentTaskActionConflictError,
  cancelAgentTaskJob,
  deleteAgentTaskJob,
} from "../../services/agentTaskActions";
import { normalizeGitRef } from "../../services/opencodeTask";
import * as repoProcessor from "../../services/repoProcessor";
import { getCommitShort } from "../../utils/commit";
import {
  isValidOrganization,
  isValidRepo,
  logger,
  normalizeRepo,
  requireAdminBearerToken,
  requireViewerBearerToken,
} from "./shared";

const CREATE_TASK_ROUTE_RATE_LIMIT_MAX = 60;
const CREATE_TASK_ROUTE_RATE_LIMIT_WINDOW_MS = 60_000;
const PULL_REQUEST_COMPLETION_MODES: readonly PullRequestCompletionMode[] = [
  "None",
  "AutoReady",
  "AutoMerge",
];
const SUPPORTED_DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const SUPPORTED_AGENT_TASK_RUNNERS = ["codex", "opencode"] as const;
const DEFAULT_AGENT_TASK_RUNNER: AgentTaskRunner = "codex";
const DEFAULT_CODEX_MODEL = "gpt-5.2-codex";
const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = "medium";
const DEFAULT_CODEX_REASONING_SUMMARY: CodexReasoningSummary = "auto";
const SUPPORTED_CODEX_REASONING_EFFORTS: readonly CodexReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];
const SUPPORTED_CODEX_REASONING_SUMMARIES: readonly CodexReasoningSummary[] = [
  "none",
  "auto",
  "concise",
  "detailed",
];
const SUPPORTED_CODEX_VERBOSITY_LEVELS: readonly CodexVerbosity[] = [
  "low",
  "medium",
  "high",
];
type SupportedDeepSeekModel = (typeof SUPPORTED_DEEPSEEK_MODELS)[number];

function isSupportedDeepSeekModel(model: unknown): model is SupportedDeepSeekModel {
  return typeof model === "string" && SUPPORTED_DEEPSEEK_MODELS.includes(model as SupportedDeepSeekModel);
}

function isSupportedAgentTaskRunner(task: unknown): task is AgentTaskRunner {
  return typeof task === "string" && SUPPORTED_AGENT_TASK_RUNNERS.includes(task as AgentTaskRunner);
}

function isSupportedCodexReasoningEffort(
  value: unknown
): value is CodexReasoningEffort {
  return typeof value === "string" &&
    SUPPORTED_CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort);
}

function isSupportedCodexReasoningSummary(
  value: unknown
): value is CodexReasoningSummary {
  return typeof value === "string" &&
    SUPPORTED_CODEX_REASONING_SUMMARIES.includes(value as CodexReasoningSummary);
}

function isSupportedCodexVerbosity(value: unknown): value is CodexVerbosity {
  return typeof value === "string" &&
    SUPPORTED_CODEX_VERBOSITY_LEVELS.includes(value as CodexVerbosity);
}

function resolvePullRequestCompletionMode(body: CreateTaskRequest): {
  mode?: PullRequestCompletionMode;
  error?: string;
} {
  const { auto_ready, auto_merge, pull_request_completion_mode } = body;

  if (auto_ready !== undefined && typeof auto_ready !== "boolean") {
    return { error: "Field 'auto_ready' must be a boolean." };
  }

  if (auto_merge !== undefined && typeof auto_merge !== "boolean") {
    return { error: "Field 'auto_merge' must be a boolean." };
  }

  if (
    pull_request_completion_mode !== undefined &&
    !PULL_REQUEST_COMPLETION_MODES.includes(pull_request_completion_mode)
  ) {
    return {
      error:
        "Field 'pull_request_completion_mode' must be one of: None, AutoReady, AutoMerge.",
    };
  }

  let compatibilityMode: PullRequestCompletionMode | undefined;
  if (auto_merge === true) {
    compatibilityMode = "AutoMerge";
  } else if (auto_ready === true) {
    compatibilityMode = "AutoReady";
  }

  if (
    compatibilityMode &&
    pull_request_completion_mode !== undefined &&
    pull_request_completion_mode !== compatibilityMode
  ) {
    return {
      error:
        "Fields 'auto_ready'/'auto_merge' conflict with 'pull_request_completion_mode'.",
    };
  }

  return {
    mode: compatibilityMode ?? pull_request_completion_mode,
  };
}

export function registerDiscoveryRoutes(
  app: FastifyInstance,
  queue: Queue,
  jobRepo: JobRepository
): void {
  /**
   * POST /api/jobs/resolve
   * Body: { "repo": "owner/repo", "ref": "main" }
   * Resolves a Git ref to a full commit SHA.
   */
  app.post<{ Body: ResolveCommitRequest }>(
    "/resolve",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
    let { repo, ref } = request.body ?? {};
    if (!repo || !ref) {
      const response: ErrorResponse = {
        error: "Both 'repo' and 'ref' are required.",
      };
      return reply.code(400).send(response);
    }

    repo = normalizeRepo(repo);
    ref = ref.trim();

    if (!isValidRepo(repo)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    try {
      const commit = await repoProcessor.resolveRefToCommitHash(
        repoProcessor.getRepositoryUrl(repo),
        ref
      );
      const response: ResolveCommitResponse = {
        repo,
        ref,
        commit,
        commitShort: getCommitShort(commit),
      };
      return reply.code(200).send(response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to resolve git ref.";
      const response: ErrorResponse = { error: message };
      const statusCode =
        message === "Git ref is required."
          ? 400
          : message.startsWith("Unable to resolve git ref")
            ? 404
            : 500;
      return reply.code(statusCode).send(response);
    }
    }
  );

  /**
   * POST /api/jobs/revert-to-commit
   * Body: { "repo": "owner/repo", "commit": "<sha>", "branch": "main" }
   * Creates a new branch from the requested base branch with the tree restored to a past commit.
   */
  app.post<{ Body: RevertToCommitRequest }>(
    "/revert-to-commit",
    { preHandler: requireAdminBearerToken },
    async (request, reply) => {
    let { repo, commit, branch, githubKey } = request.body ?? {};
    if (!repo || !commit) {
      const response: ErrorResponse = {
        error: "Both 'repo' and 'commit' are required.",
      };
      return reply.code(400).send(response);
    }

    repo = normalizeRepo(repo);
    commit = commit.trim().toLowerCase();
    branch = branch?.trim() || "main";
    githubKey = githubKey?.trim() || undefined;

    if (!isValidRepo(repo)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    if (!/^[a-f0-9]{40}$/.test(commit)) {
      const response: ErrorResponse = {
        error: "Field 'commit' must be a full 40-character commit SHA.",
      };
      return reply.code(400).send(response);
    }

    try {
      const tmpDir = path.resolve(process.env.TMP_DIR || "tmp");
      const response: RevertToCommitResponse = await revertToCommit({
        repo,
        commit,
        branch,
        githubKey,
        workDir: path.join(tmpDir, "operations", `fde-github-revert-${Date.now()}`),
      });
      return reply.code(200).send(response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to revert repository to commit.";
      const response: ErrorResponse = { error: message };
      const statusCode =
        message === "Repository URL is required." ||
        message === "Field 'commit' must be a full 40-character commit SHA." ||
        message.endsWith(" is required.") ||
        message.includes("cannot start with '-'") ||
        message.includes("unsupported control characters")
          ? 400
          : 500;
      return reply.code(statusCode).send(response);
    }
    }
  );

  /**
   * POST /api/jobs/merge-branch
   * Body: { "repo": "owner/repo", "otherBranch": "feature", "baseBranch": "main" }
   * Creates a branch from baseBranch, merges otherBranch into it, and creates a pull request.
   * If the merge branch already exists, merges otherBranch into it.
   */
  app.post<{ Body: MergeBranchRequest }>(
    "/merge-branch",
    { preHandler: requireAdminBearerToken },
    async (request, reply) => {
    let { repo, baseBranch, otherBranch, githubKey } = request.body ?? {};
    if (!repo || !otherBranch) {
      const response: ErrorResponse = {
        error: "Both 'repo' and 'otherBranch' are required.",
      };
      return reply.code(400).send(response);
    }

    repo = normalizeRepo(repo);
    baseBranch = baseBranch?.trim() || "main";
    otherBranch = otherBranch.trim();
    githubKey = githubKey?.trim() || undefined;

    if (!isValidRepo(repo)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    try {
      const tmpDir = path.resolve(process.env.TMP_DIR || "tmp");
      const response: MergeBranchResponse = await mergeBranch({
        repo,
        baseBranch,
        otherBranch,
        githubKey,
        workDir: path.join(tmpDir, "operations", `fde-github-merge-${Date.now()}`),
      });
      return reply.code(200).send(response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to merge branch.";
      const response: ErrorResponse = { error: message };
      const statusCode =
        message === "Repository URL is required." ||
        message.endsWith(" is required.") ||
        message.includes("cannot start with '-'") ||
        message.includes("unsupported control characters")
          ? 400
          : 500;
      return reply.code(statusCode).send(response);
    }
    }
  );

  /**
   * POST /api/jobs/delete-remote-branch
   * Body: { "repo": "owner/repo", "branch": "branch-name" }
   * Deletes a remote branch from a GitHub repository.
   */
  app.post<{ Body: DeleteRemoteBranchRequest }>(
    "/delete-remote-branch",
    { preHandler: requireAdminBearerToken },
    async (request, reply) => {
    let { repo, branch, githubKey } = request.body ?? {};
    if (!repo || !branch) {
      const response: ErrorResponse = {
        error: "Both 'repo' and 'branch' are required.",
      };
      return reply.code(400).send(response);
    }

    repo = normalizeRepo(repo);
    branch = branch.trim();
    githubKey = githubKey?.trim() || undefined;

    if (!isValidRepo(repo)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    if (!branch || branch.startsWith("-")) {
      const response: ErrorResponse = {
        error: "Field 'branch' must be a non-empty branch name and cannot start with '-'.",
      };
      return reply.code(400).send(response);
    }

    const token =
      githubKey ||
      process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
      process.env.PUBLIC_GITHUB_TOKEN?.trim() ||
      undefined;

    try {
      await githubApi.deleteRemoteBranch(repo, branch, token);
      const response: DeleteRemoteBranchResponse = { repo, branch };
      return reply.code(200).send(response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to delete remote branch.";
      const response: ErrorResponse = { error: message };
      const statusCode =
        error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
      return reply.code(statusCode).send(response);
    }
    }
  );

  /**
   * POST /api/jobs/create-tag
   * Body: { "repo": "owner/repo", "tag": "v1.0.0", "commit": "<sha>" }
   * Creates and pushes a remote tag for a commit on GitHub.
   */
  app.post<{ Body: CreateTagRequest }>(
    "/create-tag",
    { preHandler: requireAdminBearerToken },
    async (request, reply) => {
    let { repo, tag, commit, githubKey } = request.body ?? {};
    if (!repo || !tag || !commit) {
      const response: ErrorResponse = {
        error: "Fields 'repo', 'tag', and 'commit' are required.",
      };
      return reply.code(400).send(response);
    }

    repo = normalizeRepo(repo);
    tag = tag.trim();
    commit = commit.trim().toLowerCase();
    githubKey = githubKey?.trim() || undefined;

    if (!isValidRepo(repo)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    if (!tag || tag.startsWith("-") || /[\u0000-\u001F\u007F]/.test(tag)) {
      const response: ErrorResponse = {
        error:
          "Field 'tag' must be a non-empty tag name, cannot start with '-', and cannot contain control characters.",
      };
      return reply.code(400).send(response);
    }

    if (!/^[a-f0-9]{40}$/.test(commit)) {
      const response: ErrorResponse = {
        error: "Field 'commit' must be a full 40-character commit SHA.",
      };
      return reply.code(400).send(response);
    }

    const token =
      githubKey ||
      process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
      process.env.PUBLIC_GITHUB_TOKEN?.trim() ||
      undefined;

    try {
      await githubApi.createTag(repo, tag, commit, token);
      const response: CreateTagResponse = {
        repo,
        tag,
        ref: `refs/tags/${tag}`,
        commit,
        commitShort: getCommitShort(commit),
      };
      return reply.code(201).send(response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to create tag.";
      const response: ErrorResponse = { error: message };
      const statusCode =
        error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
      return reply.code(statusCode).send(response);
    }
    }
  );

  /**
   * POST /api/jobs/branch-permissions
   * Body: { "repo": "owner/repo", "branch": "main" }
   * Checks whether the configured GitHub token can read from and write to the selected branch.
   */
  app.post<{ Body: BranchPermissionsRequest }>(
    "/branch-permissions",
    { preHandler: requireAdminBearerToken },
    async (request, reply) => {
    let { repo, branch, githubKey } = request.body ?? {};
    if (!repo || !branch) {
      const response: ErrorResponse = {
        error: "Both 'repo' and 'branch' are required.",
      };
      return reply.code(400).send(response);
    }

    repo = normalizeRepo(repo);
    branch = branch.trim();
    githubKey = githubKey?.trim() || undefined;

    if (!isValidRepo(repo)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    if (!branch || branch.startsWith("-")) {
      const response: ErrorResponse = {
        error: "Field 'branch' must be a non-empty branch name and cannot start with '-'.",
      };
      return reply.code(400).send(response);
    }

    const token =
      githubKey ||
      process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
      process.env.PUBLIC_GITHUB_TOKEN?.trim() ||
      undefined;

    try {
      const permissions = await githubApi.getBranchPermissions(repo, branch, token);
      const response: BranchPermissionsResponse = {
        repo,
        branch,
        read: permissions.read,
        write: permissions.write,
      };
      return reply.code(200).send(response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to determine branch permissions.";
      const response: ErrorResponse = { error: message };
      const statusCode =
        error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
      return reply.code(statusCode).send(response);
    }
    }
  );

  /**
   * POST /api/jobs/pull-request/ready
   * Body: { "repo": "owner/repo", "pullNumber": 123 }
   * Marks a draft pull request as ready for review.
   */
  app.post<{ Body: MarkPullRequestReadyRequest }>(
    "/pull-request/ready",
    { preHandler: requireAdminBearerToken },
    async (request, reply) => {
    let { repo, pullNumber, githubKey } = request.body ?? {};
    if (!repo || !pullNumber) {
      const response: ErrorResponse = {
        error: "Both 'repo' and 'pullNumber' are required.",
      };
      return reply.code(400).send(response);
    }

    repo = normalizeRepo(repo);
    githubKey = githubKey?.trim() || undefined;

    if (!isValidRepo(repo)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
      const response: ErrorResponse = {
        error: "Field 'pullNumber' must be a positive integer.",
      };
      return reply.code(400).send(response);
    }

    const token =
      githubKey ||
      process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
      process.env.PUBLIC_GITHUB_TOKEN?.trim() ||
      undefined;

    try {
      await githubApi.markPullRequestReady(repo, pullNumber, token);
      const response: MarkPullRequestReadyResponse = { repo, pullNumber };
      return reply.code(200).send(response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to mark pull request as ready.";
      const response: ErrorResponse = { error: message };
      const statusCode =
        error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
      return reply.code(statusCode).send(response);
    }
    }
  );

  /**
   * POST /api/jobs/pull-request/merge
   * Body: { "repo": "owner/repo", "pullNumber": 123, "mergeMethod": "squash" }
   * Merges a pull request.
   */
  app.post<{ Body: MergePullRequestRequest }>(
    "/pull-request/merge",
    { preHandler: requireAdminBearerToken },
    async (request, reply) => {
    let { repo, pullNumber, commitTitle, commitMessage, mergeMethod, githubKey } = request.body ?? {};
    if (!repo || !pullNumber) {
      const response: ErrorResponse = {
        error: "Both 'repo' and 'pullNumber' are required.",
      };
      return reply.code(400).send(response);
    }

    repo = normalizeRepo(repo);
    githubKey = githubKey?.trim() || undefined;
    commitTitle = commitTitle?.trim() || undefined;
    commitMessage = commitMessage?.trim() || undefined;

    if (!isValidRepo(repo)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
      const response: ErrorResponse = {
        error: "Field 'pullNumber' must be a positive integer.",
      };
      return reply.code(400).send(response);
    }

    if (mergeMethod && !["merge", "squash", "rebase"].includes(mergeMethod)) {
      const response: ErrorResponse = {
        error: "Field 'mergeMethod' must be one of 'merge', 'squash', or 'rebase'.",
      };
      return reply.code(400).send(response);
    }

    const token =
      githubKey ||
      process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
      process.env.PUBLIC_GITHUB_TOKEN?.trim() ||
      undefined;

    try {
      const result = await githubApi.mergePullRequest(repo, pullNumber, {
        commitTitle,
        commitMessage,
        mergeMethod,
        token,
      });
      const response: MergePullRequestResponse = {
        repo,
        pullNumber,
        merged: result.merged,
        message: result.message,
        sha: result.sha,
      };
      return reply.code(200).send(response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to merge pull request.";
      const response: ErrorResponse = { error: message };
      const statusCode =
        error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
      return reply.code(statusCode).send(response);
    }
    }
  );

  /**
   * POST /api/jobs/pull-request/open
   * Body: { "repo": "owner/repo", "head": "feature-branch", "base": "main", "draft": true }
   * Opens a new pull request. Defaults to the last commit message on the head branch
   * for the title and description if not provided.
   */
  app.post<{ Body: OpenPullRequestRequest }>(
    "/pull-request/open",
    { preHandler: requireAdminBearerToken },
    async (request, reply) => {
    let { repo, head, base, title, body: prBody, draft, githubKey } = request.body ?? {};
    if (!repo || !head) {
      const response: ErrorResponse = {
        error: "Both 'repo' and 'head' are required.",
      };
      return reply.code(400).send(response);
    }

    repo = normalizeRepo(repo);
    head = head.trim();
    base = base?.trim() || "main";
    title = title?.trim() || undefined;
    prBody = prBody?.trim() || undefined;
    githubKey = githubKey?.trim() || undefined;

    if (!isValidRepo(repo)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    if (head.startsWith("-")) {
      const response: ErrorResponse = {
        error: "Field 'head' must be a non-empty branch name and cannot start with '-'.",
      };
      return reply.code(400).send(response);
    }

    if (base.startsWith("-")) {
      const response: ErrorResponse = {
        error: "Field 'base' must be a valid branch name and cannot start with '-'.",
      };
      return reply.code(400).send(response);
    }

    if (draft !== undefined && typeof draft !== "boolean") {
      const response: ErrorResponse = {
        error: "Field 'draft' must be a boolean.",
      };
      return reply.code(400).send(response);
    }

    const token =
      githubKey ||
      process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
      process.env.PUBLIC_GITHUB_TOKEN?.trim() ||
      undefined;

    // If no title provided, fetch the last commit on the head branch to use as default
    if (!title) {
      const lastCommit = await githubApi.getLastCommitOnBranch(repo, head, token);
      if (lastCommit?.message) {
        const firstLine = lastCommit.message.split("\n")[0].trim();
        title = firstLine || head;
        if (!prBody) {
          prBody = lastCommit.message;
        }
      } else {
        title = head;
      }
    }

    try {
      const result = await githubApi.createPullRequest(repo, head, base, {
        title,
        body: prBody,
        draft: draft ?? false,
        token,
      });
      const response: OpenPullRequestResponse = {
        repo,
        pullNumber: result.number,
        title: result.title,
        url: result.url,
        draft: result.draft,
      };
      return reply.code(201).send(response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to open pull request.";
      const response: ErrorResponse = { error: message };
      const statusCode =
        error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
      return reply.code(statusCode).send(response);
    }
    }
  );

  /**
   * POST /api/jobs/pull-request/resolve
   * Body: { "pullRequestUrl": "https://github.com/owner/repo/pull/123" }
   * Resolves a GitHub pull request into source and target commits.
   */
  app.post<{ Body: ResolvePullRequestRequest }>(
    "/pull-request/resolve",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
      const pullRequestUrl = request.body?.pullRequestUrl?.trim();
      if (!pullRequestUrl) {
        const response: ErrorResponse = {
          error: "Field 'pullRequestUrl' is required.",
        };
        return reply.code(400).send(response);
      }

      try {
        const response: ResolvePullRequestResponse =
          await githubApi.resolvePullRequest(pullRequestUrl);
        return reply.code(200).send(response);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unable to resolve GitHub pull request.";
        const response: ErrorResponse = { error: message };
        const statusCode =
          error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
        return reply.code(statusCode).send(response);
      }
    }
  );

  /**
   * POST /api/jobs/refs
   * Body: { "repo": "owner/repo" }
   * Lists available branch and tag refs for a repository.
   */
  app.post<{ Body: ListRefsRequest }>(
    "/refs",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
    let { repo } = request.body ?? {};
    if (!repo) {
      const response: ErrorResponse = {
        error: "Field 'repo' is required.",
      };
      return reply.code(400).send(response);
    }

    repo = normalizeRepo(repo);

    if (!isValidRepo(repo)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    try {
      const refs = await repoProcessor.listRepositoryRefs(
        repoProcessor.getRepositoryUrl(repo)
      );
      const response: ListRefsResponse = {
        repo,
        refs,
      };
      return reply.code(200).send(response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to list git refs.";
      const response: ErrorResponse = { error: message };
      return reply.code(500).send(response);
    }
    }
  );

  /**
   * POST /api/jobs/branches
   * Body: { "repo": "owner/repo" }
   * Lists repository branches with branch head metadata and pull request status.
   */
  app.post<{ Body: ListBranchesRequest }>(
    "/branches",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
    let { repo } = request.body ?? {};
    if (!repo) {
      const response: ErrorResponse = {
        error: "Field 'repo' is required.",
      };
      return reply.code(400).send(response);
    }

    repo = normalizeRepo(repo);

    if (!isValidRepo(repo)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    try {
      const branches = await repoProcessor.listRepositoryBranches(
        repoProcessor.getRepositoryUrl(repo)
      );
      const response: ListBranchesResponse = {
        repo,
        branches,
      };
      return reply.code(200).send(response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to list repository branches.";
      const response: ErrorResponse = { error: message };
      return reply.code(500).send(response);
    }
    }
  );

  /**
   * POST /api/jobs/commits
   * Body: { "repo": "owner/repo", "limit": 10 }
   * Lists repository commits from newest to oldest.
   */
  app.post<{ Body: ListCommitsRequest }>(
    "/commits",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
    let { repo, limit } = request.body ?? {};
    if (!repo) {
      const response: ErrorResponse = {
        error: "Field 'repo' is required.",
      };
      return reply.code(400).send(response);
    }

    repo = normalizeRepo(repo);

    if (!isValidRepo(repo)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    if (!Number.isInteger(limit) || limit <= 0) {
      const response: ErrorResponse = {
        error: "Field 'limit' must be a positive integer.",
      };
      return reply.code(400).send(response);
    }

    try {
      const commits = await repoProcessor.listRepositoryCommits(
        repoProcessor.getRepositoryUrl(repo),
        limit
      );
      const response: ListCommitsResponse = {
        repo,
        commits,
      };
      return reply.code(200).send(response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to list repository commits.";
      const response: ErrorResponse = { error: message };
      return reply.code(500).send(response);
    }
    }
  );

  /**
   * POST /api/jobs/commits/graph
   * Body: { "repo": "owner/repo", "limit": 10 }
   * Lists repository commits as node/edge items for visualization.
   */
  app.post<{ Body: ListCommitsRequest }>(
    "/commits/graph",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
    let { repo, limit } = request.body ?? {};
    if (!repo) {
      const response: ErrorResponse = {
        error: "Field 'repo' is required.",
      };
      return reply.code(400).send(response);
    }

    repo = normalizeRepo(repo);

    if (!isValidRepo(repo)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    if (!Number.isInteger(limit) || limit <= 0) {
      const response: ErrorResponse = {
        error: "Field 'limit' must be a positive integer.",
      };
      return reply.code(400).send(response);
    }

    try {
      const commits = await repoProcessor.listRepositoryCommits(
        repoProcessor.getRepositoryUrl(repo),
        limit
      );
      const response: ListCommitsGraphResponse = buildCommitGraph(commits);
      return reply.code(200).send(response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to list repository commits.";
      const response: ErrorResponse = { error: message };
      return reply.code(500).send(response);
    }
    }
  );

  /**
   * POST /api/jobs/tags
   * Body: { "repo": "owner/repo", "limit": 50 }
   * Lists tags for a repository. The API does not paginate; the server
   * iterates GitHub pages until `limit` tags have been collected.
   */
  app.post<{ Body: ListTagsRequest }>(
    "/tags",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
      let { repo, limit } = request.body ?? {};
      if (!repo) {
        const response: ErrorResponse = {
          error: "Field 'repo' is required.",
        };
        return reply.code(400).send(response);
      }

      repo = normalizeRepo(repo);

      if (!isValidRepo(repo)) {
        const response: ErrorResponse = {
          error:
            "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
        };
        return reply.code(400).send(response);
      }

      if (!Number.isInteger(limit) || limit <= 0) {
        const response: ErrorResponse = {
          error: "Field 'limit' must be a positive integer.",
        };
        return reply.code(400).send(response);
      }

      try {
        const tags = await githubApi.listTags(repo, limit);
        const response: ListTagsResponse = { repo, tags };
        return reply.code(200).send(response);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to list repository tags.";
        const response: ErrorResponse = { error: message };
        const statusCode =
          error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
        return reply.code(statusCode).send(response);
      }
    }
  );

  /**
   * POST /api/jobs/actions
   * Body: { "repo": "owner/repo", "limit": 50 }
   * Lists GitHub Actions workflow runs for a repository. The API does not
   * paginate; the server iterates GitHub pages until `limit` runs have been
   * collected.
   */
  app.post<{ Body: ListActionsRequest }>(
    "/actions",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
      let { repo, limit } = request.body ?? {};
      if (!repo) {
        const response: ErrorResponse = {
          error: "Field 'repo' is required.",
        };
        return reply.code(400).send(response);
      }

      repo = normalizeRepo(repo);

      if (!isValidRepo(repo)) {
        const response: ErrorResponse = {
          error:
            "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
        };
        return reply.code(400).send(response);
      }

      if (!Number.isInteger(limit) || limit <= 0) {
        const response: ErrorResponse = {
          error: "Field 'limit' must be a positive integer.",
        };
        return reply.code(400).send(response);
      }

      try {
        const runs = await githubApi.listActions(repo, limit);
        const response: ListActionsResponse = { repo, runs };
        return reply.code(200).send(response);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unable to list repository workflow runs.";
        const response: ErrorResponse = { error: message };
        const statusCode =
          error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
        return reply.code(statusCode).send(response);
      }
    }
  );

  /**
   * POST /api/jobs/delete-action-run
   * Body: { "repo": "owner/repo", "runId": 42 }
   * Deletes a specific GitHub Actions workflow run.
   */
  app.post<{ Body: DeleteActionRunRequest }>(
    "/delete-action-run",
    { preHandler: requireAdminBearerToken },
    async (request, reply) => {
      let { repo, runId, githubKey } = request.body ?? {};
      if (!repo || typeof runId !== "number") {
        const response: ErrorResponse = {
          error: "Both 'repo' and 'runId' are required.",
        };
        return reply.code(400).send(response);
      }

      repo = normalizeRepo(repo);
      githubKey = githubKey?.trim() || undefined;

      if (!isValidRepo(repo)) {
        const response: ErrorResponse = {
          error:
            "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
        };
        return reply.code(400).send(response);
      }

      if (!Number.isInteger(runId) || runId <= 0) {
        const response: ErrorResponse = {
          error: "Field 'runId' must be a positive integer.",
        };
        return reply.code(400).send(response);
      }

      const token =
        githubKey ||
        process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
        process.env.PUBLIC_GITHUB_TOKEN?.trim() ||
        undefined;

      try {
        await githubApi.deleteActionRun(repo, runId, token);
        const response: DeleteActionRunResponse = { repo, runId };
        return reply.code(200).send(response);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to delete workflow run.";
        const response: ErrorResponse = { error: message };
        const statusCode =
          error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
        return reply.code(statusCode).send(response);
      }
    }
  );

  /**
   * POST /api/jobs/delete-tag
   * Body: { "repo": "owner/repo", "tag": "v1.2.3" }
   * Deletes a remote tag from a GitHub repository.
   */
  app.post<{ Body: DeleteTagRequest }>(
    "/delete-tag",
    { preHandler: requireAdminBearerToken },
    async (request, reply) => {
      let { repo, tag, githubKey } = request.body ?? {};
      if (!repo || !tag) {
        const response: ErrorResponse = {
          error: "Both 'repo' and 'tag' are required.",
        };
        return reply.code(400).send(response);
      }

      repo = normalizeRepo(repo);
      tag = tag.trim();
      githubKey = githubKey?.trim() || undefined;

      if (!isValidRepo(repo)) {
        const response: ErrorResponse = {
          error:
            "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
        };
        return reply.code(400).send(response);
      }

      if (!tag || tag.startsWith("-") || /[\u0000-\u001F\u007F]/.test(tag)) {
        const response: ErrorResponse = {
          error:
            "Field 'tag' must be a non-empty tag name, cannot start with '-', and cannot contain control characters.",
        };
        return reply.code(400).send(response);
      }

      const token =
        githubKey ||
        process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
        process.env.PUBLIC_GITHUB_TOKEN?.trim() ||
        undefined;

      try {
        await githubApi.deleteTag(repo, tag, token);
        const response: DeleteTagResponse = { repo, tag };
        return reply.code(200).send(response);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to delete tag.";
        const response: ErrorResponse = { error: message };
        const statusCode =
          error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
        return reply.code(statusCode).send(response);
      }
    }
  );

  /**
   * POST /api/jobs/delete-repository
   * Body: { "repo": "owner/repo" }
   * Deletes a GitHub repository. Requires an admin bearer token and a GitHub
   * token (request body or environment) with `delete_repo` scope.
   */
  app.post<{ Body: DeleteRepositoryRequest }>(
    "/delete-repository",
    { preHandler: requireAdminBearerToken },
    async (request, reply) => {
      let { repo, githubKey } = request.body ?? {};
      if (!repo) {
        const response: ErrorResponse = {
          error: "Field 'repo' is required.",
        };
        return reply.code(400).send(response);
      }

      repo = normalizeRepo(repo);
      githubKey = githubKey?.trim() || undefined;

      if (!isValidRepo(repo)) {
        const response: ErrorResponse = {
          error:
            "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
        };
        return reply.code(400).send(response);
      }

      const token =
        githubKey ||
        process.env.PRIVATE_GITHUB_TOKEN?.trim() ||
        process.env.PUBLIC_GITHUB_TOKEN?.trim() ||
        undefined;

      try {
        await githubApi.deleteRepository(repo, token);
        const response: DeleteRepositoryResponse = { repo };
        return reply.code(200).send(response);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to delete repository.";
        const response: ErrorResponse = { error: message };
        const statusCode =
          error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
        return reply.code(statusCode).send(response);
      }
    }
  );

  /**
   * GET /api/jobs/organizations/:organization/repositories
   * Lists repositories in a GitHub organization.
   */
  app.get<{ Params: { organization: string } }>(
    "/organizations/:organization/repositories",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
      const organization = request.params.organization?.trim();
      if (!organization) {
        const response: ErrorResponse = {
          error: "Field 'organization' is required.",
        };
        return reply.code(400).send(response);
      }

      if (!isValidOrganization(organization)) {
        const response: ErrorResponse = {
          error: "Invalid organization format.",
        };
        return reply.code(400).send(response);
      }

      try {
        const response: ListOrganizationRepositoriesResponse =
          await githubApi.listOrganizationRepositories(organization);
        return reply.code(200).send(response);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unable to list organization repositories.";
        const response: ErrorResponse = { error: message };
        const statusCode =
          error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
        return reply.code(statusCode).send(response);
      }
    }
  );

  /**
   * GET /api/jobs/cache
   * Lists git cache folders and their sizes from disk.
   */
  app.get("/cache", { preHandler: requireViewerBearerToken }, async (_request, reply) => {
    try {
      const response: GitCacheStatsResponse = getGitCacheStats();
      return reply.code(200).send(response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to inspect git cache folders.";
      logger.error("Failed to inspect git cache folders", { error: message });
      const response: ErrorResponse = {
        error: "Unable to inspect git cache folders on disk.",
      };
      return reply.code(500).send(response);
    }
  });

  /**
   * POST /api/jobs/create-task
   * Body: { "repo": "owner/repo", "problem_statement": "prompt text", ... }
   * Creates a new GitHub Copilot coding agent task for a repository.
   */
  app.post<{ Body: CreateTaskRequest }>(
    "/create-task",
    {
      preHandler: requireAdminBearerToken,
      config: {
        rateLimit: {
          max: CREATE_TASK_ROUTE_RATE_LIMIT_MAX,
          timeWindow: CREATE_TASK_ROUTE_RATE_LIMIT_WINDOW_MS,
        },
      },
    },
    async (request, reply) => {
      let { repo } = request.body ?? {};
      const {
        agent_id,
        problem_statement,
        model,
        task,
        reasoning_effort,
        reasoning_summary,
        verbosity,
        codex_web_search,
        custom_agent,
        create_pull_request,
        auto_ready,
        auto_merge,
        pull_request_completion_mode,
        base_ref,
        branch,
        task_delay_ms,
        deepseek_api_key,
        githubKey,
      } = request.body ?? {};

      if (!repo || !base_ref || !problem_statement) {
        const response: ErrorResponse = {
          error: "'problem_statement', 'repo' and 'base_ref' are required.",
        };
        return reply.code(400).send(response);
      }

      repo = normalizeRepo(repo);

      if (!isValidRepo(repo)) {
        const response: ErrorResponse = {
          error:
            "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
        };
        return reply.code(400).send(response);
      }

      let requestedBranch: string | undefined;
      if (branch !== undefined) {
        if (typeof branch !== "string") {
          const response: ErrorResponse = {
            error: "Field 'branch' must be a non-empty git ref string.",
          };
          return reply.code(400).send(response);
        }

        try {
          requestedBranch = normalizeGitRef(branch, "branch");
        } catch (error) {
          const response: ErrorResponse = {
            error: error instanceof Error ? error.message : "Invalid branch value.",
          };
          return reply.code(400).send(response);
        }
      }

      const taskRunner = task === undefined ? DEFAULT_AGENT_TASK_RUNNER : task;
      if (!isSupportedAgentTaskRunner(taskRunner)) {
        const response: ErrorResponse = {
          error: "Field 'task' must be one of: codex, opencode.",
        };
        return reply.code(400).send(response);
      }

      if (
        taskRunner === "opencode" &&
        model !== undefined &&
        !isSupportedDeepSeekModel(model)
      ) {
        const response: ErrorResponse = {
          error: "Field 'model' must be one of: deepseek-v4-flash, deepseek-v4-pro.",
        };
        return reply.code(400).send(response);
      }

      if (
        taskRunner === "codex" &&
        model !== undefined &&
        (typeof model !== "string" || !model.trim())
      ) {
        const response: ErrorResponse = {
          error: "Field 'model' must be a non-empty string.",
        };
        return reply.code(400).send(response);
      }

      if (
        create_pull_request !== undefined &&
        create_pull_request !== true
      ) {
        const response: ErrorResponse = {
          error:
            "Field 'create_pull_request' must be true when provided because agent tasks always open a draft pull request.",
        };
        return reply.code(400).send(response);
      }

      if (
        reasoning_effort !== undefined &&
        !isSupportedCodexReasoningEffort(reasoning_effort)
      ) {
        const response: ErrorResponse = {
          error: "Field 'reasoning_effort' must be one of: low, medium, high, xhigh.",
        };
        return reply.code(400).send(response);
      }

      if (
        reasoning_summary !== undefined &&
        !isSupportedCodexReasoningSummary(reasoning_summary)
      ) {
        const response: ErrorResponse = {
          error: "Field 'reasoning_summary' must be one of: none, auto, concise, detailed.",
        };
        return reply.code(400).send(response);
      }

      if (
        verbosity !== undefined &&
        !isSupportedCodexVerbosity(verbosity)
      ) {
        const response: ErrorResponse = {
          error: "Field 'verbosity' must be one of: low, medium, high.",
        };
        return reply.code(400).send(response);
      }

      if (
        codex_web_search !== undefined &&
        typeof codex_web_search !== "boolean"
      ) {
        const response: ErrorResponse = {
          error: "Field 'codex_web_search' must be a boolean.",
        };
        return reply.code(400).send(response);
      }

      if (
        taskRunner !== "codex" &&
        (
          reasoning_effort !== undefined ||
          reasoning_summary !== undefined ||
          verbosity !== undefined ||
          codex_web_search !== undefined
        )
      ) {
        const response: ErrorResponse = {
          error:
            "Fields 'reasoning_effort', 'reasoning_summary', 'verbosity', and 'codex_web_search' are only supported for codex tasks.",
        };
        return reply.code(400).send(response);
      }

      const reasoningEffort =
        taskRunner === "codex"
          ? reasoning_effort ?? DEFAULT_CODEX_REASONING_EFFORT
          : undefined;
      const reasoningSummary =
        taskRunner === "codex"
          ? reasoning_summary ?? DEFAULT_CODEX_REASONING_SUMMARY
          : undefined;

      const pullRequestCompletionResolution = resolvePullRequestCompletionMode(
        request.body ?? {}
      );
      if (pullRequestCompletionResolution.error) {
        const response: ErrorResponse = {
          error: pullRequestCompletionResolution.error,
        };
        return reply.code(400).send(response);
      }
      const pullRequestCompletionMode = pullRequestCompletionResolution.mode;

      if (
        task_delay_ms !== undefined &&
        (!Number.isInteger(task_delay_ms) || task_delay_ms < 0)
      ) {
        const response: ErrorResponse = {
          error: "Field 'task_delay_ms' must be a non-negative integer.",
        };
        return reply.code(400).send(response);
      }

      const [owner, repoName] = repo.split("/", 2);
      const taskDelayMs = task_delay_ms ?? 0;
      const taskModel =
        model?.trim() ||
        (taskRunner === "opencode"
          ? DEFAULT_DEEPSEEK_MODEL
          : process.env.CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL);
      const jobId = randomUUID();
      const scheduledAt = taskDelayMs > 0
        ? new Date(Date.now() + taskDelayMs)
        : null;

      try {
        logger.info(`AgentTask: Scheduling ${taskRunner} task job=${jobId} repo=${repo} model=${taskModel} delay_ms=${taskDelayMs}`);
        await jobRepo.createAgentTaskJob(
          {
            id: jobId,
            repo,
            taskDelayMs,
            scheduledAt,
            taskRunner,
            model: taskModel,
            reasoningEffort,
            reasoningSummary,
            verbosity,
            codexWebSearch: codex_web_search,
            baseRef: base_ref,
            branchName: requestedBranch,
            pullRequestCompletionMode,
          }
        );
        await enqueueAgentTaskJob(
          queue,
          jobId,
          `${owner}/${repoName}`,
          base_ref,
          requestedBranch,
          problem_statement,
          taskRunner,
          taskModel,
          reasoningEffort,
          reasoningSummary,
          verbosity,
          codex_web_search,
          pullRequestCompletionMode,
          taskDelayMs,
          githubKey?.trim() || undefined,
          deepseek_api_key?.trim() || undefined
        );
        logger.info(`AgentTask ${jobId}: Enqueued for repo=${repo}`);
        return reply.code(201).send({ id: jobId } satisfies CreateTaskResponse);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to schedule task.";
        logger.warn(`AgentTask: Failed to schedule task for repo=${repo}: ${message}`);
        const response: ErrorResponse = { error: message };
        return reply.code(500).send(response);
      }
    }
  );

  /**
   * GET /api/jobs/create-task/pending
   * Lists local agent task jobs that are queued locally and have not started the remote task yet.
   */
  app.get(
    "/create-task/pending",
    { preHandler: requireViewerBearerToken },
    async (_request, reply) => {
      const jobs = await jobRepo.listPendingAgentTaskJobs();
      return reply.code(200).send(jobs);
    }
  );

  app.get<{ Params: { id: string } }>(
    "/create-task/:id",
    { preHandler: requireViewerBearerToken },
    async (request, reply) => {
      const job = await jobRepo.getAgentTaskJob(request.params.id);
      if (!job) {
        const response: ErrorResponse = { error: "Task job not found." };
        return reply.code(404).send(response);
      }

      const response: AgentTaskJobInfo = job;
      return reply.code(200).send(response);
    }
  );

  app.post<{ Params: { id: string } }>(
    "/create-task/:id/cancel",
    { preHandler: requireAdminBearerToken },
    async (request, reply) => {
      try {
        const updatedJob = await cancelAgentTaskJob(jobRepo, queue, request.params.id);
        if (!updatedJob) {
          const response: ErrorResponse = { error: "Task job not found." };
          return reply.code(404).send(response);
        }

        const response: AgentTaskJobInfo = updatedJob;
        return reply.code(200).send(response);
      } catch (error) {
        if (error instanceof AgentTaskActionConflictError) {
          const response: ErrorResponse = { error: error.message };
          return reply.code(409).send(response);
        }

        throw error;
      }
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/create-task/:id",
    { preHandler: requireAdminBearerToken },
    async (request, reply) => {
      const updatedJob = await deleteAgentTaskJob(jobRepo, queue, request.params.id);
      if (!updatedJob) {
        const response: ErrorResponse = { error: "Task job not found." };
        return reply.code(404).send(response);
      }

      const response: AgentTaskJobInfo = updatedJob;
      return reply.code(200).send(response);
    }
  );
}

async function enqueueAgentTaskJob(
  queue: Queue,
  jobId: string,
  repoName: string,
  baseRef: string,
  branch: string | undefined,
  problemStatement: string,
  task: AgentTaskRunner,
  model: string,
  reasoningEffort: CodexReasoningEffort | undefined,
  reasoningSummary: CodexReasoningSummary | undefined,
  verbosity: CodexVerbosity | undefined,
  codexWebSearch: boolean | undefined,
  pullRequestCompletionMode: PullRequestCompletionMode | undefined,
  delayMs = 0,
  githubKey?: string,
  deepseekApiKey?: string
): Promise<void> {
  await queue.add(
    task === "opencode" ? "create-opencode-task" : "create-codex-task",
    {
      jobId,
      repoName,
      baseRef,
      ...(branch ? { branch } : {}),
      problemStatement,
      task,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(reasoningSummary ? { reasoningSummary } : {}),
      ...(verbosity ? { verbosity } : {}),
      ...(codexWebSearch !== undefined ? { codexWebSearch } : {}),
      ...(pullRequestCompletionMode ? { pullRequestCompletionMode } : {}),
      ...(githubKey ? { githubKey } : {}),
      ...(task === "opencode" && deepseekApiKey ? { deepseekApiKey } : {}),
    },
    {
      jobId,
      delay: delayMs,
    }
  );
}

function getGitCacheStats(): GitCacheStatsResponse {
  const tmpDir = path.resolve(process.env.TMP_DIR || "tmp");
  const cacheRoot = path.join(tmpDir, "repo-cache");

  if (!fs.existsSync(cacheRoot)) {
    return {
      count: 0,
      totalSize: 0,
      folders: [],
    };
  }

  const folders = fs
    .readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const folderPath = path.join(cacheRoot, entry.name);
      return {
        name: entry.name,
        size: getDirectorySize(folderPath),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    count: folders.length,
    totalSize: folders.reduce((sum, folder) => sum + folder.size, 0),
    folders,
  };
}

function summarizeCreateTaskPayload(body: CreateTaskRequest | undefined): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  if (typeof body?.event_content === "string") {
    summary.eventContentLength = body.event_content.length;
  }

  if (typeof body?.agent_id === "number") {
    summary.agentId = body.agent_id;
  }

  if (typeof body?.problem_statement === "string") {
    summary.problemStatementLength = body.problem_statement.length;
  }

  if (typeof body?.model === "string") {
    summary.model = body.model;
  }

  if (typeof body?.task === "string") {
    summary.task = body.task;
  }

  if (typeof body?.reasoning_effort === "string") {
    summary.reasoningEffort = body.reasoning_effort;
  }

  if (typeof body?.reasoning_summary === "string") {
    summary.reasoningSummary = body.reasoning_summary;
  }

  if (typeof body?.verbosity === "string") {
    summary.verbosity = body.verbosity;
  }

  if (typeof body?.codex_web_search === "boolean") {
    summary.codexWebSearch = body.codex_web_search;
  }

  if (typeof body?.custom_agent === "string") {
    summary.customAgent = body.custom_agent;
  }

  if (typeof body?.create_pull_request === "boolean") {
    summary.createPullRequest = body.create_pull_request;
  }

  const pullRequestCompletionResolution = body
    ? resolvePullRequestCompletionMode(body)
    : undefined;
  if (pullRequestCompletionResolution?.mode) {
    summary.pullRequestCompletionMode = pullRequestCompletionResolution.mode;
  }

  if (typeof body?.base_ref === "string") {
    summary.baseRef = body.base_ref;
  }

  if (typeof body?.branch === "string") {
    summary.branch = body.branch;
  }

  if (typeof body?.task_delay_ms === "number") {
    summary.taskDelayMs = body.task_delay_ms;
  }

  return summary;
}

function buildCommitGraph(
  commits: ListCommitsResponse["commits"]
): ListCommitsGraphResponse {
  const commitIds = new Set(commits.map((commit) => commit.commit));
  const nodes: CommitGraphItem[] = commits.map((commit) => ({
    id: commit.commit,
    type: "node",
    ...(commit.branch ? { colorKey: commit.branch } : {}),
  }));
  const edges: CommitGraphItem[] = commits.flatMap((commit) =>
    commit.parents
      .filter((parent) => commitIds.has(parent))
      .map((parent) => ({
        id: `${parent}->${commit.commit}`,
        type: "edge",
        source: parent,
        target: commit.commit,
      }))
  );

  return [...nodes, ...edges];
}

function getDirectorySize(dirPath: string): number {
  return fs.readdirSync(dirPath, { withFileTypes: true }).reduce((size, entry) => {
    try {
      const entryPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        return size + getDirectorySize(entryPath);
      }

      return size + fs.lstatSync(entryPath).size;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown filesystem error.";
      logger.warn("Skipping unreadable git cache entry", {
        dirPath,
        entryName: entry.name,
        error: message,
      });
      return size;
    }
  }, 0);
}

import fs from "fs";
import path from "path";
import type { FastifyInstance } from "fastify";
import type {
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
  DeleteRemoteBranchRequest,
  DeleteRemoteBranchResponse,
  MarkPullRequestReadyRequest,
  MarkPullRequestReadyResponse,
  MergePullRequestRequest,
  MergePullRequestResponse,
  OpenPullRequestRequest,
  OpenPullRequestResponse,
} from "../../types";
import { revertToCommit, mergeBranch } from "../../github/operations";
import * as githubApi from "../../services/githubApi";
import * as repoProcessor from "../../services/repoProcessor";
import { getCommitShort } from "../../utils/commit";
import {
  getConfiguredBearerToken,
  isValidOrganization,
  isValidRepo,
  logger,
  matchesBearerToken,
  CREATE_TASK_BEARER_TOKEN_ENV,
  GITHUB_OPERATIONS_BEARER_TOKEN_ENV,
  MERGE_BRANCH_BEARER_TOKEN_ENV,
  normalizeRepo,
  REVERT_TO_COMMIT_BEARER_TOKEN_ENV,
} from "./shared";

export function registerDiscoveryRoutes(app: FastifyInstance): void {
  /**
   * POST /api/jobs/resolve
   * Body: { "repo": "owner/repo", "ref": "main" }
   * Resolves a Git ref to a full commit SHA.
   */
  app.post<{ Body: ResolveCommitRequest }>("/resolve", async (request, reply) => {
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
  });

  /**
   * POST /api/jobs/revert-to-commit
   * Body: { "repo": "owner/repo", "commit": "<sha>", "branch": "main" }
   * Creates a new branch from the requested base branch with the tree restored to a past commit.
   */
  app.post<{ Body: RevertToCommitRequest }>("/revert-to-commit", async (request, reply) => {
    const endpointBearerToken = getConfiguredBearerToken(REVERT_TO_COMMIT_BEARER_TOKEN_ENV);
    if (!endpointBearerToken) {
      const response: ErrorResponse = {
        error: "Revert-to-commit bearer token is not configured.",
      };
      return reply.code(503).send(response);
    }

    if (!matchesBearerToken(request.headers.authorization, endpointBearerToken)) {
      const response: ErrorResponse = {
        error: "Bearer token is required.",
      };
      return reply.code(401).send(response);
    }

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
  });

  /**
   * POST /api/jobs/merge-branch
   * Body: { "repo": "owner/repo", "otherBranch": "feature", "baseBranch": "main" }
   * Creates a branch from baseBranch, merges otherBranch into it, and creates a pull request.
   * If the merge branch already exists, merges otherBranch into it.
   */
  app.post<{ Body: MergeBranchRequest }>("/merge-branch", async (request, reply) => {
    const endpointBearerToken = getConfiguredBearerToken(MERGE_BRANCH_BEARER_TOKEN_ENV);
    if (!endpointBearerToken) {
      const response: ErrorResponse = {
        error: "Merge-branch bearer token is not configured.",
      };
      return reply.code(503).send(response);
    }

    if (!matchesBearerToken(request.headers.authorization, endpointBearerToken)) {
      const response: ErrorResponse = {
        error: "Bearer token is required.",
      };
      return reply.code(401).send(response);
    }

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
  });

  /**
   * POST /api/jobs/delete-remote-branch
   * Body: { "repo": "owner/repo", "branch": "branch-name" }
   * Deletes a remote branch from a GitHub repository.
   */
  app.post<{ Body: DeleteRemoteBranchRequest }>("/delete-remote-branch", async (request, reply) => {
    const endpointBearerToken = getConfiguredBearerToken(GITHUB_OPERATIONS_BEARER_TOKEN_ENV)
      ?? getConfiguredBearerToken(REVERT_TO_COMMIT_BEARER_TOKEN_ENV);
    if (!endpointBearerToken) {
      const response: ErrorResponse = {
        error: "GitHub operations bearer token is not configured.",
      };
      return reply.code(503).send(response);
    }

    if (!matchesBearerToken(request.headers.authorization, endpointBearerToken)) {
      const response: ErrorResponse = {
        error: "Bearer token is required.",
      };
      return reply.code(401).send(response);
    }

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
  });

  /**
   * POST /api/jobs/pull-request/ready
   * Body: { "repo": "owner/repo", "pullNumber": 123 }
   * Marks a draft pull request as ready for review.
   */
  app.post<{ Body: MarkPullRequestReadyRequest }>("/pull-request/ready", async (request, reply) => {
    const endpointBearerToken = getConfiguredBearerToken(GITHUB_OPERATIONS_BEARER_TOKEN_ENV)
      ?? getConfiguredBearerToken(REVERT_TO_COMMIT_BEARER_TOKEN_ENV);
    if (!endpointBearerToken) {
      const response: ErrorResponse = {
        error: "GitHub operations bearer token is not configured.",
      };
      return reply.code(503).send(response);
    }

    if (!matchesBearerToken(request.headers.authorization, endpointBearerToken)) {
      const response: ErrorResponse = {
        error: "Bearer token is required.",
      };
      return reply.code(401).send(response);
    }

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
  });

  /**
   * POST /api/jobs/pull-request/merge
   * Body: { "repo": "owner/repo", "pullNumber": 123, "mergeMethod": "squash" }
   * Merges a pull request.
   */
  app.post<{ Body: MergePullRequestRequest }>("/pull-request/merge", async (request, reply) => {
    const endpointBearerToken = getConfiguredBearerToken(GITHUB_OPERATIONS_BEARER_TOKEN_ENV)
      ?? getConfiguredBearerToken(REVERT_TO_COMMIT_BEARER_TOKEN_ENV);
    if (!endpointBearerToken) {
      const response: ErrorResponse = {
        error: "GitHub operations bearer token is not configured.",
      };
      return reply.code(503).send(response);
    }

    if (!matchesBearerToken(request.headers.authorization, endpointBearerToken)) {
      const response: ErrorResponse = {
        error: "Bearer token is required.",
      };
      return reply.code(401).send(response);
    }

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
  });

  /**
   * POST /api/jobs/pull-request/open
   * Body: { "repo": "owner/repo", "head": "feature-branch", "base": "main", "draft": true }
   * Opens a new pull request. Defaults to the last commit message on the head branch
   * for the title and description if not provided.
   */
  app.post<{ Body: OpenPullRequestRequest }>("/pull-request/open", async (request, reply) => {
    const endpointBearerToken = getConfiguredBearerToken(GITHUB_OPERATIONS_BEARER_TOKEN_ENV)
      ?? getConfiguredBearerToken(REVERT_TO_COMMIT_BEARER_TOKEN_ENV);
    if (!endpointBearerToken) {
      const response: ErrorResponse = {
        error: "GitHub operations bearer token is not configured.",
      };
      return reply.code(503).send(response);
    }

    if (!matchesBearerToken(request.headers.authorization, endpointBearerToken)) {
      const response: ErrorResponse = {
        error: "Bearer token is required.",
      };
      return reply.code(401).send(response);
    }

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
  });

  /**
   * POST /api/jobs/pull-request/resolve
   * Body: { "pullRequestUrl": "https://github.com/owner/repo/pull/123" }
   * Resolves a GitHub pull request into source and target commits.
   */
  app.post<{ Body: ResolvePullRequestRequest }>(
    "/pull-request/resolve",
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
  app.post<{ Body: ListRefsRequest }>("/refs", async (request, reply) => {
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
  });

  /**
   * POST /api/jobs/branches
   * Body: { "repo": "owner/repo" }
   * Lists repository branches with branch head metadata and pull request status.
   */
  app.post<{ Body: ListBranchesRequest }>("/branches", async (request, reply) => {
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
  });

  /**
   * POST /api/jobs/commits
   * Body: { "repo": "owner/repo", "limit": 10 }
   * Lists repository commits from newest to oldest.
   */
  app.post<{ Body: ListCommitsRequest }>("/commits", async (request, reply) => {
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
  });

  /**
   * POST /api/jobs/commits/graph
   * Body: { "repo": "owner/repo", "limit": 10 }
   * Lists repository commits as node/edge items for visualization.
   */
  app.post<{ Body: ListCommitsRequest }>("/commits/graph", async (request, reply) => {
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
  });

  /**
   * GET /api/jobs/organizations/:organization/repositories
   * Lists repositories in a GitHub organization.
   */
  app.get<{ Params: { organization: string } }>(
    "/organizations/:organization/repositories",
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
  app.get("/cache", async (_request, reply) => {
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
   * Body: { "repo": "owner/repo", "event_content": "prompt text", ... }
   * Creates a new GitHub Copilot coding agent task for a repository.
   */
  app.post<{ Body: CreateTaskRequest }>("/create-task", async (request, reply) => {
    const endpointBearerToken = getConfiguredBearerToken(CREATE_TASK_BEARER_TOKEN_ENV);
    if (!endpointBearerToken) {
      const response: ErrorResponse = {
        error: "Create-task bearer token is not configured.",
      };
      return reply.code(503).send(response);
    }

    if (!matchesBearerToken(request.headers.authorization, endpointBearerToken)) {
      const response: ErrorResponse = {
        error: "Bearer token is required.",
      };
      return reply.code(401).send(response);
    }

    let { repo } = request.body ?? {};
    const { event_content, agent_id, problem_statement, model, custom_agent, create_pull_request, base_ref } = request.body ?? {};

    if (!repo || !event_content) {
      const response: ErrorResponse = {
        error: "Both 'repo' and 'event_content' are required.",
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

    const [owner, repoName] = repo.split("/", 2);

    const copilotToken = process.env.COPILOT_GITHUB_TOKEN?.trim();
    if (!copilotToken) {
      const response: ErrorResponse = {
        error: "Copilot GitHub token is not configured.",
      };
      return reply.code(503).send(response);
    }

    const body: Record<string, unknown> = { event_content };
    if (problem_statement !== undefined) body.problem_statement = problem_statement;
    if (model !== undefined) body.model = model;
    if (create_pull_request !== undefined) body.create_pull_request = create_pull_request;
    if (base_ref !== undefined) body.base_ref = base_ref;

    try {
      logger.info("Creating GitHub Copilot task", {
        repo,
        payload: summarizeCreateTaskPayload(request.body),
      });
      const result: CreateTaskResponse = await githubApi.createTask(owner, repoName, body, copilotToken);
      logger.info("Created GitHub Copilot task", {
        repo,
        taskId: result.id,
      });
      return reply.code(201).send(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to create task.";
      logger.warn("Failed to create GitHub Copilot task", {
        repo,
        statusCode: error instanceof githubApi.GitHubApiError ? error.statusCode : 500,
        error: message,
        payload: summarizeCreateTaskPayload(request.body),
      });
      const response: ErrorResponse = { error: message };
      const statusCode =
        error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
      return reply.code(statusCode).send(response);
    }
  });
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

  if (typeof body?.custom_agent === "string") {
    summary.customAgent = body.custom_agent;
  }

  if (typeof body?.create_pull_request === "boolean") {
    summary.createPullRequest = body.create_pull_request;
  }

  if (typeof body?.base_ref === "string") {
    summary.baseRef = body.base_ref;
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

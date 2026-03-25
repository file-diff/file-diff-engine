import fs from "fs";
import path from "path";
import type { FastifyInstance } from "fastify";
import type {
  ErrorResponse,
  ListCommitsRequest,
  ListCommitsResponse,
  GitCacheStatsResponse,
  ListRefsRequest,
  ListRefsResponse,
  ListOrganizationRepositoriesResponse,
  ResolveCommitRequest,
  ResolveCommitResponse,
  ResolvePullRequestRequest,
  ResolvePullRequestResponse,
} from "../../types";
import * as githubApi from "../../services/githubApi";
import * as repoProcessor from "../../services/repoProcessor";
import { getCommitShort } from "../../utils/commit";
import { isValidOrganization, isValidRepo, logger, normalizeRepo } from "./shared";

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

import https from "https";
import type {
  CommitPullRequestSummary,
  ListOrganizationRepositoriesResponse,
  OrganizationRepositorySummary,
  ResolvePullRequestResponse,
} from "../types";
import { getCommitShort } from "../utils/commit";

const GITHUB_HOSTNAME = "github.com";
const GITHUB_API_HOSTNAME = "api.github.com";
const GITHUB_REPOS_PAGE_SIZE = 100;

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

interface GitHubPullRequestApiResponse {
  head?: {
    sha?: string;
  };
  base?: {
    sha?: string;
    repo?: {
      full_name?: string;
      html_url?: string;
    };
  };
}

interface GitHubRepositoryApiResponse {
  name?: string;
  full_name?: string;
  html_url?: string;
  pushed_at?: string;
  created_at?: string;
  updated_at?: string;
}

interface GitHubCommitPullRequestApiResponse {
  number?: number;
  title?: string;
  html_url?: string;
}

interface GitHubCreatePullRequestApiRequest {
  title: string;
  head: string;
  base: string;
  body?: string;
}

interface GitHubErrorApiResponse {
  message?: string;
}

interface GitHubRateLimitApiBucket {
  limit?: number;
  remaining?: number;
  reset?: number;
  used?: number;
  resource?: string;
}

interface GitHubRateLimitApiResponse {
  rate?: GitHubRateLimitApiBucket;
}

export interface GitHubRateLimitSummary {
  limit: number;
  remaining: number;
  reset: number;
  used: number;
  resource: string;
}

export async function resolvePullRequest(
  pullRequestUrl: string
): Promise<ResolvePullRequestResponse> {
  const { owner, repo, pullNumber } = parsePullRequestUrl(pullRequestUrl);
  const response = await getJson<GitHubPullRequestApiResponse>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
    {
      notFoundMessage: `GitHub pull request '${pullRequestUrl}' was not found.`,
    }
  );

  const targetCommit = response.base?.sha?.trim().toLowerCase();
  const sourceCommit = response.head?.sha?.trim().toLowerCase();
  const normalizedRepo = response.base?.repo?.full_name?.trim() || `${owner}/${repo}`;
  const repositoryUrl =
    response.base?.repo?.html_url?.trim() || `https://${GITHUB_HOSTNAME}/${normalizedRepo}`;

  if (!sourceCommit || !targetCommit) {
    throw new GitHubApiError(
      `GitHub pull request '${pullRequestUrl}' did not include both source and target commits.`,
      502
    );
  }

  return {
    repo: normalizedRepo,
    repositoryUrl,
    sourceCommit,
    sourceCommitShort: getCommitShort(sourceCommit),
    targetCommit,
    targetCommitShort: getCommitShort(targetCommit),
  };
}

export async function listOrganizationRepositories(
  organization: string
): Promise<ListOrganizationRepositoriesResponse> {
  const normalizedOrganization = organization.trim();
  const [organizationResult, userResult] = await Promise.allSettled([
    listRepositoriesForOwner(
      normalizedOrganization,
      "orgs",
      `GitHub organization '${normalizedOrganization}' was not found.`
    ),
    listRepositoriesForOwner(
      normalizedOrganization,
      "users",
      `GitHub user '${normalizedOrganization}' was not found.`
    ),
  ]);

  if (organizationResult.status === "fulfilled") {
    return {
      organization: normalizedOrganization,
      repositories: organizationResult.value,
    };
  }

  if (userResult.status === "fulfilled") {
    return {
      organization: normalizedOrganization,
      repositories: userResult.value,
    };
  }

  throw getOwnerRepositoriesError(normalizedOrganization, [
    organizationResult.reason,
    userResult.reason,
  ]);
}

export async function getCommitPullRequest(
  repo: string,
  commit: string
): Promise<CommitPullRequestSummary | null> {
  const [owner, repoName] = repo.split("/", 2);
  const response = await getJson<GitHubCommitPullRequestApiResponse[]>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/commits/${encodeURIComponent(commit)}/pulls`,
    {
      notFoundMessage: `GitHub commit '${commit}' was not found in repository '${repo}'.`,
    }
  );
  const pullRequest = response[0];

  if (!pullRequest?.number || !pullRequest.html_url) {
    return null;
  }

  return {
    number: pullRequest.number,
    title: pullRequest.title?.trim() || "",
    url: pullRequest.html_url.trim(),
  };
}

export async function createPullRequest(
  repo: string,
  head: string,
  base: string,
  options: {
    title: string;
    body?: string;
    token?: string;
  }
): Promise<CommitPullRequestSummary> {
  const [owner, repoName] = repo.split("/", 2);
  const response = await getJson<GitHubCommitPullRequestApiResponse>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls`,
    {
      notFoundMessage: `GitHub repository '${repo}' was not found.`,
      method: "POST",
      body: {
        title: options.title,
        head,
        base,
        ...(options.body ? { body: options.body } : {}),
      } satisfies GitHubCreatePullRequestApiRequest,
      token: options.token,
    }
  );

  if (!response.number || !response.html_url) {
    throw new GitHubApiError("GitHub pull request response was invalid.", 502);
  }

  return {
    number: response.number,
    title: response.title?.trim() || options.title,
    url: response.html_url.trim(),
  };
}

export async function getGitHubRateLimit(): Promise<GitHubRateLimitSummary> {
  const response = await getJson<GitHubRateLimitApiResponse>("/rate_limit", {
    notFoundMessage: "GitHub rate limit endpoint was not found.",
  });
  const rate = response.rate;

  if (
    typeof rate?.limit !== "number" ||
    typeof rate.remaining !== "number" ||
    typeof rate.reset !== "number" ||
    typeof rate.used !== "number"
  ) {
    throw new GitHubApiError("GitHub rate limit response was invalid.", 502);
  }

  return {
    limit: rate.limit,
    remaining: rate.remaining,
    reset: rate.reset,
    used: rate.used,
    resource: rate.resource?.trim() || "core",
  };
}

export function parsePullRequestUrl(
  pullRequestUrl: string
): { owner: string; repo: string; pullNumber: number } {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(pullRequestUrl.trim());
  } catch {
    throw new GitHubApiError(
      "Invalid pull request URL. Expected a full GitHub pull request URL.",
      400
    );
  }

  if (parsedUrl.hostname !== GITHUB_HOSTNAME) {
    throw new GitHubApiError(
      "Invalid pull request URL. Expected a full GitHub pull request URL.",
      400
    );
  }

  const match = parsedUrl.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
  if (!match) {
    throw new GitHubApiError(
      "Invalid pull request URL. Expected a full GitHub pull request URL.",
      400
    );
  }

  return {
    owner: decodeURIComponent(match[1]),
    repo: decodeURIComponent(match[2]),
    pullNumber: Number.parseInt(match[3], 10),
  };
}

async function getJson<T>(
  path: string,
  options: {
    notFoundMessage: string;
    method?: "GET" | "POST";
    body?: unknown;
    token?: string;
  }
): Promise<T> {
  const response = await requestGitHub(path, {
    method: options.method,
    body: options.body,
    token: options.token,
  });
  if (response.statusCode === 404) {
    throw new GitHubApiError(options.notFoundMessage, 404);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const payload = safeParseJson<GitHubErrorApiResponse>(response.body);
    const message =
      payload?.message?.trim() ||
      `GitHub API request failed with status ${response.statusCode}.`;
    throw new GitHubApiError(message, response.statusCode);
  }

  const payload = safeParseJson<T>(response.body);
  if (payload === null) {
    throw new GitHubApiError("GitHub API returned an invalid JSON response.", 502);
  }

  return payload;
}

async function listRepositoriesForOwner(
  owner: string,
  ownerType: "orgs" | "users",
  notFoundMessage: string
): Promise<OrganizationRepositorySummary[]> {
  const repositories: OrganizationRepositorySummary[] = [];

  for (let page = 1; ; page += 1) {
    const pageResults = await getJson<GitHubRepositoryApiResponse[]>(
      `/${ownerType}/${encodeURIComponent(owner)}/repos?per_page=${GITHUB_REPOS_PAGE_SIZE}&page=${page}&type=all&sort=full_name&direction=asc`,
      { notFoundMessage }
    );

    repositories.push(...pageResults.map((repository) => mapRepositorySummary(owner, repository)));

    if (pageResults.length < GITHUB_REPOS_PAGE_SIZE) {
      return repositories;
    }
  }
}

function mapRepositorySummary(
  owner: string,
  repository: GitHubRepositoryApiResponse
): OrganizationRepositorySummary {
  const name = repository.name?.trim() || "";
  const repo = repository.full_name?.trim() || (name ? `${owner}/${name}` : "");

  return {
    name,
    repo,
    repositoryUrl: repository.html_url?.trim() || (repo ? `https://${GITHUB_HOSTNAME}/${repo}` : ""),
    pushedAt: typeof repository.pushed_at === "string" ? repository.pushed_at : "",
    createdAt: typeof repository.created_at === "string" ? repository.created_at : "",
    updatedAt: typeof repository.updated_at === "string" ? repository.updated_at : "",
  };
}

function getOwnerRepositoriesError(owner: string, errors: unknown[]): GitHubApiError {
  const firstNonNotFoundError = errors.find(
    (error): error is GitHubApiError =>
      error instanceof GitHubApiError && error.statusCode !== 404
  );

  if (firstNonNotFoundError) {
    return firstNonNotFoundError;
  }

  const firstUnexpectedError = errors.find(
    (error): error is Error => error instanceof Error && !(error instanceof GitHubApiError)
  );
  if (firstUnexpectedError) {
    return new GitHubApiError(firstUnexpectedError.message, 500);
  }

  return new GitHubApiError(`GitHub organization or user '${owner}' was not found.`, 404);
}

function requestGitHub(
  path: string,
  options: {
    method?: "GET" | "POST";
    body?: unknown;
    token?: string;
  } = {}
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const method = options.method ?? "GET";
    const requestBody = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = https.request(
      {
        protocol: "https:",
        hostname: GITHUB_API_HOSTNAME,
        path,
        method,
        headers: getRequestHeaders(options.token, requestBody),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    request.on("error", (error) => {
      reject(new GitHubApiError(`GitHub API request failed: ${error.message}`, 502));
    });

    if (requestBody) {
      request.write(requestBody);
    }
    request.end();
  });
}

function getRequestHeaders(
  tokenOverride?: string,
  requestBody?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "file-diff-engine",
  };
  if (requestBody !== undefined) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    headers["Content-Length"] = String(Buffer.byteLength(requestBody));
  }
  const token = tokenOverride?.trim() || process.env.PUBLIC_GITHUB_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function safeParseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

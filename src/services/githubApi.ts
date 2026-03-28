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
}

interface GitHubCommitPullRequestApiResponse {
  number?: number;
  title?: string;
  html_url?: string;
}

interface GitHubErrorApiResponse {
  message?: string;
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
  const repositories: OrganizationRepositorySummary[] = [];

  for (let page = 1; ; page += 1) {
    const pageResults = await getJson<GitHubRepositoryApiResponse[]>(
      `/orgs/${encodeURIComponent(normalizedOrganization)}/repos?per_page=${GITHUB_REPOS_PAGE_SIZE}&page=${page}&type=all&sort=full_name&direction=asc`,
      {
        notFoundMessage: `GitHub organization '${normalizedOrganization}' was not found.`,
      }
    );

    repositories.push(
      ...pageResults.map((repository) => ({
        name: repository.name?.trim() || "",
        repo:
          repository.full_name?.trim() ||
          `${normalizedOrganization}/${repository.name?.trim() || ""}`,
        repositoryUrl:
          repository.html_url?.trim() ||
          `https://${GITHUB_HOSTNAME}/${repository.full_name?.trim() || ""}`,
      }))
    );

    if (pageResults.length < GITHUB_REPOS_PAGE_SIZE) {
      break;
    }
  }

  return {
    organization: normalizedOrganization,
    repositories,
  };
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
  options: { notFoundMessage: string }
): Promise<T> {
  const response = await requestGitHub(path);
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

function requestGitHub(path: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: "https:",
        hostname: GITHUB_API_HOSTNAME,
        path,
        method: "GET",
        headers: getRequestHeaders(),
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

    request.end();
  });
}

function getRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "file-diff-engine",
  };
  const token = process.env.PUBLIC_GITHUB_TOKEN?.trim();
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

import https from "https";
import type { IncomingHttpHeaders } from "http";
import type {
  CommitPullRequestSummary,
  CreateTaskResponse,
  ListOrganizationRepositoriesResponse,
  OrganizationRepositorySummary,
  ResolvePullRequestResponse,
  TaskInfoResponse,
} from "../types";
import { getCommitShort } from "../utils/commit";
import { createLogger } from "../utils/logger";

const GITHUB_HOSTNAME = "github.com";
const GITHUB_API_HOSTNAME = "api.github.com";
const GITHUB_COPILOT_API_HOSTNAME = "api.individual.githubcopilot.com";
const GITHUB_REPOS_PAGE_SIZE = 100;
const logger = createLogger("github-api");

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
  state?: string;
  draft?: boolean;
}

interface GitHubCreatePullRequestApiRequest {
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

interface GitHubErrorApiResponse {
  message?: string;
  documentation_url?: string;
}

interface GitHubMergePullRequestApiResponse {
  sha?: string;
  merged?: boolean;
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

interface GitHubTaskApiResponse {
  id?: string;
  [key: string]: unknown;
}

export interface GitHubRateLimitSummary {
  limit: number;
  remaining: number;
  reset: number;
  used: number;
  resource: string;
}

interface BearerProviderResponse {
  source?: string;
  authorization_header?: string;
  bearer_token?: string;
}

export async function fetchCopilotAuthorizationHeader(): Promise<string> {
  const providerUrl = process.env.GITHUB_BEARER_PROVIDER_URL?.trim();
  const providerBearer = process.env.GITHUB_BEARER_PROVIDER_BEARER?.trim();

  if (!providerUrl) {
    throw new GitHubApiError("GITHUB_BEARER_PROVIDER_URL is not configured.", 503);
  }

  if (!providerBearer) {
    throw new GitHubApiError("GITHUB_BEARER_PROVIDER_BEARER is not configured.", 503);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(providerUrl);
  } catch {
    throw new GitHubApiError("GITHUB_BEARER_PROVIDER_URL is not a valid URL.", 503);
  }

  const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const request = https.request(
      {
        protocol: "https:",
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: parsedUrl.pathname + parsedUrl.search,
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "file-diff-engine",
          // GITHUB_BEARER_PROVIDER_BEARER is sent as-is in the Authorization header
          Authorization: providerBearer,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    request.on("error", (error) => {
      reject(new GitHubApiError(`Bearer provider request failed (${parsedUrl.hostname}): ${error.message}`, 502));
    });

    request.end();
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new GitHubApiError(
      `Bearer provider (${parsedUrl.hostname}) returned status ${response.statusCode}.`,
      502
    );
  }

  let parsed: BearerProviderResponse;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new GitHubApiError("Bearer provider returned invalid JSON.", 502);
  }

  const authorizationHeader = parsed.authorization_header?.trim();
  if (!authorizationHeader) {
    throw new GitHubApiError("Bearer provider response did not contain an authorization_header.", 502);
  }

  return authorizationHeader;
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

  const state =
    pullRequest.state?.trim().toLowerCase() === "open"
      ? "open"
      : pullRequest.state?.trim().toLowerCase() === "closed"
        ? "closed"
        : undefined;

  return {
    number: pullRequest.number,
    title: pullRequest.title?.trim() || "",
    url: pullRequest.html_url.trim(),
    ...(state ? { state } : {}),
  };
}

export async function createPullRequest(
  repo: string,
  head: string,
  base: string,
  options: {
    title: string;
    body?: string;
    draft?: boolean;
    token?: string;
  }
): Promise<CreatePullRequestResult> {
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
        ...(options.draft !== undefined ? { draft: options.draft } : {}),
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
    draft: response.draft === true,
  };
}

export interface CreatePullRequestResult extends CommitPullRequestSummary {
  draft: boolean;
}

export async function deleteRemoteBranch(
  repo: string,
  branch: string,
  token?: string
): Promise<void> {
  const [owner, repoName] = repo.split("/", 2);
  const encodedRef = branch
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  await getJson<Record<string, unknown>>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/refs/heads/${encodedRef}`,
    {
      notFoundMessage: `Branch '${branch}' was not found in repository '${repo}'.`,
      method: "DELETE",
      token,
    }
  );
}

export interface BranchLastCommit {
  sha: string;
  message: string;
}

export async function getLastCommitOnBranch(
  repo: string,
  branch: string,
  token?: string
): Promise<BranchLastCommit | null> {
  const [owner, repoName] = repo.split("/", 2);
  const encodedBranch = branch
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  try {
    const response = await getJson<{
      commit?: { sha?: string; commit?: { message?: string } };
    }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/branches/${encodedBranch}`,
      {
        notFoundMessage: `Branch '${branch}' was not found in repository '${repo}'.`,
        token,
      }
    );
    const sha = response.commit?.sha?.trim();
    const message = response.commit?.commit?.message?.trim() || "";
    if (!sha) {
      return null;
    }
    return { sha, message };
  } catch {
    return null;
  }
}

export async function markPullRequestReady(
  repo: string,
  pullNumber: number,
  token?: string
): Promise<void> {
  const [owner, repoName] = repo.split("/", 2);

  // First, get the PR node ID via REST
  const pr = await getJson<{ node_id?: string }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls/${pullNumber}`,
    {
      notFoundMessage: `Pull request #${pullNumber} was not found in repository '${repo}'.`,
      token,
    }
  );

  const nodeId = pr.node_id?.trim();
  if (!nodeId) {
    throw new GitHubApiError(
      `Pull request #${pullNumber} in repository '${repo}' did not include a node ID.`,
      502
    );
  }

  // Use the GraphQL API to mark the PR as ready for review
  const mutation = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number } } }`;
  await getJson<Record<string, unknown>>(
    "/graphql",
    {
      notFoundMessage: `Pull request #${pullNumber} was not found in repository '${repo}'.`,
      method: "POST",
      body: { query: mutation, variables: { id: nodeId } },
      token,
    }
  );
}

export async function mergePullRequest(
  repo: string,
  pullNumber: number,
  options?: {
    commitTitle?: string;
    commitMessage?: string;
    mergeMethod?: "merge" | "squash" | "rebase";
    token?: string;
  }
): Promise<MergePullRequestResult> {
  const [owner, repoName] = repo.split("/", 2);
  const body: Record<string, unknown> = {};
  if (options?.commitTitle) body.commit_title = options.commitTitle;
  if (options?.commitMessage) body.commit_message = options.commitMessage;
  if (options?.mergeMethod) body.merge_method = options.mergeMethod;

  const response = await getJson<GitHubMergePullRequestApiResponse>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls/${pullNumber}/merge`,
    {
      notFoundMessage: `Pull request #${pullNumber} was not found in repository '${repo}'.`,
      method: "PUT",
      body,
      token: options?.token,
    }
  );

  return {
    merged: response.merged === true,
    message: response.message?.trim() || "",
    sha: response.sha?.trim() || "",
  };
}

export interface MergePullRequestResult {
  merged: boolean;
  message: string;
  sha: string;
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

export async function createTask(
  owner: string,
  repo: string,
  body: Record<string, unknown>,
  authorizationHeader: string
): Promise<CreateTaskResponse> {
  const response = await getCopilotJson<GitHubTaskApiResponse>(
    `/agents/repos/${owner}/${repo}/tasks`,
    {
      notFoundMessage: `GitHub repository '${owner}/${repo}' was not found when creating tasks.`,
      method: "POST",
      body,
      authorizationHeader,
    }
  );

  const taskId = response.id?.trim();
  if (!taskId) {
    throw new GitHubApiError("GitHub task response was invalid.", 502);
  }

  return { id: taskId };
}

export async function getTask(
  owner: string,
  repo: string,
  taskId: string,
  authorizationHeader: string
): Promise<TaskInfoResponse> {
  return await getCopilotJson<TaskInfoResponse>(
    `/agents/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(taskId)}`,
    {
      notFoundMessage: `GitHub task '${taskId}' was not found in repository '${owner}/${repo}'.`,
      authorizationHeader,
    }
  );
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
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    token?: string;
  }
): Promise<T> {
  const response = await requestGitHub(path, {
    method: options.method,
    body: options.body,
    token: options.token,
  });
  return parseJsonResponse(path, options, response);
}

async function getCopilotJson<T>(
  path: string,
  options: {
    notFoundMessage: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    authorizationHeader: string;
  }
): Promise<T> {
  const response = await requestCopilot(path, {
    method: options.method,
    body: options.body,
    authorizationHeader: options.authorizationHeader,
  });
  return parseJsonResponse(path, options, response);
}

function parseJsonResponse<T>(
  path: string,
  options: {
    notFoundMessage: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  },
  response: { statusCode: number; body: string; headers: IncomingHttpHeaders }
): T {
  const payload = safeParseJson<GitHubErrorApiResponse>(response.body);
  const responseMessage = payload?.message?.trim();
  if (response.statusCode === 404) {
    logger.debug("GitHub API returned 404", {
      method: options.method ?? "GET",
      path,
      responseMessage,
      documentationUrl: payload?.documentation_url,
      ...summarizeHeaders(response.headers),
    });
    throw new GitHubApiError(options.notFoundMessage, 404);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const message =
      responseMessage ||
      `GitHub API request failed with status ${response.statusCode}.`;
    logger.warn("GitHub API request failed", {
      method: options.method ?? "GET",
      path,
      statusCode: response.statusCode,
      responseMessage: response.body,
      documentationUrl: payload?.documentation_url,
      ...summarizeHeaders(response.headers),
    });
    throw new GitHubApiError(message, response.statusCode);
  }

  // 204 No Content is a valid success response (e.g. DELETE operations)
  if (response.statusCode === 204 || !response.body.trim()) {
    return {} as T;
  }

  const successPayload = safeParseJson<T>(response.body);
  if (successPayload === null) {
    throw new GitHubApiError("GitHub API returned an invalid JSON response.", 502);
  }

  return successPayload;
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
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    token?: string;
  } = {}
): Promise<{ statusCode: number; body: string; headers: IncomingHttpHeaders }> {
  return requestJson(GITHUB_API_HOSTNAME, path, getRequestHeaders(options.token), options);
}

function requestCopilot(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    authorizationHeader: string;
  }
): Promise<{ statusCode: number; body: string; headers: IncomingHttpHeaders }> {
  return requestJson(
    GITHUB_COPILOT_API_HOSTNAME,
    path,
    getCopilotRequestHeaders(options.authorizationHeader),
    options
  );
}

function requestJson(
  hostname: string,
  path: string,
  headers: Record<string, string>,
  options: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
  } = {}
): Promise<{ statusCode: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const method = options.method ?? "GET";
    const requestBody = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = https.request(
      {
        protocol: "https:",
        hostname,
        path,
        method,
        headers: getJsonRequestHeaders(headers, requestBody),
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
            headers: response.headers,
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

function summarizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const [headerName, summaryKey] of [
    ["x-github-request-id", "requestId"],
    ["x-accepted-github-permissions", "acceptedPermissions"],
    ["x-oauth-scopes", "oauthScopes"],
    ["x-ratelimit-remaining", "rateLimitRemaining"],
  ] as const) {
    const value = getResponseHeader(headers, headerName);
    if (value) {
      summary[summaryKey] = value;
    }
  }

  return summary;
}

function getResponseHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  return undefined;
}

function getRequestHeaders(tokenOverride?: string): Record<string, string> {
  const token = tokenOverride?.trim() || process.env.PUBLIC_GITHUB_TOKEN?.trim();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "file-diff-engine",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function getCopilotRequestHeaders(authorizationHeader: string): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": "file-diff-engine",
    Authorization: authorizationHeader,
  };
}

function getJsonRequestHeaders(
  headers: Record<string, string>,
  requestBody?: string
): Record<string, string> {
  if (requestBody === undefined) {
    return headers;
  }

  return {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(requestBody)),
  };
}

function safeParseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

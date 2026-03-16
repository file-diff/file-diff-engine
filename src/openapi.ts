import fs from "fs/promises";
import path from "path";

interface OpenApiServer {
  url: string;
  description?: string;
}

interface OpenApiTag {
  name: string;
  description?: string;
}

interface OpenApiSchema {
  [key: string]: unknown;
}

interface OpenApiMediaType {
  schema?: OpenApiSchema;
  example?: unknown;
}

interface OpenApiRequestBody {
  description?: string;
  required?: boolean;
  content: Record<string, OpenApiMediaType>;
}

interface OpenApiResponse {
  description: string;
  headers?: Record<string, { description?: string; schema?: OpenApiSchema }>;
  content?: Record<string, OpenApiMediaType>;
}

interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
  example?: unknown;
}

interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
}

export interface OpenApiDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: OpenApiServer[];
  tags: OpenApiTag[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    schemas: Record<string, OpenApiSchema>;
  };
}

const apiVersionExample = "2026.03.10+abc1234";
const commitExample = "0123456789abcdef0123456789abcdef01234567";
const secondCommitExample = "1111111111111111111111111111111111111111";
const fileHashExample = "2222222222222222222222222222222222222222";
const jobStatusValues = ["waiting", "active", "completed", "failed"];
const fileTypeValues = ["d", "t", "b", "x", "s"];
const defaultServerUrl = "https://your-host.example.com";

const staticOpenApiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "File Diff Engine API",
    version: "1.0.0",
    description:
      "OpenAPI bindings for the file-diff-engine HTTP service. " +
      "This contract covers repository discovery, job orchestration, file download, tokenization, and diff operations.",
  },
  servers: [
    {
      url: defaultServerUrl,
      description: "Example deployment base URL",
    },
  ],
  tags: [
    {
      name: "system",
      description: "Service health and build metadata endpoints.",
    },
    {
      name: "discovery",
      description: "Resolve refs, pull requests, and repository metadata before creating jobs.",
    },
    {
      name: "jobs",
      description: "Create jobs and inspect processed repository metadata.",
    },
    {
      name: "files",
      description: "Download files and derive secondary artifacts from processed file blobs.",
    },
  ],
  paths: {
    "/api/health": {
      get: {
        tags: ["system"],
        summary: "Health check",
        description: "Checks whether the API process is running and able to respond.",
        responses: {
          "200": {
            description: "Health check response.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/HealthResponse",
                },
                example: {
                  status: "ok",
                  message: "API is healthy",
                },
              },
            },
          },
        },
      },
    },
    "/api/version": {
      get: {
        tags: ["system"],
        summary: "Build version",
        description: "Returns the configured build version string, or `dev` when not set.",
        responses: {
          "200": {
            description: "Build version response.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/VersionResponse",
                },
                example: {
                  version: apiVersionExample,
                },
              },
            },
          },
        },
      },
    },
    "/api/jobs/resolve": {
      post: {
        tags: ["discovery"],
        summary: "Resolve a git ref",
        description:
          "Resolves a branch, tag, or commit-like ref into a full 40-character commit SHA for a repository.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ResolveCommitRequest",
              },
              example: {
                repo: "facebook/react",
                ref: "main",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Resolved commit details.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ResolveCommitResponse",
                },
                example: {
                  repo: "facebook/react",
                  ref: "main",
                  commit: commitExample,
                  commitShort: "0123456",
                },
              },
            },
          },
          "400": {
            description: "Missing or invalid request fields.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
          "404": {
            description: "The provided ref could not be resolved.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
          "500": {
            description: "Unexpected repository resolution failure.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/api/jobs/pull-request/resolve": {
      post: {
        tags: ["discovery"],
        summary: "Resolve a GitHub pull request",
        description:
          "Resolves a full GitHub pull request URL into source and target commit hashes.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ResolvePullRequestRequest",
              },
              example: {
                pullRequestUrl: "https://github.com/facebook/react/pull/123",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Resolved pull request commit information.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ResolvePullRequestResponse",
                },
                example: {
                  repo: "facebook/react",
                  repositoryUrl: "https://github.com/facebook/react",
                  sourceCommit: commitExample,
                  sourceCommitShort: "0123456",
                  targetCommit: secondCommitExample,
                  targetCommitShort: "1111111",
                },
              },
            },
          },
          "400": {
            description: "Missing or malformed pull request URL.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
          "404": {
            description: "GitHub resource not found.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
          "500": {
            description: "Unexpected GitHub API failure.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/api/jobs/refs": {
      post: {
        tags: ["discovery"],
        summary: "List repository refs",
        description: "Lists available branches and tags for a repository.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ListRefsRequest",
              },
              example: {
                repo: "facebook/react",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Available branches and tags.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ListRefsResponse",
                },
                example: {
                  repo: "facebook/react",
                  refs: [
                    {
                      name: "main",
                      ref: "refs/heads/main",
                      type: "branch",
                      commit: commitExample,
                      commitShort: "0123456",
                    },
                    {
                      name: "v1.0.0",
                      ref: "refs/tags/v1.0.0",
                      type: "tag",
                      commit: commitExample,
                      commitShort: "0123456",
                    },
                  ],
                },
              },
            },
          },
          "400": {
            description: "Missing or invalid repository identifier.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
          "500": {
            description: "Repository refs could not be listed.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/api/jobs/organizations/{organization}/repositories": {
      get: {
        tags: ["discovery"],
        summary: "List organization repositories",
        description: "Lists repositories visible within a GitHub organization.",
        parameters: [
          {
            name: "organization",
            in: "path",
            required: true,
            description: "GitHub organization name.",
            schema: {
              type: "string",
            },
            example: "facebook",
          },
        ],
        responses: {
          "200": {
            description: "Repositories visible for the organization.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ListOrganizationRepositoriesResponse",
                },
                example: {
                  organization: "facebook",
                  repositories: [
                    {
                      name: "react",
                      repo: "facebook/react",
                      repositoryUrl: "https://github.com/facebook/react",
                    },
                  ],
                },
              },
            },
          },
          "400": {
            description: "Missing or invalid organization name.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
          "404": {
            description: "Organization not found.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
          "500": {
            description: "Unexpected GitHub API failure.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/api/jobs": {
      post: {
        tags: ["jobs"],
        summary: "Create or reuse a processing job",
        description:
          "Creates a new repository-processing job for a specific commit. If the commit already exists, the existing job summary is returned.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/JobRequest",
              },
              example: {
                repo: "facebook/react",
                commit: commitExample,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Existing job summary reused.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/JobSummary",
                },
              },
            },
          },
          "201": {
            description: "New job created.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/JobSummary",
                },
                example: {
                  id: commitExample,
                  status: "waiting",
                  commit: commitExample,
                  commitShort: "0123456",
                },
              },
            },
          },
          "400": {
            description: "Missing or invalid repository or commit fields.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/api/jobs/{id}": {
      get: {
        tags: ["jobs"],
        summary: "Get job details",
        description: "Returns status and progress for a previously created job.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Job ID / commit SHA.",
            schema: {
              type: "string",
            },
            example: commitExample,
          },
        ],
        responses: {
          "200": {
            description: "Job details.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/JobInfo",
                },
                example: {
                  id: commitExample,
                  repo: "facebook/react",
                  commit: commitExample,
                  commitShort: "0123456",
                  status: "completed",
                  progress: 100,
                  totalFiles: 4321,
                  processedFiles: 4321,
                  createdAt: "2026-03-16T00:00:00.000Z",
                  updatedAt: "2026-03-16T00:02:30.000Z",
                },
              },
            },
          },
          "404": {
            description: "Job not found.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/api/jobs/{id}/files": {
      get: {
        tags: ["jobs"],
        summary: "List processed files",
        description: "Returns compact metadata for files processed for a job.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Job ID / commit SHA.",
            schema: {
              type: "string",
            },
            example: commitExample,
          },
        ],
        responses: {
          "200": {
            description: "Processed file metadata.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/JobFilesResponse",
                },
                example: {
                  jobId: commitExample,
                  commit: commitExample,
                  commitShort: "0123456",
                  status: "completed",
                  progress: 100,
                  files: [
                    {
                      t: "t",
                      path: "README.md",
                      s: 1234,
                      update: "2026-03-16T00:00:00.000Z",
                      commit: commitExample,
                      hash: fileHashExample,
                    },
                  ],
                },
              },
            },
          },
          "404": {
            description: "Job not found.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/api/jobs/{id}/files/hash/{hash}/download": {
      get: {
        tags: ["files"],
        summary: "Download a processed file",
        description:
          "Streams the binary contents of a file belonging to a processed job by its git blob hash.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Job ID / commit SHA.",
            schema: {
              type: "string",
            },
            example: commitExample,
          },
          {
            name: "hash",
            in: "path",
            required: true,
            description: "Git blob hash for the requested file.",
            schema: {
              type: "string",
            },
            example: fileHashExample,
          },
        ],
        responses: {
          "200": {
            description: "Binary file contents.",
            headers: {
              "Content-Disposition": {
                description: "Attachment file name derived from stored metadata.",
                schema: {
                  type: "string",
                },
              },
            },
            content: {
              "application/octet-stream": {
                schema: {
                  type: "string",
                  format: "binary",
                },
              },
            },
          },
          "404": {
            description: "Job or file hash not found.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
          "429": {
            description: "Download rate limit exceeded.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RateLimitErrorResponse",
                },
                example: {
                  statusCode: 429,
                  error: "Too Many Requests",
                  message: "Rate limit exceeded, retry in 1 minute",
                },
              },
            },
          },
          "500": {
            description: "Invalid stored path or other unexpected file access error.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/api/jobs/files/hash/{hash}/tokenize": {
      get: {
        tags: ["files"],
        summary: "Tokenize a file with Shiki",
        description:
          "Loads a processed file by blob hash and returns the JSON token payload emitted by Shiki.",
        parameters: [
          {
            name: "hash",
            in: "path",
            required: true,
            description: "Git blob hash for the file to tokenize.",
            schema: {
              type: "string",
            },
            example: fileHashExample,
          },
        ],
        responses: {
          "200": {
            description: "Shiki tokenization payload.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ShikiTokenizationResponse",
                },
                example: {
                  tokens: [
                    [
                      {
                        content: "#",
                        offset: 0,
                        color: "#24292e",
                        fontStyle: 0,
                      },
                    ],
                  ],
                  fg: "#24292e",
                  bg: "#fff",
                  themeName: "github-light",
                },
              },
            },
          },
          "404": {
            description: "File hash not found or file unavailable on disk.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
          "500": {
            description: "Invalid stored path or tokenization failure.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/api/jobs/files/hash/{leftHash}/diff/{rightHash}": {
      get: {
        tags: ["files"],
        summary: "Diff two files by hash",
        description:
          "Runs `difft --display json` for two processed files located by git blob hash and returns the parsed JSON result.",
        parameters: [
          {
            name: "leftHash",
            in: "path",
            required: true,
            description: "Git blob hash for the left-hand file.",
            schema: {
              type: "string",
            },
            example: fileHashExample,
          },
          {
            name: "rightHash",
            in: "path",
            required: true,
            description: "Git blob hash for the right-hand file.",
            schema: {
              type: "string",
            },
            example: secondCommitExample,
          },
        ],
        responses: {
          "200": {
            description: "Parsed `difft` JSON output.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/DifftResponse",
                },
                example: {
                  status: "different",
                  changes: [],
                },
              },
            },
          },
          "404": {
            description: "Either file hash was not found or the file is unavailable on disk.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
          "500": {
            description: "Invalid stored path or `difft` execution failure.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ErrorResponse: {
        type: "object",
        additionalProperties: false,
        properties: {
          error: { type: "string" },
        },
        required: ["error"],
      },
      RateLimitErrorResponse: {
        type: "object",
        additionalProperties: false,
        properties: {
          statusCode: { type: "integer" },
          error: { type: "string" },
          message: { type: "string" },
        },
        required: ["statusCode", "error", "message"],
      },
      HealthResponse: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { const: "ok" },
          message: { type: "string" },
        },
        required: ["status", "message"],
      },
      VersionResponse: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: "string" },
        },
        required: ["version"],
      },
      ResolveCommitRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          repo: { type: "string" },
          ref: { type: "string" },
        },
        required: ["repo", "ref"],
      },
      ResolveCommitResponse: {
        type: "object",
        additionalProperties: false,
        properties: {
          repo: { type: "string" },
          ref: { type: "string" },
          commit: { type: "string", pattern: "^[a-f0-9]{40}$" },
          commitShort: { type: "string" },
        },
        required: ["repo", "ref", "commit", "commitShort"],
      },
      ResolvePullRequestRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          pullRequestUrl: { type: "string", format: "uri" },
        },
        required: ["pullRequestUrl"],
      },
      ResolvePullRequestResponse: {
        type: "object",
        additionalProperties: false,
        properties: {
          repo: { type: "string" },
          repositoryUrl: { type: "string", format: "uri" },
          sourceCommit: { type: "string", pattern: "^[a-f0-9]{40}$" },
          sourceCommitShort: { type: "string" },
          targetCommit: { type: "string", pattern: "^[a-f0-9]{40}$" },
          targetCommitShort: { type: "string" },
        },
        required: [
          "repo",
          "repositoryUrl",
          "sourceCommit",
          "sourceCommitShort",
          "targetCommit",
          "targetCommitShort",
        ],
      },
      ListRefsRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          repo: { type: "string" },
        },
        required: ["repo"],
      },
      GitRefSummary: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          ref: { type: "string" },
          type: { type: "string", enum: ["branch", "tag"] },
          commit: { type: "string", pattern: "^[a-f0-9]{40}$" },
          commitShort: { type: "string" },
        },
        required: ["name", "ref", "type", "commit", "commitShort"],
      },
      ListRefsResponse: {
        type: "object",
        additionalProperties: false,
        properties: {
          repo: { type: "string" },
          refs: {
            type: "array",
            items: { $ref: "#/components/schemas/GitRefSummary" },
          },
        },
        required: ["repo", "refs"],
      },
      OrganizationRepositorySummary: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          repo: { type: "string" },
          repositoryUrl: { type: "string", format: "uri" },
        },
        required: ["name", "repo", "repositoryUrl"],
      },
      ListOrganizationRepositoriesResponse: {
        type: "object",
        additionalProperties: false,
        properties: {
          organization: { type: "string" },
          repositories: {
            type: "array",
            items: { $ref: "#/components/schemas/OrganizationRepositorySummary" },
          },
        },
        required: ["organization", "repositories"],
      },
      JobRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          repo: { type: "string" },
          commit: {
            type: "string",
            pattern: "^[a-f0-9]{40}$",
          },
        },
        required: ["repo", "commit"],
      },
      JobStatus: {
        type: "string",
        enum: jobStatusValues,
      },
      JobSummary: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          status: { $ref: "#/components/schemas/JobStatus" },
          commit: { type: "string", pattern: "^[a-f0-9]{40}$" },
          commitShort: { type: "string" },
        },
        required: ["id", "status", "commit", "commitShort"],
      },
      JobInfo: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          repo: { type: "string" },
          commit: { type: "string", pattern: "^[a-f0-9]{40}$" },
          commitShort: { type: "string" },
          status: { $ref: "#/components/schemas/JobStatus" },
          progress: { type: "number" },
          totalFiles: { type: "integer" },
          processedFiles: { type: "integer" },
          error: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: [
          "id",
          "repo",
          "commit",
          "commitShort",
          "status",
          "progress",
          "totalFiles",
          "processedFiles",
          "createdAt",
          "updatedAt",
        ],
      },
      JobFileSummary: {
        type: "object",
        additionalProperties: false,
        properties: {
          t: { type: "string", enum: fileTypeValues },
          path: { type: "string" },
          s: { type: "integer" },
          update: { type: "string", format: "date-time" },
          commit: { type: "string" },
          hash: { type: "string" },
        },
        required: ["t", "path", "s", "update", "commit", "hash"],
      },
      JobFilesResponse: {
        type: "object",
        additionalProperties: false,
        properties: {
          jobId: { type: "string" },
          commit: { type: "string", pattern: "^[a-f0-9]{40}$" },
          commitShort: { type: "string" },
          status: { $ref: "#/components/schemas/JobStatus" },
          progress: { type: "number" },
          files: {
            type: "array",
            items: { $ref: "#/components/schemas/JobFileSummary" },
          },
        },
        required: ["jobId", "commit", "commitShort", "status", "progress", "files"],
      },
      ShikiToken: {
        type: "object",
        additionalProperties: true,
        properties: {
          content: { type: "string" },
          offset: { type: "integer" },
          color: { type: "string" },
          fontStyle: { type: "integer" },
        },
      },
      ShikiTokenizationResponse: {
        type: "object",
        additionalProperties: true,
        properties: {
          tokens: {
            type: "array",
            items: {
              type: "array",
              items: { $ref: "#/components/schemas/ShikiToken" },
            },
          },
          fg: { type: "string" },
          bg: { type: "string" },
          themeName: { type: "string" },
        },
        required: ["tokens"],
      },
      DifftResponse: {
        type: "object",
        additionalProperties: true,
        description: "Raw parsed JSON returned by `difft --display json`.",
      },
    },
  },
};

export function getOpenApiDocument(baseUrl?: string): OpenApiDocument {
  const document = JSON.parse(JSON.stringify(staticOpenApiDocument)) as OpenApiDocument;
  document.servers = [
    {
      url: baseUrl ?? defaultServerUrl,
      description: baseUrl ? "Current API server" : "Example deployment base URL",
    },
  ];
  return document;
}

export function renderOpenApiHtml(
  document: OpenApiDocument,
  specUrl: string = "/openapi.json"
): string {
  const pathEntries = Object.entries(document.paths);
  const navItems = pathEntries
    .flatMap(([routePath, methods]) =>
      Object.entries(methods).map(([method, operation]) => {
        const anchor = operationAnchor(method, routePath);
        return `<li><a href="#${anchor}"><span class="method ${escapeHtml(method)}">${escapeHtml(
          method.toUpperCase()
        )}</span><span>${escapeHtml(routePath)}</span></a></li>`;
      })
    )
    .join("");

  const operationSections = pathEntries
    .flatMap(([routePath, methods]) =>
      Object.entries(methods).map(([method, operation]) =>
        renderOperationSection(method, routePath, operation)
      )
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(document.info.title)} - OpenAPI</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f8fb;
        --card: #ffffff;
        --border: #d9e1ec;
        --text: #1f2937;
        --muted: #5f6b7a;
        --accent: #2563eb;
        --get: #0f766e;
        --post: #7c3aed;
        --code-bg: #0f172a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--text);
        background: var(--bg);
      }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .layout {
        display: grid;
        grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
        min-height: 100vh;
      }
      nav {
        position: sticky;
        top: 0;
        height: 100vh;
        overflow: auto;
        padding: 24px;
        border-right: 1px solid var(--border);
        background: #fff;
      }
      nav h1 {
        margin: 0 0 8px;
        font-size: 1.35rem;
      }
      nav p {
        margin: 0 0 16px;
        color: var(--muted);
        line-height: 1.5;
      }
      nav ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 8px;
      }
      nav li a {
        display: flex;
        gap: 10px;
        align-items: center;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--card);
      }
      main {
        padding: 32px;
        display: grid;
        gap: 20px;
      }
      .hero, .endpoint, .panel {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 24px;
        box-shadow: 0 6px 18px rgba(15, 23, 42, 0.04);
      }
      .hero p, .endpoint p, .panel p {
        color: var(--muted);
        line-height: 1.6;
      }
      .badges {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 16px;
      }
      .badge, .method {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        padding: 0.3rem 0.7rem;
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .badge {
        background: #eff6ff;
        color: #1d4ed8;
      }
      .method.get { background: #ccfbf1; color: var(--get); }
      .method.post { background: #ede9fe; color: var(--post); }
      .endpoint header {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        margin-bottom: 14px;
      }
      .endpoint h2 {
        margin: 0;
        font-size: 1.15rem;
      }
      .grid {
        display: grid;
        gap: 16px;
      }
      @media (min-width: 1000px) {
        .grid.two {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      h3, h4 {
        margin: 0 0 8px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      th {
        font-size: 0.85rem;
        color: var(--muted);
      }
      code, pre {
        font-family: "SFMono-Regular", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      pre {
        margin: 0;
        padding: 14px;
        overflow: auto;
        background: var(--code-bg);
        color: #e2e8f0;
        border-radius: 12px;
        font-size: 0.85rem;
        line-height: 1.5;
      }
      .inline-code {
        padding: 0.15rem 0.4rem;
        border-radius: 8px;
        background: #e5e7eb;
      }
      .response-list {
        display: grid;
        gap: 14px;
      }
      .response-card {
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 16px;
        background: #fff;
      }
      .response-card h4 {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .muted {
        color: var(--muted);
      }
      @media (max-width: 900px) {
        .layout {
          grid-template-columns: 1fr;
        }
        nav {
          position: static;
          height: auto;
          border-right: 0;
          border-bottom: 1px solid var(--border);
        }
        main {
          padding: 20px;
        }
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <nav>
        <h1>${escapeHtml(document.info.title)}</h1>
        <p>${escapeHtml(document.info.description)}</p>
        <p><strong>JSON:</strong> <a href="${escapeHtml(specUrl)}">${escapeHtml(specUrl)}</a></p>
        <ul>${navItems}</ul>
      </nav>
      <main>
        <section class="hero">
          <h2>OpenAPI bindings</h2>
          <p>${escapeHtml(document.info.description)}</p>
          <div class="badges">
            <span class="badge">OpenAPI ${escapeHtml(document.openapi)}</span>
            ${document.servers
              .map(
                (server) =>
                  `<span class="badge">${escapeHtml(server.description ?? "Server")}: ${escapeHtml(
                    server.url
                  )}</span>`
              )
              .join("")}
          </div>
        </section>
        <section class="panel">
          <h3>Components</h3>
          <p>This service publishes a machine-readable contract at <a href="${escapeHtml(
            specUrl
          )}">${escapeHtml(specUrl)}</a> and a generated static website view built from the same source document.</p>
          <div class="grid two">
            <div>
              <h4>Tags</h4>
              <table>
                <thead><tr><th>Name</th><th>Description</th></tr></thead>
                <tbody>
                  ${document.tags
                    .map(
                      (tag) =>
                        `<tr><td><code>${escapeHtml(tag.name)}</code></td><td>${escapeHtml(
                          tag.description ?? ""
                        )}</td></tr>`
                    )
                    .join("")}
                </tbody>
              </table>
            </div>
            <div>
              <h4>Schemas</h4>
              <pre>${escapeHtml(JSON.stringify(document.components.schemas, null, 2))}</pre>
            </div>
          </div>
        </section>
        ${operationSections}
      </main>
    </div>
  </body>
</html>`;
}

export async function writeOpenApiSite(
  outputDir: string,
  baseUrl?: string
): Promise<{ htmlPath: string; jsonPath: string }> {
  const document = getOpenApiDocument(baseUrl);
  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "openapi.json");
  const htmlPath = path.join(outputDir, "index.html");
  await fs.writeFile(jsonPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await fs.writeFile(htmlPath, renderOpenApiHtml(document, "./openapi.json"), "utf8");
  return { htmlPath, jsonPath };
}

function renderOperationSection(
  method: string,
  routePath: string,
  operation: OpenApiOperation
): string {
  const anchor = operationAnchor(method, routePath);
  const parameters = operation.parameters ?? [];
  const requestBody = operation.requestBody;

  return `<section id="${anchor}" class="endpoint">
    <header>
      <span class="method ${escapeHtml(method)}">${escapeHtml(method.toUpperCase())}</span>
      <h2><code>${escapeHtml(routePath)}</code></h2>
      ${
        operation.tags?.length
          ? operation.tags
              .map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`)
              .join("")
          : ""
      }
    </header>
    <p><strong>${escapeHtml(operation.summary ?? "Endpoint")}</strong></p>
    <p>${escapeHtml(operation.description ?? "")}</p>
    ${
      parameters.length
        ? `<div class="panel">
            <h3>Parameters</h3>
            <table>
              <thead>
                <tr><th>Name</th><th>In</th><th>Required</th><th>Description</th><th>Schema</th></tr>
              </thead>
              <tbody>
                ${parameters
                  .map(
                    (parameter) =>
                      `<tr>
                        <td><code>${escapeHtml(parameter.name)}</code></td>
                        <td>${escapeHtml(parameter.in)}</td>
                        <td>${parameter.required ? "Yes" : "No"}</td>
                        <td>${escapeHtml(parameter.description ?? "")}</td>
                        <td><code>${escapeHtml(renderSchemaSummary(parameter.schema))}</code></td>
                      </tr>`
                  )
                  .join("")}
              </tbody>
            </table>
          </div>`
        : ""
    }
    ${
      requestBody
        ? `<div class="panel">
            <h3>Request body</h3>
            ${renderMediaTypes(requestBody.content)}
          </div>`
        : ""
    }
    <div class="panel">
      <h3>Responses</h3>
      <div class="response-list">
        ${Object.entries(operation.responses)
          .map(
            ([statusCode, response]) => `<article class="response-card">
              <h4>
                <span>Status ${escapeHtml(statusCode)}</span>
                <span class="muted">${escapeHtml(response.description)}</span>
              </h4>
              ${
                response.headers
                  ? `<p><strong>Headers</strong></p><pre>${escapeHtml(
                      JSON.stringify(response.headers, null, 2)
                    )}</pre>`
                  : ""
              }
              ${
                response.content
                  ? renderMediaTypes(response.content)
                  : `<p class="muted">No response body.</p>`
              }
            </article>`
          )
          .join("")}
      </div>
    </div>
  </section>`;
}

function renderMediaTypes(content: Record<string, OpenApiMediaType>): string {
  return Object.entries(content)
    .map(
      ([mediaType, media]) => `<div class="grid two" style="margin-top: 12px;">
        <div>
          <h4>${escapeHtml(mediaType)}</h4>
          <pre>${escapeHtml(JSON.stringify(media.schema ?? {}, null, 2))}</pre>
        </div>
        <div>
          <h4>Example</h4>
          <pre>${escapeHtml(
            JSON.stringify(
              media.example ?? { note: "No example supplied for this media type." },
              null,
              2
            )
          )}</pre>
        </div>
      </div>`
    )
    .join("");
}

function renderSchemaSummary(schema?: OpenApiSchema): string {
  if (!schema) {
    return "unspecified";
  }
  const ref = typeof schema.$ref === "string" ? schema.$ref : undefined;
  if (ref) {
    return ref;
  }
  const type = schema.type;
  if (Array.isArray(type)) {
    return type.join(" | ");
  }
  if (typeof type === "string") {
    return type;
  }
  if (typeof schema.const === "string") {
    return schema.const;
  }
  return "object";
}

function operationAnchor(method: string, routePath: string): string {
  return `${method}-${routePath.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { JobRepository } from "../../db/repository";
import {
  AgentTaskActionConflictError,
  cancelAgentTaskJob,
  deleteAgentTaskJob,
} from "../../services/agentTaskActions";
import * as githubApi from "../../services/githubApi";
import {
  buildPullRequestReviewProblemStatement,
  normalizeGitRef,
} from "../../services/opencodeTask";
import type { ManagedQueue } from "../../services/queue";
import type {
  AgentTaskJobInfo,
  AgentTaskMode,
  AgentTaskRunner,
  CodexReasoningEffort,
  CodexReasoningSummary,
  CodexVerbosity,
  CreatePullRequestReviewRequest,
  CreateTaskRequest,
  CreateTaskResponse,
  ErrorResponse,
  PullRequestCompletionMode,
} from "../../types";
import {
  isValidRepo,
  logger,
  normalizeRepo,
  requireAdminBearerToken,
  requireViewerBearerToken,
} from "../jobs/shared";

const CREATE_TASK_ROUTE_RATE_LIMIT_MAX = 60;
const CREATE_TASK_ROUTE_RATE_LIMIT_WINDOW_MS = 60_000;
const PULL_REQUEST_COMPLETION_MODES: readonly PullRequestCompletionMode[] = [
  "None",
  "AutoReady",
  "AutoMerge",
];
const SUPPORTED_DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const SUPPORTED_AGENT_TASK_RUNNERS = ["codex", "opencode", "claude"] as const;
const DEFAULT_AGENT_TASK_RUNNER: AgentTaskRunner = "codex";
const DEFAULT_CODEX_MODEL = "gpt-5.2-codex";
const DEFAULT_CLAUDE_MODEL = "sonnet";
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

export function registerAgentCreateTaskRoutes(
  app: FastifyInstance,
  queue: ManagedQueue,
  jobRepo: JobRepository
): void {
  /**
   * POST /api/agents/create-task
   * Creates a new local agent task for a repository.
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
        problem_statement,
        model,
        task,
        reasoning_effort,
        reasoning_summary,
        verbosity,
        codex_web_search,
        create_pull_request,
        auto_ready,
        auto_merge,
        pull_request_completion_mode,
        base_ref,
        branch,
        branch_title,
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

      const requestedBranchResult = resolveRequestedBranch(branch, branch_title);
      if (requestedBranchResult.error) {
        const response: ErrorResponse = { error: requestedBranchResult.error };
        return reply.code(400).send(response);
      }

      const taskRunner = task === undefined ? DEFAULT_AGENT_TASK_RUNNER : task;
      const validationError = validateAgentTaskOptions({
        taskRunner,
        model,
        create_pull_request,
        reasoning_effort,
        reasoning_summary,
        verbosity,
        codex_web_search,
      });
      if (validationError) {
        const response: ErrorResponse = { error: validationError };
        return reply.code(400).send(response);
      }

      const pullRequestCompletionResolution = resolvePullRequestCompletionMode(
        {
          auto_ready,
          auto_merge,
          pull_request_completion_mode,
        }
      );
      if (pullRequestCompletionResolution.error) {
        const response: ErrorResponse = {
          error: pullRequestCompletionResolution.error,
        };
        return reply.code(400).send(response);
      }

      const delayError = validateTaskDelayMs(task_delay_ms);
      if (delayError) {
        const response: ErrorResponse = { error: delayError };
        return reply.code(400).send(response);
      }

      const [owner, repoName] = repo.split("/", 2);
      const taskDelayMs = task_delay_ms ?? 0;
      const taskModel = resolveTaskModel(taskRunner, model);
      const jobId = randomUUID();
      const scheduledAt = taskDelayMs > 0
        ? new Date(Date.now() + taskDelayMs)
        : null;
      const reasoningEffort =
        taskRunner === "codex"
          ? reasoning_effort ?? DEFAULT_CODEX_REASONING_EFFORT
          : undefined;
      const reasoningSummary =
        taskRunner === "codex"
          ? reasoning_summary ?? DEFAULT_CODEX_REASONING_SUMMARY
          : undefined;

      let agentTaskJobCreated = false;
      try {
        logger.info(`AgentTask: Scheduling ${taskRunner} task job=${jobId} repo=${repo} model=${taskModel} delay_ms=${taskDelayMs}`);
        await jobRepo.createAgentTaskJob({
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
          branchName: requestedBranchResult.branch,
          pullRequestCompletionMode: pullRequestCompletionResolution.mode,
        });
        agentTaskJobCreated = true;
        await enqueueAgentTaskJob(
          queue,
          jobId,
          `${owner}/${repoName}`,
          base_ref,
          requestedBranchResult.branch,
          problem_statement,
          taskRunner,
          taskModel,
          reasoningEffort,
          reasoningSummary,
          verbosity,
          codex_web_search,
          pullRequestCompletionResolution.mode,
          taskDelayMs,
          githubKey?.trim() || undefined,
          deepseek_api_key?.trim() || undefined
        );
        logger.info(`AgentTask ${jobId}: Enqueued for repo=${repo}`);
        return reply.code(201).send({ id: jobId } satisfies CreateTaskResponse);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to schedule task.";
        if (agentTaskJobCreated) {
          await markAgentTaskEnqueueFailure(jobRepo, jobId, message);
        }
        logger.warn(`AgentTask: Failed to schedule task for repo=${repo}: ${message}`);
        const response: ErrorResponse = { error: message };
        return reply.code(500).send(response);
      }
    }
  );

  /**
   * POST /api/agents/create-review
   * Creates a local agent task that reviews an existing pull request.
   */
  app.post<{ Body: CreatePullRequestReviewRequest }>(
    "/create-review",
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
        model,
        task,
        reasoning_effort,
        reasoning_summary,
        verbosity,
        codex_web_search,
        task_delay_ms,
        deepseek_api_key,
        githubKey,
      } = request.body ?? {};
      const pullRequestNumber =
        request.body?.pull_request_number ?? request.body?.pullRequestNumber;

      if (!repo || pullRequestNumber === undefined) {
        const response: ErrorResponse = {
          error: "'repo' and 'pull_request_number' are required.",
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

      if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
        const response: ErrorResponse = {
          error: "Field 'pull_request_number' must be a positive integer.",
        };
        return reply.code(400).send(response);
      }

      if (
        request.body?.branch !== undefined ||
        request.body?.branch_title !== undefined ||
        request.body?.create_pull_request !== undefined ||
        request.body?.auto_ready !== undefined ||
        request.body?.auto_merge !== undefined ||
        request.body?.pull_request_completion_mode !== undefined
      ) {
        const response: ErrorResponse = {
          error:
            "Fields 'branch', 'branch_title', 'create_pull_request', 'auto_ready', 'auto_merge', and 'pull_request_completion_mode' are not supported for pull request review tasks.",
        };
        return reply.code(400).send(response);
      }

      const taskRunner = task === undefined ? DEFAULT_AGENT_TASK_RUNNER : task;
      const validationError = validateAgentTaskOptions({
        taskRunner,
        model,
        reasoning_effort,
        reasoning_summary,
        verbosity,
        codex_web_search,
      });
      if (validationError) {
        const response: ErrorResponse = { error: validationError };
        return reply.code(400).send(response);
      }

      const delayError = validateTaskDelayMs(task_delay_ms);
      if (delayError) {
        const response: ErrorResponse = { error: delayError };
        return reply.code(400).send(response);
      }

      const taskDelayMs = task_delay_ms ?? 0;
      const taskModel = resolveTaskModel(taskRunner, model);
      const jobId = randomUUID();
      const scheduledAt = taskDelayMs > 0
        ? new Date(Date.now() + taskDelayMs)
        : null;
      const reasoningEffort =
        taskRunner === "codex"
          ? reasoning_effort ?? DEFAULT_CODEX_REASONING_EFFORT
          : undefined;
      const reasoningSummary =
        taskRunner === "codex"
          ? reasoning_summary ?? DEFAULT_CODEX_REASONING_SUMMARY
          : undefined;

      let agentTaskJobCreated = false;
      try {
        const token = githubKey?.trim() || undefined;
        const pullRequest = await githubApi.getPullRequestReviewTarget(
          repo,
          pullRequestNumber,
          token
        );
        const problemStatement = buildPullRequestReviewProblemStatement(
          pullRequest.headRef,
          pullRequest.number
        );

        logger.info(`AgentTask: Scheduling ${taskRunner} review job=${jobId} repo=${repo} pr=${pullRequest.number} model=${taskModel} delay_ms=${taskDelayMs}`);
        await jobRepo.createAgentTaskJob({
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
          baseRef: pullRequest.baseRef,
          branchName: pullRequest.headRef,
          pullRequestUrl: pullRequest.url,
          pullRequestNumber: pullRequest.number,
        });
        agentTaskJobCreated = true;
        await enqueueAgentTaskJob(
          queue,
          jobId,
          repo,
          pullRequest.baseRef,
          pullRequest.headRef,
          problemStatement,
          taskRunner,
          taskModel,
          reasoningEffort,
          reasoningSummary,
          verbosity,
          codex_web_search,
          undefined,
          taskDelayMs,
          token,
          deepseek_api_key?.trim() || undefined,
          "review",
          {
            number: pullRequest.number,
            url: pullRequest.url,
            title: pullRequest.title,
            headRepo: pullRequest.headRepo,
            headSha: pullRequest.headSha,
          }
        );
        logger.info(`AgentTask ${jobId}: Enqueued review for repo=${repo} pr=${pullRequest.number}`);
        return reply.code(201).send({ id: jobId } satisfies CreateTaskResponse);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to schedule review.";
        if (agentTaskJobCreated) {
          await markAgentTaskEnqueueFailure(jobRepo, jobId, message);
        }
        logger.warn(`AgentTask: Failed to schedule review for repo=${repo}: ${message}`);
        const response: ErrorResponse = { error: message };
        const statusCode =
          error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
        return reply.code(statusCode).send(response);
      }
    }
  );

  /**
   * GET /api/agents/create-task/pending
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

function resolvePullRequestCompletionMode(
  body: Pick<CreateTaskRequest, "auto_ready" | "auto_merge" | "pull_request_completion_mode">
): {
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

function resolveRequestedBranch(
  branch: unknown,
  branchTitle: unknown
): { branch?: string; error?: string } {
  if (branch !== undefined && typeof branch !== "string") {
    return { error: "Field 'branch' must be a non-empty git ref string." };
  }

  if (branchTitle !== undefined && typeof branchTitle !== "string") {
    return { error: "Field 'branch_title' must be a non-empty git ref string." };
  }

  try {
    const normalizedBranch = branch !== undefined
      ? normalizeGitRef(branch, "branch")
      : undefined;
    const normalizedBranchTitle = branchTitle !== undefined
      ? normalizeGitRef(branchTitle, "branch_title")
      : undefined;

    if (
      normalizedBranch &&
      normalizedBranchTitle &&
      normalizedBranch !== normalizedBranchTitle
    ) {
      return {
        error: "Fields 'branch' and 'branch_title' must match when both are provided.",
      };
    }

    return { branch: normalizedBranch ?? normalizedBranchTitle };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid branch value.",
    };
  }
}

function validateAgentTaskOptions(options: {
  taskRunner: unknown;
  model?: string;
  create_pull_request?: boolean;
  reasoning_effort?: CodexReasoningEffort;
  reasoning_summary?: CodexReasoningSummary;
  verbosity?: CodexVerbosity;
  codex_web_search?: boolean;
}): string | undefined {
  const {
    taskRunner,
    model,
    create_pull_request,
    reasoning_effort,
    reasoning_summary,
    verbosity,
    codex_web_search,
  } = options;

  if (!isSupportedAgentTaskRunner(taskRunner)) {
    return "Field 'task' must be one of: codex, opencode, claude.";
  }

  if (
    taskRunner === "opencode" &&
    model !== undefined &&
    !isSupportedDeepSeekModel(model)
  ) {
    return "Field 'model' must be one of: deepseek-v4-flash, deepseek-v4-pro.";
  }

  if (
    (taskRunner === "codex" || taskRunner === "claude") &&
    model !== undefined &&
    (typeof model !== "string" || !model.trim())
  ) {
    return "Field 'model' must be a non-empty string.";
  }

  if (
    create_pull_request !== undefined &&
    create_pull_request !== true
  ) {
    return "Field 'create_pull_request' must be true when provided because agent tasks always open a draft pull request.";
  }

  if (
    reasoning_effort !== undefined &&
    !isSupportedCodexReasoningEffort(reasoning_effort)
  ) {
    return "Field 'reasoning_effort' must be one of: low, medium, high, xhigh.";
  }

  if (
    reasoning_summary !== undefined &&
    !isSupportedCodexReasoningSummary(reasoning_summary)
  ) {
    return "Field 'reasoning_summary' must be one of: none, auto, concise, detailed.";
  }

  if (
    verbosity !== undefined &&
    !isSupportedCodexVerbosity(verbosity)
  ) {
    return "Field 'verbosity' must be one of: low, medium, high.";
  }

  if (
    codex_web_search !== undefined &&
    typeof codex_web_search !== "boolean"
  ) {
    return "Field 'codex_web_search' must be a boolean.";
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
    return "Fields 'reasoning_effort', 'reasoning_summary', 'verbosity', and 'codex_web_search' are only supported for codex tasks.";
  }

  return undefined;
}

function validateTaskDelayMs(taskDelayMs: unknown): string | undefined {
  if (
    taskDelayMs !== undefined &&
    (typeof taskDelayMs !== "number" ||
      !Number.isInteger(taskDelayMs) ||
      taskDelayMs < 0)
  ) {
    return "Field 'task_delay_ms' must be a non-negative integer.";
  }

  return undefined;
}

function resolveTaskModel(
  taskRunner: AgentTaskRunner,
  model: string | undefined
): string {
  return model?.trim() ||
    (taskRunner === "opencode"
      ? DEFAULT_DEEPSEEK_MODEL
      : taskRunner === "claude"
        ? process.env.CLAUDE_MODEL?.trim() || DEFAULT_CLAUDE_MODEL
        : process.env.CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL);
}

async function markAgentTaskEnqueueFailure(
  jobRepo: JobRepository,
  jobId: string,
  reason: string
): Promise<void> {
  try {
    await jobRepo.updateAgentTaskJobStatus(
      jobId,
      "failed",
      `Failed to enqueue task job: ${reason}`
    );
  } catch (rollbackError) {
    logger.error(
      `Failed to mark agent task job ${jobId} as failed after enqueue error: ${
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      }`
    );
  }
}

async function enqueueAgentTaskJob(
  queue: ManagedQueue,
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
  deepseekApiKey?: string,
  taskMode: AgentTaskMode = "task",
  pullRequest?: {
    number: number;
    url: string;
    title: string;
    headRepo: string;
    headSha: string;
  }
): Promise<void> {
  await queue.add(
    task === "opencode"
      ? "create-opencode-task"
      : task === "claude"
        ? "create-claude-task"
        : "create-codex-task",
    {
      jobId,
      repoName,
      baseRef,
      ...(branch ? { branch } : {}),
      problemStatement,
      task,
      taskMode,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(reasoningSummary ? { reasoningSummary } : {}),
      ...(verbosity ? { verbosity } : {}),
      ...(codexWebSearch !== undefined ? { codexWebSearch } : {}),
      ...(pullRequestCompletionMode ? { pullRequestCompletionMode } : {}),
      ...(pullRequest
        ? {
            pullRequestNumber: pullRequest.number,
            pullRequestUrl: pullRequest.url,
            pullRequestTitle: pullRequest.title,
            pullRequestHeadRepo: pullRequest.headRepo,
            pullRequestHeadSha: pullRequest.headSha,
          }
        : {}),
      ...(githubKey ? { githubKey } : {}),
      ...(task === "opencode" && deepseekApiKey ? { deepseekApiKey } : {}),
    },
    {
      jobId,
      delay: delayMs,
    }
  );
}

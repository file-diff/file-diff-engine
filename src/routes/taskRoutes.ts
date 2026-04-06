import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync } from "fastify";
import type { ErrorResponse } from "../types";
import * as githubApi from "../services/githubApi";
import {
  CREATE_TASK_BEARER_TOKEN_ENV,
  getConfiguredBearerToken,
  isValidRepo,
  matchesBearerToken,
} from "./jobs/shared";

const TASK_ROUTE_RATE_LIMIT_MAX = 60;
const TASK_ROUTE_RATE_LIMIT_WINDOW_MS = 60_000;

async function validateTaskRepoAuthorization(
  authorizationHeader: string | string[] | undefined,
  owner: string,
  repo: string
): Promise<
  | { ok: true; copilotAuthorizationHeader: string }
  | { ok: false; statusCode: number; response: ErrorResponse }
> {
  const endpointBearerToken = getConfiguredBearerToken(CREATE_TASK_BEARER_TOKEN_ENV);
  if (!endpointBearerToken) {
    return {
      ok: false,
      statusCode: 503,
      response: {
        error: "Create-task bearer token is not configured.",
      },
    };
  }

  if (!matchesBearerToken(authorizationHeader, endpointBearerToken)) {
    return {
      ok: false,
      statusCode: 401,
      response: {
        error: "Bearer token is required.",
      },
    };
  }

  if (!isValidRepo(`${owner}/${repo}`)) {
    return {
      ok: false,
      statusCode: 400,
      response: {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      },
    };
  }

  try {
    return {
      ok: true,
      copilotAuthorizationHeader:
        await githubApi.fetchCopilotAuthorizationHeader(),
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to fetch Copilot authorization header.";
    return {
      ok: false,
      statusCode:
        error instanceof githubApi.GitHubApiError ? error.statusCode : 503,
      response: { error: message },
    };
  }
}

export const registerTaskRoutes: FastifyPluginAsync = async (app) => {
  await app.register(rateLimit, { global: false });

  app.get<{
    Params: {
      owner: string;
      repo: string;
    };
  }>(
    "/agents/repos/:owner/:repo/tasks",
    {
      preHandler: app.rateLimit({
        max: TASK_ROUTE_RATE_LIMIT_MAX,
        timeWindow: TASK_ROUTE_RATE_LIMIT_WINDOW_MS,
      }),
    },
    async (request, reply) => {
      const { owner, repo } = request.params;
      const authorizedRequest = await validateTaskRepoAuthorization(
        request.headers.authorization,
        owner,
        repo
      );
      if (!authorizedRequest.ok) {
        return reply.code(authorizedRequest.statusCode).send(authorizedRequest.response);
      }

      try {
        const result = await githubApi.listTasks(
          owner,
          repo,
          authorizedRequest.copilotAuthorizationHeader
        );
        return reply.code(200).send(result);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to list tasks.";
        const response: ErrorResponse = { error: message };
        const statusCode =
          error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
        return reply.code(statusCode).send(response);
      }
    }
  );

  app.get<{
    Params: {
      owner: string;
      repo: string;
      task_id: string;
    }
  }>(
    "/agents/repos/:owner/:repo/tasks/:task_id",
    {
      preHandler: app.rateLimit({
        max: TASK_ROUTE_RATE_LIMIT_MAX,
        timeWindow: TASK_ROUTE_RATE_LIMIT_WINDOW_MS,
      }),
    },
    async (request, reply) => {
      const { owner, repo, task_id: rawTaskId } = request.params;
      const taskId = rawTaskId.trim();
      if (!taskId) {
        const response: ErrorResponse = {
          error: "Task id is required.",
        };
        return reply.code(400).send(response);
      }

      const authorizedRequest = await validateTaskRepoAuthorization(
        request.headers.authorization,
        owner,
        repo
      );
      if (!authorizedRequest.ok) {
        return reply.code(authorizedRequest.statusCode).send(authorizedRequest.response);
      }

      try {
        const result = await githubApi.getTask(
          owner,
          repo,
          taskId,
          authorizedRequest.copilotAuthorizationHeader
        );
        return reply.code(200).send(result);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to get task info.";
        const response: ErrorResponse = { error: message };
        const statusCode =
          error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
        return reply.code(statusCode).send(response);
      }
    }
  );
};

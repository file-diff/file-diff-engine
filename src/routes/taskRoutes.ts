import type { FastifyPluginAsync } from "fastify";
import type { ErrorResponse } from "../types";
import * as githubApi from "../services/githubApi";
import {
  CREATE_TASK_BEARER_TOKEN_ENV,
  getConfiguredBearerToken,
  isValidRepo,
  matchesBearerToken,
} from "./jobs/shared";

export const registerTaskRoutes: FastifyPluginAsync = async (app) => {
  app.get<{
    Params: {
      owner: string;
      repo: string;
      task_id: string;
    };
  }>("/agents/repos/:owner/:repo/tasks/:task_id", async (request, reply) => {
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

    const { owner, repo, task_id: rawTaskId } = request.params;
    const taskId = rawTaskId.trim();
    if (!isValidRepo(`${owner}/${repo}`)) {
      const response: ErrorResponse = {
        error:
          "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react').",
      };
      return reply.code(400).send(response);
    }

    if (!taskId) {
      const response: ErrorResponse = {
        error: "Task id is required.",
      };
      return reply.code(400).send(response);
    }

    let copilotAuthorizationHeader: string;
    try {
      copilotAuthorizationHeader = await githubApi.fetchCopilotAuthorizationHeader();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to fetch Copilot authorization header.";
      const response: ErrorResponse = { error: message };
      const statusCode =
        error instanceof githubApi.GitHubApiError ? error.statusCode : 503;
      return reply.code(statusCode).send(response);
    }

    try {
      const result = await githubApi.getTask(owner, repo, taskId, copilotAuthorizationHeader);
      return reply.code(200).send(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to get task info.";
      const response: ErrorResponse = { error: message };
      const statusCode =
        error instanceof githubApi.GitHubApiError ? error.statusCode : 500;
      return reply.code(statusCode).send(response);
    }
  });
};

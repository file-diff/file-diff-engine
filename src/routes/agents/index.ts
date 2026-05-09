import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync } from "fastify";
import { JobRepository } from "../../db/repository";
import type { ManagedQueue } from "../../services/queue";
import { registerAgentCreateTaskRoutes } from "./createTaskRoutes";

export function createAgentRoutes(
  queue: ManagedQueue,
  jobRepo: JobRepository
): FastifyPluginAsync {
  return async function registerAgentRoutes(app) {
    await app.register(rateLimit, { global: false });

    registerAgentCreateTaskRoutes(app, queue, jobRepo);
  };
}

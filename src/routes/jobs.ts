import { Queue } from "bullmq";
import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync } from "fastify";
import { JobRepository } from "../db/repository";
import { registerDiscoveryRoutes } from "./jobs/discoveryRoutes";
import { registerDownloadRoutes } from "./jobs/downloadRoutes";
import { registerJobManagementRoutes } from "./jobs/jobManagementRoutes";

export function createJobRoutes(
  queue: Queue,
  jobRepo: JobRepository
): FastifyPluginAsync {
  return async function registerJobRoutes(app) {
    await app.register(rateLimit, { global: false });

    registerDiscoveryRoutes(app, queue, jobRepo);
    registerJobManagementRoutes(app, queue, jobRepo);
    registerDownloadRoutes(app, jobRepo);
  };
}

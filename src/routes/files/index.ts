import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync } from "fastify";
import { JobRepository } from "../../db/repository";
import type { ManagedQueue } from "../../services/queue";
import { registerDownloadRoutes } from "../jobs/downloadRoutes";
import { registerIndexTaskRoutes } from "./indexTaskRoutes";

export function createFileRoutes(
  queue: ManagedQueue,
  jobRepo: JobRepository
): FastifyPluginAsync {
  return async function registerFileRoutes(app) {
    await app.register(rateLimit, { global: false });

    registerIndexTaskRoutes(app, queue, jobRepo);
    registerDownloadRoutes(app, jobRepo, {
      hashBasePath: "/hash",
      jobFileBasePath: "/index-task/:id/hash",
    });
  };
}

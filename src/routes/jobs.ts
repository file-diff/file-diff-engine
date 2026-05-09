import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync } from "fastify";
import { registerDiscoveryRoutes } from "./jobs/discoveryRoutes";

export function createJobRoutes(): FastifyPluginAsync {
  return async function registerJobRoutes(app) {
    await app.register(rateLimit, { global: false });

    registerDiscoveryRoutes(app);
  };
}

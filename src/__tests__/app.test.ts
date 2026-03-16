import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import type { DatabaseClient } from "../db/database";
import { createApp } from "../app";
import type { VersionResponse } from "../types";
import { createTestDatabase } from "./helpers/testDatabase";

describe("createApp", () => {
  let db: DatabaseClient;
  let mockQueue: Queue;
  const originalBuildVersion = process.env.BUILD_VERSION;

  beforeEach(async () => {
    db = await createTestDatabase();
    mockQueue = {
      close: async () => undefined,
    } as unknown as Queue;
  });

  afterEach(async () => {
    if (originalBuildVersion === undefined) {
      delete process.env.BUILD_VERSION;
    } else {
      process.env.BUILD_VERSION = originalBuildVersion;
    }
    await db.end();
  });

  it("responds to health checks with permissive CORS headers", async () => {
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/health",
      headers: {
        origin: "https://frontend.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "X-Requested-With, Content-Type",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://frontend.example"
    );
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["access-control-allow-methods"]).toContain("GET");
    expect(response.headers["access-control-allow-headers"]).toContain(
      "X-Requested-With"
    );

    await app.close();
  });

  it("returns the configured build version", async () => {
    process.env.BUILD_VERSION = "2026.03.10+abc1234";
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await app.inject({
      method: "GET",
      url: "/api/version",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<VersionResponse>()).toEqual({
      version: "2026.03.10+abc1234",
    });

    await app.close();
  });

  it("publishes an OpenAPI document", async () => {
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: {
        host: "api.example.test",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      openapi: "3.1.0",
      info: {
        title: "File Diff Engine API",
      },
      servers: [
        {
          url: "http://api.example.test",
          description: "Current API server",
        },
      ],
    });

    await app.close();
  });

  it("renders an OpenAPI website", async () => {
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await app.inject({
      method: "GET",
      url: "/openapi",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("OpenAPI bindings");
    expect(response.body).toContain("/api/jobs/resolve");

    await app.close();
  });
});

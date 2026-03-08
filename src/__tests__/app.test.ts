import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import type { DatabaseClient } from "../db/database";
import { createApp } from "../app";
import { createTestDatabase } from "./helpers/testDatabase";

describe("createApp", () => {
  let db: DatabaseClient;
  let mockQueue: Queue;

  beforeEach(async () => {
    db = await createTestDatabase();
    mockQueue = {
      close: async () => undefined,
    } as unknown as Queue;
  });

  afterEach(async () => {
    await db.end();
  });

  it("responds to health checks with permissive CORS headers", async () => {
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await app.inject({
      method: "OPTIONS",
      url: "/health",
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
});

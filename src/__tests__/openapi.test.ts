import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getOpenApiDocument,
  renderOpenApiHtml,
  writeOpenApiSite,
} from "../openapi";

describe("openapi helpers", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((tempDir) => fs.rm(tempDir, { recursive: true, force: true }))
    );
  });

  it("creates a document with a current server override", () => {
    const document = getOpenApiDocument("https://api.example.test");

    expect(document.openapi).toBe("3.1.0");
    expect(document.servers).toEqual([
      {
        url: "https://api.example.test",
        description: "Current API server",
      },
    ]);
    expect(document.paths["/api/jobs"].post?.responses["201"]).toBeDefined();
  });

  it("renders an html website from the published document", () => {
    const html = renderOpenApiHtml(getOpenApiDocument(), "/openapi.json");

    expect(html).toContain("File Diff Engine API");
    expect(html).toContain("/openapi.json");
    expect(html).toContain("POST");
    expect(html).toContain("/api/jobs/resolve");
  });

  it("writes a static website bundle", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fde-openapi-"));
    tempDirs.push(tempDir);

    const { htmlPath, jsonPath } = await writeOpenApiSite(tempDir);
    const html = await fs.readFile(htmlPath, "utf8");
    const json = JSON.parse(await fs.readFile(jsonPath, "utf8")) as {
      info: { title: string };
      paths: Record<string, unknown>;
    };

    expect(path.basename(htmlPath)).toBe("index.html");
    expect(path.basename(jsonPath)).toBe("openapi.json");
    expect(html).toContain("./openapi.json");
    expect(json.info.title).toBe("File Diff Engine API");
    expect(json.paths["/api/jobs/files/hash/{hash}/tokenize"]).toBeDefined();
  });
});

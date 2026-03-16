import path from "path";
import { writeOpenApiSite } from "../openapi";

async function main() {
  const outputDir = path.resolve(process.cwd(), "docs/openapi");
  const { htmlPath, jsonPath } = await writeOpenApiSite(outputDir);
  console.log(`Generated OpenAPI website at ${htmlPath}`);
  console.log(`Generated OpenAPI document at ${jsonPath}`);
}

void main().catch((error: unknown) => {
  console.error("Failed to generate OpenAPI website.", error);
  process.exit(1);
});

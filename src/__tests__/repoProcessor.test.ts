import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execSync } from "child_process";
import { processRepository } from "../services/repoProcessor";

/** Create a small local git repo with text, binary, and directory entries. */
function createTestRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });

  execSync("git init", { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });

  // Text file
  fs.writeFileSync(path.join(dir, "hello.txt"), "Hello World\n");

  // Sub-directory with a file
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "index.ts"),
    'console.log("hello");\n'
  );

  // Binary file (contains null bytes)
  const binBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x01]);
  fs.writeFileSync(path.join(dir, "image.bin"), binBuf);

  execSync("git add -A", { cwd: dir });
  execSync('git commit -m "initial commit"', { cwd: dir });
  execSync("git tag v1.0.0", { cwd: dir });
}

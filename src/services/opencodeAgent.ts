import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { createLogger } from "../utils/logger";
import { getCommitShort } from "../utils/commit";

const execFileAsync = promisify(execFile);
const logger = createLogger("opencode-agent");

const OPENER_CLI_PATH = process.env.OPENER_CLI_PATH || "opencode";

export interface OpenCodeAgentConfig {
  owner: string;
  repoName: string;
  baseRef: string;
  prompt: string;
  model?: string;
  createPullRequest?: boolean;
  workDir: string;
}

export interface OpenCodeAgentResult {
  branchName: string;
  commitHash: string;
  commitShort: string;
  log: string[];
}

async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  const command = `git ${args.join(" ")}`;
  logger.debug("Running git command", { cwd, command });
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env },
  });
  const stdoutText = (stdout ?? "").toString().trim();
  const stderrText = (stderr ?? "").toString().trim();
  if (stderrText) {
    logger.debug("Git command emitted stderr", { cwd, command, stderr: stderrText });
  }
  return stdoutText;
}

export async function runOpenCodeAgent(config: OpenCodeAgentConfig): Promise<OpenCodeAgentResult> {
  const { owner, repoName, baseRef, prompt, createPullRequest, workDir } = config;
  const repo = `${owner}/${repoName}`;
  const repoUrl = `https://github.com/${repo}.git`;
  const tag = `OpenCodeAgent ${repo}:`;
  const log: string[] = [];

  fs.mkdirSync(workDir, { recursive: true });

  const timestamp = Date.now();
  const safeBranchName = `opencode-task-${timestamp}`;
  const cloneDir = path.join(workDir, safeBranchName);

  log.push(`Cloning ${repo} into ${cloneDir}`);

  await runGitCommand(workDir, [
    "clone", "--depth=1", "--branch", baseRef, "--single-branch", "--", repoUrl, cloneDir,
  ]);

  await runGitCommand(cloneDir, ["checkout", "-b", safeBranchName]);

  const planPath = path.join(cloneDir, "PLAN.md");
  const planContent = [
    `# Plan: ${safeBranchName}`,
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Task",
    "",
    prompt,
    "",
    "## Instructions",
    "",
    "1. Review the codebase to understand the current structure.",
    "2. Implement the necessary changes described in the task above.",
    "3. Ensure all changes follow the existing code style and conventions.",
    "4. Run the tests to verify correctness.",
    "5. Update the PLAN.md as progress is made.",
    "",
  ].join("\n");

  fs.writeFileSync(planPath, planContent, "utf8");
  log.push(`Written plan to ${planPath}`);

  await runGitCommand(cloneDir, ["add", "PLAN.md"]);

  const planCommitMessage = [
    `feat: add plan for ${safeBranchName}`,
    "",
    prompt,
    "",
    "This commit contains the initial plan for the opencode agent task.",
    "Co-authored-by: opencode <opencode@opencode.ai>",
  ].join("\n");

  await runGitCommand(cloneDir, ["commit", "--allow-empty", "-m", planCommitMessage]);
  log.push(`Committed plan on branch ${safeBranchName}`);

  const planCommitHash = await runGitCommand(cloneDir, ["rev-parse", "HEAD"]);
  const planCommitShort = getCommitShort(planCommitHash);
  log.push(`Plan commit: ${planCommitHash}`);

  const opencodeArgs: string[] = [];
  if (config.model) {
    opencodeArgs.push("--model", config.model);
  }
  opencodeArgs.push("--yes");

  logger.info(`${tag} Running opencode in ${cloneDir}`);
  log.push(`Running: ${OPENER_CLI_PATH} ${opencodeArgs.join(" ")}`);

  const opencodeEnv = {
    ...process.env,
    OPENCODE_CWD: cloneDir,
  };

  try {
    const { stdout, stderr } = await execFileAsync(
      OPENER_CLI_PATH,
      opencodeArgs,
      {
        cwd: cloneDir,
        env: opencodeEnv,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    const stdoutText = (stdout ?? "").toString().trim();
    const stderrText = (stderr ?? "").toString().trim();
    log.push(`opencode stdout: ${stdoutText.slice(0, 2000)}`);
    if (stderrText) {
      log.push(`opencode stderr: ${stderrText.slice(0, 1000)}`);
    }
    logger.info(`${tag} opencode completed successfully`);
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    logger.error(`${tag} opencode failed: ${description}`);
    log.push(`opencode failed: ${description}`);
    throw new Error(`opencode execution failed: ${description}`);
  }

  if (createPullRequest) {
    const token = process.env.PRIVATE_GITHUB_TOKEN?.trim() || process.env.PUBLIC_GITHUB_TOKEN?.trim();
    if (token) {
      const remoteUrl = repoUrl.replace("https://", `https://x-access-token:${token}@`);
      await runGitCommand(cloneDir, ["remote", "set-url", "origin", remoteUrl]);
      await runGitCommand(cloneDir, ["push", "origin", safeBranchName]);
      log.push(`Pushed branch ${safeBranchName} to origin`);

      const prTitle = `opencode: ${safeBranchName}`;
      const ghArgs = [
        "api",
        "repos",
        `/${repo}/pulls`,
        "--field",
        `title=${prTitle}`,
        "--field",
        `head=${safeBranchName}`,
        "--field",
        `base=${baseRef}`,
        "--field",
        `body=${prompt.slice(0, 1000)}`,
      ];
      try {
        const ghResult = await execFileAsync("gh", ghArgs, {
          cwd: cloneDir,
          env: { ...process.env, GH_TOKEN: token },
        });
        log.push(`PR created: ${(ghResult.stdout ?? "").toString().trim()}`);
      } catch (prError) {
        logger.warn(`${tag} Failed to create PR: ${prError instanceof Error ? prError.message : String(prError)}`);
        log.push(`PR creation failed (non-fatal)`);
      }
    } else {
      logger.warn(`${tag} No GitHub token found, skipping push and PR creation`);
      log.push("No GitHub token found, skipped push and PR");
    }
  }

  return {
    branchName: safeBranchName,
    commitHash: planCommitHash,
    commitShort: planCommitShort,
    log,
  };
}

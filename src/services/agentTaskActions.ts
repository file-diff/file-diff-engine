import type { Queue } from "bullmq";
import { JobRepository } from "../db/repository";
import type { AgentTaskJobInfo } from "../types";

const CANCEL_MESSAGE = "Task canceled by request.";

export class AgentTaskActionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTaskActionConflictError";
  }
}

export async function cancelAgentTaskJob(
  jobRepo: JobRepository,
  queue: Queue,
  taskId: string
): Promise<AgentTaskJobInfo | undefined> {
  const job = await jobRepo.getAgentTaskJob(taskId);
  if (!job) {
    return undefined;
  }

  if (job.status === "completed" || job.status === "failed") {
    throw new AgentTaskActionConflictError(
      "Task job has already finished and cannot be canceled."
    );
  }

  if (job.status === "canceled") {
    return job;
  }

  await jobRepo.requestAgentTaskCancellation(taskId);

  const removedQueuedJob = await removeQueuedAgentTaskJob(queue, taskId);
  if (job.status === "waiting" || removedQueuedJob) {
    await jobRepo.updateAgentTaskStatus(taskId, "canceled", job.branch ?? undefined);
    await jobRepo.updateAgentTaskJobStatus(taskId, "canceled", CANCEL_MESSAGE);
  }

  return jobRepo.getAgentTaskJob(taskId);
}

export async function deleteAgentTaskJob(
  jobRepo: JobRepository,
  queue: Queue,
  taskId: string
): Promise<AgentTaskJobInfo | undefined> {
  const job = await jobRepo.getAgentTaskJob(taskId);
  if (!job) {
    return undefined;
  }

  if (job.status === "waiting" || job.status === "active") {
    await jobRepo.requestAgentTaskCancellation(taskId);
    const removedQueuedJob = await removeQueuedAgentTaskJob(queue, taskId);
    if (job.status === "waiting" || removedQueuedJob) {
      await jobRepo.updateAgentTaskStatus(taskId, "canceled", job.branch ?? undefined);
      await jobRepo.updateAgentTaskJobStatus(taskId, "canceled", CANCEL_MESSAGE);
    }
  }

  await jobRepo.markAgentTaskJobDeleted(taskId);
  return jobRepo.getAgentTaskJob(taskId);
}

async function removeQueuedAgentTaskJob(
  queue: Queue,
  taskId: string
): Promise<boolean> {
  const queuedJob = await queue.getJob(taskId);
  if (!queuedJob) {
    return false;
  }

  const state = await queuedJob.getState();
  if (state === "active") {
    return false;
  }

  await queuedJob.remove();
  return true;
}

import { JobRepository } from "../db/repository";
import {
  getQueueJobNameForTaskRunner,
  type ManagedQueue,
  type QueueJobName,
} from "./queue";
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
  queue: ManagedQueue,
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

  const removedQueuedJob = await removeQueuedAgentTaskJob(
    queue,
    taskId,
    getQueueJobNameForTaskRunner(job.taskRunner)
  );
  if (job.status === "waiting" || removedQueuedJob) {
    await jobRepo.updateAgentTaskStatus(taskId, "canceled", job.branch ?? undefined);
    await jobRepo.updateAgentTaskJobStatus(taskId, "canceled", CANCEL_MESSAGE);
  }

  return jobRepo.getAgentTaskJob(taskId);
}

export async function deleteAgentTaskJob(
  jobRepo: JobRepository,
  queue: ManagedQueue,
  taskId: string
): Promise<AgentTaskJobInfo | undefined> {
  const job = await jobRepo.getAgentTaskJob(taskId);
  if (!job) {
    return undefined;
  }

  if (job.status === "waiting" || job.status === "active") {
    await jobRepo.requestAgentTaskCancellation(taskId);
    const removedQueuedJob = await removeQueuedAgentTaskJob(
      queue,
      taskId,
      getQueueJobNameForTaskRunner(job.taskRunner)
    );
    if (job.status === "waiting" || removedQueuedJob) {
      await jobRepo.updateAgentTaskStatus(taskId, "canceled", job.branch ?? undefined);
      await jobRepo.updateAgentTaskJobStatus(taskId, "canceled", CANCEL_MESSAGE);
    }
  }

  await jobRepo.markAgentTaskJobDeleted(taskId);
  return jobRepo.getAgentTaskJob(taskId);
}

async function removeQueuedAgentTaskJob(
  queue: ManagedQueue,
  taskId: string,
  jobName: QueueJobName
): Promise<boolean> {
  const queuedJob =
    (await queue.getJob(taskId, jobName)) ?? (await queue.getJob(taskId));
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

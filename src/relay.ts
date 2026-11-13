import { loadConfig, type RelayConfig } from "./config.js";
import { RelayError, isTransientError } from "./errors.js";
import { transientMessage } from "./retry.js";
import { generateRequestId } from "./ids.js";
import { createResultStore, type ResultStore } from "./results.js";
import { createTaskStore, FileTaskStore, taskFilePath, type TaskStore } from "./tasks.js";
import type { PendingResult, RelayOutcome, SubmitTaskInput } from "./types.js";
import { buildWebhookPointer, startGrokRun } from "./webhook.js";

export const DEFAULT_WAIT_SECONDS = 300;
export const MAX_WAIT_SECONDS = 780;
export const POLL_INTERVAL_MS = 3_000;

export type RelayDeps = {
  config: RelayConfig;
  store: ResultStore;
  taskStore: TaskStore;
  startRun?: typeof startGrokRun;
};

/** When an outbox write already succeeded, don't stall the webhook on a dead tunnel. */
const OUTBOX_HTTP_RETRY = { maxAttempts: 2, initialDelayMs: 150, maxDelayMs: 400 };
const OUTBOX_HTTP_TIMEOUT_MS = 3_000;

export function createRelay(env: NodeJS.ProcessEnv = process.env): RelayDeps {
  const config = loadConfig(env);
  const store = createResultStore({
    resultsDir: config.resultsDir,
    resultsUrl: config.resultsUrl,
    resultsToken: config.resultsToken,
    getResultsUrl: config.getResultsUrl,
    inboxDir: config.inboxDir,
  });
  const taskStore = createTaskStore({
    tasksDir: config.tasksDir,
    resultsUrl: config.resultsUrl,
    resultsToken: config.resultsToken,
    getResultsUrl: config.getResultsUrl,
    ...(config.outboxDir
      ? { retry: OUTBOX_HTTP_RETRY, timeoutMs: OUTBOX_HTTP_TIMEOUT_MS }
      : {}),
  });
  return { config, store, taskStore };
}

function normalizeWait(waitSeconds?: number): number {
  if (waitSeconds === undefined || Number.isNaN(waitSeconds)) {
    return DEFAULT_WAIT_SECONDS;
  }
  if (waitSeconds < 0) {
    throw new RelayError("wait_seconds must be 0 or greater.", "invalid_wait");
  }
  if (waitSeconds > MAX_WAIT_SECONDS) {
    throw new RelayError(
      `wait_seconds cannot exceed ${MAX_WAIT_SECONDS}.`,
      "invalid_wait",
    );
  }
  return waitSeconds;
}

function pending(requestId: string, lastTransient?: string): PendingResult {
  const extra = lastTransient ? ` Last error: ${lastTransient}` : "";
  return {
    request_id: requestId,
    status: "pending",
    message:
      "Timed out waiting for a result. Call get_grok_result with this request_id later." + extra,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollForResult(
  store: ResultStore,
  requestId: string,
  waitSeconds: number,
): Promise<RelayOutcome> {
  const deadline = Date.now() + waitSeconds * 1000;
  let lastTransient: string | undefined;
  for (;;) {
    try {
      const result = await store.read(requestId);
      if (result) return result;
      lastTransient = undefined;
    } catch (err) {
      if (!isTransientError(err)) throw err;
      lastTransient = transientMessage(err);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return pending(requestId, lastTransient);
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

export async function submitGrokTask(
  input: SubmitTaskInput,
  deps: RelayDeps,
): Promise<{ request_id: string; status: "submitted" }> {
  const task = input.task?.trim();
  if (!task) {
    throw new RelayError("task must not be empty.", "invalid_task");
  }
  const requestId = input.requestId ?? generateRequestId();
  const payload = {
    task,
    context: input.context,
    bot: input.bot,
  };
  let macTaskPath: string | undefined;
  let outboxOk = false;
  if (deps.config.outboxDir) {
    try {
      await new FileTaskStore(deps.config.outboxDir).put(requestId, payload);
      macTaskPath = taskFilePath(deps.config.outboxDir, requestId);
      outboxOk = true;
    } catch (err) {
      // A conflicting outbox file is a real error. Other write failures can
      // still be recovered if the HTTP upload succeeds.
      if (err instanceof RelayError && err.code === "task_exists") throw err;
      if (!deps.config.resultsUrl && !deps.config.getResultsUrl) {
        if (err instanceof RelayError) throw err;
        throw new RelayError("Failed to write the task to the outbox.", "task_upload_failed");
      }
    }
  }
  try {
    await deps.taskStore.put(requestId, payload);
  } catch (err) {
    if (outboxOk) {
      const hard =
        err instanceof RelayError &&
        (err.code === "task_exists" || err.code === "task_too_large" || err.code === "invalid_task");
      if (hard) throw err;
      // Tunnel / network / HTTP errors: the outbox write is enough.
    } else {
      if (err instanceof RelayError) throw err;
      throw new RelayError("Failed to upload the task payload.", "task_upload_failed");
    }
  }
  const startRun = deps.startRun ?? startGrokRun;
  try {
    await startRun({
      url: deps.config.webhookUrl,
      key: deps.config.webhookKey,
      payload: buildWebhookPointer(requestId, task, { macTaskPath }),
    });
  } catch (err) {
    if (isTransientError(err)) {
      const detail = transientMessage(err) ?? "The webhook is temporarily unreachable.";
      throw new RelayError(
        `The task was uploaded (request_id: ${requestId}) but the webhook could not be reached after retries. ${detail} Use get_grok_result later; the routine may already have started.`,
        "webhook_after_upload",
        { transient: true, requestId },
      );
    }
    throw err;
  }
  return { request_id: requestId, status: "submitted" };
}

export async function askGrok(
  input: SubmitTaskInput & { waitSeconds?: number },
  deps: RelayDeps,
): Promise<RelayOutcome> {
  const waitSeconds = normalizeWait(input.waitSeconds);
  try {
    const submitted = await submitGrokTask(input, deps);
    return pollForResult(deps.store, submitted.request_id, waitSeconds);
  } catch (err) {
    if (isTransientError(err) && err instanceof RelayError && err.requestId) {
      return pollForResult(deps.store, err.requestId, waitSeconds);
    }
    throw err;
  }
}

export async function getGrokResult(
  requestId: string,
  deps: RelayDeps,
  waitSeconds?: number,
): Promise<RelayOutcome> {
  const wait =
    waitSeconds === undefined || Number.isNaN(waitSeconds)
      ? 0
      : normalizeWait(waitSeconds);
  if (wait <= 0) {
    try {
      const result = await deps.store.read(requestId);
      if (result) return result;
    } catch (err) {
      if (isTransientError(err)) {
        return {
          request_id: requestId,
          status: "pending",
          message:
            "No result yet. The results server was temporarily unreachable. Call get_grok_result later. " +
            (transientMessage(err) ?? ""),
        };
      }
      throw err;
    }
    return {
      request_id: requestId,
      status: "pending",
      message: "No result yet. The bot may still be working.",
    };
  }
  return pollForResult(deps.store, requestId, wait);
}

import { loadConfig, type RelayConfig } from "./config.js";
import { RelayError } from "./errors.js";
import { generateRequestId } from "./ids.js";
import { createResultStore, type ResultStore } from "./results.js";
import type { PendingResult, RelayOutcome, SubmitTaskInput } from "./types.js";
import { startGrokRun } from "./webhook.js";

export const DEFAULT_WAIT_SECONDS = 300;
export const MAX_WAIT_SECONDS = 780;
export const POLL_INTERVAL_MS = 3_000;

export type RelayDeps = {
  config: RelayConfig;
  store: ResultStore;
  startRun?: typeof startGrokRun;
};

export function createRelay(env: NodeJS.ProcessEnv = process.env): RelayDeps {
  const config = loadConfig(env);
  const store = createResultStore({
    resultsDir: config.resultsDir,
    resultsUrl: config.resultsUrl,
    resultsToken: config.resultsToken,
  });
  return { config, store };
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

function pending(requestId: string): PendingResult {
  return {
    request_id: requestId,
    status: "pending",
    message:
      "Timed out waiting for a result. Call get_grok_result with this request_id later.",
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
  for (;;) {
    const result = await store.read(requestId);
    if (result) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return pending(requestId);
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
  const startRun = deps.startRun ?? startGrokRun;
  await startRun({
    url: deps.config.webhookUrl,
    key: deps.config.webhookKey,
    payload: {
      task,
      context: input.context,
      bot: input.bot,
      request_id: requestId,
    },
  });
  return { request_id: requestId, status: "submitted" };
}

export async function askGrok(
  input: SubmitTaskInput & { waitSeconds?: number },
  deps: RelayDeps,
): Promise<RelayOutcome> {
  const waitSeconds = normalizeWait(input.waitSeconds);
  const submitted = await submitGrokTask(input, deps);
  return pollForResult(deps.store, submitted.request_id, waitSeconds);
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
    const result = await deps.store.read(requestId);
    if (result) return result;
    return {
      request_id: requestId,
      status: "pending",
      message: "No result yet. The bot may still be working.",
    };
  }
  const outcome = await pollForResult(deps.store, requestId, wait);
  if (outcome.status === "pending") {
    return {
      request_id: requestId,
      status: "pending",
      message: "No result yet. The bot may still be working.",
    };
  }
  return outcome;
}

import { isTransientError, type RelayError } from "./errors.js";

export const DEFAULT_RETRY_ATTEMPTS = 5;
export const DEFAULT_INITIAL_DELAY_MS = 400;
export const DEFAULT_MAX_DELAY_MS = 8_000;

export type RetryOptions = {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Stop retrying once Date.now() exceeds this value. */
  deadline?: number;
  /** Called before a retry, e.g. to re-read a results URL file. */
  onRetry?: (attempt: number, err: unknown) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function backoffDelay(
  attempt: number,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  const exp = initialDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(maxDelayMs, exp);
}

/**
 * Retry `fn` on transient errors (network failures, timeouts, HTTP 502/503/504/530).
 * Non-transient errors are thrown immediately.
 */
/** Mutable so tests can use short backoffs. Production code should leave these defaults. */
export const retryPolicy = {
  maxAttempts: DEFAULT_RETRY_ATTEMPTS,
  initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
  maxDelayMs: DEFAULT_MAX_DELAY_MS,
};

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? retryPolicy.maxAttempts;
  const initialDelayMs = options.initialDelayMs ?? retryPolicy.initialDelayMs;
  const maxDelayMs = options.maxDelayMs ?? retryPolicy.maxDelayMs;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      break;
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientError(err) || attempt >= maxAttempts) {
        throw err;
      }
      let delay = backoffDelay(attempt, initialDelayMs, maxDelayMs);
      if (options.deadline !== undefined) {
        const remaining = options.deadline - Date.now();
        if (remaining <= 0) throw err;
        delay = Math.min(delay, remaining);
      }
      if (options.onRetry) {
        await options.onRetry(attempt, err);
      }
      await sleep(delay);
    }
  }
  throw lastError;
}

export function transientMessage(err: unknown): string | undefined {
  if (err && typeof err === "object" && "message" in err && typeof (err as RelayError).message === "string") {
    return (err as RelayError).message;
  }
  return undefined;
}

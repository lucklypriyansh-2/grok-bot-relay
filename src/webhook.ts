import { RelayError, isRetryableHttpStatus, safeNetworkError, transientHttpError } from "./errors.js";
import { withRetry } from "./retry.js";
import { assertValidRequestId } from "./ids.js";

const POST_TIMEOUT_MS = 30_000;

export const TASK_PREVIEW_CHARS = 200;
export const MAX_WEBHOOK_BODY_CHARS = 600;

/** Small pointer posted to the routine webhook. request_id is always first. */
export type WebhookPointerPayload = {
  request_id: string;
  task_ref: string;
  task_preview: string;
};

export function taskRefFor(requestId: string): string {
  return `tasks/${requestId}.json`;
}

export function serializeWebhookPointer(payload: WebhookPointerPayload): string {
  // Key order matters: request_id must be first so a truncated wake still has the id.
  return JSON.stringify({
    request_id: payload.request_id,
    task_ref: payload.task_ref,
    task_preview: payload.task_preview,
  });
}

/**
 * Build a webhook body of at most MAX_WEBHOOK_BODY_CHARS.
 * task_preview is the first TASK_PREVIEW_CHARS of the task, shortened further
 * if JSON escaping would push the body over the cap.
 */
export function buildWebhookPointer(requestId: string, task: string): WebhookPointerPayload {
  assertValidRequestId(requestId);
  let preview = task.slice(0, TASK_PREVIEW_CHARS);
  let payload: WebhookPointerPayload = {
    request_id: requestId,
    task_ref: taskRefFor(requestId),
    task_preview: preview,
  };
  while (serializeWebhookPointer(payload).length > MAX_WEBHOOK_BODY_CHARS && preview.length > 0) {
    const over = serializeWebhookPointer(payload).length - MAX_WEBHOOK_BODY_CHARS;
    preview = preview.slice(0, Math.max(0, preview.length - Math.max(over, 1)));
    payload = {
      request_id: requestId,
      task_ref: taskRefFor(requestId),
      task_preview: preview,
    };
  }
  const body = serializeWebhookPointer(payload);
  if (body.length > MAX_WEBHOOK_BODY_CHARS) {
    throw new RelayError(
      `Webhook pointer body exceeds the ${MAX_WEBHOOK_BODY_CHARS} character limit.`,
      "webhook_body_too_large",
    );
  }
  return payload;
}

/**
 * POST a small task pointer to the Grok Bot routine webhook.
 * A 200 means a run started, not that it finished.
 * Never include the URL, key, or response body in thrown errors.
 */
export async function startGrokRun(options: {
  url: string;
  key: string;
  payload: WebhookPointerPayload;
}): Promise<void> {
  const body = serializeWebhookPointer(options.payload);
  await withRetry(async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), POST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(options.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal: ac.signal,
      });
    } catch {
      throw safeNetworkError();
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 200) {
      await res.arrayBuffer().catch(() => undefined);
      return;
    }
    await res.arrayBuffer().catch(() => undefined);
    if (isRetryableHttpStatus(res.status)) {
      throw transientHttpError("webhook", res.status);
    }
    throw new RelayError(
      `Webhook rejected the request (HTTP ${res.status}).`,
      "webhook_http_error",
    );
  });
}

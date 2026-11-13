import { RelayError, safeNetworkError } from "./errors.js";

const POST_TIMEOUT_MS = 30_000;

export type WebhookPayload = {
  task: string;
  context?: string;
  bot?: string;
  request_id: string;
};

/**
 * POST a task to the Grok Bot routine webhook.
 * A 200 means a run started, not that it finished.
 * Never include the URL, key, or response body in thrown errors.
 */
export async function startGrokRun(options: {
  url: string;
  key: string;
  payload: WebhookPayload;
}): Promise<void> {
  const body: WebhookPayload = {
    task: options.payload.task,
    request_id: options.payload.request_id,
  };
  if (options.payload.context !== undefined) body.context = options.payload.context;
  if (options.payload.bot !== undefined) body.bot = options.payload.bot;

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
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch {
    throw safeNetworkError();
  } finally {
    clearTimeout(timer);
  }

  if (res.status !== 200) {
    // Drain the body so the socket can close, but do not surface it.
    await res.arrayBuffer().catch(() => undefined);
    throw new RelayError(
      `Webhook rejected the request (HTTP ${res.status}).`,
      "webhook_http_error",
    );
  }
}

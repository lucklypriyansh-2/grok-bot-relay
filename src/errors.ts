export type RelayErrorOptions = {
  httpStatus?: number;
  transient?: boolean;
  requestId?: string;
};

export class RelayError extends Error {
  readonly code: string;
  readonly httpStatus?: number;
  readonly transient: boolean;
  readonly requestId?: string;

  constructor(message: string, code = "relay_error", options: RelayErrorOptions = {}) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.transient = options.transient ?? false;
    this.requestId = options.requestId;
  }
}

/** HTTP statuses that are safe to retry. 530 is Cloudflare "origin is down". */
export const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504, 530]);

export function isRetryableHttpStatus(status: number): boolean {
  return TRANSIENT_HTTP_STATUSES.has(status);
}

export function isTransientError(err: unknown): boolean {
  if (err instanceof RelayError) {
    if (err.transient) return true;
    if (typeof err.httpStatus === "number" && isRetryableHttpStatus(err.httpStatus)) return true;
    return (
      err.code === "webhook_unreachable" ||
      err.code === "results_unreachable" ||
      err.code === "webhook_transient" ||
      err.code === "results_transient"
    );
  }
  return false;
}

function tunnelHint(status?: number): string {
  if (status === 530) {
    return " HTTP 530 usually means the Cloudflare tunnel lost its origin.";
  }
  return "";
}

export function transientHttpError(
  kind: "webhook" | "results",
  status: number,
): RelayError {
  const hint = tunnelHint(status);
  if (kind === "webhook") {
    return new RelayError(
      `The webhook is temporarily unreachable (HTTP ${status}).${hint}`,
      "webhook_transient",
      { httpStatus: status, transient: true },
    );
  }
  return new RelayError(
    `The results server is temporarily unreachable (HTTP ${status}).${hint}`,
    "results_transient",
    { httpStatus: status, transient: true },
  );
}

/** Strip known secrets from a string. Used as defense in depth before printing errors. */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      out = out.split(secret).join("[redacted]");
    }
  }
  out = out.replace(/crsr_[A-Za-z0-9]+/g, "crsr_[redacted]");
  return out;
}

/** Fetch and similar errors often embed the URL. Never surface the original message. */
export function safeNetworkError(): RelayError {
  return new RelayError("Failed to reach the webhook.", "webhook_unreachable", {
    transient: true,
  });
}

export function safeResultsNetworkError(): RelayError {
  return new RelayError("Failed to reach the results server.", "results_unreachable", {
    transient: true,
  });
}

export function pendingWaitMessage(lastTransient?: string): string {
  const extra = lastTransient
    ? ` Last error: ${lastTransient}`
    : "";
  return (
    "Timed out waiting for a result. Call get_grok_result with this request_id later." +
    extra
  );
}

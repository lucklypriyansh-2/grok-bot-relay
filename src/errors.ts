export class RelayError extends Error {
  readonly code: string;

  constructor(message: string, code = "relay_error") {
    super(message);
    this.name = "RelayError";
    this.code = code;
  }
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
  return new RelayError("Failed to reach the webhook.", "webhook_unreachable");
}

export function safeResultsNetworkError(): RelayError {
  return new RelayError("Failed to reach the results server.", "results_unreachable");
}

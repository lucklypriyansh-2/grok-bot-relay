import { randomBytes } from "node:crypto";
import { RelayError } from "./errors.js";

/** Letters, numbers, underscore, hyphen; 1-80 chars. Rejects path traversal. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export function isValidRequestId(id: string): boolean {
  return typeof id === "string" && REQUEST_ID_PATTERN.test(id);
}

export function assertValidRequestId(id: string): void {
  if (!isValidRequestId(id)) {
    throw new RelayError(
      "Invalid request_id. Use only letters, numbers, underscores, and hyphens (1-80 characters).",
      "invalid_request_id",
    );
  }
}

/** Format: gb-YYYYMMDD-HHMMSS-<8 hex>, using local time. */
export function generateRequestId(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const hex = randomBytes(4).toString("hex");
  const id = `gb-${y}${m}${d}-${hh}${mm}${ss}-${hex}`;
  assertValidRequestId(id);
  return id;
}

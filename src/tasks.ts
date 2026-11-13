import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  RelayError,
  isRetryableHttpStatus,
  safeResultsNetworkError,
  transientHttpError,
} from "./errors.js";
import { withRetry } from "./retry.js";
import { assertValidRequestId } from "./ids.js";

export const MAX_TASK_BYTES = 256 * 1024;
const PUT_TIMEOUT_MS = 30_000;

export type TaskPayload = {
  task: string;
  context?: string;
  bot?: string;
};

export interface TaskStore {
  put(requestId: string, payload: TaskPayload): Promise<void>;
}

export function taskFilePath(dir: string, requestId: string): string {
  assertValidRequestId(requestId);
  const dirResolved = path.resolve(dir);
  const file = path.resolve(dirResolved, `${requestId}.json`);
  const prefix = dirResolved.endsWith(path.sep) ? dirResolved : dirResolved + path.sep;
  if (!file.startsWith(prefix)) {
    throw new RelayError("Invalid request_id.", "invalid_request_id");
  }
  return file;
}

export function parseTaskPayload(data: unknown): TaskPayload {
  if (!data || typeof data !== "object") {
    throw new RelayError("Task payload is not a valid JSON object.", "invalid_task");
  }
  const rec = data as Record<string, unknown>;
  if (typeof rec.task !== "string" || !rec.task.trim()) {
    throw new RelayError("task must not be empty.", "invalid_task");
  }
  const payload: TaskPayload = { task: rec.task.trim() };
  if (rec.context !== undefined) {
    if (typeof rec.context !== "string") {
      throw new RelayError("context must be a string.", "invalid_task");
    }
    payload.context = rec.context;
  }
  if (rec.bot !== undefined) {
    if (typeof rec.bot !== "string") {
      throw new RelayError("bot must be a string.", "invalid_task");
    }
    payload.bot = rec.bot;
  }
  return payload;
}

export function sameTaskPayload(a: TaskPayload, b: TaskPayload): boolean {
  return a.task === b.task && a.context === b.context && a.bot === b.bot;
}

export function serializedTaskBytes(payload: TaskPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function assertTaskSize(payload: TaskPayload): void {
  if (serializedTaskBytes(payload) > MAX_TASK_BYTES) {
    throw new RelayError(
      `Task payload exceeds the ${MAX_TASK_BYTES} byte limit.`,
      "task_too_large",
    );
  }
}

export class FileTaskStore implements TaskStore {
  constructor(private readonly dir: string) {}

  async put(requestId: string, payload: TaskPayload): Promise<void> {
    assertValidRequestId(requestId);
    const parsed = parseTaskPayload(payload);
    assertTaskSize(parsed);
    const file = taskFilePath(this.dir, requestId);
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const existingRaw = await fs.readFile(file, "utf8");
      const existing = parseTaskPayload(JSON.parse(existingRaw));
      if (sameTaskPayload(existing, parsed)) return;
      throw new RelayError(
        "A task with this request_id already exists and the payload differs.",
        "task_exists",
      );
    } catch (err) {
      if (err instanceof RelayError) throw err;
      if (err instanceof SyntaxError) {
        throw new RelayError(
          "A task with this request_id already exists and the payload differs.",
          "task_exists",
        );
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    const body = JSON.stringify(parsed, null, 2) + "\n";
    try {
      await fs.writeFile(tmp, body, { encoding: "utf8", flag: "wx" });
      try {
        await fs.link(tmp, file);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          try {
            const existing = parseTaskPayload(JSON.parse(await fs.readFile(file, "utf8")));
            if (sameTaskPayload(existing, parsed)) return;
          } catch {
            // fall through to conflict
          }
          throw new RelayError(
            "A task with this request_id already exists and the payload differs.",
            "task_exists",
          );
        }
        throw err;
      }
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  }
}

export class HttpTaskStore implements TaskStore {
  private readonly resolveBaseUrl: () => Promise<string>;

  constructor(
    baseUrl: string | (() => Promise<string>),
    private readonly headers: Record<string, string> = {},
  ) {
    this.resolveBaseUrl =
      typeof baseUrl === "function" ? baseUrl : async () => baseUrl;
  }

  private async urlFor(requestId: string): Promise<string> {
    assertValidRequestId(requestId);
    const base = (await this.resolveBaseUrl()).replace(/\/+$/, "");
    return `${base}/tasks/${encodeURIComponent(requestId)}`;
  }

  async put(requestId: string, payload: TaskPayload): Promise<void> {
    const parsed = parseTaskPayload(payload);
    assertTaskSize(parsed);
    await withRetry(async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PUT_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(await this.urlFor(requestId), {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...this.headers,
          },
          body: JSON.stringify(parsed),
          signal: ac.signal,
        });
      } catch {
        throw safeResultsNetworkError();
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 200 || res.status === 201) {
        await res.arrayBuffer().catch(() => undefined);
        return;
      }
      if (res.status === 409) {
        await res.arrayBuffer().catch(() => undefined);
        throw new RelayError(
          "A task with this request_id already exists and the payload differs.",
          "task_exists",
        );
      }
      if (res.status === 413) {
        await res.arrayBuffer().catch(() => undefined);
        throw new RelayError(
          `Task payload exceeds the ${MAX_TASK_BYTES} byte limit.`,
          "task_too_large",
        );
      }
      await res.arrayBuffer().catch(() => undefined);
      if (isRetryableHttpStatus(res.status)) {
        throw transientHttpError("results", res.status);
      }
      throw new RelayError(
        `Failed to upload the task payload (HTTP ${res.status}).`,
        "task_http_error",
      );
    });
  }
}

export function createTaskStore(options: {
  tasksDir: string;
  resultsUrl?: string;
  resultsToken?: string;
  getResultsUrl?: () => Promise<string>;
}): TaskStore {
  if (options.getResultsUrl || options.resultsUrl) {
    const headers: Record<string, string> = {};
    if (options.resultsToken) {
      headers.Authorization = `Bearer ${options.resultsToken}`;
    }
    const resolve = options.getResultsUrl ?? (async () => options.resultsUrl as string);
    return new HttpTaskStore(resolve, headers);
  }
  return new FileTaskStore(options.tasksDir);
}

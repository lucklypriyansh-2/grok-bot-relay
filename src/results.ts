import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseArtifactList } from "./artifacts.js";
import {
  RelayError,
  isRetryableHttpStatus,
  isTransientError,
  safeResultsNetworkError,
  transientHttpError,
} from "./errors.js";
import { withRetry, type RetryOptions } from "./retry.js";
import { assertValidRequestId } from "./ids.js";
import { RESULT_STATUSES, type GrokResult, type ResultStatus } from "./types.js";

/**
 * Where finished answers are read and written.
 * FileResultStore is for same-machine use. HttpResultStore is the later
 * path (e.g. a tailnet host) — tools call this interface only, so they
 * do not need to change when you switch.
 */
export interface ResultStore {
  writeAtomic(result: GrokResult): Promise<void>;
  read(requestId: string): Promise<GrokResult | null>;
}

export function resultFilePath(dir: string, requestId: string): string {
  assertValidRequestId(requestId);
  const dirResolved = path.resolve(dir);
  const file = path.resolve(dirResolved, `${requestId}.json`);
  const prefix = dirResolved.endsWith(path.sep) ? dirResolved : dirResolved + path.sep;
  if (!file.startsWith(prefix)) {
    throw new RelayError("Invalid request_id.", "invalid_request_id");
  }
  return file;
}

export function parseResult(data: unknown): GrokResult {
  if (!data || typeof data !== "object") {
    throw new RelayError("Result file is not valid JSON object.", "bad_result");
  }
  const rec = data as Record<string, unknown>;
  const request_id = rec.request_id;
  const status = rec.status;
  const answer = rec.answer;
  const finished_at = rec.finished_at;
  if (typeof request_id !== "string" || !request_id) {
    throw new RelayError("Result is missing request_id.", "bad_result");
  }
  if (typeof status !== "string" || !RESULT_STATUSES.includes(status as ResultStatus)) {
    throw new RelayError(
      'Result status must be "done", "rejected", or "needs_approval".',
      "bad_result",
    );
  }
  if (typeof answer !== "string") {
    throw new RelayError("Result is missing answer.", "bad_result");
  }
  if (typeof finished_at !== "string" || !finished_at) {
    throw new RelayError("Result is missing finished_at.", "bad_result");
  }
  const result: GrokResult = { request_id, status: status as ResultStatus, answer, finished_at };
  if (rec.artifacts !== undefined) {
    result.artifacts = parseArtifactList(rec.artifacts);
  }
  return result;
}

export class FileResultStore implements ResultStore {
  constructor(private readonly dir: string) {}

  async writeAtomic(result: GrokResult): Promise<void> {
    assertValidRequestId(result.request_id);
    const file = resultFilePath(this.dir, result.request_id);
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    const body = JSON.stringify(result, null, 2) + "\n";
    try {
      await fs.writeFile(tmp, body, { encoding: "utf8", flag: "wx" });
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  async read(requestId: string): Promise<GrokResult | null> {
    const file = resultFilePath(this.dir, requestId);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw err;
    }
    try {
      return parseResult(JSON.parse(raw));
    } catch (err) {
      if (err instanceof RelayError) throw err;
      throw new RelayError("Result file is not valid JSON.", "bad_result");
    }
  }
}

/**
 * Reads and writes results over HTTP, for when the CLI and the bot no
 * longer share a filesystem (e.g. a tailnet host or a Cloudflare tunnel).
 *
 *   GET  {baseUrl}/results/{request_id}  -> 200 JSON or 404
 *   PUT  {baseUrl}/results/{request_id}  -> 200/201/204
 */
export class HttpResultStore implements ResultStore {
  private readonly resolveBaseUrl: () => Promise<string>;
  private readonly retry: RetryOptions;

  constructor(
    baseUrl: string | (() => Promise<string>),
    private readonly headers: Record<string, string> = {},
    retry: RetryOptions = {},
  ) {
    this.resolveBaseUrl =
      typeof baseUrl === "function" ? baseUrl : async () => baseUrl;
    this.retry = retry;
  }

  private async urlFor(requestId: string): Promise<string> {
    assertValidRequestId(requestId);
    const base = (await this.resolveBaseUrl()).replace(/\/+$/, "");
    return `${base}/results/${encodeURIComponent(requestId)}`;
  }

  async read(requestId: string): Promise<GrokResult | null> {
    return withRetry(async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30_000);
      let res: Response;
      try {
        res = await fetch(await this.urlFor(requestId), {
          method: "GET",
          headers: { Accept: "application/json", ...this.headers },
          signal: ac.signal,
        });
      } catch {
        throw safeResultsNetworkError();
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 404) return null;
      if (res.ok) {
        try {
          return parseResult(await res.json());
        } catch (err) {
          if (err instanceof RelayError) throw err;
          throw new RelayError("Result is not valid JSON.", "bad_result");
        }
      }
      await res.arrayBuffer().catch(() => undefined);
      if (isRetryableHttpStatus(res.status)) {
        throw transientHttpError("results", res.status);
      }
      throw new RelayError(`Failed to read result (HTTP ${res.status}).`, "result_http_error");
    }, this.retry);
  }

  async writeAtomic(result: GrokResult): Promise<void> {
    await withRetry(async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30_000);
      let res: Response;
      try {
        res = await fetch(await this.urlFor(result.request_id), {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...this.headers,
          },
          body: JSON.stringify(result),
          signal: ac.signal,
        });
      } catch {
        throw safeResultsNetworkError();
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) return;
      await res.arrayBuffer().catch(() => undefined);
      if (isRetryableHttpStatus(res.status)) {
        throw transientHttpError("results", res.status);
      }
      throw new RelayError(`Failed to write result (HTTP ${res.status}).`, "result_http_error");
    }, this.retry);
  }
}

/**
 * Prefer a local inbox (the routine copies results here) and fall back to HTTP.
 * Transient remote errors are treated as "not ready yet" so polling stays snappy
 * when the tunnel is down.
 */
export class InboxFirstResultStore implements ResultStore {
  constructor(
    private readonly inbox: FileResultStore,
    private readonly remote?: ResultStore,
  ) {}

  async read(requestId: string): Promise<GrokResult | null> {
    const local = await this.inbox.read(requestId);
    if (local) return local;
    if (!this.remote) return null;
    try {
      return await this.remote.read(requestId);
    } catch (err) {
      if (isTransientError(err)) return null;
      throw err;
    }
  }

  writeAtomic(result: GrokResult): Promise<void> {
    if (this.remote) return this.remote.writeAtomic(result);
    return this.inbox.writeAtomic(result);
  }
}

export function createResultStore(options: {
  resultsDir: string;
  resultsUrl?: string;
  resultsToken?: string;
  getResultsUrl?: () => Promise<string>;
  inboxDir?: string;
}): ResultStore {
  let remote: ResultStore | undefined;
  if (options.getResultsUrl || options.resultsUrl) {
    const headers: Record<string, string> = {};
    if (options.resultsToken) {
      headers.Authorization = `Bearer ${options.resultsToken}`;
    }
    const resolve = options.getResultsUrl ?? (async () => options.resultsUrl as string);
    // When an inbox is the primary path, do not burn the poll interval on HTTP retries.
    const retry: RetryOptions = options.inboxDir ? { maxAttempts: 1 } : {};
    remote = new HttpResultStore(resolve, headers, retry);
  }
  if (options.inboxDir) {
    const inbox = new FileResultStore(options.inboxDir);
    return remote ? new InboxFirstResultStore(inbox, remote) : inbox;
  }
  return remote ?? new FileResultStore(options.resultsDir);
}

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  RelayError,
  isRetryableHttpStatus,
  isTransientError,
  safeResultsNetworkError,
  transientHttpError,
} from "./errors.js";
import { withRetry, type RetryOptions } from "./retry.js";
import { assertValidRequestId, isValidRequestId } from "./ids.js";
import type { ArtifactInfo, GrokResult, RelayOutcome } from "./types.js";

/**
 * Artifacts are extra files Grok Bot writes for a request, stored flat in
 * <results_dir>/<request_id>/<name>. Names are a single safe path segment.
 */
export const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 120_000;

export function isValidArtifactName(name: string): boolean {
  return (
    typeof name === "string" &&
    ARTIFACT_NAME_PATTERN.test(name) &&
    !name.includes("..") &&
    !name.endsWith(".tmp")
  );
}

export function assertValidArtifactName(name: string): void {
  if (!isValidArtifactName(name)) {
    throw new RelayError(
      "Invalid artifact name. Use letters, numbers, dot, underscore and hyphen (no '..', max 128 chars).",
      "invalid_artifact_name",
    );
  }
}

function within(dir: string, file: string): boolean {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return file.startsWith(prefix);
}

export function artifactsDirPath(resultsDir: string, requestId: string): string {
  assertValidRequestId(requestId);
  const root = path.resolve(resultsDir);
  const dir = path.resolve(root, requestId);
  if (!within(root, dir)) throw new RelayError("Invalid request_id.", "invalid_request_id");
  return dir;
}

export function artifactFilePath(resultsDir: string, requestId: string, name: string): string {
  assertValidArtifactName(name);
  const dir = artifactsDirPath(resultsDir, requestId);
  const file = path.resolve(dir, name);
  if (!within(dir, file)) {
    throw new RelayError("Invalid artifact name.", "invalid_artifact_name");
  }
  return file;
}

const CONTENT_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".html": "text/plain; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".zip": "application/zip",
};

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve());
  });
  return hash.digest("hex");
}

/**
 * List regular files in the artifacts dir. Symlinks, subdirectories,
 * temp files and unsafe names are skipped. Missing dir -> [].
 */
export async function listArtifactsOnDisk(
  resultsDir: string,
  requestId: string,
): Promise<ArtifactInfo[]> {
  const dir = artifactsDirPath(resultsDir, requestId);
  let entries: import("node:fs").Dirent[];
  try {
    const st = await fs.lstat(dir);
    if (!st.isDirectory()) return [];
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
  const out: ArtifactInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isValidArtifactName(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const st = await fs.lstat(file);
    if (!st.isFile()) continue;
    out.push({
      name: entry.name,
      size: st.size,
      sha256: await sha256File(file),
      content_type: contentTypeFor(entry.name),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Open an artifact for reading; returns null when it does not exist or is not a regular file. */
export async function statArtifactOnDisk(
  resultsDir: string,
  requestId: string,
  name: string,
): Promise<{ file: string; size: number } | null> {
  const file = artifactFilePath(resultsDir, requestId, name);
  try {
    const st = await fs.lstat(file);
    if (!st.isFile()) return null;
    const real = await fs.realpath(file);
    const realDir = await fs.realpath(artifactsDirPath(resultsDir, requestId));
    if (!within(realDir, real)) return null;
    return { file, size: st.size };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/** Copy a local file into the artifacts dir atomically. Used by `grok-relay complete --artifact`. */
export async function addArtifactFromFile(
  resultsDir: string,
  requestId: string,
  sourcePath: string,
  name = path.basename(sourcePath),
): Promise<ArtifactInfo> {
  const dest = artifactFilePath(resultsDir, requestId, name);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.copyFile(sourcePath, tmp);
    await fs.rename(tmp, dest);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  const st = await fs.stat(dest);
  return { name, size: st.size, sha256: await sha256File(dest), content_type: contentTypeFor(name) };
}

// ---------------------------------------------------------------------------
// HTTP server routes (read-only). Wired from results-server.ts.
// ---------------------------------------------------------------------------

const LIST_ROUTE = /^\/results\/([^/]+)\/artifacts$/;
const FILE_ROUTE = /^\/results\/([^/]+)\/artifacts\/([^/]+)$/;

function sendText(res: http.ServerResponse, status: number, body: string, type: string) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Handle GET /results/<id>/artifacts and GET /results/<id>/artifacts/<name>.
 * Call only after the bearer token is verified. Returns true when handled.
 */
export async function handleArtifactRoute(
  method: string,
  pathname: string,
  res: http.ServerResponse,
  resultsDir: string,
): Promise<boolean> {
  const listMatch = LIST_ROUTE.exec(pathname);
  const fileMatch = listMatch ? null : FILE_ROUTE.exec(pathname);
  if (!listMatch && !fileMatch) return false;
  if (method !== "GET" && method !== "HEAD") {
    sendText(res, 405, "method not allowed\n", "text/plain; charset=utf-8");
    return true;
  }
  const requestId = (listMatch ?? fileMatch)![1];
  if (!isValidRequestId(requestId)) {
    sendText(res, 400, "invalid request_id\n", "text/plain; charset=utf-8");
    return true;
  }
  if (listMatch) {
    const artifacts = await listArtifactsOnDisk(resultsDir, requestId);
    sendText(
      res,
      200,
      JSON.stringify({ request_id: requestId, artifacts }) + "\n",
      "application/json; charset=utf-8",
    );
    return true;
  }
  const name = safeDecode(fileMatch![2]);
  if (name === null || !isValidArtifactName(name)) {
    sendText(res, 400, "invalid artifact name\n", "text/plain; charset=utf-8");
    return true;
  }
  const found = await statArtifactOnDisk(resultsDir, requestId, name);
  if (!found) {
    sendText(res, 404, "not found\n", "text/plain; charset=utf-8");
    return true;
  }
  const sha = await sha256File(found.file);
  res.writeHead(200, {
    "Content-Type": contentTypeFor(name),
    "Content-Length": found.size,
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="${name}"`,
    "X-Content-Type-Options": "nosniff",
    "X-Artifact-Sha256": sha,
  });
  if (method === "HEAD") {
    res.end();
    return true;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(found.file);
    stream.on("error", reject);
    res.on("close", () => resolve());
    stream.pipe(res);
  });
  return true;
}

// ---------------------------------------------------------------------------
// Client side: list and download.
// ---------------------------------------------------------------------------

export interface ArtifactStore {
  list(requestId: string): Promise<ArtifactInfo[]>;
  fetch(requestId: string, name: string): Promise<Buffer>;
}

export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly resultsDir: string) {}

  list(requestId: string): Promise<ArtifactInfo[]> {
    return listArtifactsOnDisk(this.resultsDir, requestId);
  }

  async fetch(requestId: string, name: string): Promise<Buffer> {
    const found = await statArtifactOnDisk(this.resultsDir, requestId, name);
    if (!found) throw new RelayError(`Artifact not found: ${name}`, "artifact_not_found");
    if (found.size > MAX_ARTIFACT_BYTES) {
      throw new RelayError(`Artifact too large: ${name}`, "artifact_too_large");
    }
    return fs.readFile(found.file);
  }
}

export class HttpArtifactStore implements ArtifactStore {
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

  private async base(requestId: string): Promise<string> {
    assertValidRequestId(requestId);
    const origin = (await this.resolveBaseUrl()).replace(/\/+$/, "");
    return `${origin}/results/${encodeURIComponent(requestId)}/artifacts`;
  }

  private async get(url: string, accept: string): Promise<Response> {
    return withRetry(async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, { headers: { Accept: accept, ...this.headers }, signal: ac.signal });
      } catch {
        throw safeResultsNetworkError();
      } finally {
        clearTimeout(timer);
      }
      if (res.ok || res.status === 404) return res;
      await res.arrayBuffer().catch(() => undefined);
      if (isRetryableHttpStatus(res.status)) {
        throw transientHttpError("results", res.status);
      }
      throw new RelayError(`Failed to fetch artifact (HTTP ${res.status}).`, "artifact_http_error");
    }, this.retry);
  }

  async list(requestId: string): Promise<ArtifactInfo[]> {
    const res = await this.get(await this.base(requestId), "application/json");
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => undefined);
      return [];
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      throw new RelayError(`Failed to list artifacts (HTTP ${res.status}).`, "artifact_http_error");
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new RelayError("Artifact list is not valid JSON.", "bad_artifacts");
    }
    return parseArtifactList((data as { artifacts?: unknown })?.artifacts);
  }

  async fetch(requestId: string, name: string): Promise<Buffer> {
    assertValidArtifactName(name);
    const res = await this.get(`${await this.base(requestId)}/${encodeURIComponent(name)}`, "*/*");
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => undefined);
      throw new RelayError(`Artifact not found: ${name}`, "artifact_not_found");
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      throw new RelayError(
        `Failed to download artifact ${name} (HTTP ${res.status}).`,
        "artifact_http_error",
      );
    }
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_ARTIFACT_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw new RelayError(`Artifact too large: ${name}`, "artifact_too_large");
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

/**
 * Prefer artifacts already in a local inbox and fall back to HTTP.
 * list() includes a `path` for files that are already on disk.
 */
export class InboxFirstArtifactStore implements ArtifactStore {
  constructor(
    private readonly inboxDir: string,
    private readonly inbox: FileArtifactStore,
    private readonly remote?: ArtifactStore,
  ) {}

  async list(requestId: string): Promise<ArtifactInfo[]> {
    const local = await this.inbox.list(requestId);
    if (local.length > 0) {
      return local.map((a) => ({
        ...a,
        path: a.path ?? artifactFilePath(this.inboxDir, requestId, a.name),
      }));
    }
    if (!this.remote) return local;
    try {
      return await this.remote.list(requestId);
    } catch (err) {
      if (isTransientError(err)) return [];
      throw err;
    }
  }

  async fetch(requestId: string, name: string): Promise<Buffer> {
    try {
      return await this.inbox.fetch(requestId, name);
    } catch (err) {
      if (!(err instanceof RelayError) || err.code !== "artifact_not_found") throw err;
    }
    if (!this.remote) {
      throw new RelayError(`Artifact not found: ${name}`, "artifact_not_found");
    }
    return this.remote.fetch(requestId, name);
  }
}

export function createArtifactStore(options: {
  resultsDir: string;
  resultsUrl?: string;
  resultsToken?: string;
  getResultsUrl?: () => Promise<string>;
  inboxDir?: string;
}): ArtifactStore {
  let remote: ArtifactStore | undefined;
  if (options.getResultsUrl || options.resultsUrl) {
    const headers: Record<string, string> = {};
    if (options.resultsToken) headers.Authorization = `Bearer ${options.resultsToken}`;
    const resolve = options.getResultsUrl ?? (async () => options.resultsUrl as string);
    const retry: RetryOptions = options.inboxDir ? { maxAttempts: 1 } : {};
    remote = new HttpArtifactStore(resolve, headers, retry);
  }
  if (options.inboxDir) {
    const inbox = new FileArtifactStore(options.inboxDir);
    return remote
      ? new InboxFirstArtifactStore(options.inboxDir, inbox, remote)
      : new InboxFirstArtifactStore(options.inboxDir, inbox);
  }
  return remote ?? new FileArtifactStore(options.resultsDir);
}

export function parseArtifactList(data: unknown): ArtifactInfo[] {
  if (data === undefined || data === null) return [];
  if (!Array.isArray(data)) {
    throw new RelayError("artifacts must be an array.", "bad_result");
  }
  const out: ArtifactInfo[] = [];
  for (const item of data) {
    const rec =
      typeof item === "string" ? { name: item } : (item as Record<string, unknown> | null);
    if (!rec || typeof rec !== "object" || typeof rec.name !== "string") {
      throw new RelayError("Each artifact needs a name.", "bad_result");
    }
    if (!isValidArtifactName(rec.name)) {
      throw new RelayError(`Invalid artifact name in result: ${rec.name}`, "bad_result");
    }
    const info: ArtifactInfo = { name: rec.name };
    if (typeof rec.size === "number" && Number.isFinite(rec.size)) info.size = rec.size;
    if (typeof rec.sha256 === "string" && /^[a-f0-9]{64}$/i.test(rec.sha256)) {
      info.sha256 = rec.sha256.toLowerCase();
    }
    if (typeof rec.content_type === "string") info.content_type = rec.content_type;
    if (typeof rec.description === "string") info.description = rec.description;
    out.push(info);
  }
  return out;
}

export function defaultDownloadDir(requestId: string): string {
  assertValidRequestId(requestId);
  return path.join(os.homedir(), "grok-relay-artifacts", requestId);
}

export type DownloadedArtifact = {
  name: string;
  path: string;
  size: number;
  sha256: string;
  verified: boolean;
  already_local?: boolean;
};

/**
 * Download artifacts (all, or the named subset) into destDir. Each file is
 * written atomically and its sha256 is checked against the listing.
 */
export async function downloadArtifacts(
  store: ArtifactStore,
  requestId: string,
  options: { destDir?: string; names?: string[] } = {},
): Promise<{ request_id: string; dest_dir: string; files: DownloadedArtifact[] }> {
  assertValidRequestId(requestId);
  const destDir = path.resolve(options.destDir?.trim() || defaultDownloadDir(requestId));
  const listing = await store.list(requestId);
  let wanted = listing;
  if (options.names && options.names.length > 0) {
    for (const n of options.names) assertValidArtifactName(n);
    const missing = options.names.filter((n) => !listing.some((a) => a.name === n));
    if (missing.length > 0) {
      throw new RelayError(`Artifact not found: ${missing.join(", ")}`, "artifact_not_found");
    }
    wanted = listing.filter((a) => options.names!.includes(a.name));
  }
  const explicitDest = Boolean(options.destDir?.trim());
  const files: DownloadedArtifact[] = [];
  const needCopy = wanted.filter((art) => {
    if (art.path && !explicitDest) return false;
    if (art.path && explicitDest && path.resolve(art.path) === path.resolve(destDir, art.name)) return false;
    return true;
  });
  if (needCopy.length > 0 || explicitDest) {
    await fs.mkdir(destDir, { recursive: true });
  }
  for (const art of wanted) {
    const localPath = art.path && path.isAbsolute(art.path) ? art.path : undefined;
    if (localPath && !explicitDest) {
      let size = art.size ?? 0;
      let sha = art.sha256 ?? "";
      try {
        const st = await fs.lstat(localPath);
        if (st.isFile()) size = st.size;
      } catch {
        // fall through to fetch if the listed path is gone
      }
      if (!sha) {
        try { sha = await sha256File(localPath); } catch { sha = ""; }
      }
      files.push({
        name: art.name,
        path: localPath,
        size,
        sha256: sha,
        verified: Boolean(art.sha256),
        already_local: true,
      });
      continue;
    }
    const bytes = await store.fetch(requestId, art.name);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (art.sha256 && art.sha256 !== sha) {
      throw new RelayError(`Checksum mismatch for ${art.name}; not saved.`, "artifact_checksum");
    }
    const dest = path.resolve(destDir, art.name);
    if (!within(destDir, dest)) throw new RelayError("Invalid artifact name.", "invalid_artifact_name");
    const tmp = `${dest}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tmp, bytes, { flag: "wx" });
      await fs.rename(tmp, dest);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
    files.push({ name: art.name, path: dest, size: bytes.length, sha256: sha, verified: Boolean(art.sha256) });
  }
  const resolvedDest =
    !explicitDest && files.length > 0 && files.every((f) => f.already_local)
      ? path.dirname(files[0].path)
      : destDir;
  return { request_id: requestId, dest_dir: resolvedDest, files };
}

/**
 * Attach the live artifact listing to a finished result, merging any
 * descriptions the bot put in the result JSON, plus a hint for the caller.
 * Best effort: listing errors never hide the answer.
 */
export async function withArtifacts(
  outcome: RelayOutcome,
  store: ArtifactStore,
): Promise<RelayOutcome & { artifacts_hint?: string }> {
  if (outcome.status === "pending") return outcome;
  const result = outcome as GrokResult;
  let live: ArtifactInfo[] | null = null;
  try {
    live = await store.list(result.request_id);
  } catch {
    live = null;
  }
  const declared = result.artifacts ?? [];
  const merged: ArtifactInfo[] = live
    ? live.map((a) => {
        const d = declared.find((x) => x.name === a.name);
        return d?.description ? { ...a, description: d.description } : a;
      })
    : declared;
  const missing = live ? declared.filter((d) => !live!.some((a) => a.name === d.name)) : [];
  const out: GrokResult & { artifacts_hint?: string; missing_artifacts?: string[] } = {
    ...result,
    artifacts: merged,
  };
  if (missing.length > 0) out.missing_artifacts = missing.map((m) => m.name);
  if (merged.length > 0) {
    const local = merged.filter((a) => a.path);
    if (local.length > 0) {
      const listed = local.map((a) => `  ${a.name}  ${a.path}`).join("\n");
      out.artifacts_hint =
        `${local.length} artifact file(s) already on this machine (no download needed):\n${listed}`;
    } else {
      out.artifacts_hint =
        `${merged.length} artifact file(s) attached. Call download_grok_artifacts ` +
        `(CLI: grok-relay download ${result.request_id}) to save them to ` +
        `~/grok-relay-artifacts/${result.request_id}/, then read the files for the full detail.`;
    }
  }
  return out;
}

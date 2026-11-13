#!/usr/bin/env node
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultResultsDir, defaultTasksDir } from "./config.js";
import { isValidRequestId } from "./ids.js";
import { handleArtifactRoute } from "./artifacts.js";
import { FileResultStore } from "./results.js";
import { FileTaskStore, MAX_TASK_BYTES, parseTaskPayload, taskFilePath } from "./tasks.js";

export const DEFAULT_RESULTS_PORT = 8787;
export const DEFAULT_RESULTS_HOST = "127.0.0.1";
export const DEFAULT_ENV_PATH = path.join(os.homedir(), ".config", "grok-relay", "env");

const REQUEST_ID_IN_PATH = /^\/results\/([^/]+)$/;
const TASK_ID_IN_PATH = /^\/tasks\/([^/]+)$/;

class BodyLimitError extends Error {
  constructor() {
    super("payload too large");
    this.name = "BodyLimitError";
  }
}

async function readLimitedBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const declared = req.headers["content-length"];
  if (declared !== undefined) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      req.resume();
      throw new BodyLimitError();
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      req.resume();
      throw new BodyLimitError();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

/** SHA-256 then timing-safe compare, so unequal lengths cannot short-circuit. */
export function tokensEqual(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export type ResultsServerOptions = {
  resultsDir: string;
  tasksDir: string;
  token: string;
  host?: string;
  port?: number;
};

export type StartedResultsServer = {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

export async function startResultsServer(
  options: ResultsServerOptions,
): Promise<StartedResultsServer> {
  if (!options.token) {
    throw new Error("Missing required environment variable: GROK_RELAY_RESULTS_TOKEN.");
  }
  const store = new FileResultStore(options.resultsDir);
  const taskStore = new FileTaskStore(options.tasksDir);
  const host = options.host ?? DEFAULT_RESULTS_HOST;
  const port = options.port ?? DEFAULT_RESULTS_PORT;

  const server = http.createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname.replace(/\/+$/, "") || "/";

      const token = bearerToken(req.headers.authorization);
      if (!token || !tokensEqual(token, options.token)) {
        send(res, 401, "unauthorized\n");
        return;
      }

      if (method === "GET" && pathname === "/health") {
        send(res, 200, "ok\n");
        return;
      }

      const taskMatch = TASK_ID_IN_PATH.exec(pathname);
      if (method === "PUT" && taskMatch) {
        const requestId = taskMatch[1];
        if (!isValidRequestId(requestId)) {
          req.resume();
          send(res, 400, "invalid request_id\n");
          return;
        }
        let raw: Buffer;
        try {
          raw = await readLimitedBody(req, MAX_TASK_BYTES);
        } catch (err) {
          if (err instanceof BodyLimitError) {
            send(res, 413, "payload too large\n");
            return;
          }
          throw err;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          send(res, 400, "invalid json\n");
          return;
        }
        let payload;
        try {
          payload = parseTaskPayload(parsed);
        } catch {
          send(res, 400, "invalid task\n");
          return;
        }
        let existed = false;
        try {
          await fs.access(taskFilePath(options.tasksDir, requestId));
          existed = true;
        } catch {
          existed = false;
        }
        try {
          await taskStore.put(requestId, payload);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === "task_exists") {
            send(res, 409, "task exists\n");
            return;
          }
          if (code === "task_too_large") {
            send(res, 413, "payload too large\n");
            return;
          }
          throw err;
        }
        if (existed) {
          send(res, 200, "ok\n");
        } else {
          send(res, 201, "created\n");
        }
        return;
      }

      // Read-only artifact routes: GET /results/<id>/artifacts[/<name>]
      if (await handleArtifactRoute(method, pathname, res, options.resultsDir)) return;

      const resultMatch = REQUEST_ID_IN_PATH.exec(pathname);
      if (method === "GET" && resultMatch) {
        const requestId = resultMatch[1];
        if (!isValidRequestId(requestId)) {
          send(res, 400, "invalid request_id\n");
          return;
        }
        const result = await store.read(requestId);
        if (!result) {
          send(res, 404, "not found\n");
          return;
        }
        send(res, 200, JSON.stringify(result) + "\n", "application/json; charset=utf-8");
        return;
      }

      send(res, 404, "not found\n");
    })().catch(() => {
      if (!res.headersSent) {
        send(res, 500, "internal error\n");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("results server failed to bind");
  }

  return {
    host,
    port: addr.port,
    url: `http://${host}:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Parse `export KEY=value` lines. Never logs file contents. */
export function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export async function loadEnvFile(
  envPath = DEFAULT_ENV_PATH,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(envPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }
  const parsed = parseEnvFile(raw);
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined || env[key] === "") {
      env[key] = value;
    }
  }
}

/**
 * Ensure GROK_RELAY_RESULTS_TOKEN exists in the env file and in `env`.
 * Generates a 32-byte token and appends it when missing. Never prints the token.
 */
export async function ensureResultsToken(
  envPath = DEFAULT_ENV_PATH,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await fs.mkdir(path.dirname(envPath), { recursive: true, mode: 0o700 });
  let raw = "";
  try {
    raw = await fs.readFile(envPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
  const parsed = parseEnvFile(raw);
  const existing =
    env.GROK_RELAY_RESULTS_TOKEN?.trim() || parsed.GROK_RELAY_RESULTS_TOKEN?.trim() || "";
  if (existing) {
    env.GROK_RELAY_RESULTS_TOKEN = existing;
    if (!parsed.GROK_RELAY_RESULTS_TOKEN) {
      const prefix = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
      await fs.appendFile(envPath, `${prefix}export GROK_RELAY_RESULTS_TOKEN=${existing}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    await fs.chmod(envPath, 0o600);
    return;
  }
  const token = randomBytes(32).toString("hex");
  const prefix = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
  await fs.appendFile(envPath, `${prefix}export GROK_RELAY_RESULTS_TOKEN=${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(envPath, 0o600);
  env.GROK_RELAY_RESULTS_TOKEN = token;
}

async function applyResultsEnv(envPath = DEFAULT_ENV_PATH): Promise<void> {
  let raw = "";
  try {
    raw = await fs.readFile(envPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    return;
  }
  const parsed = parseEnvFile(raw);
  for (const key of [
    "GROK_RELAY_RESULTS_TOKEN",
    "GROK_RELAY_RESULTS_DIR",
    "GROK_RELAY_TASKS_DIR",
    "GROK_RELAY_RESULTS_HOST",
    "GROK_RELAY_RESULTS_PORT",
  ]) {
    if ((process.env[key] === undefined || process.env[key] === "") && parsed[key]) {
      process.env[key] = parsed[key];
    }
  }
}

async function main() {
  await applyResultsEnv();
  await ensureResultsToken();
  const token = process.env.GROK_RELAY_RESULTS_TOKEN?.trim() ?? "";
  if (!token) {
    process.stderr.write("Missing required environment variable: GROK_RELAY_RESULTS_TOKEN.\n");
    process.exit(1);
  }
  const resultsDir = process.env.GROK_RELAY_RESULTS_DIR?.trim() || defaultResultsDir();
  const tasksDir = process.env.GROK_RELAY_TASKS_DIR?.trim() || defaultTasksDir();
  const host = process.env.GROK_RELAY_RESULTS_HOST?.trim() || DEFAULT_RESULTS_HOST;
  const portRaw = process.env.GROK_RELAY_RESULTS_PORT?.trim();
  const port = portRaw ? Number(portRaw) : DEFAULT_RESULTS_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write("GROK_RELAY_RESULTS_PORT must be a valid port.\n");
    process.exit(1);
  }
  try {
    const started = await startResultsServer({ resultsDir, tasksDir, token, host, port });
    process.stdout.write(`results server listening on ${started.host}:${started.port}\n`);
  } catch {
    process.stderr.write("results server failed to start.\n");
    process.exit(1);
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch(() => {
    process.stderr.write("results server failed to start.\n");
    process.exit(1);
  });
}

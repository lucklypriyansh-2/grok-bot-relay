import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RelayError } from "./errors.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function defaultResultsDir(): string {
  return path.join(packageRoot, "results");
}

export function defaultTasksDir(): string {
  return path.join(packageRoot, "tasks");
}

const RESULTS_URL_PATTERN = /^https?:\/\/[^\s]+$/i;
const MAX_URL_FILE_BYTES = 8 * 1024;

export type RelayConfig = {
  webhookUrl: string;
  webhookKey: string;
  resultsDir: string;
  tasksDir: string;
  resultsUrl?: string;
  resultsUrlFile?: string;
  resultsToken?: string;
  getResultsUrl?: () => Promise<string>;
};

/**
 * Read a results origin from a file (one URL, optional # comments).
 * Re-reading this file lets a client pick up a new quick-tunnel URL after a restart.
 */
export function parseResultsUrlFile(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    let value = trimmed;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.trim().replace(/\/+$/, "");
    if (!RESULTS_URL_PATTERN.test(value)) {
      throw new RelayError(
        "GROK_RELAY_RESULTS_URL_FILE does not contain a valid http(s) origin.",
        "invalid_results_url_file",
      );
    }
    return value;
  }
  throw new RelayError(
    "GROK_RELAY_RESULTS_URL_FILE is empty.",
    "invalid_results_url_file",
  );
}

export async function readResultsUrlFile(filePath: string): Promise<string> {
  let raw: string;
  try {
    const st = await fs.stat(filePath);
    if (st.size > MAX_URL_FILE_BYTES) {
      throw new RelayError(
        "GROK_RELAY_RESULTS_URL_FILE is too large.",
        "invalid_results_url_file",
      );
    }
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err instanceof RelayError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new RelayError(
        "GROK_RELAY_RESULTS_URL_FILE does not exist.",
        "missing_results_url_file",
      );
    }
    throw new RelayError(
      "Could not read GROK_RELAY_RESULTS_URL_FILE.",
      "results_url_file_error",
    );
  }
  return parseResultsUrlFile(raw);
}

/**
 * Returns a function that resolves the results origin, re-reading
 * GROK_RELAY_RESULTS_URL_FILE on every call when that variable is set.
 * Falls back to GROK_RELAY_RESULTS_URL if the file is briefly unreadable.
 */
export function makeResultsUrlResolver(
  env: NodeJS.ProcessEnv,
): (() => Promise<string>) | undefined {
  const file = env.GROK_RELAY_RESULTS_URL_FILE?.trim() || "";
  const staticUrl = env.GROK_RELAY_RESULTS_URL?.trim().replace(/\/+$/, "") || "";
  if (!file && !staticUrl) return undefined;
  if (staticUrl && !RESULTS_URL_PATTERN.test(staticUrl) && !file) {
    throw new RelayError(
      "GROK_RELAY_RESULTS_URL is not a valid http(s) origin.",
      "invalid_results_url",
    );
  }
  return async () => {
    if (file) {
      try {
        return await readResultsUrlFile(file);
      } catch (err) {
        if (staticUrl && RESULTS_URL_PATTERN.test(staticUrl)) return staticUrl;
        throw err;
      }
    }
    return staticUrl;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const webhookUrl = env.GROK_WEBHOOK_URL?.trim() ?? "";
  const webhookKey = env.GROK_WEBHOOK_KEY?.trim() ?? "";
  const resultsDir = env.GROK_RELAY_RESULTS_DIR?.trim() || defaultResultsDir();
  const tasksDir = env.GROK_RELAY_TASKS_DIR?.trim() || defaultTasksDir();
  const resultsUrl = env.GROK_RELAY_RESULTS_URL?.trim().replace(/\/+$/, "") || undefined;
  const resultsUrlFile = env.GROK_RELAY_RESULTS_URL_FILE?.trim() || undefined;
  const resultsToken = env.GROK_RELAY_RESULTS_TOKEN?.trim() || undefined;
  const getResultsUrl = makeResultsUrlResolver(env);

  const missing: string[] = [];
  if (!webhookUrl) missing.push("GROK_WEBHOOK_URL");
  if (!webhookKey) missing.push("GROK_WEBHOOK_KEY");
  if ((resultsUrl || resultsUrlFile) && !resultsToken) missing.push("GROK_RELAY_RESULTS_TOKEN");
  if (missing.length > 0) {
    throw new RelayError(
      `Missing required environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`,
      "missing_env",
    );
  }

  return {
    webhookUrl,
    webhookKey,
    resultsDir,
    tasksDir,
    resultsUrl,
    resultsUrlFile,
    resultsToken,
    getResultsUrl,
  };
}

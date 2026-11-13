import path from "node:path";
import { fileURLToPath } from "node:url";
import { RelayError } from "./errors.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function defaultResultsDir(): string {
  return path.join(packageRoot, "results");
}

export type RelayConfig = {
  webhookUrl: string;
  webhookKey: string;
  resultsDir: string;
  resultsUrl?: string;
  resultsToken?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const webhookUrl = env.GROK_WEBHOOK_URL?.trim() ?? "";
  const webhookKey = env.GROK_WEBHOOK_KEY?.trim() ?? "";
  const resultsDir = env.GROK_RELAY_RESULTS_DIR?.trim() || defaultResultsDir();
  const resultsUrl = env.GROK_RELAY_RESULTS_URL?.trim() || undefined;
  const resultsToken = env.GROK_RELAY_RESULTS_TOKEN?.trim() || undefined;

  const missing: string[] = [];
  if (!webhookUrl) missing.push("GROK_WEBHOOK_URL");
  if (!webhookKey) missing.push("GROK_WEBHOOK_KEY");
  if (resultsUrl && !resultsToken) missing.push("GROK_RELAY_RESULTS_TOKEN");
  if (missing.length > 0) {
    throw new RelayError(
      `Missing required environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`,
      "missing_env",
    );
  }

  return { webhookUrl, webhookKey, resultsDir, resultsUrl, resultsToken };
}

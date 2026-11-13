/**
 * Build a process env for tests that never inherits GROK_* (or other
 * secrets) from the real environment. This is what let Mac `npm test`
 * write leftover files into the live tasks/ folder: envFor used to
 * spread process.env, including GROK_RELAY_RESULTS_URL.
 */
const SAFE_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "NODE_PATH",
  "NODE_OPTIONS",
  "TERM",
  "COLORTERM",
  "FORCE_COLOR",
  "NO_COLOR",
  "XPC_SERVICE_NAME",
  "SSH_AUTH_SOCK",
];

export function isolatedEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("GROK_") && !Object.prototype.hasOwnProperty.call(overrides, key)) {
      delete env[key];
    }
  }
  return env;
}

/** Strip any GROK_* keys from an env object (e.g. getDefaultEnvironment()). */
export function withoutGrokEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("GROK_")) continue;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

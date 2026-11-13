import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { RelayError } from "../src/errors.ts";
import { loadConfig } from "../src/config.ts";
import { generateRequestId } from "../src/ids.ts";
import { FileResultStore, HttpResultStore, createResultStore } from "../src/results.ts";
import {
  ensureResultsToken,
  parseEnvFile,
  startResultsServer,
  tokensEqual,
} from "../src/results-server.ts";

const TOKEN = "TEST_RESULTS_TOKEN_DO_NOT_PRINT_7c4d";
const OTHER = "OTHER_RESULTS_TOKEN_DO_NOT_PRINT_1a2b";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-relay-results-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function assertNoSecret(text: string, secrets: string[] = [TOKEN, OTHER]) {
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), "secret leaked in output");
  }
  assert.ok(!text.includes("Bearer "), "authorization header leaked in output");
  assert.ok(!/crsr_[A-Za-z0-9]+/.test(text), "crsr_ token leaked in output");
}

async function request(
  url: string,
  options: { method?: string; token?: string | null; body?: string } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body,
  });
  const body = await res.text();
  const headers: http.IncomingHttpHeaders = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  assertNoSecret(body);
  return { status: res.status, body, headers };
}

describe("tokensEqual", () => {
  it("accepts equal tokens and rejects others, including different lengths", () => {
    assert.equal(tokensEqual("abc", "abc"), true);
    assert.equal(tokensEqual("abc", "abd"), false);
    assert.equal(tokensEqual("short", "much-longer-token"), false);
    assert.equal(tokensEqual("", "x"), false);
  });
});

describe("results HTTP server", () => {
  it("requires a bearer token, serves health and results, and rejects writes", async () => {
    await withTempDir(async (dir) => {
      const store = new FileResultStore(dir);
      const request_id = "gb-20261113-131001-e557ab31";
      await store.writeAtomic({
        request_id,
        status: "done",
        answer: "grok-relay-ok",
        finished_at: "2026-11-13T07:40:06Z",
      });
      const server = await startResultsServer({
        resultsDir: dir,
        token: TOKEN,
        host: "127.0.0.1",
        port: 0,
      });
      try {
        const health = await request(`${server.url}/health`, { token: TOKEN });
        assert.equal(health.status, 200);
        assert.equal(health.body, "ok\n");

        const noToken = await request(`${server.url}/health`);
        assert.equal(noToken.status, 401);

        const badToken = await request(`${server.url}/health`, { token: OTHER });
        assert.equal(badToken.status, 401);

        const got = await request(`${server.url}/results/${request_id}`, { token: TOKEN });
        assert.equal(got.status, 200);
        const parsed = JSON.parse(got.body);
        assert.equal(parsed.status, "done");
        assert.equal(parsed.answer, "grok-relay-ok");
        assert.equal(parsed.request_id, request_id);

        const missing = await request(`${server.url}/results/gb-missing-id-00000000`, {
          token: TOKEN,
        });
        assert.equal(missing.status, 404);

        const invalid = await request(`${server.url}/results/../etc/passwd`, { token: TOKEN });
        assert.ok(invalid.status === 400 || invalid.status === 404);

        const dotted = await request(`${server.url}/results/foo.bar`, { token: TOKEN });
        assert.equal(dotted.status, 400);

        const put = await request(`${server.url}/results/${request_id}`, {
          method: "PUT",
          token: TOKEN,
          body: JSON.stringify({
            request_id,
            status: "done",
            answer: "should-not-write",
            finished_at: "2026-11-13T00:00:00Z",
          }),
        });
        assert.equal(put.status, 404);
        const reread = await store.read(request_id);
        assert.equal(reread?.answer, "grok-relay-ok");

        const post = await request(`${server.url}/results/${request_id}`, {
          method: "POST",
          token: TOKEN,
          body: "{}",
        });
        assert.equal(post.status, 404);

        const other = await request(`${server.url}/secret`, { token: TOKEN });
        assert.equal(other.status, 404);
      } finally {
        await server.close();
      }
    });
  });
});

describe("HttpResultStore", () => {
  it("sends the bearer token and reads a result over HTTP", async () => {
    await withTempDir(async (dir) => {
      const request_id = generateRequestId();
      const fileStore = new FileResultStore(dir);
      await fileStore.writeAtomic({
        request_id,
        status: "done",
        answer: "via-http",
        finished_at: "2026-11-13T07:40:06Z",
      });
      const server = await startResultsServer({
        resultsDir: dir,
        token: TOKEN,
        host: "127.0.0.1",
        port: 0,
      });
      try {
        const store = createResultStore({
          resultsDir: dir,
          resultsUrl: server.url,
          resultsToken: TOKEN,
        });
        assert.ok(store instanceof HttpResultStore);
        const got = await store.read(request_id);
        assert.equal(got?.status, "done");
        assert.equal(got?.answer, "via-http");

        const missing = await store.read("gb-no-such-result-aaaaaaa1");
        assert.equal(missing, null);

        const unauth = new HttpResultStore(server.url);
        await assert.rejects(
          () => unauth.read(request_id),
          (err: unknown) => {
            assert.ok(err instanceof RelayError);
            assert.match(err.message, /HTTP 401/);
            assertNoSecret(err.message);
            assert.ok(!err.message.includes(server.url));
            return true;
          },
        );
      } finally {
        await server.close();
      }
    });
  });

  it("does not leak the results URL on a network failure", async () => {
    const url = "http://127.0.0.1:1/secret-results-path-should-not-leak";
    const store = new HttpResultStore(url, { Authorization: `Bearer ${TOKEN}` });
    await assert.rejects(
      () => store.read("gb-20261113-000000-aaaaaaaa"),
      (err: unknown) => {
        assert.ok(err instanceof RelayError);
        assert.equal(err.message, "Failed to reach the results server.");
        assert.ok(!err.message.includes("secret-results-path"));
        assertNoSecret(err.message);
        return true;
      },
    );
  });
});

describe("config for HTTP results", () => {
  it("requires GROK_RELAY_RESULTS_TOKEN when a results URL is set", () => {
    let thrown: unknown;
    try {
      loadConfig({
        GROK_WEBHOOK_URL: "http://example.invalid",
        GROK_WEBHOOK_KEY: "TESTKEY_DO_NOT_PRINT_9f3a2c1b",
        GROK_RELAY_RESULTS_URL: "http://example.invalid/results-base",
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof RelayError);
    assert.equal(
      thrown.message,
      "Missing required environment variable: GROK_RELAY_RESULTS_TOKEN.",
    );
    assert.ok(!thrown.message.includes("http://example.invalid"));
  });
});

describe("ensureResultsToken", () => {
  it("appends a 32-byte token, sets mode 600, and does not rotate an existing token", async () => {
    await withTempDir(async (dir) => {
      const envPath = path.join(dir, "env");
      await writeFile(envPath, "export GROK_WEBHOOK_KEY=placeholder\n", { mode: 0o600 });
      const env: NodeJS.ProcessEnv = {};
      await ensureResultsToken(envPath, env);
      const first = env.GROK_RELAY_RESULTS_TOKEN;
      assert.ok(first);
      assert.match(first!, /^[0-9a-f]{64}$/);
      const mode = (await stat(envPath)).mode & 0o777;
      assert.equal(mode, 0o600);
      const raw = await readFile(envPath, "utf8");
      const parsed = parseEnvFile(raw);
      assert.equal(parsed.GROK_RELAY_RESULTS_TOKEN, first);
      assert.equal(parsed.GROK_WEBHOOK_KEY, "placeholder");

      const env2: NodeJS.ProcessEnv = {};
      await ensureResultsToken(envPath, env2);
      assert.equal(env2.GROK_RELAY_RESULTS_TOKEN, first);
      const raw2 = await readFile(envPath, "utf8");
      assert.equal(
        raw2.split("GROK_RELAY_RESULTS_TOKEN=").length - 1,
        1,
        "token should not be appended twice",
      );
    });
  });
});

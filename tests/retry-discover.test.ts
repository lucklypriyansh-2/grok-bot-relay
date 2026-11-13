import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { RelayError, isTransientError, transientHttpError } from "../src/errors.ts";
import {
  loadConfig,
  makeResultsUrlResolver,
  parseResultsUrlFile,
  readResultsUrlFile,
} from "../src/config.ts";
import { backoffDelay, retryPolicy, withRetry } from "../src/retry.ts";
import { FileTaskStore, HttpTaskStore } from "../src/tasks.ts";
import { HttpResultStore } from "../src/results.ts";
import { createRelay, pollForResult } from "../src/relay.ts";
import { isolatedEnv } from "./test-env.ts";

const TOKEN = "TEST_RESULTS_TOKEN_DO_NOT_PRINT_7c4d";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-relay-retry-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("backoff and withRetry", () => {
  it("grows delays and caps them", () => {
    assert.equal(backoffDelay(1, 400, 8_000), 400);
    assert.equal(backoffDelay(2, 400, 8_000), 800);
    assert.equal(backoffDelay(3, 400, 8_000), 1_600);
    assert.equal(backoffDelay(10, 400, 8_000), 8_000);
  });

  it("retries transient errors and returns the eventual value", async () => {
    let n = 0;
    const value = await withRetry(
      async () => {
        n += 1;
        if (n < 3) throw transientHttpError("results", 530);
        return "ok";
      },
      { initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 5 },
    );
    assert.equal(value, "ok");
    assert.equal(n, 3);
  });

  it("does not retry a non-transient error", async () => {
    let n = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            n += 1;
            throw new RelayError("Webhook rejected the request (HTTP 401).", "webhook_http_error", {
              httpStatus: 401,
            });
          },
          { initialDelayMs: 1, maxAttempts: 5 },
        ),
      (err: unknown) => {
        assert.ok(err instanceof RelayError);
        assert.match(err.message, /HTTP 401/);
        return true;
      },
    );
    assert.equal(n, 1);
  });
});

describe("results URL file discovery", () => {
  it("parses a URL, ignores comments, and rejects junk", () => {
    assert.equal(
      parseResultsUrlFile("# comment\n\nhttps://example.invalid/origin/\n"),
      "https://example.invalid/origin",
    );
    assert.throws(() => parseResultsUrlFile("not a url\n"), RelayError);
    assert.throws(() => parseResultsUrlFile("   \n# only comments\n"), RelayError);
  });

  it("re-reads the file on every resolve and falls back to the static URL", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "tunnel-url.txt");
      await writeFile(file, "https://first.example.invalid\n");
      const resolve = makeResultsUrlResolver({
        GROK_RELAY_RESULTS_URL_FILE: file,
        GROK_RELAY_RESULTS_URL: "https://fallback.example.invalid",
      });
      assert.ok(resolve);
      assert.equal(await resolve!(), "https://first.example.invalid");
      await writeFile(file, "https://second.example.invalid\n");
      assert.equal(await resolve!(), "https://second.example.invalid");
      await rm(file);
      assert.equal(await resolve!(), "https://fallback.example.invalid");
    });
  });

  it("loadConfig requires a token when a URL file is set", () => {
    assert.throws(
      () =>
        loadConfig({
          GROK_WEBHOOK_URL: "http://example.invalid",
          GROK_WEBHOOK_KEY: "k",
          GROK_RELAY_RESULTS_URL_FILE: "/tmp/x",
        }),
      /GROK_RELAY_RESULTS_TOKEN/,
    );
  });
});

describe("HTTP stores retry 530 and honor a URL file", () => {
  const prev = { ...retryPolicy };
  before(() => {
    retryPolicy.initialDelayMs = 5;
    retryPolicy.maxDelayMs = 10;
    retryPolicy.maxAttempts = 5;
  });
  after(() => {
    Object.assign(retryPolicy, prev);
  });

  it("PUT /tasks retries 530 then succeeds, and is idempotent", async () => {
    await withTempDir(async (dir) => {
      let hits = 0;
      const tasksDir = path.join(dir, "tasks");
      const fileStore = new FileTaskStore(tasksDir);
      const server = createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
          hits += 1;
          if (hits <= 2) {
            res.writeHead(530);
            res.end("origin down");
            return;
          }
          const id = req.url?.split("/").pop() ?? "id";
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          try {
            await fileStore.put(id, body);
            res.writeHead(hits === 3 ? 201 : 200);
            res.end(hits === 3 ? "created" : "ok");
          } catch (err) {
            const code = (err as { code?: string }).code;
            res.writeHead(code === "task_exists" ? 409 : 500);
            res.end("err");
          }
        })();
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind");
      const origin = `http://127.0.0.1:${addr.port}`;
      try {
        const store = new HttpTaskStore(origin);
        await store.put("gb-retry-task-aaaaaaaa", { task: "hello" });
        assert.ok(hits >= 3);
        await store.put("gb-retry-task-aaaaaaaa", { task: "hello" });
        const stored = JSON.parse(
          await readFile(path.join(tasksDir, "gb-retry-task-aaaaaaaa.json"), "utf8"),
        );
        assert.equal(stored.task, "hello");
      } finally {
        await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
      }
    });
  });

  it("GET /results retries 530 and can switch origin via a URL file", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "url.txt");
      let hits = 0;
      const server = createServer((req, res) => {
        hits += 1;
        if (hits <= 2) {
          res.writeHead(530);
          res.end("down");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            request_id: "gb-retry-get-aaaaaaaa",
            status: "done",
            answer: "ok",
            finished_at: "2026-11-13T09:00:00.000Z",
          }),
        );
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind");
      const origin = `http://127.0.0.1:${addr.port}`;
      await writeFile(file, origin + "\n");
      try {
        const store = new HttpResultStore(async () => readResultsUrlFile(file));
        const got = await store.read("gb-retry-get-aaaaaaaa");
        assert.equal(got?.answer, "ok");
        assert.ok(hits >= 3);
      } finally {
        await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
      }
    });
  });
});

describe("ask_grok and polling stay pending on transient errors", () => {
  it("pollForResult returns pending instead of throwing when every GET is a 530", async () => {
    const store = {
      writeAtomic: async () => {},
      read: async () => {
        throw transientHttpError("results", 530);
      },
    };
    const started = Date.now();
    const outcome = await pollForResult(store, "gb-pending-530-aaaaaaaa", 1);
    assert.equal(outcome.status, "pending");
    assert.equal(outcome.request_id, "gb-pending-530-aaaaaaaa");
    if (outcome.status === "pending") {
      assert.match(outcome.message, /get_grok_result/i);
      assert.match(outcome.message, /530/);
    }
    assert.ok(Date.now() - started >= 900);
  });

  it("isTransientError is true for 502/503/504/530 and network errors", () => {
    for (const status of [502, 503, 504, 530]) {
      assert.equal(isTransientError(transientHttpError("results", status)), true);
    }
    assert.equal(
      isTransientError(new RelayError("Failed to reach the results server.", "results_unreachable", { transient: true })),
      true,
    );
    assert.equal(
      isTransientError(new RelayError("Webhook rejected the request (HTTP 401).", "webhook_http_error")),
      false,
    );
  });
});

describe("tests do not inherit a real GROK_RELAY_RESULTS_URL", () => {
  it("isolatedEnv drops GROK_* from process.env even if they are set", () => {
    const previous = process.env.GROK_RELAY_RESULTS_URL;
    process.env.GROK_RELAY_RESULTS_URL = "https://should-never-leak.example.invalid";
    try {
      const env = isolatedEnv({ GROK_WEBHOOK_URL: "http://127.0.0.1:9/mock" });
      assert.equal(env.GROK_RELAY_RESULTS_URL, undefined);
      assert.equal(env.GROK_WEBHOOK_URL, "http://127.0.0.1:9/mock");
      assert.ok(!Object.keys(env).some((k) => k !== "GROK_WEBHOOK_URL" && k.startsWith("GROK_")));
    } finally {
      if (previous === undefined) delete process.env.GROK_RELAY_RESULTS_URL;
      else process.env.GROK_RELAY_RESULTS_URL = previous;
    }
  });

  it("createRelay with an isolated env does not point at a process.env results URL", () => {
    const previous = process.env.GROK_RELAY_RESULTS_URL;
    process.env.GROK_RELAY_RESULTS_URL = "https://should-never-leak.example.invalid";
    try {
      const deps = createRelay(
        isolatedEnv({
          GROK_WEBHOOK_URL: "http://127.0.0.1:9/mock",
          GROK_WEBHOOK_KEY: "TESTKEY_DO_NOT_PRINT_9f3a2c1b",
          GROK_RELAY_RESULTS_DIR: "/tmp/isolated-results",
          GROK_RELAY_TASKS_DIR: "/tmp/isolated-tasks",
        }),
      );
      assert.equal(deps.config.resultsUrl, undefined);
      assert.equal(deps.config.getResultsUrl, undefined);
      assert.equal(deps.taskStore.constructor.name, "FileTaskStore");
      assert.equal(deps.store.constructor.name, "FileResultStore");
    } finally {
      if (previous === undefined) delete process.env.GROK_RELAY_RESULTS_URL;
      else process.env.GROK_RELAY_RESULTS_URL = previous;
    }
  });
});

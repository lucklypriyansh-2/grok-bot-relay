import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { RelayError } from "../src/errors.ts";
import { assertValidRequestId, generateRequestId, isValidRequestId } from "../src/ids.ts";
import { loadConfig } from "../src/config.ts";
import { FileResultStore } from "../src/results.ts";
import {
  askGrok,
  createRelay,
  getGrokResult,
  submitGrokTask,
} from "../src/relay.ts";
import { startMockWebhook } from "./mock-webhook.ts";

const SECRET = "TESTKEY_DO_NOT_PRINT_9f3a2c1b";
const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "../dist/cli.js");

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-relay-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function envFor(url: string, dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GROK_WEBHOOK_URL: url,
    GROK_WEBHOOK_KEY: SECRET,
    GROK_RELAY_RESULTS_DIR: dir,
  };
}

function assertNoSecret(text: string) {
  assert.ok(!text.includes(SECRET), "secret key leaked in output");
  assert.ok(!text.includes("Bearer "), "authorization header leaked in output");
}

describe("request ids", () => {
  it("generates gb-YYYYMMDD-HHMMSS-<8 hex>", () => {
    const id = generateRequestId(new Date(2026, 10, 13, 12, 41, 5));
    assert.match(id, /^gb-20261113-124105-[0-9a-f]{8}$/);
    assert.equal(isValidRequestId(id), true);
  });

  it("rejects path traversal and other bad ids", () => {
    const bad = [
      "../etc/passwd",
      "foo/bar",
      "foo.bar",
      "id with spaces",
      "",
      "a".repeat(81),
      "gb-../../tmp",
      "id.json",
      "foo\\bar",
    ];
    for (const id of bad) {
      assert.equal(isValidRequestId(id), false, id);
      assert.throws(() => assertValidRequestId(id), RelayError);
    }
  });
});

describe("config", () => {
  it("errors clearly when env vars are missing, without leaking anything", () => {
    let thrown: unknown;
    try {
      loadConfig({});
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof RelayError);
    assert.match(thrown.message, /GROK_WEBHOOK_URL/);
    assert.match(thrown.message, /GROK_WEBHOOK_KEY/);
    assertNoSecret(thrown.message);
  });

  it("names only the missing variable", () => {
    let thrown: unknown;
    try {
      loadConfig({ GROK_WEBHOOK_URL: "http://example.invalid" });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof RelayError);
    assert.equal(thrown.message, "Missing required environment variable: GROK_WEBHOOK_KEY.");
    assert.ok(!thrown.message.includes("http://example.invalid"));
  });
});

describe("relay ask / submit / get", () => {
  it("ask posts, waits, and returns the answer", async () => {
    await withTempDir(async (dir) => {
      const mock = await startMockWebhook({
        resultsDir: dir,
        key: SECRET,
        delayMs: 120,
        answer: "pong",
      });
      try {
        const outcome = await askGrok(
          { task: "ping", context: "unit", bot: "Coding Bot", waitSeconds: 10 },
          createRelay(envFor(mock.url, dir)),
        );
        assert.equal(outcome.status, "done");
        if (outcome.status === "done") {
          assert.equal(outcome.answer, "pong");
          assert.ok(isValidRequestId(outcome.request_id));
        }
        assert.equal(mock.calls.length, 1);
        assert.equal(mock.calls[0].authorization, `Bearer ${SECRET}`);
        const body = mock.calls[0].body as Record<string, unknown>;
        assert.equal(body.task, "ping");
        assert.equal(body.context, "unit");
        assert.equal(body.bot, "Coding Bot");
        assert.equal(body.request_id, outcome.request_id);
      } finally {
        await mock.close();
      }
    });
  });

  it("submit is fire-and-forget and get collects the result", async () => {
    await withTempDir(async (dir) => {
      const mock = await startMockWebhook({
        resultsDir: dir,
        key: SECRET,
        delayMs: 200,
        answer: "later",
      });
      try {
        const deps = createRelay(envFor(mock.url, dir));
        const submitted = await submitGrokTask({ task: "do work" }, deps);
        assert.ok(isValidRequestId(submitted.request_id));
        const early = await getGrokResult(submitted.request_id, deps);
        assert.equal(early.status, "pending");
        const deadline = Date.now() + 5000;
        let later = early;
        while (Date.now() < deadline) {
          later = await getGrokResult(submitted.request_id, deps);
          if (later.status !== "pending") break;
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(later.status, "done");
        if (later.status === "done") assert.equal(later.answer, "later");
      } finally {
        await mock.close();
      }
    });
  });

  it("ask times out as pending and keeps the request_id", async () => {
    await withTempDir(async (dir) => {
      const mock = await startMockWebhook({
        resultsDir: dir,
        key: SECRET,
        writeResult: false,
      });
      try {
        const outcome = await askGrok(
          { task: "slow", waitSeconds: 1 },
          createRelay(envFor(mock.url, dir)),
        );
        assert.equal(outcome.status, "pending");
        assert.ok(isValidRequestId(outcome.request_id));
        if (outcome.status === "pending") {
          assert.match(outcome.message, /get_grok_result/i);
        }
      } finally {
        await mock.close();
      }
    });
  });

  it("rejects a bad request_id before touching the filesystem", async () => {
    await withTempDir(async (dir) => {
      const deps = createRelay(
        envFor("http://127.0.0.1:9/unused", dir),
      );
      await assert.rejects(
        () => getGrokResult("../etc/passwd", deps),
        (err: unknown) => {
          assert.ok(err instanceof RelayError);
          assert.equal(err.code, "invalid_request_id");
          assertNoSecret(err.message);
          return true;
        },
      );
    });
  });

  it("surfaces a non-200 as a status-code-only error", async () => {
    await withTempDir(async (dir) => {
      const mock = await startMockWebhook({
        resultsDir: dir,
        key: SECRET,
        status: 503,
      });
      try {
        await assert.rejects(
          () => askGrok({ task: "nope", waitSeconds: 1 }, createRelay(envFor(mock.url, dir))),
          (err: unknown) => {
            assert.ok(err instanceof RelayError);
            assert.equal(err.message, "Webhook rejected the request (HTTP 503).");
            assert.ok(!err.message.includes(mock.url));
            assertNoSecret(err.message);
            return true;
          },
        );
      } finally {
        await mock.close();
      }
    });
  });

  it("does not leak the URL on a network failure", async () => {
    await withTempDir(async (dir) => {
      const url = "http://127.0.0.1:1/secret-path-should-not-leak";
      await assert.rejects(
        () => askGrok({ task: "nope" }, createRelay(envFor(url, dir))),
        (err: unknown) => {
          assert.ok(err instanceof RelayError);
          assert.equal(err.message, "Failed to reach the webhook.");
          assert.ok(!err.message.includes("secret-path"));
          assert.ok(!err.message.includes(url));
          assertNoSecret(err.message);
          return true;
        },
      );
    });
  });
});

describe("file store atomic write", () => {
  it("writes a readable result and leaves no tmp file", async () => {
    await withTempDir(async (dir) => {
      const store = new FileResultStore(dir);
      const request_id = generateRequestId();
      await store.writeAtomic({
        request_id,
        status: "done",
        answer: "ok",
        finished_at: "2026-11-13T07:11:00.000Z",
      });
      const got = await store.read(request_id);
      assert.deepEqual(got, {
        request_id,
        status: "done",
        answer: "ok",
        finished_at: "2026-11-13T07:11:00.000Z",
      });
      const { readdir } = await import("node:fs/promises");
      const names = await readdir(dir);
      assert.deepEqual(names, [`${request_id}.json`]);
    });
  });
});

describe("CLI wrapper", () => {
  it("ask / get work, and the key never appears in output", async () => {
    await withTempDir(async (dir) => {
      const mock = await startMockWebhook({
        resultsDir: dir,
        key: SECRET,
        delayMs: 80,
        answer: "from-cli",
      });
      try {
        const result = await runCli(
          ["ask", "--json", "--wait", "10", "hello from cli"],
          envFor(mock.url, dir),
        );
        assert.equal(result.code, 0, result.stderr);
        assertNoSecret(result.stdout);
        assertNoSecret(result.stderr);
        assert.ok(!result.stdout.includes(mock.url));
        assert.ok(!result.stderr.includes(mock.url));
        const parsed = JSON.parse(result.stdout);
        assert.equal(parsed.status, "done");
        assert.equal(parsed.answer, "from-cli");

        const got = await runCli(["get", "--json", parsed.request_id], envFor(mock.url, dir));
        assert.equal(got.code, 0, got.stderr);
        assertNoSecret(got.stdout + got.stderr);
        assert.equal(JSON.parse(got.stdout).answer, "from-cli");
      } finally {
        await mock.close();
      }
    });
  });

  it("get --wait polls until a result appears", async () => {
    await withTempDir(async (dir) => {
      const request_id = "gb-20261113-waittest-aaaabbbb";
      const started = Date.now();
      const writing = (async () => {
        await new Promise((r) => setTimeout(r, 1200));
        const { FileResultStore } = await import("../src/results.ts");
        const store = new FileResultStore(dir);
        await store.writeAtomic({
          request_id,
          status: "done",
          answer: "waited",
          finished_at: "2026-11-13T07:40:06Z",
        });
      })();
      const result = await runCli(
        ["get", "--json", "--wait", "10", request_id],
        envFor("http://127.0.0.1:9/unused", dir),
      );
      await writing;
      const elapsed = Date.now() - started;
      assert.equal(result.code, 0, result.stderr);
      assertNoSecret(result.stdout + result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.status, "done");
      assert.equal(parsed.answer, "waited");
      assert.ok(elapsed >= 1000, `expected polling, finished in ${elapsed}ms`);
    });
  });

  it("get without --wait returns pending immediately if no result exists", async () => {
    await withTempDir(async (dir) => {
      const started = Date.now();
      const result = await runCli(
        ["get", "--json", "gb-20261113-pending-ccccdddd"],
        envFor("http://127.0.0.1:9/unused", dir),
      );
      const elapsed = Date.now() - started;
      assert.equal(result.code, 2, result.stderr);
      assertNoSecret(result.stdout + result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.status, "pending");
      assert.ok(elapsed < 2000, `expected immediate return, took ${elapsed}ms`);
    });
  });

  it("prints only the status code when the webhook returns non-200", async () => {
    await withTempDir(async (dir) => {
      const mock = await startMockWebhook({
        resultsDir: dir,
        key: SECRET,
        status: 401,
      });
      try {
        const result = await runCli(["ask", "hello"], envFor(mock.url, dir));
        assert.equal(result.code, 1);
        assert.match(result.stderr, /HTTP 401/);
        assertNoSecret(result.stdout + result.stderr);
        assert.ok(!result.stderr.includes(mock.url));
      } finally {
        await mock.close();
      }
    });
  });
});

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

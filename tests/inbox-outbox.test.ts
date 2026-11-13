import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_INBOX_BASENAME,
  DEFAULT_OUTBOX_BASENAME,
  loadConfig,
  resolveOptionalDir,
} from "../src/config.ts";
import { RelayError } from "../src/errors.ts";
import {
  createArtifactStore,
  downloadArtifacts,
  withArtifacts,
} from "../src/artifacts.ts";
import { askGrok, createRelay, getGrokResult, submitGrokTask } from "../src/relay.ts";
import { FileResultStore } from "../src/results.ts";
import { FileTaskStore } from "../src/tasks.ts";
import {
  MAX_WEBHOOK_BODY_CHARS,
  buildWebhookPointer,
  serializeWebhookPointer,
} from "../src/webhook.ts";
import { startMockWebhook } from "./mock-webhook.ts";
import { isolatedEnv } from "./test-env.ts";

const SECRET = "TESTKEY_DO_NOT_PRINT_inbox_7c2e";
const TOKEN = "a".repeat(64);
const ID = "gb-20261113-160000-abcd1234";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-inbox-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function envFor(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return isolatedEnv({
    GROK_WEBHOOK_URL: extra.GROK_WEBHOOK_URL ?? "http://127.0.0.1:9/unused",
    GROK_WEBHOOK_KEY: SECRET,
    GROK_RELAY_RESULTS_DIR: path.join(dir, "results"),
    GROK_RELAY_TASKS_DIR: path.join(dir, "tasks"),
    ...extra,
  });
}

describe("resolveOptionalDir", () => {
  it("treats unset as off, default as ~/basename, and expands ~/", () => {
    assert.equal(resolveOptionalDir(undefined, DEFAULT_INBOX_BASENAME), undefined);
    assert.equal(resolveOptionalDir("", DEFAULT_INBOX_BASENAME), undefined);
    assert.equal(resolveOptionalDir("  ", DEFAULT_OUTBOX_BASENAME), undefined);
    assert.equal(
      resolveOptionalDir("default", DEFAULT_INBOX_BASENAME),
      path.join(os.homedir(), DEFAULT_INBOX_BASENAME),
    );
    assert.equal(
      resolveOptionalDir("default", DEFAULT_OUTBOX_BASENAME),
      path.join(os.homedir(), DEFAULT_OUTBOX_BASENAME),
    );
    assert.equal(resolveOptionalDir("~/custom-in", "x"), path.join(os.homedir(), "custom-in"));
    const abs = path.join(os.tmpdir(), "relay-inbox-abs");
    assert.equal(resolveOptionalDir(abs, "x"), abs);
  });

  it("loadConfig wires inbox and outbox and does not require a token without a URL", () => {
    const inbox = path.join(os.tmpdir(), "cfg-inbox");
    const outbox = path.join(os.tmpdir(), "cfg-outbox");
    const cfg = loadConfig(
      isolatedEnv({
        GROK_WEBHOOK_URL: "http://127.0.0.1:9/hook",
        GROK_WEBHOOK_KEY: SECRET,
        GROK_RELAY_INBOX_DIR: inbox,
        GROK_RELAY_OUTBOX_DIR: outbox,
      }),
    );
    assert.equal(cfg.inboxDir, path.resolve(inbox));
    assert.equal(cfg.outboxDir, path.resolve(outbox));
    assert.equal(cfg.resultsUrl, undefined);
  });
});

describe("webhook pointer mac_task_path", () => {
  it("includes mac_task_path after request_id and stays under the cap", () => {
    const macPath = path.join(os.homedir(), "grok-relay-outbox", `${ID}.json`);
    const payload = buildWebhookPointer(ID, "A".repeat(4000), { macTaskPath: macPath });
    const raw = serializeWebhookPointer(payload);
    assert.ok(raw.startsWith('{"request_id"'));
    assert.ok(raw.length <= MAX_WEBHOOK_BODY_CHARS, String(raw.length));
    assert.equal(payload.mac_task_path, macPath);
    assert.ok(raw.includes("mac_task_path"));
    assert.ok(raw.includes(macPath));
  });
});

describe("local inbox results", () => {
  it("reads a result from the inbox even when the HTTP origin is down", async () => {
    await withTempDir(async (dir) => {
      const inbox = path.join(dir, "inbox");
      const result = {
        request_id: ID,
        status: "done" as const,
        answer: "from-inbox",
        finished_at: "2026-11-13T16:00:00+05:30",
      };
      await mkdir(inbox, { recursive: true });
      await new FileResultStore(inbox).writeAtomic(result);

      const deps = createRelay(
        envFor(dir, {
          GROK_RELAY_INBOX_DIR: inbox,
          GROK_RELAY_RESULTS_URL: "http://127.0.0.1:1",
          GROK_RELAY_RESULTS_TOKEN: TOKEN,
        }),
      );
      const got = await getGrokResult(ID, deps, 0);
      assert.equal(got.status, "done");
      if (got.status === "done") assert.equal(got.answer, "from-inbox");
    });
  });

  it("falls back to HTTP when the inbox has no result yet", async () => {
    await withTempDir(async (dir) => {
      const inbox = path.join(dir, "inbox");
      const resultsDir = path.join(dir, "remote-results");
      await mkdir(inbox, { recursive: true });
      await mkdir(resultsDir, { recursive: true });
      const mock = await startMockWebhook({ resultsDir, key: SECRET, delayMs: 0, answer: "from-http" });
      // Use a tiny results HTTP server via FileResultStore + startResultsServer? Simpler: write
      // the result and serve it. We only need get() to hit HTTP. Use results-server.
      const { startResultsServer } = await import("../src/results-server.ts");
      await new FileResultStore(resultsDir).writeAtomic({
        request_id: ID,
        status: "done",
        answer: "from-http",
        finished_at: "2026-11-13T16:00:00+05:30",
      });
      const srv = await startResultsServer({
        resultsDir,
        tasksDir: path.join(dir, "tasks"),
        token: TOKEN,
        port: 0,
      } as Parameters<typeof startResultsServer>[0]);
      try {
        const deps = createRelay(
          envFor(dir, {
            GROK_WEBHOOK_URL: mock.url,
            GROK_RELAY_INBOX_DIR: inbox,
            GROK_RELAY_RESULTS_URL: `http://127.0.0.1:${srv.port}`,
            GROK_RELAY_RESULTS_TOKEN: TOKEN,
          }),
        );
        const got = await getGrokResult(ID, deps, 0);
        assert.equal(got.status, "done");
        if (got.status === "done") assert.equal(got.answer, "from-http");
      } finally {
        await srv.close();
        await mock.close();
      }
    });
  });

  it("ask_grok polls the inbox and returns the answer without a working tunnel", async () => {
    await withTempDir(async (dir) => {
      const inbox = path.join(dir, "inbox");
      const outbox = path.join(dir, "outbox");
      await mkdir(inbox, { recursive: true });
      const mock = await startMockWebhook({
        resultsDir: inbox,
        key: SECRET,
        delayMs: 80,
        answer: "inbox-poll-ok",
      });
      try {
        const outcome = await askGrok(
          { task: "please reply", waitSeconds: 8 },
          createRelay(
            envFor(dir, {
              GROK_WEBHOOK_URL: mock.url,
              GROK_RELAY_INBOX_DIR: inbox,
              GROK_RELAY_OUTBOX_DIR: outbox,
              GROK_RELAY_RESULTS_URL: "http://127.0.0.1:1",
              GROK_RELAY_RESULTS_TOKEN: TOKEN,
            }),
          ),
        );
        assert.equal(outcome.status, "done");
        if (outcome.status === "done") assert.equal(outcome.answer, "inbox-poll-ok");
        assert.equal(mock.calls.length, 1);
        const body = mock.calls[0].body as { mac_task_path?: string; request_id: string };
        assert.ok(body.mac_task_path?.endsWith(`${body.request_id}.json`));
        const written = JSON.parse(await readFile(body.mac_task_path as string, "utf8"));
        assert.equal(written.task, "please reply");
      } finally {
        await mock.close();
      }
    });
  });
});

describe("local outbox tasks", () => {
  it("writes the full task to the outbox before the webhook and still sends when PUT fails", async () => {
    await withTempDir(async (dir) => {
      const outbox = path.join(dir, "outbox");
      const inbox = path.join(dir, "inbox");
      await mkdir(outbox, { recursive: true });
      const mock = await startMockWebhook({ resultsDir: inbox, key: SECRET, writeResult: false });
      try {
        const submitted = await submitGrokTask(
          { task: "do the thing", context: "ctx", bot: "grok" },
          createRelay(
            envFor(dir, {
              GROK_WEBHOOK_URL: mock.url,
              GROK_RELAY_OUTBOX_DIR: outbox,
              GROK_RELAY_INBOX_DIR: inbox,
              GROK_RELAY_RESULTS_URL: "http://127.0.0.1:1",
              GROK_RELAY_RESULTS_TOKEN: TOKEN,
            }),
          ),
        );
        assert.equal(submitted.status, "submitted");
        const file = path.join(outbox, `${submitted.request_id}.json`);
        const stored = JSON.parse(await readFile(file, "utf8"));
        assert.equal(stored.task, "do the thing");
        assert.equal(stored.context, "ctx");
        assert.equal(stored.bot, "grok");
        assert.equal(mock.calls.length, 1);
        const body = mock.calls[0].body as { mac_task_path?: string; task_ref?: string };
        assert.equal(body.mac_task_path, file);
        assert.equal(body.task_ref, `tasks/${submitted.request_id}.json`);
      } finally {
        await mock.close();
      }
    });
  });

  it("still fails the request when PUT conflicts, even if the outbox write succeeded", async () => {
    await withTempDir(async (dir) => {
      const outbox = path.join(dir, "outbox");
      const tasksDir = path.join(dir, "server-tasks");
      await mkdir(tasksDir, { recursive: true });
      await new FileTaskStore(tasksDir).put(ID, { task: "original-different" });
      const { startResultsServer } = await import("../src/results-server.ts");
      const srv = await startResultsServer({
        resultsDir: path.join(dir, "results"),
        tasksDir,
        token: TOKEN,
        port: 0,
      } as Parameters<typeof startResultsServer>[0]);
      const mock = await startMockWebhook({
        resultsDir: path.join(dir, "inbox"),
        key: SECRET,
        writeResult: false,
      });
      try {
        await assert.rejects(
          submitGrokTask(
            { task: "new-payload", requestId: ID },
            createRelay(
              envFor(dir, {
                GROK_WEBHOOK_URL: mock.url,
                GROK_RELAY_OUTBOX_DIR: outbox,
                GROK_RELAY_RESULTS_URL: `http://127.0.0.1:${srv.port}`,
                GROK_RELAY_RESULTS_TOKEN: TOKEN,
              }),
            ),
          ),
          (err: unknown) => err instanceof RelayError && err.code === "task_exists",
        );
        assert.equal(mock.calls.length, 0);
      } finally {
        await srv.close();
        await mock.close();
      }
    });
  });

  it("fails as usual when there is no outbox and the HTTP upload fails", async () => {
    await withTempDir(async (dir) => {
      const mock = await startMockWebhook({
        resultsDir: path.join(dir, "results"),
        key: SECRET,
        writeResult: false,
      });
      try {
        await assert.rejects(
          submitGrokTask(
            { task: "no-outbox" },
            createRelay(
              envFor(dir, {
                GROK_WEBHOOK_URL: mock.url,
                GROK_RELAY_RESULTS_URL: "http://127.0.0.1:1",
                GROK_RELAY_RESULTS_TOKEN: TOKEN,
              }),
            ),
          ),
          RelayError,
        );
        assert.equal(mock.calls.length, 0);
      } finally {
        await mock.close();
      }
    });
  });
});

describe("inbox artifacts", () => {
  it("lists local paths and download returns them without a network fetch", async () => {
    await withTempDir(async (dir) => {
      const inbox = path.join(dir, "inbox");
      const artDir = path.join(inbox, ID);
      await mkdir(artDir, { recursive: true });
      const file = path.join(artDir, "notes.md");
      await writeFile(file, "# notes\n");
      await new FileResultStore(inbox).writeAtomic({
        request_id: ID,
        status: "done",
        answer: "see notes",
        finished_at: "2026-11-13T16:00:00+05:30",
        artifacts: [{ name: "notes.md", description: "Notes" }],
      });

      const store = createArtifactStore({
        resultsDir: path.join(dir, "results"),
        resultsUrl: "http://127.0.0.1:1",
        resultsToken: TOKEN,
        inboxDir: inbox,
      });
      const listed = await store.list(ID);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].name, "notes.md");
      assert.equal(listed[0].path, file);

      const dl = await downloadArtifacts(store, ID);
      assert.equal(dl.files.length, 1);
      assert.equal(dl.files[0].path, file);
      assert.equal(dl.files[0].already_local, true);
      assert.equal(dl.dest_dir, artDir);

      const hinted = await withArtifacts(
        await new FileResultStore(inbox).read(ID),
        store,
      );
      assert.match(String((hinted as { artifacts_hint?: string }).artifacts_hint), /no download needed/);
      assert.match(String((hinted as { artifacts_hint?: string }).artifacts_hint), /notes\.md/);
    });
  });
});

describe("tests do not inherit a real inbox or outbox", () => {
  it("isolatedEnv drops GROK_RELAY_INBOX_DIR and OUTBOX_DIR", () => {
    const env = isolatedEnv({ GROK_WEBHOOK_URL: "http://127.0.0.1:9", GROK_WEBHOOK_KEY: "k" });
    assert.equal(env.GROK_RELAY_INBOX_DIR, undefined);
    assert.equal(env.GROK_RELAY_OUTBOX_DIR, undefined);
    const cfg = loadConfig(env);
    assert.equal(cfg.inboxDir, undefined);
    assert.equal(cfg.outboxDir, undefined);
  });
});

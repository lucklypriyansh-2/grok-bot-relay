import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockWebhook } from "./mock-webhook.ts";

const SECRET = "TESTKEY_DO_NOT_PRINT_9f3a2c1b";
const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "../dist/server.js");

type Session = {
  client: Client;
  transport: StdioClientTransport;
  stderr: string;
  close: () => Promise<void>;
};

async function openSession(env: Record<string, string>): Promise<Session> {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...getDefaultEnvironment(),
      ...env,
    },
    stderr: "pipe",
  });
  const err = transport.stderr;
  if (err) {
    err.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
  }
  const client = new Client({ name: "grok-relay-test", version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    transport,
    get stderr() {
      return stderr;
    },
    close: async () => {
      await client.close();
    },
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

describe("MCP stdio server", () => {
  it("lists tools and ask_grok returns the mock answer", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "grok-relay-mcp-"));
    const mock = await startMockWebhook({
      resultsDir: dir,
      key: SECRET,
      delayMs: 100,
      answer: "mcp-ok",
    });
    let session: Session | undefined;
    try {
      session = await openSession({
        GROK_WEBHOOK_URL: mock.url,
        GROK_WEBHOOK_KEY: SECRET,
        GROK_RELAY_RESULTS_DIR: dir,
      });
      const listed = await session.client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      assert.deepEqual(names, ["ask_grok", "get_grok_result", "submit_grok_task"]);

      const asked = await session.client.callTool({
        name: "ask_grok",
        arguments: { task: "say ok", wait_seconds: 15 },
      });
      const askedText = textOf(asked as { content: Array<{ type: string; text?: string }> });
      assert.ok(!askedText.includes(SECRET), "secret key leaked in MCP tool output");
      assert.ok(!askedText.includes(mock.url), "webhook URL leaked in MCP tool output");
      const payload = JSON.parse(askedText);
      assert.equal(payload.status, "done");
      assert.equal(payload.answer, "mcp-ok");
      assert.notEqual(asked.isError, true);
    } finally {
      if (session) {
        assert.ok(!session.stderr.includes(SECRET), "secret key leaked on MCP stderr");
        if (mock.url) {
          assert.ok(!session.stderr.includes(mock.url), "webhook URL leaked on MCP stderr");
        }
        await session.close();
      }
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("get_grok_result rejects a bad request_id", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "grok-relay-mcp-"));
    const mock = await startMockWebhook({ resultsDir: dir, key: SECRET, writeResult: false });
    let session: Session | undefined;
    try {
      session = await openSession({
        GROK_WEBHOOK_URL: mock.url,
        GROK_WEBHOOK_KEY: SECRET,
        GROK_RELAY_RESULTS_DIR: dir,
      });
      const result = await session.client.callTool({
        name: "get_grok_result",
        arguments: { request_id: "../etc/passwd" },
      });
      assert.equal(result.isError, true);
      const text = textOf(result as { content: Array<{ type: string; text?: string }> });
      assert.match(text, /Invalid request_id/);
      assert.ok(!text.includes(SECRET));
    } finally {
      if (session) await session.close();
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("optional CLI MCP config", () => {
  it("records whether claude / codex / gemini CLIs are installed", async () => {
    const found: Record<string, string | null> = {};
    for (const bin of ["claude", "codex", "gemini"]) {
      found[bin] = await which(bin);
    }
    // This test is informational: those CLIs are not required to ship the server.
    assert.ok(Object.keys(found).length === 3);
    if (found.claude) {
      const help = await runCapture(found.claude, ["mcp", "--help"]);
      assert.ok(
        help.stdout.includes("mcp") || help.stderr.includes("mcp") || help.code === 0,
        "claude mcp help failed",
      );
    }
  });
});

function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("which", [bin], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c.toString();
    });
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
}

function runCapture(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

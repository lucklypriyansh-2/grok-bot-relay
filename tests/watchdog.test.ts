import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const watchdog = path.join(here, "../scripts/tunnel-watchdog.py");

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-watchdog-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [watchdog, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe("tunnel watchdog", () => {
  it("classifies health and restarts after 3 failures, then writes a new url", async () => {
    await withTemp(async (dir) => {
      const runDir = path.join(dir, "run");
      const restarts = path.join(dir, "restarts.txt");
      const envFile = path.join(dir, "env");
      await writeFile(envFile, "export GROK_RELAY_RESULTS_TOKEN=watchdog-test-token\n", { mode: 0o600 });
      let hits = 0;
      const server = createServer((req, res) => {
        hits += 1;
        const auth = String(req.headers.authorization ?? "");
        if (auth !== "Bearer watchdog-test-token") {
          res.writeHead(401);
          res.end("no");
          return;
        }
        res.writeHead(530);
        res.end("origin down");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind");
      const origin = `http://127.0.0.1:${addr.port}`;
      const { mkdir } = await import("node:fs/promises");
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, "tunnel-url.txt"), origin + "\n");
      const restartCmd = `echo restarted >> '${restarts}' && echo 'https://recovered.example.invalid' > '${path.join(runDir, "tunnel-url.txt")}'`;
      try {
        const env: NodeJS.ProcessEnv = {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          GROK_RELAY_ROOT: dir,
          GROK_RELAY_RUN_DIR: runDir,
          GROK_RELAY_ENV: envFile,
          GROK_RELAY_RESTART_TUNNEL_CMD: restartCmd,
          GROK_RELAY_WATCHDOG_LOG: path.join(runDir, "watchdog.log"),
        };
        // Three --once checks should trip the restart on the third failure.
        for (let i = 0; i < 3; i++) {
          const result = await run(["--once", "--failures", "3"], env);
          assert.equal(result.code, 0, result.stderr);
        }
        const log = await readFile(path.join(runDir, "watchdog.log"), "utf8");
        assert.match(log, /health failed: HTTP 530/);
        assert.match(log, /tunnel likely lost its origin/);
        assert.match(log, /new tunnel url https:\/\/recovered\.example\.invalid/);
        assert.ok(!log.includes("watchdog-test-token"));
        assert.ok(!log.includes("Bearer "));
        const count = (await readFile(restarts, "utf8")).trim().split("\n").length;
        assert.equal(count, 1);
        const url = (await readFile(path.join(runDir, "tunnel-url.txt"), "utf8")).trim();
        assert.equal(url, "https://recovered.example.invalid");
        assert.ok(hits >= 3);
      } finally {
        await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
      }
    });
  });
});

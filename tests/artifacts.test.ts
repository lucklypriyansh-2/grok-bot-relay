import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { isolatedEnv, withoutGrokEnv } from "./test-env.ts";
import {
  defaultDownloadDir,
  downloadArtifacts,
  FileArtifactStore,
  HttpArtifactStore,
  isValidArtifactName,
  listArtifactsOnDisk,
  withArtifacts,
} from "../src/artifacts.ts";
import { RelayError } from "../src/errors.ts";
import { FileResultStore, HttpResultStore, parseResult } from "../src/results.ts";
import { startResultsServer } from "../src/results-server.ts";

const TOKEN = "TEST_ARTIFACT_TOKEN_DO_NOT_PRINT_91ab";
const ID = "gb-20261113-140000-abcdef12";
const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "../dist/cli.js");
const serverPath = path.join(here, "../dist/server.js");

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-relay-art-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seed(resultsDir: string) {
  const artDir = path.join(resultsDir, ID);
  await mkdir(artDir, { recursive: true });
  const report = "# Report\n\nSee sources.\n";
  const csv = "id,status\nP1,open\n";
  const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3, 255]);
  await writeFile(path.join(artDir, "report.md"), report);
  await writeFile(path.join(artDir, "problems.csv"), csv);
  await writeFile(path.join(artDir, "register.xlsx"), xlsx);
  await new FileResultStore(resultsDir).writeAtomic({
    request_id: ID,
    status: "done",
    answer: "summary only",
    finished_at: "2026-11-13T08:30:00.000Z",
    artifacts: [
      { name: "report.md", description: "Full research report" },
      { name: "problems.csv" },
      { name: "register.xlsx" },
    ],
  });
  return { report, csv, xlsx };
}

/** Raw HTTP GET so the path is sent exactly as written (fetch would normalise it). */
function rawGet(
  port: number,
  rawPath: string,
  token: string | null = TOKEN,
): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: rawPath,
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("artifact names", () => {
  it("accepts safe names and rejects traversal and odd names", () => {
    for (const ok of ["report.md", "data_1.csv", "Register-v2.xlsx", "a"]) {
      assert.equal(isValidArtifactName(ok), true, ok);
    }
    for (const bad of ["", "../x", "..", "a/b", "a\\b", ".hidden", "x..y", "a b", "f.tmp", "x".repeat(129)]) {
      assert.equal(isValidArtifactName(bad), false, bad);
    }
  });

  it("parseResult keeps an artifacts array and rejects unsafe names", () => {
    const r = parseResult({
      request_id: ID,
      status: "done",
      answer: "a",
      finished_at: "x",
      artifacts: ["a.md", { name: "b.csv", size: 3, description: "d", junk: 1 }],
    });
    assert.deepEqual(r.artifacts, [{ name: "a.md" }, { name: "b.csv", size: 3, description: "d" }]);
    assert.throws(
      () => parseResult({ request_id: ID, status: "done", answer: "a", finished_at: "x", artifacts: [{ name: "../etc" }] }),
      RelayError,
    );
    const plain = parseResult({ request_id: ID, status: "done", answer: "a", finished_at: "x" });
    assert.equal(plain.artifacts, undefined);
  });
});

describe("artifact HTTP routes", () => {
  it("lists and serves artifacts with auth, hashes, and traversal protection", async () => {
    await withTemp(async (root) => {
      const resultsDir = path.join(root, "results");
      const { report, xlsx } = await seed(resultsDir);
      await writeFile(path.join(root, "secret.txt"), "TOP SECRET");
      await symlink(path.join(root, "secret.txt"), path.join(resultsDir, ID, "link.txt"));
      const srv = await startResultsServer({
        resultsDir,
        tasksDir: path.join(root, "tasks"),
        token: TOKEN,
        port: 0,
      } as Parameters<typeof startResultsServer>[0]);
      try {
        const base = `/results/${ID}/artifacts`;
        assert.equal((await rawGet(srv.port, base, null)).status, 401);
        assert.equal((await rawGet(srv.port, base, "wrong")).status, 401);

        const list = await rawGet(srv.port, base);
        assert.equal(list.status, 200);
        const parsed = JSON.parse(list.body.toString());
        assert.deepEqual(
          parsed.artifacts.map((a: { name: string }) => a.name),
          ["problems.csv", "register.xlsx", "report.md"],
        );
        const rep = parsed.artifacts.find((a: { name: string }) => a.name === "report.md");
        assert.equal(rep.size, Buffer.byteLength(report));
        assert.equal(rep.sha256, sha(report));

        const file = await rawGet(srv.port, `${base}/register.xlsx`);
        assert.equal(file.status, 200);
        assert.deepEqual(file.body, xlsx);
        assert.equal(file.headers["x-artifact-sha256"], sha(xlsx));
        assert.match(String(file.headers["content-type"]), /spreadsheetml/);

        // Traversal and unsafe names
        for (const p of [
          `${base}/..%2F..%2Fsecret.txt`,
          `${base}/%2e%2e`,
          `${base}/..`,
          `${base}/.hidden`,
          `${base}/a%5Cb`,
          `${base}/%E0%A4%A`,
        ]) {
          const r = await rawGet(srv.port, p);
          // Dot segments are resolved by URL parsing before routing (e.g. to the
          // result JSON). Either way, nothing outside the artifacts dir is served.
          assert.ok(!r.body.toString().includes("TOP SECRET"), p);
          assert.equal(r.headers["x-artifact-sha256"], undefined, p);
          if (!p.includes("%2e%2e") && !p.endsWith("/..")) {
            assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
          }
        }
        const traversal = await rawGet(srv.port, `/results/${ID}/artifacts/../../../secret.txt`);
        assert.ok(!traversal.body.toString().includes("TOP SECRET"));
        // Symlinks are never listed or served
        assert.equal((await rawGet(srv.port, `${base}/link.txt`)).status, 404);
        assert.equal((await rawGet(srv.port, `/results/bad.id/artifacts`)).status, 400);
        assert.equal((await rawGet(srv.port, `${base}/missing.md`)).status, 404);
        // No artifacts dir -> empty list
        const empty = await rawGet(srv.port, `/results/gb-none/artifacts`);
        assert.equal(empty.status, 200);
        assert.deepEqual(JSON.parse(empty.body.toString()).artifacts, []);
        // Read-only
        const put = await fetch(`http://127.0.0.1:${srv.port}${base}/x.md`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${TOKEN}` },
          body: "x",
        });
        assert.equal(put.status, 405);
        // Result JSON still served, with artifacts
        const res = await new HttpResultStore(`http://127.0.0.1:${srv.port}`, {
          Authorization: `Bearer ${TOKEN}`,
        }).read(ID);
        assert.equal(res?.artifacts?.length, 3);
      } finally {
        await srv.close();
      }
    });
  });

  it("downloads over HTTP into a folder and verifies checksums", async () => {
    await withTemp(async (root) => {
      const resultsDir = path.join(root, "results");
      const { report, csv, xlsx } = await seed(resultsDir);
      const srv = await startResultsServer({
        resultsDir,
        tasksDir: path.join(root, "tasks"),
        token: TOKEN,
        port: 0,
      } as Parameters<typeof startResultsServer>[0]);
      try {
        const store = new HttpArtifactStore(`http://127.0.0.1:${srv.port}/`, {
          Authorization: `Bearer ${TOKEN}`,
        });
        const dest = path.join(root, "out");
        const all = await downloadArtifacts(store, ID, { destDir: dest });
        assert.equal(all.files.length, 3);
        assert.ok(all.files.every((f) => f.verified));
        assert.equal(await readFile(path.join(dest, "report.md"), "utf8"), report);
        assert.equal(await readFile(path.join(dest, "problems.csv"), "utf8"), csv);
        assert.deepEqual(await readFile(path.join(dest, "register.xlsx")), xlsx);

        const one = await downloadArtifacts(store, ID, { destDir: path.join(root, "one"), names: ["problems.csv"] });
        assert.deepEqual(one.files.map((f) => f.name), ["problems.csv"]);
        await assert.rejects(downloadArtifacts(store, ID, { destDir: dest, names: ["nope.md"] }), RelayError);
        await assert.rejects(downloadArtifacts(store, ID, { destDir: dest, names: ["../x"] }), RelayError);

        const badToken = new HttpArtifactStore(`http://127.0.0.1:${srv.port}`, { Authorization: "Bearer nope" });
        await assert.rejects(badToken.list(ID), (e: unknown) => e instanceof RelayError && !String(e).includes(TOKEN));
      } finally {
        await srv.close();
      }
    });
  });

  it("rejects a file whose bytes do not match the listed sha256", async () => {
    const store = {
      list: async () => [{ name: "a.md", sha256: "0".repeat(64) }],
      fetch: async () => Buffer.from("tampered"),
    };
    await withTemp(async (root) => {
      await assert.rejects(downloadArtifacts(store, ID, { destDir: root }), /Checksum mismatch/);
    });
  });

  it("defaults downloads to ~/grok-relay-artifacts/<request_id>", () => {
    assert.equal(defaultDownloadDir(ID), path.join(os.homedir(), "grok-relay-artifacts", ID));
    assert.throws(() => defaultDownloadDir("../x"), RelayError);
  });
});

describe("withArtifacts", () => {
  it("merges live listing with declared descriptions and adds a hint", async () => {
    await withTemp(async (resultsDir) => {
      await seed(resultsDir);
      const result = await new FileResultStore(resultsDir).read(ID);
      const out = (await withArtifacts(result!, new FileArtifactStore(resultsDir))) as Record<string, unknown>;
      const arts = out.artifacts as Array<{ name: string; sha256?: string; description?: string }>;
      assert.equal(arts.length, 3);
      assert.equal(arts.find((a) => a.name === "report.md")?.description, "Full research report");
      assert.ok(arts.every((a) => typeof a.sha256 === "string"));
      assert.match(String(out.artifacts_hint), /download_grok_artifacts/);
      const pending = await withArtifacts(
        { request_id: ID, status: "pending", message: "m" },
        new FileArtifactStore(resultsDir),
      );
      assert.equal((pending as Record<string, unknown>).artifacts, undefined);
    });
  });

  it("lists nothing for a request without artifacts", async () => {
    await withTemp(async (dir) => {
      assert.deepEqual(await listArtifactsOnDisk(dir, ID), []);
    });
  });
});

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: isolatedEnv({ PATH: process.env.PATH ?? "", HOME: env.HOME ?? os.homedir(), ...env }),
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code: code ?? 0, out, err }));
  });
}

describe("CLI artifacts", () => {
  it("complete --artifact, artifacts, and download round-trip", async () => {
    await withTemp(async (root) => {
      const resultsDir = path.join(root, "results");
      const src = path.join(root, "brief.md");
      await writeFile(src, "# Brief\n");
      const summary = path.join(root, "summary.txt");
      await writeFile(summary, "Short summary.");
      const env = { GROK_RELAY_RESULTS_DIR: resultsDir, HOME: root };
      const done = await runCli(["complete", "--answer-file", summary, "--artifact", src, "--json", ID], env);
      assert.equal(done.code, 0, done.err);
      const written = JSON.parse(done.out);
      assert.equal(written.answer, "Short summary.");
      assert.equal(written.artifacts[0].name, "brief.md");
      assert.equal(written.artifacts[0].sha256, sha("# Brief\n"));

      const listed = await runCli(["artifacts", "--json", ID], env);
      assert.equal(JSON.parse(listed.out).artifacts.length, 1);

      const dl = await runCli(["download", "--json", ID], env);
      assert.equal(dl.code, 0, dl.err);
      const dlOut = JSON.parse(dl.out);
      assert.equal(dlOut.dest_dir, path.join(root, "grok-relay-artifacts", ID));
      assert.equal(await readFile(path.join(dlOut.dest_dir, "brief.md"), "utf8"), "# Brief\n");

      const bad = await runCli(["complete", "--artifact", path.join(root, "nope.md"), ID], env);
      assert.notEqual(bad.code, 0);
    });
  });
});

describe("MCP artifact tools", () => {
  it("list_grok_artifacts and download_grok_artifacts work over stdio", async () => {
    await withTemp(async (root) => {
      const resultsDir = path.join(root, "results");
      await seed(resultsDir);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        env: isolatedEnv({
          ...withoutGrokEnv(getDefaultEnvironment()),
          GROK_WEBHOOK_URL: "http://127.0.0.1:9/unused",
          GROK_WEBHOOK_KEY: "unused-key",
          GROK_RELAY_RESULTS_DIR: resultsDir,
        }) as Record<string, string>,
        stderr: "pipe",
      });
      const client = new Client({ name: "artifact-test", version: "1.0.0" });
      await client.connect(transport);
      try {
        const text = (r: unknown) =>
          (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("");
        const listed = JSON.parse(text(await client.callTool({ name: "list_grok_artifacts", arguments: { request_id: ID } })));
        assert.equal(listed.artifacts.length, 3);
        const dest = path.join(root, "dl");
        const dl = JSON.parse(
          text(await client.callTool({ name: "download_grok_artifacts", arguments: { request_id: ID, dest_dir: dest } })),
        );
        assert.equal(dl.files.length, 3);
        assert.equal(await readFile(path.join(dest, "problems.csv"), "utf8"), "id,status\nP1,open\n");
        const got = JSON.parse(text(await client.callTool({ name: "get_grok_result", arguments: { request_id: ID } })));
        assert.equal(got.artifacts.length, 3);
        assert.match(got.artifacts_hint, /download_grok_artifacts/);
      } finally {
        await client.close();
      }
    });
  });
});

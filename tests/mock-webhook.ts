import http from "node:http";
import { FileResultStore } from "../src/results.ts";
import type { ResultStatus } from "../src/types.ts";

export type MockWebhookOptions = {
  resultsDir: string;
  key: string;
  delayMs?: number;
  status?: number;
  answer?: string;
  resultStatus?: ResultStatus;
  writeResult?: boolean;
};

export type MockWebhook = {
  url: string;
  close: () => Promise<void>;
  calls: Array<{ authorization?: string; body: unknown; method?: string }>;
};

export async function startMockWebhook(options: MockWebhookOptions): Promise<MockWebhook> {
  const store = new FileResultStore(options.resultsDir);
  const calls: MockWebhook["calls"] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      calls.push({
        authorization: req.headers.authorization,
        body,
        method: req.method,
      });

      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }

      if (req.headers.authorization !== `Bearer ${options.key}`) {
        res.writeHead(401);
        res.end("unauthorized");
        return;
      }

      const status = options.status ?? 200;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(status === 200 ? JSON.stringify({ ok: true }) : JSON.stringify({ error: "fail" }));

      const shouldWrite = options.writeResult ?? status === 200;
      const rec = body as { request_id?: string; task?: string };
      if (shouldWrite && rec?.request_id) {
        const delay = options.delayMs ?? 80;
        setTimeout(() => {
          void store.writeAtomic({
            request_id: rec.request_id as string,
            status: options.resultStatus ?? "done",
            answer: options.answer ?? `echo:${rec.task ?? ""}`,
            finished_at: new Date().toISOString(),
          });
        }, delay);
      }
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("mock webhook failed to bind");
  }
  return {
    url: `http://127.0.0.1:${addr.port}/webhook`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

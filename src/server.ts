#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createArtifactStore,
  downloadArtifacts,
  withArtifacts,
} from "./artifacts.js";
import { loadConfig } from "./config.js";
import { RelayError } from "./errors.js";
import {
  askGrok,
  createRelay,
  DEFAULT_WAIT_SECONDS,
  getGrokResult,
  MAX_WAIT_SECONDS,
  submitGrokTask,
} from "./relay.js";

const server = new McpServer({
  name: "grok-bot-relay",
  version: "1.2.0",
});

function toolText(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

function toolError(err: unknown) {
  const message =
    err instanceof RelayError
      ? err.message
      : "An unexpected error occurred while talking to Grok Bot.";
  return toolText({ error: message }, true);
}

function deps() {
  return createRelay(process.env);
}

function artifactStore() {
  const config = loadConfig(process.env);
  return createArtifactStore({
    resultsDir: config.resultsDir,
    resultsUrl: config.resultsUrl,
    resultsToken: config.resultsToken,
    getResultsUrl: config.getResultsUrl,
    inboxDir: config.inboxDir,
  });
}

server.registerTool(
  "ask_grok",
  {
    title: "Ask Grok Bot",
    description:
      "Send a task to Grok Bot and wait for the answer. Returns the answer, or a request_id with status pending if it times out so you can collect it later with get_grok_result.",
    inputSchema: {
      task: z.string().min(1).describe("The task for Grok Bot to perform."),
      context: z
        .string()
        .optional()
        .describe("Optional extra context for the bot."),
      bot: z
        .string()
        .optional()
        .describe("Optional bot name to route the task to."),
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_SECONDS)
        .optional()
        .describe(
          `How long to wait for a result, in seconds. Default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}.`,
        ),
    },
  },
  async ({ task, context, bot, wait_seconds }) => {
    try {
      const outcome = await askGrok(
        { task, context, bot, waitSeconds: wait_seconds },
        deps(),
      );
      return toolText(await withArtifacts(outcome, artifactStore()));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "submit_grok_task",
  {
    title: "Submit Grok Bot task",
    description:
      "Fire-and-forget: start a Grok Bot task and return a request_id immediately. Use get_grok_result to collect the answer later.",
    inputSchema: {
      task: z.string().min(1).describe("The task for Grok Bot to perform."),
      context: z
        .string()
        .optional()
        .describe("Optional extra context for the bot."),
      bot: z
        .string()
        .optional()
        .describe("Optional bot name to route the task to."),
    },
  },
  async ({ task, context, bot }) => {
    try {
      const submitted = await submitGrokTask({ task, context, bot }, deps());
      return toolText(submitted);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "get_grok_result",
  {
    title: "Get Grok Bot result",
    description:
      "Look up a previously submitted task by request_id. Returns the result, or status pending if it is not ready yet. A finished result may include an `artifacts` array (detailed files such as Markdown reports, JSON, CSV or XLSX). The `answer` is only a summary: when artifacts are listed, call download_grok_artifacts and read the files for the full detail.",
    inputSchema: {
      request_id: z
        .string()
        .min(1)
        .describe("The request_id returned by ask_grok or submit_grok_task."),
    },
  },
  async ({ request_id }) => {
    try {
      const outcome = await getGrokResult(request_id, deps());
      return toolText(await withArtifacts(outcome, artifactStore()));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "list_grok_artifacts",
  {
    title: "List Grok Bot artifacts",
    description:
      "List the artifact files Grok Bot attached to a request (name, size in bytes, sha256, content type). Artifacts hold the full detail: reports, source lists, JSON, CSV, XLSX.",
    inputSchema: {
      request_id: z.string().min(1).describe("The request_id of the task."),
    },
  },
  async ({ request_id }) => {
    try {
      const artifacts = await artifactStore().list(request_id);
      return toolText({ request_id, artifacts });
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "download_grok_artifacts",
  {
    title: "Download Grok Bot artifacts",
    description:
      "Download a request's artifact files to a local folder (default ~/grok-relay-artifacts/<request_id>/), verifying each sha256. Returns the local paths so you can Read them. Optionally pass names to fetch only some files.",
    inputSchema: {
      request_id: z.string().min(1).describe("The request_id of the task."),
      dest_dir: z
        .string()
        .optional()
        .describe("Local folder to save into. Default ~/grok-relay-artifacts/<request_id>/."),
      names: z
        .array(z.string().min(1))
        .optional()
        .describe("Only download these artifact names. Default: all."),
    },
  },
  async ({ request_id, dest_dir, names }) => {
    try {
      const out = await downloadArtifacts(artifactStore(), request_id, {
        destDir: dest_dir,
        names,
      });
      return toolText(out);
    } catch (err) {
      return toolError(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(() => {
  // Do not print the underlying error: it may contain a URL or key.
  process.stderr.write("grok-bot-relay failed to start.\n");
  process.exit(1);
});

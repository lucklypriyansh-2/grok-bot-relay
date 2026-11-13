#!/usr/bin/env node
import {
  addArtifactFromFile,
  createArtifactStore,
  downloadArtifacts,
  listArtifactsOnDisk,
  withArtifacts,
} from "./artifacts.js";
import {
  DEFAULT_INBOX_BASENAME,
  defaultResultsDir,
  makeResultsUrlResolver,
  resolveOptionalDir,
} from "./config.js";
import { RelayError, redact } from "./errors.js";
import {
  askGrok,
  createRelay,
  DEFAULT_WAIT_SECONDS,
  getGrokResult,
  MAX_WAIT_SECONDS,
  submitGrokTask,
} from "./relay.js";
import { FileResultStore } from "./results.js";
import { RESULT_STATUSES, type ResultStatus } from "./types.js";

const USAGE = `Usage:
  grok-relay ask [--bot NAME] [--context TEXT] [--wait SECONDS] [--json] <task>
  grok-relay submit [--bot NAME] [--context TEXT] [--json] <task>
  grok-relay get [--wait SECONDS] [--json] <request_id>
  grok-relay complete [--status done|rejected|needs_approval] [--answer TEXT | --answer-file PATH]
                     [--artifact PATH]... [--json] <request_id>
  grok-relay artifacts [--json] <request_id>
  grok-relay download [--dest DIR] [--name NAME]... [--json] <request_id>

Artifacts are files in <results_dir>/<request_id>/ served at
GET /results/<id>/artifacts and /results/<id>/artifacts/<name>.
download saves them to ~/grok-relay-artifacts/<request_id>/ by default.

Environment:
  GROK_WEBHOOK_URL             Routine webhook URL (required for ask/submit)
  GROK_WEBHOOK_KEY             Routine webhook key (required for ask/submit)
  GROK_RELAY_RESULTS_DIR       Directory for result JSON files
  GROK_RELAY_TASKS_DIR         Directory for full task JSON files
  GROK_RELAY_RESULTS_URL       Optional HTTP base URL for results and task upload
  GROK_RELAY_RESULTS_URL_FILE  Optional file with the results origin (re-read on each request)
  GROK_RELAY_RESULTS_TOKEN     Bearer token for the HTTP result store
  GROK_RELAY_INBOX_DIR         Optional local inbox (set to "default" for ~/grok-relay-inbox)
  GROK_RELAY_OUTBOX_DIR        Optional local outbox (set to "default" for ~/grok-relay-outbox)
`;

type Flags = {
  cmd?: string;
  rest: string[];
  bot?: string;
  context?: string;
  wait?: number;
  json: boolean;
  status?: string;
  answer?: string;
  answerFile?: string;
  dest?: string;
  names: string[];
  artifactPaths: string[];
  help: boolean;
};

function parseArgs(argv: string[]): Flags {
  const args = argv.slice(2);
  const flags: Flags = { rest: [], json: false, help: false, names: [], artifactPaths: [] };
  if (args.length === 0) return flags;
  flags.cmd = args[0];
  if (flags.cmd === "-h" || flags.cmd === "--help" || flags.cmd === "help") {
    flags.help = true;
    return flags;
  }
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      const v = args[++i];
      if (v === undefined) throw new RelayError(`Missing value for ${a}.`, "invalid_args");
      return v;
    };
    if (a === "--json") flags.json = true;
    else if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "--bot") flags.bot = next();
    else if (a === "--context") flags.context = next();
    else if (a === "--wait") flags.wait = Number(next());
    else if (a === "--status") flags.status = next();
    else if (a === "--answer") flags.answer = next();
    else if (a === "--answer-file") flags.answerFile = next();
    else if (a === "--dest") flags.dest = next();
    else if (a === "--name") flags.names.push(next());
    else if (a === "--artifact") flags.artifactPaths.push(next());
    else if (a.startsWith("-")) {
      throw new RelayError(`Unknown option: ${a}`, "invalid_args");
    } else {
      flags.rest.push(a);
    }
  }
  return flags;
}

function secrets(): Array<string | undefined> {
  return [
    process.env.GROK_WEBHOOK_KEY,
    process.env.GROK_WEBHOOK_URL,
    process.env.GROK_RELAY_RESULTS_TOKEN,
    process.env.GROK_RELAY_RESULTS_URL,
  ];
}

function cliArtifactStore() {
  // Artifacts / download should work with only an inbox or results dir;
  // they must not require the webhook variables that ask/submit need.
  const resultsDir = process.env.GROK_RELAY_RESULTS_DIR?.trim() || defaultResultsDir();
  const resultsUrl = process.env.GROK_RELAY_RESULTS_URL?.trim().replace(/\/+$/, "") || undefined;
  const resultsToken = process.env.GROK_RELAY_RESULTS_TOKEN?.trim() || undefined;
  return createArtifactStore({
    resultsDir,
    resultsUrl,
    resultsToken,
    getResultsUrl: makeResultsUrlResolver(process.env),
    inboxDir: resolveOptionalDir(process.env.GROK_RELAY_INBOX_DIR, DEFAULT_INBOX_BASENAME),
  });
}

function printArtifactsHint(outcome: { artifacts?: { name: string; size?: number; path?: string }[]; artifacts_hint?: string }) {
  if (!outcome.artifacts || outcome.artifacts.length === 0) return;
  process.stdout.write("\nArtifacts:\n");
  for (const a of outcome.artifacts) {
    const extra = a.path
      ? `  ${a.path}`
      : a.size !== undefined
        ? ` (${a.size} bytes)`
        : "";
    process.stdout.write(`  ${a.name}${extra}\n`);
  }
  if (outcome.artifacts_hint) process.stdout.write(outcome.artifacts_hint + "\n");
}

function printJson(value: unknown) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

async function main() {
  let flags: Flags;
  try {
    flags = parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(redact((err as Error).message, secrets()) + "\n");
    process.exitCode = 1;
    return;
  }

  if (flags.help || !flags.cmd) {
    process.stdout.write(USAGE);
    process.exitCode = flags.help || !flags.cmd ? (flags.help ? 0 : 1) : 0;
    if (!flags.cmd && !flags.help) process.exitCode = 1;
    return;
  }

  try {
    if (flags.cmd === "ask") {
      const task = flags.rest.join(" ").trim();
      if (!task) throw new RelayError("ask requires a task.", "invalid_args");
      if (flags.wait !== undefined && (Number.isNaN(flags.wait) || flags.wait < 0)) {
        throw new RelayError("wait must be 0 or greater.", "invalid_args");
      }
      if (flags.wait !== undefined && flags.wait > MAX_WAIT_SECONDS) {
        throw new RelayError(
          `wait cannot exceed ${MAX_WAIT_SECONDS} seconds.`,
          "invalid_args",
        );
      }
      const outcome = await askGrok(
        {
          task,
          context: flags.context,
          bot: flags.bot,
          waitSeconds: flags.wait ?? DEFAULT_WAIT_SECONDS,
        },
        createRelay(),
      );
      if (flags.json) printJson(outcome);
      else if (outcome.status === "pending") {
        process.stdout.write(
          `${outcome.message}\nrequest_id: ${outcome.request_id}\nstatus: pending\n`,
        );
      } else {
        process.stdout.write(outcome.answer + "\n");
      }
      if (outcome.status === "pending") process.exitCode = 2;
      return;
    }

    if (flags.cmd === "submit") {
      const task = flags.rest.join(" ").trim();
      if (!task) throw new RelayError("submit requires a task.", "invalid_args");
      const submitted = await submitGrokTask(
        { task, context: flags.context, bot: flags.bot },
        createRelay(),
      );
      if (flags.json) printJson(submitted);
      else process.stdout.write(submitted.request_id + "\n");
      return;
    }

    if (flags.cmd === "get") {
      const requestId = flags.rest[0];
      if (!requestId) throw new RelayError("get requires a request_id.", "invalid_args");
      if (flags.wait !== undefined && (Number.isNaN(flags.wait) || flags.wait < 0)) {
        throw new RelayError("wait must be 0 or greater.", "invalid_args");
      }
      if (flags.wait !== undefined && flags.wait > MAX_WAIT_SECONDS) {
        throw new RelayError(
          `wait cannot exceed ${MAX_WAIT_SECONDS} seconds.`,
          "invalid_args",
        );
      }
      const outcome = await withArtifacts(
        await getGrokResult(requestId, createRelay(), flags.wait),
        cliArtifactStore(),
      );
      if (flags.json) printJson(outcome);
      else if (outcome.status === "pending") {
        process.stdout.write(
          `${outcome.message}\nrequest_id: ${outcome.request_id}\nstatus: pending\n`,
        );
      } else {
        process.stdout.write(outcome.answer + "\n");
        printArtifactsHint(outcome);
      }
      if (outcome.status === "pending") process.exitCode = 2;
      return;
    }

    if (flags.cmd === "complete") {
      const requestId = flags.rest[0];
      if (!requestId) throw new RelayError("complete requires a request_id.", "invalid_args");
      const status = (flags.status ?? "done") as ResultStatus;
      if (!RESULT_STATUSES.includes(status)) {
        throw new RelayError(
          'status must be "done", "rejected", or "needs_approval".',
          "invalid_args",
        );
      }
      if (flags.answer !== undefined && flags.answerFile !== undefined) {
        throw new RelayError("Use --answer or --answer-file, not both.", "invalid_args");
      }
      const dir = process.env.GROK_RELAY_RESULTS_DIR?.trim() || defaultResultsDir();
      const store = new FileResultStore(dir);
      const { promises: fsp } = await import("node:fs");
      const answer =
        flags.answerFile !== undefined
          ? await fsp.readFile(flags.answerFile, "utf8")
          : (flags.answer ?? "");
      // Artifacts first, result JSON last, so a visible result always has its files.
      for (const src of flags.artifactPaths) {
        await addArtifactFromFile(dir, requestId, src);
      }
      const local = await listArtifactsOnDisk(dir, requestId);
      const result = {
        request_id: requestId,
        status,
        answer,
        finished_at: new Date().toISOString(),
        ...(local.length > 0 ? { artifacts: local } : {}),
      };
      await store.writeAtomic(result);
      if (flags.json) printJson(result);
      else process.stdout.write(`Wrote result for ${requestId} (${status}).\n`);
      return;
    }

    if (flags.cmd === "artifacts") {
      const requestId = flags.rest[0];
      if (!requestId) throw new RelayError("artifacts requires a request_id.", "invalid_args");
      const artifacts = await cliArtifactStore().list(requestId);
      if (flags.json) printJson({ request_id: requestId, artifacts });
      else if (artifacts.length === 0) process.stdout.write("No artifacts.\n");
      else {
        for (const a of artifacts) {
          process.stdout.write(`${a.name}\t${a.size ?? "?"}\t${a.sha256 ?? ""}\n`);
        }
      }
      return;
    }

    if (flags.cmd === "download") {
      const requestId = flags.rest[0];
      if (!requestId) throw new RelayError("download requires a request_id.", "invalid_args");
      const out = await downloadArtifacts(cliArtifactStore(), requestId, {
        destDir: flags.dest,
        names: flags.names,
      });
      if (flags.json) printJson(out);
      else {
        if (out.files.length === 0) process.stdout.write("No artifacts.\n");
        for (const f of out.files) process.stdout.write(`${f.path}\t${f.size}\n`);
      }
      return;
    }

    throw new RelayError(`Unknown command: ${flags.cmd}`, "invalid_args");
  } catch (err) {
    const message =
      err instanceof RelayError
        ? err.message
        : "An unexpected error occurred while talking to Grok Bot.";
    process.stderr.write(redact(message, secrets()) + "\n");
    process.exitCode = 1;
  }
}

main();

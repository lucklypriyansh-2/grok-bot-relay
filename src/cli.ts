#!/usr/bin/env node
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
  grok-relay complete [--status done|rejected|needs_approval] [--answer TEXT] [--json] <request_id>

Environment:
  GROK_WEBHOOK_URL             Routine webhook URL (required for ask/submit)
  GROK_WEBHOOK_KEY             Routine webhook key (required for ask/submit)
  GROK_RELAY_RESULTS_DIR       Directory for result JSON files
  GROK_RELAY_RESULTS_URL       Optional HTTP result store base URL
  GROK_RELAY_RESULTS_TOKEN     Bearer token for the HTTP result store
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
  help: boolean;
};

function parseArgs(argv: string[]): Flags {
  const args = argv.slice(2);
  const flags: Flags = { rest: [], json: false, help: false };
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
      const outcome = await getGrokResult(requestId, createRelay(), flags.wait);
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
      const { defaultResultsDir } = await import("./config.js");
      const dir = process.env.GROK_RELAY_RESULTS_DIR?.trim() || defaultResultsDir();
      const store = new FileResultStore(dir);
      const result = {
        request_id: requestId,
        status,
        answer: flags.answer ?? "",
        finished_at: new Date().toISOString(),
      };
      await store.writeAtomic(result);
      if (flags.json) printJson(result);
      else process.stdout.write(`Wrote result for ${requestId} (${status}).\n`);
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

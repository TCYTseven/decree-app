import readline from "node:readline";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import type { LLMUsage } from "../core/types.js";
import { loadSpec } from "../core/config.js";
import { runAgent } from "../runtime/index.js";
import { MissingApiKeyError } from "../llm/client.js";
import { banner } from "../ui/banner.js";
import { CliError, explainError } from "../ui/errors.js";
import { addUsage, emptyUsage, formatUsage, formatUsd, plural } from "../ui/format.js";
import { isTTY, log } from "../ui/logger.js";
import { c, sym } from "../ui/theme.js";
import { rootFor } from "./context.js";
import { findApiKey, toolsTable } from "./pipeline.js";
import { createApprover, StreamPrinter } from "./agent-ui.js";

export interface ChatCmdOptions {
  model?: string;
  apiKey?: string;
  dryRunTools?: boolean;
}

class ExitChat extends Error {}

/** Ask for one line. A fresh readline per question keeps stdin free for approval prompts. */
function readLine(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let done = false;
    rl.on("SIGINT", () => {
      done = true;
      rl.close();
      process.stdout.write("\n");
      reject(new ExitChat());
    });
    rl.on("close", () => {
      if (!done) {
        process.stdout.write("\n");
        reject(new ExitChat()); // Ctrl+D
      }
    });
    rl.question(promptText, (answer) => {
      done = true;
      rl.close();
      resolve(answer);
    });
  });
}

const HELP = [
  `${c.cyan("/tools")}  list the agent's tools`,
  `${c.cyan("/cost")}   token usage and spend so far`,
  `${c.cyan("/reset")}  forget the conversation`,
  `${c.cyan("/exit")}   quit ${c.dim("(or Ctrl+D)")}`,
  c.dim("Ctrl+C stops the current reply; press it again to quit."),
].join("\n");

export async function chatCommand(opts: ChatCmdOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  if (!isTTY()) {
    throw new CliError("chat needs an interactive terminal", { hint: `For scripts use: decree-harness run "your prompt" [--json]` });
  }
  const { spec, warnings } = await loadSpec(root);
  const { key } = await findApiKey(root, opts.apiKey);
  if (!key) throw new MissingApiKeyError();

  p.intro(banner("chat"));
  for (const w of warnings) log.warn(w);
  const model = opts.model ?? spec.model.id;
  log.info(
    `${c.bold(spec.displayName)} ${c.dim(`${sym.dot} ${model} ${sym.dot} ${plural(spec.tools.length, "tool")}${spec.subagents.length ? ` ${sym.dot} ${plural(spec.subagents.length, "subagent")}` : ""}${opts.dryRunTools ? ` ${sym.dot} tools in dry-run mode` : ""}`)}`,
  );
  log.message(c.dim(`Type a message, or /help. ${spec.goal ? `Goal: ${spec.goal}` : ""}`));

  const printer = new StreamPrinter();
  const approve = createApprover(printer);
  let history: unknown[] = [];
  let usage: LLMUsage = emptyUsage();
  let cost = 0;
  let turns = 0;
  let current: AbortController | undefined;

  const onSigint = () => {
    if (!current) {
      printer.line(c.dim("Bye."));
      process.exit(0);
    }
    if (current.signal.aborted) {
      printer.line(c.dim("Bye."));
      process.exit(130);
    }
    current.abort();
    printer.line(c.dim("(stopped, press Ctrl+C again to quit)"));
  };
  process.on("SIGINT", onSigint);

  try {
    for (;;) {
      let input: string;
      try {
        input = (await readLine(`${c.cyan(c.bold(sym.arrow))} `)).trim();
      } catch (err) {
        if (err instanceof ExitChat) break;
        throw err;
      }
      if (!input) continue;
      if (input.startsWith("/")) {
        const [command] = input.slice(1).split(/\s+/);
        if (command === "exit" || command === "quit" || command === "q") break;
        if (command === "reset" || command === "clear") {
          history = [];
          printer.line(c.dim("Conversation reset."));
        } else if (command === "cost") {
          printer.line(`${c.dim("Usage")} ${formatUsage(usage)} ${c.dim(sym.dot)} ${c.bold(formatUsd(cost))} ${c.dim(`over ${plural(turns, "reply", "replies")}`)}`);
        } else if (command === "tools") {
          printer.line(toolsTable(spec));
        } else if (command === "help" || command === "?") {
          printer.line(HELP);
        } else {
          printer.line(c.yellow(`Unknown command /${command}. Try /help.`));
        }
        continue;
      }

      current = new AbortController();
      const stops: string[] = [];
      printer.resetTurn();
      printer.write("\n");
      try {
        const result = await runAgent(spec, {
          projectRoot: root,
          prompt: input,
          history,
          apiKey: key,
          model: opts.model,
          dryRun: opts.dryRunTools,
          signal: current.signal,
          approve,
          onEvent: (e) => {
            if (e.type === "error") stops.push(e.message);
            printer.onEvent(e);
          },
        });
        usage = addUsage(usage, result.usage);
        cost += result.costUsd;
        if (current.signal.aborted) {
          printer.line(c.dim("(reply stopped; the conversation keeps its previous state)"));
          continue;
        }
        for (const m of stops) printer.line(c.yellow(`${sym.warn} ${m}`));
        history = result.messages;
        turns++;
        printer.newline();
        printer.line(c.dim(`${turnStats(result)}${formatUsd(result.costUsd)} ${sym.dot} ${formatUsd(cost)} total`));
      } catch (err) {
        if (current.signal.aborted) {
          printer.line(c.dim("(reply stopped; the conversation keeps its previous state)"));
        } else {
          const e = explainError(err);
          printer.line(`${c.red(sym.fail)} ${c.red(e.message)}${e.hint ? c.dim(`  hint: ${e.hint}`) : ""}`);
          const status = (err as { status?: number }).status;
          if (status === 401 || /not\s+implemented/i.test(e.message)) break; // retrying won't help
        }
      } finally {
        current = undefined;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
  p.outro(`${formatUsd(cost)} spent ${c.dim(`${sym.dot} ${formatUsage(usage)}`)}`);
}

function turnStats(r: { turns: number; toolCalls: unknown[] }): string {
  const parts = [plural(r.turns, "turn")];
  if (r.toolCalls.length) parts.push(plural(r.toolCalls.length, "tool call"));
  return `${parts.join(` ${sym.dot} `)} ${sym.dot} `;
}

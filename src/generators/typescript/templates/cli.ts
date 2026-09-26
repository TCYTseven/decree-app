import type { TsModel } from "../model.js";
import { oneLine, templateBody } from "../render.js";

export function cliTs(m: TsModel): string {
  return `/**
 * Command line entry point.
 *
 *   npm start -- "your request"   one-shot run
 *   echo "your request" | npm start
 *   npm start                     interactive chat (/exit, /reset, /cost, /help)
 */
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./agent.js";
import { describeError } from "./client.js";
import { AGENT_NAME, MODEL, PROJECT_ROOT } from "./config.js";
import type { AgentEvent, Approver } from "./types.js";

const HELP = \`\${AGENT_NAME}
${templateBody(oneLine(m.spec.description))}

Usage:
  npm start -- "<request>"    run once and exit
  npm start                   interactive chat

Options:
  -y, --yes     approve every tool call without asking (use with care)
  -h, --help    show this help

Chat commands: /exit, /reset (clear the conversation), /cost, /help

Model: \${MODEL.id} (effort \${MODEL.effort}). Project root: \${PROJECT_ROOT}\`;

const tty = process.stderr.isTTY;
const dim = (s: string) => (tty ? \`\\x1b[2m\${s}\\x1b[22m\` : s);
const red = (s: string) => (tty ? \`\\x1b[31m\${s}\\x1b[39m\` : s);
const yellow = (s: string) => (tty ? \`\\x1b[33m\${s}\\x1b[39m\` : s);

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { yes: { type: "boolean", short: "y" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const yes = values.yes ?? false;
  const prompt = positionals.join(" ").trim();
  if (prompt) await oneShot(prompt, yes);
  else if (!process.stdin.isTTY) await oneShot(await readStdin(), yes); // echo "..." | npm start
  else await chat(yes);
}

async function oneShot(prompt: string, yes: boolean): Promise<void> {
  // Approvals need a terminal; without one (CI, pipes) tools needing approval are declined.
  const rl = process.stdin.isTTY && !yes ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  try {
    const result = await runAgent({ prompt, approve: approver(rl, yes), onEvent: render });
    process.stdout.write("\\n");
    console.error(dim(summary(result.turns, result.costUsd, result.stopReason)));
    if (result.stopReason !== "end_turn") process.exitCode = 1;
  } finally {
    rl?.close();
  }
}

async function chat(yes: boolean): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let history: Anthropic.Beta.BetaMessageParam[] = [];
  let totalCost = 0;
  let running: AbortController | undefined;
  // Ctrl-C interrupts the current run; at the prompt it exits.
  rl.on("SIGINT", () => (running ? running.abort() : rl.close()));
  rl.on("close", () => process.exit(0));

  console.log(\`\${AGENT_NAME} \${dim(\`(\${MODEL.id}) - /help for commands, /exit to quit\`)}\`);
  while (true) {
    const line = (await rl.question("\\n> ")).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") {
      console.log(HELP);
      continue;
    }
    if (line === "/reset") {
      history = [];
      console.log(dim("Conversation cleared."));
      continue;
    }
    if (line === "/cost") {
      console.log(dim(\`Estimated spend this session: $\${totalCost.toFixed(4)}\`));
      continue;
    }

    running = new AbortController();
    try {
      const result = await runAgent({
        prompt: line,
        history,
        approve: approver(rl, yes, running.signal),
        onEvent: render,
        signal: running.signal,
      });
      history = result.messages;
      totalCost += result.costUsd;
      process.stdout.write("\\n");
      console.error(dim(summary(result.turns, result.costUsd, result.stopReason)));
    } catch (err) {
      // The failed turn is dropped; the conversation continues from the previous state.
      console.error(red(describeError(err)));
    } finally {
      running = undefined;
    }
  }
  rl.close();
}

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) throw new Error("No request given. Pass one as an argument or on stdin (see --help).");
  return text.trim();
}

function approver(rl: Interface | undefined, yes: boolean, signal?: AbortSignal): Approver {
  return async ({ name, input }) => {
    if (yes) return true;
    if (!rl) {
      console.error(yellow(\`Declined \${name}: approval needed but no terminal (use --yes to allow).\`));
      return false;
    }
    const answer = await rl.question(yellow(\`\\nAllow \${name} \${preview(input, 400)}? [y/N] \`), { signal });
    return /^y(es)?$/i.test(answer.trim());
  };
}

let midLine = false;

function render(event: AgentEvent): void {
  const who = event.agent ? \`[\${event.agent}] \` : "";
  switch (event.type) {
    case "text":
      process.stdout.write(event.text);
      midLine = !event.text.endsWith("\\n");
      break;
    case "tool_call":
      log(dim(\`\${who}→ \${event.name} \${preview(event.input, 200)}\`));
      break;
    case "tool_result": {
      const mark = event.isError ? red("✗") : "✓";
      log(dim(\`\${who}\`) + mark + dim(\` \${event.name} (\${event.ms}ms) \${preview(event.output, 120)}\`));
      break;
    }
    case "approval_denied":
      log(yellow(\`\${who}declined \${event.name}\`));
      break;
    case "notice":
      log(yellow(\`\${who}\${event.message}\`));
      break;
  }
}

/** Write a status line to stderr, starting a new line if text was mid-stream. */
function log(line: string): void {
  if (midLine) process.stdout.write("\\n");
  midLine = false;
  console.error(line);
}

function preview(value: unknown, max: number): string {
  const text = (typeof value === "string" ? value : JSON.stringify(value) ?? "").replace(/\\s+/g, " ");
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function summary(turns: number, cost: number, stopReason: string | null): string {
  return \`[\${turns} turn\${turns === 1 ? "" : "s"}, ~$\${cost.toFixed(4)}, stop: \${stopReason}]\`;
}

main().catch((err) => {
  console.error(red(describeError(err)));
  process.exit(1);
});
`;
}

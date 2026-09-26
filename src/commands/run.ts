import type { Command } from "commander";
import type { RunResult, RuntimeEvent } from "../core/types.js";
import { loadSpec } from "../core/config.js";
import { runAgent } from "../runtime/index.js";
import { MissingApiKeyError } from "../llm/client.js";
import { CliError } from "../ui/errors.js";
import { formatTokens, formatUsage, formatUsd, plural, totalTokens } from "../ui/format.js";
import { isTTY, log } from "../ui/logger.js";
import { c, sym, termWidth } from "../ui/theme.js";
import { rootFor } from "./context.js";
import { findApiKey } from "./pipeline.js";
import { createApprover, StreamPrinter } from "./agent-ui.js";

export interface RunCmdOptions {
  json?: boolean;
  yes?: boolean;
  model?: string;
  apiKey?: string;
  dryRunTools?: boolean;
}

export async function runCommand(promptParts: string[], opts: RunCmdOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  let prompt = promptParts.join(" ").trim();
  if (!prompt && !process.stdin.isTTY) {
    // allow `echo "question" | decree-harness run`
    const chunks: Buffer[] = [];
    for await (const ch of process.stdin) chunks.push(ch as Buffer);
    prompt = Buffer.concat(chunks).toString("utf8").trim();
  }
  if (!prompt) throw new CliError("No prompt given", { hint: `e.g. decree-harness run "how many pending orders are there?"` });

  const { spec, warnings } = await loadSpec(root);
  for (const w of warnings) log.debug(`spec warning: ${w}`);
  const { key } = await findApiKey(root, undefined);
  const apiKey = opts.apiKey ?? key;
  if (!apiKey) throw new MissingApiKeyError();

  const printer = new StreamPrinter(opts.json ? process.stderr : process.stdout);
  if (opts.yes) {
    process.stderr.write(c.yellow(`${sym.warn} --yes: every tool call is auto-approved, including destructive ones.\n`));
  }
  const approver = opts.yes ? async () => true : isTTY() && !opts.json ? createApprover(printer) : undefined;
  const errors: string[] = [];
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
    process.stderr.write(c.dim("\n(aborting… press Ctrl+C again to force quit)\n"));
  };
  process.on("SIGINT", onSigint);
  let result: RunResult;
  if (!opts.json) printer.startWait("thinking");
  try {
    result = await runAgent(spec, {
      projectRoot: root,
      prompt,
      apiKey,
      model: opts.model,
      dryRun: opts.dryRunTools,
      signal: controller.signal,
      approve:
        approver ??
        (async ({ name }) => {
          process.stderr.write(c.yellow(`${sym.warn} ${name} needs approval but no terminal is attached; declined (use --yes to allow).\n`));
          return false;
        }),
      onEvent: (e: RuntimeEvent) => {
        if (e.type === "error") errors.push(e.message);
        if (opts.json) {
          if (e.type !== "text" && e.type !== "thinking") printer.onEvent(e);
        } else printer.onEvent(e);
      },
    });
  } finally {
    printer.stopWait();
    process.off("SIGINT", onSigint);
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printer.newline();
    // Full token breakdown when it fits on one line, else a compact total.
    const head = [plural(result.turns, "turn"), plural(result.toolCalls.length, "tool call")];
    const full = [...head, formatUsage(result.usage), formatUsd(result.costUsd)].join(` ${sym.dot} `);
    const short = [...head, `${formatTokens(totalTokens(result.usage))} tokens`, formatUsd(result.costUsd)].join(` ${sym.dot} `);
    process.stderr.write(c.dim(`\n${full.length < termWidth(process.stderr) ? full : short}\n`));
  }
  if (controller.signal.aborted) throw new CliError("Run aborted.", { exitCode: 130 });
  if (errors.length || result.stopReason === "refusal") {
    throw new CliError(errors[0] ?? "The model refused this request", { exitCode: 1, details: errors.slice(1) });
  }
}

import type { Command } from "commander";
import { loadSpec } from "../core/config.js";
import { groupWarnings, plural } from "../ui/format.js";
import { log } from "../ui/logger.js";
import { c, sym, termWidth, wrapText } from "../ui/theme.js";
import { rootFor } from "./context.js";
import { approvalModeText, toolsTable } from "./pipeline.js";

export async function toolsCommand(opts: { json?: boolean }, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  const { spec, warnings } = await loadSpec(root);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(spec.tools, null, 2)}\n`);
    return;
  }
  const width = termWidth();
  for (const w of groupWarnings(warnings)) log.warn(w);
  const out = [
    wrapText(
      `${c.bold(spec.displayName)} ${c.dim(`${sym.dot} ${plural(spec.tools.length, "tool")} ${sym.dot} ${approvalModeText(spec.guardrails.approvalMode, spec.tools.filter((t) => t.requiresApproval || t.destructive).length)}`)}`,
      width,
    ),
    toolsTable(spec, { source: true, width }),
  ];
  if (spec.subagents.length) {
    out.push("", c.bold("Subagents"));
    for (const s of spec.subagents) {
      out.push(wrapText(`  ${c.cyan(s.name)} ${c.dim(sym.arrow)} ${s.tools.join(", ")}`, width, "    "));
    }
  }
  log.raw(out.join("\n"));
}

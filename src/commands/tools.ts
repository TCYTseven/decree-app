import type { Command } from "commander";
import { loadSpec } from "../core/config.js";
import { log } from "../ui/logger.js";
import { renderTable } from "../ui/table.js";
import { c, sym } from "../ui/theme.js";
import { plural } from "../ui/format.js";
import { rootFor } from "./context.js";
import { safetyBadge, toolTarget } from "./pipeline.js";

export async function toolsCommand(opts: { json?: boolean }, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  const { spec } = await loadSpec(root);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(spec.tools, null, 2)}\n`);
    return;
  }
  const rows = spec.tools.map((t) => {
    const flags = [safetyBadge(t)];
    if (t.destructive) flags.push(c.red("destructive"));
    return [c.bold(t.name), c.dim(t.kind), flags.join(" "), c.dim(toolTarget(t)), c.dim(t.source ?? "")];
  });
  const out = [
    `${c.bold(spec.displayName)} ${c.dim(`${sym.dot} ${plural(spec.tools.length, "tool")} ${sym.dot} approval mode: ${spec.guardrails.approvalMode}`)}`,
    renderTable(
      [
        { header: "Tool", min: 10 },
        { header: "Kind", min: 4 },
        { header: "Flags", min: 10 },
        { header: "Binds to", min: 8, max: 32 },
        { header: "Source", min: 6, max: 28 },
      ],
      rows,
    ),
  ];
  if (spec.subagents.length) {
    out.push("", c.bold("Subagents"));
    for (const s of spec.subagents) out.push(`  ${c.cyan(s.name)} ${c.dim(sym.arrow)} ${s.tools.join(", ")}`);
  }
  log.raw(out.join("\n"));
}

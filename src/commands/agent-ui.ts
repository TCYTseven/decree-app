import * as p from "@clack/prompts";
import type { RuntimeEvent, ToolSpec } from "../core/types.js";
import { compactJson, formatDuration } from "../ui/format.js";
import { uiState } from "../ui/logger.js";
import { c, sym } from "../ui/theme.js";

/** Tracks whether stdout is mid-line so status lines always start on a fresh line. */
export class StreamPrinter {
  private midLine = false;
  private thinkingShown = false;

  constructor(private out: NodeJS.WriteStream = process.stdout) {}

  write(s: string): void {
    if (!s) return;
    this.out.write(s);
    this.midLine = !s.endsWith("\n");
  }

  newline(): void {
    if (this.midLine) this.write("\n");
  }

  line(s: string): void {
    this.newline();
    this.write(`${s}\n`);
  }

  resetTurn(): void {
    this.thinkingShown = false;
  }

  /** Render one runtime event. Returns nothing; errors are reported inline. */
  onEvent(e: RuntimeEvent): void {
    switch (e.type) {
      case "text":
        this.write(e.text);
        break;
      case "thinking":
        if (uiState.verbose) this.write(c.dim(e.text));
        else if (!this.thinkingShown) this.line(c.dim(`${c.magenta("✻")} thinking…`));
        this.thinkingShown = true;
        break;
      case "tool_call": {
        const args = compactJson(e.input, Math.max(20, (process.stdout.columns ?? 100) - e.name.length - 10));
        this.line(c.dim(`  ${sym.gear} ${e.name}${args ? ` ${args}` : ""}`));
        break;
      }
      case "tool_result": {
        const mark = e.isError ? c.red(sym.fail) : c.green(sym.ok);
        const lines = e.output.split("\n").length;
        const first = e.isError ? ` ${c.red(e.output.split("\n")[0].slice(0, 100))}` : "";
        this.line(`  ${mark} ${c.dim(`${e.name} ${sym.dot} ${formatDuration(e.ms)} ${sym.dot} ${lines} line${lines === 1 ? "" : "s"}`)}${first}`);
        break;
      }
      case "approval_denied":
        this.line(c.yellow(`  ${sym.fail} ${e.name} declined`));
        break;
      case "turn_end":
        this.thinkingShown = false;
        break;
      case "error":
        // Collected by the caller: fatal errors are thrown by runAgent and
        // reported once by the error handler; non-fatal stops are shown after the turn.
        break;
      case "done":
        this.newline();
        break;
    }
  }
}

/** Interactive approval prompt: tool name, why it needs approval, pretty JSON input. */
export function createApprover(printer: StreamPrinter) {
  const always = new Set<string>();
  return async (call: { name: string; input: unknown; tool: ToolSpec }): Promise<boolean> => {
    if (always.has(call.name)) return true;
    printer.newline();
    const flags = [call.tool.kind, call.tool.destructive ? c.red("destructive") : "", call.tool.readOnly ? "read-only" : "writes"].filter(Boolean);
    let json: string;
    try {
      json = JSON.stringify(call.input, null, 2);
    } catch {
      json = String(call.input);
    }
    p.log.warn(`${c.bold(call.name)} ${c.dim(`(${flags.join(", ")})`)} needs your approval\n${c.dim(json)}`);
    const choice = await p.select<"yes" | "always" | "no">({
      message: `Allow ${c.bold(call.name)}?`,
      options: [
        { value: "yes", label: "Yes, once" },
        { value: "always", label: `Yes, and don't ask again for ${call.name} this session` },
        { value: "no", label: "No", hint: "the agent will be told you declined" },
      ],
      initialValue: "no",
    });
    if (p.isCancel(choice) || choice === "no") return false;
    if (choice === "always") always.add(call.name);
    return true;
  };
}

import * as p from "@clack/prompts";
import type { RuntimeEvent, ToolSpec } from "../core/types.js";
import { compactJson, formatDuration } from "../ui/format.js";
import { uiState } from "../ui/logger.js";
import { c, sym, termWidth, truncate, visibleWidth } from "../ui/theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Prints a streaming agent run. Tracks whether output is mid-line so status lines
 * always start on a fresh line, word-wraps streamed text on a terminal, and shows
 * a small live indicator while waiting on the model or a tool.
 */
export class StreamPrinter {
  private midLine = false;
  private col = 0;
  private word = "";
  private readonly tty: boolean;
  private waitTimer?: NodeJS.Timeout;
  private waitShown = false;
  private declined = new Set<string>();

  constructor(private out: NodeJS.WriteStream = process.stdout) {
    this.tty = Boolean(out.isTTY);
  }

  private width(): number {
    return termWidth(this.out) - 1;
  }

  /** Raw write (no wrapping). */
  write(s: string): void {
    if (!s) return;
    this.stopWait();
    this.out.write(s);
    const nl = s.lastIndexOf("\n");
    this.col = nl >= 0 ? visibleWidth(s.slice(nl + 1)) : this.col + visibleWidth(s);
    this.midLine = !s.endsWith("\n");
  }

  private flushWord(): void {
    if (!this.word) return;
    const w = visibleWidth(this.word);
    if (this.col > 0 && this.col + w > this.width()) this.write("\n");
    this.write(this.word);
    this.word = "";
  }

  /** Streamed assistant text: word-wrapped to the terminal on a TTY, passed through when piped. */
  text(s: string): void {
    if (!this.tty) return this.write(s);
    for (const ch of s) {
      if (ch === "\n") {
        this.flushWord();
        this.write("\n");
      } else if (ch === " ") {
        this.flushWord();
        if (this.col >= this.width()) this.write("\n");
        else if (this.col > 0) this.write(" ");
      } else {
        this.word += ch;
        if (visibleWidth(this.word) >= this.width()) this.flushWord();
      }
    }
    // Keep a partial word only until the next delta; show complete words right away.
    if (this.word && /[.,;:!?)]$/.test(this.word)) this.flushWord();
  }

  newline(): void {
    this.flushWord();
    this.stopWait();
    if (this.midLine) this.write("\n");
  }

  line(s: string): void {
    this.newline();
    this.write(`${s}\n`);
  }

  /** Show `⠋ label 3s` on its own line until the next output. TTY only. */
  startWait(label: string): void {
    if (!this.tty || uiState.quiet) return;
    this.flushWord();
    this.stopWait();
    if (this.midLine) {
      this.out.write("\n");
      this.midLine = false;
      this.col = 0;
    }
    const started = Date.now();
    let i = 0;
    const draw = () => {
      const secs = Math.floor((Date.now() - started) / 1000);
      this.out.write(`\r\u001b[2K${c.magenta(FRAMES[i++ % FRAMES.length])} ${c.dim(`${label}${secs >= 2 ? ` ${secs}s` : ""}`)}`);
      this.waitShown = true;
    };
    this.waitTimer = setInterval(draw, 80);
    this.waitTimer.unref?.();
  }

  stopWait(): void {
    if (this.waitTimer) clearInterval(this.waitTimer);
    this.waitTimer = undefined;
    if (this.waitShown) this.out.write("\r\u001b[2K");
    this.waitShown = false;
  }

  resetTurn(): void {
    this.declined.clear();
  }

  /** Render one runtime event. Returns nothing; errors are reported inline. */
  onEvent(e: RuntimeEvent): void {
    switch (e.type) {
      case "text":
        this.text(e.text);
        break;
      case "thinking":
        if (uiState.verbose) this.write(c.dim(e.text));
        else if (!this.waitTimer) this.startWait("thinking");
        break;
      case "tool_call": {
        const args = compactJson(e.input, Math.max(20, this.width() - e.name.length - 6));
        this.line(c.dim(`  ${sym.gear} ${e.name}${args ? ` ${args}` : ""}`));
        this.startWait(`running ${e.name}`);
        break;
      }
      case "tool_result": {
        if (this.declined.delete(e.id)) {
          this.startWait("thinking");
          break; // already reported as declined
        }
        const lines = e.output.split("\n").length;
        const head = `  ${e.isError ? c.red(sym.fail) : c.green(sym.ok)} ${e.name} ${c.dim(formatDuration(e.ms))}`;
        const rest = e.isError
          ? ` ${c.red(truncate(e.output.split("\n")[0], Math.max(10, this.width() - visibleWidth(head) - 1)))}`
          : c.dim(` ${sym.dot} ${lines} line${lines === 1 ? "" : "s"}`);
        this.line(head + rest);
        this.startWait("thinking");
        break;
      }
      case "approval_denied":
        this.declined.add(e.id);
        this.line(c.yellow(`  ${sym.fail} ${e.name} declined`));
        break;
      case "turn_end":
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
    const flags = [call.tool.kind, call.tool.destructive ? c.red("destructive") : call.tool.readOnly ? "read-only" : "writes"];
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

/**
 * Markdown rendering helpers shared by every generator. Pure functions, no I/O.
 */

/** Escape a value for use inside a GFM table cell: pipes, newlines, and backslashes before pipes. */
export function escapeTableCell(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/\\\|/g, "\\\\|") // keep an existing "\|" from turning into an escaped pipe + stray char
    .replace(/\|/g, "\\|")
    .replace(/\n+/g, "<br>")
    .trim();
}

/** Render a GFM table. Every cell is escaped with `escapeTableCell`. Cells already wrapped by `inlineCode` stay valid. */
export function renderTable(headers: string[], rows: unknown[][]): string {
  const head = `| ${headers.map(escapeTableCell).join(" | ")} |`;
  const sep = `|${headers.map(() => "---").join("|")}|`;
  const body = rows.map((r) => `| ${headers.map((_, i) => escapeTableCell(r[i])).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

function longestRun(s: string, ch: string): number {
  let max = 0;
  let cur = 0;
  for (const c of s) {
    if (c === ch) {
      cur++;
      if (cur > max) max = cur;
    } else cur = 0;
  }
  return max;
}

/**
 * Inline code span that survives backticks in the content (uses a longer
 * delimiter run, padding with spaces when the content starts/ends with a backtick).
 * Newlines are collapsed to spaces (code spans cannot hold them anyway).
 */
export function inlineCode(value: string): string {
  const s = value.replace(/\r?\n/g, " ");
  if (s === "") return "` `";
  const fence = "`".repeat(longestRun(s, "`") + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

/** Fenced code block whose fence is longer than any backtick run inside `content`. */
export function codeBlock(content: string, lang = ""): string {
  const fence = "`".repeat(Math.max(3, longestRun(content, "`") + 1));
  const body = content.endsWith("\n") ? content : `${content}\n`;
  return `${fence}${lang}\n${body}${fence}`;
}

/**
 * Shift ATX headings (`#`, `##`, ...) down by `levels`, capped at h6. Lines
 * inside fenced code blocks are left untouched.
 */
export function demoteHeadings(markdown: string, levels: number): string {
  let fence: string | null = null;
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (f) {
        const marker = f[1]!;
        if (fence === null) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return line;
      }
      if (fence !== null) return line;
      const h = /^(\s{0,3})(#{1,6})(\s|$)/.exec(line);
      if (!h) return line;
      const n = Math.min(6, h[2]!.length + levels);
      return `${h[1]}${"#".repeat(n)}${line.slice(h[1]!.length + h[2]!.length)}`;
    })
    .join("\n");
}

/** Collapse a possibly multi-line string to one line (for list items and summaries). */
export function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").trim();
}

/** Prefix every line with "> " to make a blockquote. */
export function blockquote(value: string): string {
  return value
    .split(/\r?\n/)
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

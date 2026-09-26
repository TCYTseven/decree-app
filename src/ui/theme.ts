import pc from "picocolors";

export type Colors = ReturnType<typeof pc.createColors>;

/** Whether colors should be on, given argv/env. Respects NO_COLOR, FORCE_COLOR and --no-color. */
export function detectColor(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  if (argv.includes("--no-color") || "NO_COLOR" in env) return false;
  if (argv.includes("--color") || ("FORCE_COLOR" in env && env.FORCE_COLOR !== "0")) return true;
  return pc.isColorSupported;
}

/** Shared color helpers. Mutable so `--no-color` can switch them off after parsing. */
export const c: Colors = { ...pc.createColors(detectColor()) };

let colorEnabled = c.isColorSupported;

export function setColorEnabled(on: boolean): void {
  colorEnabled = on;
  Object.assign(c, pc.createColors(on));
  if (!on) process.env.NO_COLOR = "1"; // so @clack/prompts (its own picocolors) follows along
}

export function isColorEnabled(): boolean {
  return colorEnabled;
}

const unicode = process.platform !== "win32" || Boolean(process.env.WT_SESSION) || process.env.TERM_PROGRAM === "vscode";
const u = (a: string, b: string) => (unicode ? a : b);

export const sym = {
  ok: u("✓", "v"),
  fail: u("✗", "x"),
  warn: u("▲", "!"),
  readOnly: u("●", "*"),
  approval: u("▲", "!"),
  arrow: u("›", ">"),
  bullet: u("•", "-"),
  dot: u("·", "."),
  gear: u("⚙", "#"),
  ellipsis: u("…", "..."),
  dash: u("─", "-"),
};

// ANSI helpers --------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function charWidth(cp: number): number {
  // Zero width: combining marks, variation selectors, ZWJ
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d) return 0;
  // Wide: CJK, fullwidth forms, emoji
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  )
    return 2;
  return 1;
}

/** Display width of a string in terminal cells, ignoring ANSI escapes. */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Truncate to `max` display cells, appending an ellipsis. Drops styling when truncation happens. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(s) <= max) return s;
  const plain = stripAnsi(s);
  let out = "";
  let w = 0;
  for (const ch of plain) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + sym.ellipsis;
}

export function padEnd(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

export function padStart(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : " ".repeat(width - w) + s;
}

export function termWidth(stream: NodeJS.WriteStream = process.stdout): number {
  const cols = stream.columns;
  return cols && cols > 20 ? cols : 100;
}

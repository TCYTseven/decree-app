/**
 * Static analysis of shell command templates (`{{param}}` placeholders).
 *
 * A placeholder is replaced by a POSIX single-quoted value, which is only a safe,
 * literal shell word when the placeholder sits in plain (unquoted, top-level)
 * shell text. Inside '...' or "..." the inserted quotes would close the author's
 * quotes and the value would be parsed as shell code; after `$`, `\`, `$(`, inside
 * backticks, `${...}` or a `#` comment the quoting is also not honored as intended.
 *
 * The generated targets carry a copy of `unsafePlaceholder` (TS, MCP, Python):
 * keep them in sync.
 */

export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;

export type UnsafeContext = "single quotes" | "double quotes" | "backticks" | "${...}" | "a comment" | "$" | "\\" | "$(";

export interface PlaceholderUse {
  name: string;
  start: number;
  end: number;
  /** Why the placeholder is unsafe; undefined when it is a plain top-level word (or part of one). */
  unsafe?: UnsafeContext;
  /** For a placeholder inside quotes: index of the opening quote of the innermost context. */
  openAt?: number;
}

type Frame = { kind: "'" | '"' | "`" | "${" | "#"; at: number };

const CONTEXT_NAME: Record<Frame["kind"], UnsafeContext> = {
  "'": "single quotes",
  '"': "double quotes",
  "`": "backticks",
  "${": "${...}",
  "#": "a comment",
};

/** Scan a template, tracking shell quoting state, and report every placeholder with its context. */
export function scanShellTemplate(template: string): PlaceholderUse[] {
  const out: PlaceholderUse[] = [];
  const stack: Frame[] = [];
  const top = () => stack[stack.length - 1];
  const re = /^\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/;
  // Never skip over the start of a placeholder: every one the renderer would fill must be seen.
  const placeholderAt = (j: number) => re.test(template.slice(j));
  let i = 0;
  while (i < template.length) {
    const rest = template.slice(i);
    const m = re.exec(rest);
    if (m) {
      const use: PlaceholderUse = { name: m[1]!, start: i, end: i + m[0].length };
      const frame = top();
      if (frame) {
        use.unsafe = CONTEXT_NAME[frame.kind];
        use.openAt = frame.at;
      } else {
        const prev = template[i - 1];
        if (prev === "$") use.unsafe = "$";
        else if (prev === "\\") use.unsafe = "\\";
        else if (/\$\(\s*$/.test(template.slice(0, i))) use.unsafe = "$(";
      }
      out.push(use);
      i = use.end;
      continue;
    }
    const c = template[i]!;
    const frame = top();
    if (frame?.kind === "'") {
      if (c === "'") stack.pop();
      i++;
      continue;
    }
    if (frame?.kind === "#") {
      if (c === "\n") stack.pop();
      i++;
      continue;
    }
    if (c === "\\") {
      i += placeholderAt(i + 1) ? 1 : 2;
      continue;
    }
    if (frame?.kind === '"') {
      if (c === '"') stack.pop();
      else if (c === "`") stack.push({ kind: "`", at: i });
      else if (c === "$" && template[i + 1] === "{" && !placeholderAt(i + 1)) {
        stack.push({ kind: "${", at: i });
        i++;
      }
      i++;
      continue;
    }
    // Unquoted text: top level, inside backticks or inside ${...}.
    if (c === "'" || c === '"') stack.push({ kind: c, at: i });
    else if (c === "`") {
      if (frame?.kind === "`") stack.pop();
      else stack.push({ kind: "`", at: i });
    } else if (c === "$" && template[i + 1] === "{" && !placeholderAt(i + 1)) {
      stack.push({ kind: "${", at: i });
      i++;
    } else if (c === "}" && frame?.kind === "${") stack.pop();
    else if (c === "#" && (i === 0 || /[\s;&|()<>]/.test(template[i - 1]!))) stack.push({ kind: "#", at: i });
    i++;
  }
  return out;
}

export interface NormalizedShellTemplate {
  command: string;
  /** Human-readable notes about quotes that were stripped. */
  fixed: string[];
  /** Placeholders that are still unsafe (the template must be rejected). */
  unsafe: PlaceholderUse[];
}

/**
 * Strip quotes that wrap exactly one placeholder (`"{{x}}"` / `'{{x}}'` -> `{{x}}`):
 * the placeholder is quoted by the renderer anyway. Anything else that is unsafe is
 * reported so the caller can reject the template.
 */
export function normalizeShellTemplate(template: string): NormalizedShellTemplate {
  let command = template;
  const fixed: string[] = [];
  for (let guard = 0; guard < 100; guard++) {
    const uses = scanShellTemplate(command);
    const fix = uses.find(
      (u) =>
        (u.unsafe === "single quotes" || u.unsafe === "double quotes") &&
        u.openAt === u.start - 1 &&
        command[u.end] === command[u.openAt],
    );
    if (!fix) return { command, fixed, unsafe: uses.filter((u) => u.unsafe) };
    const quote = command[fix.openAt!]!;
    fixed.push(`${quote}{{${fix.name}}}${quote} -> {{${fix.name}}}`);
    command = command.slice(0, fix.start - 1) + command.slice(fix.start, fix.end) + command.slice(fix.end + 1);
  }
  return { command, fixed, unsafe: scanShellTemplate(command).filter((u) => u.unsafe) };
}

/** First unsafe placeholder of a template, as an error message; undefined when the template is safe. */
export function unsafeTemplateError(template: string): string | undefined {
  const bad = scanShellTemplate(template).find((u) => u.unsafe);
  if (!bad) return undefined;
  const where = bad.unsafe === "$" || bad.unsafe === "\\" || bad.unsafe === "$(" ? `right after "${bad.unsafe}"` : `inside ${bad.unsafe}`;
  return `unsafe command template: placeholder {{${bad.name}}} is ${where}; placeholders must be bare shell words (the value is quoted automatically)`;
}

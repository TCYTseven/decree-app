/**
 * The path matcher behind `get_decisions`. Every target (runtime, TypeScript, Python, MCP server, Claude Code
 * script) ports this file line for line, so a decision governs the same paths wherever the harness runs.
 *
 * Globs are relative to the repo root:
 *  - `**` matches any run of characters including "/"; `**\/` also matches zero directories
 *  - `*` matches any run of characters except "/"; `?` one character except "/"
 *  - `{a,b}` matches either literal alternative
 *  - `dir/**` and a plain `dir` both match `dir` itself and everything below it
 * Paths and globs are normalized first: backslashes become "/", and empty and "." segments are dropped.
 */

const META = /[*?{]/;

/** "./src//db\\users.ts/" -> "src/db/users.ts"; "." and "" -> "" (the repo root). */
export function normalizeRepoPath(input: string): string {
  return String(input)
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg !== "" && seg !== ".")
    .join("/");
}

/** A glob normalized like a path; an empty glob means the whole repo ("**"). */
export function normalizeGlob(glob: string): string {
  return normalizeRepoPath(glob) || "**";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export function globToRegExp(glob: string): RegExp {
  const g = normalizeGlob(glob);
  if (!META.test(g)) return new RegExp(`^${escapeRegExp(g)}(?:/.*)?$`);
  let body = g;
  let tail = "";
  if (body.endsWith("/**")) {
    body = body.slice(0, -3);
    tail = "(?:/.*)?";
  }
  let re = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "*" && body[i + 1] === "*") {
      if (body[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{" && body.indexOf("}", i) > i) {
      const end = body.indexOf("}", i);
      re += `(?:${body.slice(i + 1, end).split(",").map(escapeRegExp).join("|")})`;
      i = end;
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(`^${re}${tail}$`);
}

/** How specific a glob is: the length of its literal prefix ("src/db/**" -> 6, "**" -> 0). */
export function globSpecificity(glob: string): number {
  const g = normalizeGlob(glob);
  const idx = g.search(META);
  const prefix = idx < 0 ? g : g.slice(0, idx);
  return prefix.replace(/\/+$/, "").length;
}

/**
 * True when `glob` governs `path`: the path matches the glob, or the path is a directory that contains what the
 * glob names (`src` is governed by `src/db/**`). The repo root ("" or ".") is governed by every glob.
 */
export function globMatches(glob: string, path: string): boolean {
  const p = normalizeRepoPath(path);
  if (p === "") return true;
  const g = normalizeGlob(glob);
  if (globToRegExp(g).test(p)) return true;
  const idx = g.search(META);
  const prefix = idx < 0 ? g : g.slice(0, idx);
  return prefix.startsWith(`${p}/`);
}

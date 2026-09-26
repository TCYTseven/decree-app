import { promises as fs } from "node:fs";
import path from "node:path";
import type { EnvVarInfo } from "../core/types.js";
import type { ScanContext } from "./context.js";

const EXAMPLE_FILE_RE = /^(\.env\.(example|sample|template|dist|defaults|tpl|example\.local|local\.example|development\.example|test\.example)|example\.env|env\.example|\.env\.[\w-]+\.(example|sample|template))$/i;

const IGNORED_NAMES = new Set([
  "PATH", "HOME", "USER", "USERNAME", "PWD", "SHELL", "TERM", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "CI",
  "HOSTNAME", "EDITOR", "INIT_CWD", "npm_lifecycle_event", "npm_package_version", "FORCE_COLOR", "NO_COLOR",
  "GITHUB_ACTIONS", "VITEST", "JEST_WORKER_ID",
  // Terminal / OS plumbing read by CLIs; never app configuration.
  "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM", "WT_SESSION", "COLUMNS", "LINES", "SHLVL", "OLDPWD", "LOGNAME",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
]);

const SECRET_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH_?KEY|_KEY$|^KEY$|SIGNING|WEBHOOK_SECRET|SESSION_SECRET|COOKIE_SECRET|SALT|DSN$)/i;
const PUBLIC_RE = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)/;

export function isSecretName(name: string): boolean {
  if (PUBLIC_RE.test(name) && !/SECRET|PRIVATE|PASSWORD/.test(name)) return false;
  if (/PUBLIC_KEY|PUBLISHABLE_KEY|KEY_ID$|_KEY_PATH$|_KEY_FILE$/.test(name)) return false;
  return SECRET_RE.test(name);
}

/** Example values are only kept when they are clearly placeholders or the var is not secret. */
function safeExample(name: string, value: string, secret: boolean): string | undefined {
  if (!value) return undefined;
  if (!secret) return value.length > 200 ? value.slice(0, 200) : value;
  const placeholder = /^(<.*>|\$\{.*\}|x{3,}|\*{3,}|your[-_ ].*|change[-_ ]?me.*|replace[-_ ]?me.*|todo|example.*|dummy.*|test.*|placeholder.*|secret|password|sk-\.\.\.|\.\.\.|null|none|changeit)$/i;
  return placeholder.test(value) || /your|example|changeme|replace|placeholder|xxxx|\.\.\./i.test(value) ? value : undefined;
}

export function parseEnvFile(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2]!.trim();
    const q = /^(['"])(.*)\1/.exec(v);
    if (q) v = q[2]!;
    else v = v.replace(/\s+#.*$/, "").trim();
    out.push({ name: m[1]!, value: v });
  }
  return out;
}

const CODE_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
  /Deno\.env\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /Bun\.env\.([A-Z_][A-Z0-9_]*)/g,
  /os\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /os\.environ\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /os\.(?:Getenv|LookupEnv)\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /ENV\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /ENV\.fetch\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /(?:std::)?env::var(?:_os)?\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /System\.getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /\bgetenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /\benv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /Environment\.GetEnvironmentVariable\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
];

export async function detectEnvVars(ctx: ScanContext, sources: Map<string, string>): Promise<EnvVarInfo[]> {
  const vars = new Map<string, EnvVarInfo>();
  const add = (name: string, source: string, example?: string) => {
    if (IGNORED_NAMES.has(name) || name.startsWith("npm_")) return;
    const secret = isSecretName(name);
    const prev = vars.get(name);
    const ex = example !== undefined ? safeExample(name, example, secret) : undefined;
    if (!prev) {
      const v: EnvVarInfo = { name, source, secret };
      if (ex !== undefined) v.example = ex;
      vars.set(name, v);
    } else if (prev.example === undefined && ex !== undefined) prev.example = ex;
  };

  // 1. Example files (names + example values).
  const exampleFiles = ctx.files.filter((f) => f.depth <= 2 && EXAMPLE_FILE_RE.test(f.name)).sort((a, b) => a.depth - b.depth);
  for (const f of exampleFiles) {
    const text = await ctx.read(f.path);
    if (!text) continue;
    for (const { name, value } of parseEnvFile(text)) add(name, f.path, value);
  }

  // 2. Real .env files: names ONLY. Values are never read into the profile.
  for (const name of [".env", ".env.local", ".env.development"]) {
    let text: string | undefined;
    try {
      const abs = path.join(ctx.root, name);
      const st = await fs.stat(abs);
      if (st.isFile() && st.size < 256 * 1024) text = await fs.readFile(abs, "utf8");
    } catch {
      /* not present */
    }
    if (!text) continue;
    for (const { name: n } of parseEnvFile(text)) add(n, name);
  }

  // 3. Code references.
  for (const [file, text] of sources) {
    if (!/env|getenv|ENV\[|ENV\.fetch/i.test(text)) continue;
    for (const re of CODE_PATTERNS) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) add(m[1]!, file);
    }
  }
  // docker-compose `${VAR}` references
  for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    const text = await ctx.read(f);
    if (!text) continue;
    for (const m of text.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(?::?[-?][^}]*)?\}/g)) add(m[1]!, f);
  }

  // Example-file vars first (in file order), then the rest alphabetically.
  const all = [...vars.values()];
  const fromExamples = all.filter((v) => EXAMPLE_FILE_RE.test(path.posix.basename(v.source)));
  const rest = all.filter((v) => !fromExamples.includes(v)).sort((a, b) => a.name.localeCompare(b.name));
  return [...fromExamples, ...rest];
}

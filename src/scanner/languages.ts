import type { LanguageStat } from "../core/types.js";
import { outsideJvmPackage } from "./context.js";
import type { FileEntry } from "./walk.js";

const EXT_LANG: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".pyi": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".rb": "Ruby", ".rake": "Ruby",
  ".php": "PHP",
  ".java": "Java",
  ".kt": "Kotlin", ".kts": "Kotlin",
  ".scala": "Scala",
  ".swift": "Swift",
  ".m": "Objective-C", ".mm": "Objective-C",
  ".c": "C", ".h": "C",
  ".cpp": "C++", ".cc": "C++", ".cxx": "C++", ".hpp": "C++", ".hh": "C++",
  ".cs": "C#",
  ".fs": "F#",
  ".ex": "Elixir", ".exs": "Elixir",
  ".erl": "Erlang",
  ".hs": "Haskell",
  ".clj": "Clojure", ".cljs": "Clojure",
  ".lua": "Lua",
  ".dart": "Dart",
  ".r": "R",
  ".jl": "Julia",
  ".zig": "Zig",
  ".nim": "Nim",
  ".ml": "OCaml",
  ".pl": "Perl", ".pm": "Perl",
  ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
  ".ps1": "PowerShell",
  ".sql": "SQL",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".astro": "Astro",
  ".html": "HTML", ".htm": "HTML",
  ".css": "CSS", ".scss": "SCSS", ".sass": "SCSS", ".less": "Less",
  ".sol": "Solidity",
  ".tf": "HCL",
  ".proto": "Protocol Buffers",
  ".graphql": "GraphQL", ".gql": "GraphQL",
};

/** Languages that never become the primary language when a "real" one exists. */
const SECONDARY = new Set(["HTML", "CSS", "SCSS", "Less", "SQL", "Shell", "PowerShell", "HCL", "Protocol Buffers", "GraphQL"]);

const FIXTURE_DIR_RE = /(^|\/)(fixtures?|testdata|_?examples?|samples?|code[-_]?samples)\//i;

/** Big JS/CSS files under public/static asset dirs are build output (a compiled bundle), not the project's code. */
const ASSET_DIR_RE = /(^|\/)(public|static|assets|wwwroot|web\/static|dist-assets)\//i;
function isBuiltAsset(f: FileEntry): boolean {
  return (f.ext === ".js" || f.ext === ".css" || f.ext === ".mjs") && f.size > 50 * 1024 && ASSET_DIR_RE.test(f.path);
}

export function languageOf(f: FileEntry): string | undefined {
  if (/\.min\.[cm]?js$/.test(f.name)) return undefined;
  return EXT_LANG[f.ext];
}

export function detectLanguages(allFiles: FileEntry[]): { languages: LanguageStat[]; primaryLanguage?: string } {
  const map = new Map<string, LanguageStat>();
  // Fixtures and examples describe other projects; count them only if nothing else exists.
  const own = allFiles.filter((f) => !FIXTURE_DIR_RE.test(outsideJvmPackage(f.path)) && !isBuiltAsset(f) && languageOf(f));
  // Documentation code samples (one snippet per language next to an API spec) are never the project's language.
  const files = own.length ? own : allFiles.filter((f) => !/(^|\/)code[-_]?samples\//i.test(f.path));
  for (const f of files) {
    const lang = languageOf(f);
    if (!lang) continue;
    let s = map.get(lang);
    if (!s) map.set(lang, (s = { name: lang, files: 0, bytes: 0 }));
    s.files++;
    s.bytes += f.size;
  }
  const languages = [...map.values()].sort((a, b) => b.bytes - a.bytes || b.files - a.files || a.name.localeCompare(b.name));
  const primary = languages.find((l) => !SECONDARY.has(l.name)) ?? languages[0];
  return { languages, primaryLanguage: primary?.name };
}

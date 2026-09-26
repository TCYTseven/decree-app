import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ProjectProfile } from "../core/types.js";
import type { ScanContext } from "./context.js";

export const README_MAX_CHARS = 8000;
const DOC_EXT = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);

export async function detectDocs(ctx: ScanContext): Promise<ProjectProfile["docs"]> {
  const readmePath =
    ctx.first("README.md", "readme.md", "Readme.md", "README.mdx", "README.rst", "README.txt", "README") ??
    ctx.files.find((f) => f.depth === 0 && /^readme(\.|$)/i.test(f.name))?.path;
  let readme: string | undefined;
  if (readmePath) {
    const text = await ctx.read(readmePath);
    if (text) readme = truncate(text.trim(), README_MAX_CHARS);
  }
  const files: string[] = [];
  const rootDocs = ctx.files.filter((f) => f.depth === 0 && DOC_EXT.has(f.ext) && f.ext !== ".txt" && !/^(license|licence|copying)/i.test(f.name));
  const dirDocs = ctx.files.filter((f) => /^(docs?|documentation|wiki|guides?)\//i.test(f.path) && DOC_EXT.has(f.ext));
  for (const f of [...rootDocs, ...dirDocs]) {
    if (files.length >= 50) break;
    files.push(f.path);
  }
  return readme !== undefined ? { readme, files } : { files };
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  const at = cut > max * 0.7 ? cut : max;
  return text.slice(0, at) + `\n… [truncated ${text.length - at} chars]`;
}

/** First meaningful paragraph of a README, used as a description fallback. */
export function readmeSummary(readme: string | undefined): string | undefined {
  if (!readme) return undefined;
  const lines = readme.split(/\r?\n/);
  const para: string[] = [];
  let inCode = false;
  let sawIntro = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (l.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (!l) {
      if (para.length) break;
      continue;
    }
    // Only the intro describes the project; later sections are setup steps ("Click the Use this template button").
    if (/^##+\s/.test(l) && sawIntro) break;
    if (/^#\s/.test(l) || !/^(#|!\[|\[!\[|<|---|===|\||>\s*\[!)/.test(l)) sawIntro = true;
    if (/^(#|!\[|\[!\[|<|---|===|\||>\s*\[!)/.test(l)) {
      if (para.length) break;
      continue;
    }
    // Feature bullet lists ("- ⚡ FastAPI for ...") make a poor one-line summary; look for prose instead.
    if (/^([-*+]|\d+[.)])\s/.test(l)) {
      if (para.length) break;
      continue;
    }
    para.push(l.replace(/^>\s*/, "").replace(/^#+\s+/, ""));
  }
  const s = para.join(" ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, "").trim();
  return s ? (s.length > 300 ? s.slice(0, 297) + "..." : s) : undefined;
}

function exists(root: string, rel: string, dir = false): boolean {
  const p = path.join(root, rel);
  if (!existsSync(p)) return false;
  try {
    return dir ? statSync(p).isDirectory() : statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Checked directly on disk: these files are often gitignored but still matter. */
export function detectAgentConfig(root: string): ProjectProfile["existingAgentConfig"] {
  return {
    claudeMd: exists(root, "CLAUDE.md") || exists(root, ".claude/CLAUDE.md") || exists(root, "CLAUDE.local.md"),
    agentsMd: exists(root, "AGENTS.md") || exists(root, "agents.md"),
    mcpJson: exists(root, ".mcp.json"),
    cursorRules: exists(root, ".cursorrules") || exists(root, ".cursor/rules", true),
    claudeDir: exists(root, ".claude", true),
  };
}

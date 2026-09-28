/**
 * Offline, deterministic extraction of the decisions a team already wrote down:
 *
 *  - ADRs (docs/adr, docs/decisions, adr/, architecture/decisions, ...): title, status, supersession, the
 *    Decision section as the constraint and the Context section as the rationale.
 *  - Agent rules files (CLAUDE.md, AGENTS.md, .cursor/rules/*.mdc, .cursorrules, Copilot instructions, nested
 *    CLAUDE.md/AGENTS.md): imperative bullets ("Never ...", "Always ...", "... must ...") become proposed decisions.
 *  - Post-mortems (docs/postmortems, incidents/, ...): rule-like bullets under Action items / Lessons / Follow-ups /
 *    Prevention become proposed decisions.
 *
 * `governs` comes from explicit frontmatter first (`governs:`, `globs:`, `applyTo:`), then from repo paths the text
 * mentions that exist, then the directory of a nested rules file, and finally "**". Ids are derived from file names
 * and rule text (never from line numbers), so re-running extraction yields the same ids.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Decision, DecisionStatus } from "../core/types.js";
import { isFixturePath } from "../scanner/context.js";
import { walkProject, type WalkResult } from "../scanner/walk.js";
import { normalizeRepoPath } from "./glob.js";

export type DecisionSourceKind = "adr" | "rules" | "postmortem";

export interface ExtractOptions {
  /** Stop walking after this many files (default 20000). */
  maxFiles?: number;
  /** A walk you already have (the scanner's), to avoid walking twice. */
  walk?: WalkResult;
}

export interface ExtractResult {
  decisions: Decision[];
  /** Candidate files that were read, POSIX paths relative to the root. */
  sources: string[];
}

const MAX_SOURCE_BYTES = 256 * 1024;
const CONSTRAINT_MAX = 400;
const MD_EXT = /\.(md|mdx|markdown)$/i;
const ADR_DIR = /(^|\/)(adrs?|decisions|decision-records|architecture-decisions|architecture\/decisions)\//i;
const POSTMORTEM_DIR = /(^|\/)(post-?mortems?|incidents?|incident-reports?)\//i;
const NOT_A_RECORD = /^(readme|index|template|adr-template|\d+-template|_template|toc|summary)\.(md|mdx|markdown)$/i;

/** What kind of decision record a file is, from its path alone (no reading). */
export function classifyDecisionSource(rel: string): DecisionSourceKind | undefined {
  if (isFixturePath(rel)) return undefined;
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();
  if (lower === "claude.md" || lower === "agents.md") return "rules";
  if (rel === ".cursorrules" || rel === ".github/copilot-instructions.md") return "rules";
  if (/(^|\/)\.cursor\/rules\/[^/]+\.mdc?$/i.test(rel)) return "rules";
  if (/^\.github\/instructions\/[^/]+\.instructions\.md$/i.test(rel)) return "rules";
  if (!MD_EXT.test(name) || NOT_A_RECORD.test(name)) return undefined;
  if (ADR_DIR.test(rel)) return "adr";
  if (POSTMORTEM_DIR.test(rel)) return "postmortem";
  return undefined;
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

interface Line {
  text: string;
  no: number; // 1-based line number in the file
}

interface Section {
  heading: string; // "" for text before the first heading
  level: number;
  lines: Line[];
}

interface Parsed {
  data: Record<string, unknown>;
  body: Line[];
}

const TOOL_BLOCK_START = /<!--\s*[\w-]*(gstack|decree)[\w:-]*:(start|begin)\s*-->/i;
const TOOL_BLOCK_END = /<!--\s*[\w-]*(gstack|decree)[\w:-]*:end\s*-->/i;

function parseDoc(text: string): Parsed {
  const all = text.replace(/\r\n?/g, "\n").split("\n");
  let data: Record<string, unknown> = {};
  let start = 0;
  if (all[0]?.trim() === "---") {
    const end = all.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) {
      try {
        const parsed = parseYaml(all.slice(1, end).join("\n")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
      } catch {
        // not YAML after all: treat it as body text
      }
      start = end + 1;
    }
  }
  const body: Line[] = [];
  let fence: string | undefined;
  let comment = false;
  let toolBlock = false;
  for (let i = start; i < all.length; i++) {
    const raw = all[i]!;
    // Blocks other tools manage between markers (`<!-- gstack-...:start -->` ... `:end -->`) are theirs, not the team's.
    if (TOOL_BLOCK_START.test(raw)) {
      toolBlock = true;
      continue;
    }
    if (toolBlock) {
      if (TOOL_BLOCK_END.test(raw)) toolBlock = false;
      continue;
    }
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    // HTML comments are invisible to readers, so they carry no rules (tools also keep markers in them).
    if (comment) {
      if (raw.includes("-->")) comment = false;
      continue;
    }
    if (/^\s*<!--/.test(raw) && !raw.includes("-->")) {
      comment = true;
      continue;
    }
    body.push({ text: raw.replace(/<!--.*?-->/g, ""), no: i + 1 });
  }
  return { data, body };
}

function sectionsOf(body: Line[]): Section[] {
  const out: Section[] = [{ heading: "", level: 0, lines: [] }];
  for (const l of body) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l.text);
    if (m) out.push({ heading: m[2]!.trim(), level: m[1]!.length, lines: [] });
    else out[out.length - 1]!.lines.push(l);
  }
  return out;
}

/** A heading without numbering or emphasis: "## 2. **Decision**" -> "decision". */
function headingKey(h: string): string {
  return stripMd(h)
    .replace(/^[\d.)\s-]+/, "")
    .replace(/[:.]$/, "")
    .trim()
    .toLowerCase();
}

/** Links to their text, emphasis and HTML tags removed; inline code is kept (it carries paths and names). */
export function stripMd(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

interface Bullet {
  text: string;
  no: number;
}

/** List items of a block of lines (continuation lines folded in), with their line numbers. */
function bulletsOf(lines: Line[]): Bullet[] {
  const out: Bullet[] = [];
  let cur: { parts: string[]; no: number; indent: number } | undefined;
  const flush = () => {
    if (cur) out.push({ text: stripMd(cur.parts.join(" ")), no: cur.no });
    cur = undefined;
  };
  for (const l of lines) {
    const m = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(l.text);
    if (m) {
      flush();
      cur = { parts: [m[2]!], no: l.no, indent: m[1]!.length };
    } else if (cur && l.text.trim() && /^\s+/.test(l.text) && !/^\s*#/.test(l.text)) {
      cur.parts.push(l.text.trim());
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** First paragraph of a block (or its bullet list when it starts with one), as plain text. */
function firstBlock(lines: Line[]): string {
  const start = lines.findIndex((l) => l.text.trim() !== "");
  if (start < 0) return "";
  if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[start]!.text)) {
    const run: Line[] = [];
    for (const l of lines.slice(start)) {
      if (!l.text.trim()) {
        if (run.length) {
          const next = lines[lines.indexOf(l) + 1];
          if (!next || !/^\s*(?:[-*+]|\d+[.)])\s+/.test(next.text)) break;
        }
        continue;
      }
      if (!/^\s*(?:[-*+]|\d+[.)])\s+/.test(l.text) && !/^\s+/.test(l.text)) break;
      run.push(l);
    }
    return bulletsOf(run)
      .map((b) => (/[.!?]$/.test(b.text) ? b.text : `${b.text}.`))
      .join(" ");
  }
  const para: string[] = [];
  for (const l of lines.slice(start)) {
    if (!l.text.trim()) break;
    para.push(l.text.trim());
  }
  return stripMd(para.join(" ").replace(/^>\s*/gm, ""));
}

/** Trim to about `max` chars, preferring a sentence end, then a word boundary. */
export function clipText(s: string, max = CONSTRAINT_MAX): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1);
  const word = cut.lastIndexOf(" ");
  return `${cut.slice(0, word > max * 0.5 ? word : max).replace(/[,;:]$/, "")}...`;
}

/** "Never write raw SQL outside `src/db`." -> "never-write-raw-sql-outside-src". */
export function slugWords(s: string, words = 6, max = 48): string {
  const slug = s
    .toLowerCase()
    .replace(/[`'"’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, words)
    .join("-");
  if (slug.length <= max) return slug;
  return slug.slice(0, max).replace(/-[^-]*$/, "") || slug.slice(0, max);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A short title: the first sentence (or clause) of the rule, at most about 80 chars. */
function titleFrom(constraint: string): string {
  const first = constraint.split(/(?<=[.!?])\s/)[0]!.replace(/[.!?]$/, "");
  if (first.length <= 80) return first;
  const cut = first.slice(0, 80);
  const word = cut.lastIndexOf(" ");
  return `${cut.slice(0, word > 40 ? word : 80).replace(/[,;:]$/, "")}...`;
}

// ---------------------------------------------------------------------------
// Rules and status
// ---------------------------------------------------------------------------

const RULE_START = /^(?:[\w ./`-]{1,40}:\s+)?(never|always|do not|don't|dont|must|only|avoid|prefer|use)\b/i;
const RULE_ANYWHERE = /\b(must|must not|never|always|do not|don't|should not|shouldn't|is not allowed|are not allowed|is forbidden)\b/i;

/** True for a bullet that states a rule an agent can follow ("Never ...", "Always ...", "X must ..."). */
export function isRuleText(text: string): boolean {
  const t = text.trim();
  if (t.length < 20 || t.split(/\s+/).length < 4 || t.length > 800) return false;
  if (/^\[?[^\]]*\]?\(?https?:\/\/\S+\)?$/.test(t)) return false;
  const start = RULE_START.exec(t);
  if (start) {
    // "Use X" alone is a description ("Use the CLI to deploy"); it is a rule when it names what not to do.
    if (start[1]!.toLowerCase() !== "use") return true;
    return /\binstead\b|\brather than\b|\bnot\b|\bonly\b|\bnever\b/i.test(t);
  }
  return RULE_ANYWHERE.test(t);
}

const LIVE = /^(accepted|approved|adopted|active|agreed|decided|implemented|done|final|in effect|enacted)\b/i;
const PROPOSED = /^(proposed|draft|pending|open|in review|under review|in discussion|rfc|wip|work in progress)\b/i;
const SUPERSEDED = /^(superseded|deprecated|rejected|obsolete|replaced|withdrawn|retired|abandoned|declined|amended)\b/i;

export function statusFromText(text: string | undefined): DecisionStatus | undefined {
  const t = stripMd(text ?? "")
    .replace(/^[\s:*_`-]+/, "")
    .trim();
  if (!t) return undefined;
  if (SUPERSEDED.test(t)) return "superseded";
  if (LIVE.test(t)) return "live";
  if (PROPOSED.test(t)) return "proposed";
  return undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    const parts = v.filter((x) => typeof x === "string" && x.trim()) as string[];
    return parts.length ? parts.join(", ") : undefined;
  }
  return undefined;
}

/** A frontmatter list or comma-separated string of globs. */
function globList(v: unknown): string[] | undefined {
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const out = items
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .map((x) => normalizeRepoPath(x) || "**");
  return out.length ? [...new Set(out)] : undefined;
}

// ---------------------------------------------------------------------------
// Governs inference
// ---------------------------------------------------------------------------

interface Known {
  files: Set<string>;
  dirs: Set<string>;
}

/** Repo paths a text mentions (in backticks, or plain tokens containing "/") that exist: dirs become "dir/**". */
export function inferGoverns(text: string, known: Known, base = ""): string[] | undefined {
  const candidates: string[] = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) candidates.push(m[1]!);
  for (const m of text.replace(/`[^`\n]*`/g, " ").matchAll(/(?:^|[\s("'])(\.{0,2}\/?[\w.@-]+(?:\/[\w.@*-]*)+)/g)) candidates.push(m[1]!);
  const out: string[] = [];
  for (const raw of candidates) {
    const c = raw.trim().replace(/[.,;:)!?]+$/, "");
    if (!c || /\s/.test(c) || c.includes("://") || /^[~/]/.test(c) || c.split("/").includes("..")) continue;
    const rel = normalizeRepoPath(base ? `${base}/${c}` : c);
    if (!rel) continue;
    let glob: string | undefined;
    if (/[*?{]/.test(rel)) {
      const lit = rel.slice(0, rel.search(/[*?{]/));
      const dir = lit.includes("/") ? lit.slice(0, lit.lastIndexOf("/")) : "";
      if (dir === "" || known.dirs.has(dir)) glob = rel;
    } else if (known.files.has(rel)) glob = rel;
    else if (known.dirs.has(rel)) glob = `${rel}/**`;
    if (glob && !out.includes(glob)) out.push(glob);
  }
  return out.length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Per-kind extraction
// ---------------------------------------------------------------------------

interface AdrDraft extends Decision {
  number?: number;
  file: string;
  supersededByRef?: string;
  supersedesRef?: string;
}

const REF = /(?:\[([^\]]+)\]\(([^)\s]+)\)|\b((?:ADR|RFC)?[-\s#]*\d+)\b)/i;

function refIn(text: string, verb: RegExp): string | undefined {
  const m = new RegExp(`${verb.source}\\s*:?\\s*${REF.source}`, "i").exec(text);
  if (!m) return undefined;
  return m[2] ?? m[3] ?? m[1];
}

function parseAdr(rel: string, text: string, known: Known): AdrDraft | undefined {
  const { data, body } = parseDoc(text);
  const sections = sectionsOf(body);
  const h1 = sections.find((s) => s.level === 1);
  const file = rel.slice(rel.lastIndexOf("/") + 1).replace(MD_EXT, "");
  const rawTitle = str(data.title) ?? h1?.heading ?? file.replace(/[-_]+/g, " ");
  const numMatch = /^(?:ADR|RFC|Decision)?[\s-]*#?(\d+)\s*[:.)\-–—]\s*/i.exec(stripMd(rawTitle));
  const title = stripMd(rawTitle).replace(/^(?:ADR|RFC|Decision)?[\s-]*#?\d+\s*[:.)\-–—]\s*/i, "").trim() || stripMd(rawTitle);
  const fileNum = /^(?:adr[-_]?)?(\d+)/i.exec(file);
  const number = numMatch ? Number(numMatch[1]) : fileNum ? Number(fileNum[1]) : undefined;
  const fileSlug = slug(file);
  const id = str(data.id) ? slug(str(data.id)!) : fileSlug.startsWith("adr") ? fileSlug : `adr-${fileSlug}`;

  // Status: frontmatter, a "Status: X" line, or the first line of a Status section.
  const full = body.map((l) => l.text).join("\n");
  let statusText = str(data.status);
  if (!statusText) {
    const line = /^\s*(?:[-*+]\s*)?(?:\*\*|__)?status(?:\*\*|__)?\s*:\s*(?:\*\*|__)?(.+)$/im.exec(full);
    if (line) statusText = line[1];
  }
  const statusSection = sections.find((s) => headingKey(s.heading) === "status");
  if (!statusText && statusSection) statusText = statusSection.lines.find((l) => l.text.trim())?.text;
  const parsedStatus = statusFromText(statusText);
  const supersededByRef = str(data.superseded_by) ?? str(data.supersededBy) ?? refIn(full, /superseded\s+by/);
  const supersedesRef = str(data.supersedes) ?? refIn(full, /\bsupersedes/);

  const decisionSection = sections.find((s) => /^(decision|decision outcome|the decision|decisions?|decision made|resolution|we decided)$/.test(headingKey(s.heading)));
  const contextSection = sections.find((s) => /^(context|context and problem statement|background|problem|problem statement|motivation)$/.test(headingKey(s.heading)));
  let constraint = decisionSection ? firstBlock(decisionSection.lines) : "";
  if (!constraint) {
    const intro = sections.find((s) => s.level <= 1 && s.lines.some((l) => l.text.trim() && !/^\s*(?:[-*+]\s*)?(?:\*\*|__)?\w+(?:\*\*|__)?\s*:/.test(l.text)));
    constraint = intro ? firstBlock(intro.lines.filter((l) => !/^\s*(?:[-*+]\s*)?(?:\*\*|__)?\w+(?:\*\*|__)?\s*:/.test(l.text))) : "";
  }
  constraint = clipText(constraint || title);
  const rationale = contextSection ? clipText(firstBlock(contextSection.lines)) : "";
  const ownerLine = /^\s*(?:[-*+]\s*)?(?:\*\*|__)?(?:deciders|owners?|authors?|decision makers?)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?(.+)$/im.exec(full);
  const owner = str(data.owner) ?? str(data.owners) ?? str(data.deciders) ?? str(data.author) ?? str(data.authors) ?? (ownerLine ? stripMd(ownerLine[1]!) : undefined);
  const governs = globList(data.governs) ?? globList(data.scope) ?? globList(data.paths) ?? inferGoverns(`${title}\n${constraint}`, known) ?? ["**"];

  const d: AdrDraft = {
    id,
    title,
    constraint,
    status: parsedStatus ?? (supersededByRef ? "superseded" : "proposed"),
    governs,
    source: rel,
    file: rel,
  };
  if (owner) d.owner = clipText(owner, 120);
  if (rationale) d.rationale = rationale;
  if (number !== undefined) d.number = number;
  if (supersededByRef) d.supersededByRef = supersededByRef;
  if (supersedesRef) d.supersedesRef = supersedesRef;
  return d;
}

/** Resolve "ADR-0007", "7" or "0007-use-kafka.md" against the parsed ADRs. */
function resolveRef(ref: string, from: AdrDraft, adrs: AdrDraft[]): AdrDraft | undefined {
  const target = ref.split("#")[0]!;
  if (/\.(md|mdx|markdown)$/i.test(target)) {
    const abs = path.posix.normalize(path.posix.join(path.posix.dirname(from.file), target));
    const hit = adrs.find((a) => a.file === abs) ?? adrs.find((a) => a.file.endsWith(`/${target.replace(/^\.\//, "")}`));
    if (hit) return hit;
  }
  const num = /(\d+)/.exec(ref);
  if (num) return adrs.find((a) => a.number === Number(num[1]) && a !== from && path.posix.dirname(a.file) === path.posix.dirname(from.file)) ?? adrs.find((a) => a.number === Number(num[1]) && a !== from);
  return undefined;
}

function linkAdrs(adrs: AdrDraft[]): void {
  for (const a of adrs) {
    if (!a.supersededByRef) continue;
    const t = resolveRef(a.supersededByRef, a, adrs);
    if (t && t !== a) {
      a.supersededBy = t.id;
      a.status = "superseded";
    }
  }
  for (const b of adrs) {
    if (!b.supersedesRef || b.status !== "live") continue;
    const t = resolveRef(b.supersedesRef, b, adrs);
    if (!t || t === b) continue;
    t.supersededBy ??= b.id;
    t.status = "superseded";
  }
}

const SKIP_SECTION = /^(gstack|skill routing|gbrain search guidance|available skills)\b/i;
const DECREE_SECTIONS = new Set(["working rules", "commands", "api", "safety", "agent setup", "team decisions"]);
const DECREE_MARKER = "Generated by decree-harness";

function ruleFileSlug(rel: string): string {
  if (rel === ".cursorrules") return "cursorrules";
  if (rel === ".github/copilot-instructions.md") return "copilot";
  const cursor = /(?:^|\/)\.cursor\/rules\/([^/]+)\.mdc?$/i.exec(rel);
  if (cursor) {
    const dir = rel.slice(0, rel.indexOf(".cursor/rules/")).replace(/\/$/, "");
    return slug(`${dir ? `${dir}-` : ""}cursor-${cursor[1]}`);
  }
  const copilot = /^\.github\/instructions\/([^/]+)\.instructions\.md$/i.exec(rel);
  if (copilot) return slug(`copilot-${copilot[1]}`);
  // Nested files keep only their own directory name: services/billing/AGENTS.md -> billing-agents-md.
  const parts = rel.replace(/^\.claude\//, "").split("/");
  return slug(parts.slice(-2).join("-"));
}

/** The directory a rules file scopes to ("" = the whole repo). */
function ruleFileDir(rel: string): string {
  const cursor = rel.indexOf(".cursor/rules/");
  if (cursor >= 0) return rel.slice(0, cursor).replace(/\/$/, "");
  const dir = path.posix.dirname(rel);
  return dir === "." || dir === ".claude" || dir === ".github" || dir.startsWith(".github/") ? "" : dir;
}

function parseRules(rel: string, text: string, known: Known): Decision[] {
  const { data, body } = parseDoc(text);
  const generatedByDecree = text.includes(DECREE_MARKER);
  const explicit = globList(data.globs) ?? globList(data.applyTo);
  const dir = ruleFileDir(rel);
  const fileSlug = ruleFileSlug(rel);
  const out: Decision[] = [];
  let skipLevel = 0;
  for (const s of sectionsOf(body)) {
    if (skipLevel && s.level > skipLevel) continue;
    skipLevel = 0;
    const key = headingKey(s.heading);
    if (SKIP_SECTION.test(key) || (generatedByDecree && DECREE_SECTIONS.has(key))) {
      skipLevel = s.level;
      continue;
    }
    for (const b of bulletsOf(s.lines)) {
      if (!isRuleText(b.text)) continue;
      const constraint = clipText(b.text);
      const governs = explicit ?? inferGoverns(constraint, known, dir) ?? [dir ? `${dir}/**` : "**"];
      out.push({
        id: `rule-${fileSlug}-${slugWords(constraint, 6, 40)}`,
        title: titleFrom(constraint),
        constraint,
        status: "proposed",
        governs,
        source: `${rel}:${b.no}`,
      });
    }
  }
  return out;
}

const LESSON_SECTION = /^(action items?|actions|lessons?|lessons learned|learnings|follow[- ]?ups?|follow[- ]?up actions|prevention|preventive (measures|actions)|remediation|what we will do|what we'll do|next steps)\b/;

function parsePostmortem(rel: string, text: string, known: Known): Decision[] {
  const { body } = parseDoc(text);
  const sections = sectionsOf(body);
  const name = stripMd(sections.find((s) => s.level === 1)?.heading ?? "");
  const fileSlug = slug(rel.slice(rel.lastIndexOf("/") + 1).replace(MD_EXT, ""));
  const out: Decision[] = [];
  let inLessons = 0;
  for (const s of sections) {
    const key = headingKey(s.heading);
    if (LESSON_SECTION.test(key)) inLessons = s.level;
    else if (inLessons && s.level <= inLessons) inLessons = 0;
    if (!inLessons) continue;
    for (const b of bulletsOf(s.lines)) {
      if (!isRuleText(b.text)) continue;
      const constraint = clipText(b.text);
      const d: Decision = {
        id: `postmortem-${fileSlug}-${slugWords(constraint, 5, 40)}`,
        title: titleFrom(constraint),
        constraint,
        status: "proposed",
        governs: inferGoverns(constraint, known) ?? ["**"],
        source: `${rel}:${b.no}`,
      };
      if (name) d.rationale = clipText(`Lesson from the post-mortem "${name}".`, 200);
      out.push(d);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dedupe + entry point
// ---------------------------------------------------------------------------

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** True when two constraints say the same thing (same words, or at least 85% word overlap). */
export function nearDuplicate(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.join(" ") === tb.join(" ")) return true;
  if (ta.length < 4 || tb.length < 4) return false;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter) >= 0.85;
}

/** Keep the first of near-identical constraints and make ids unique (a repeated id gets -2, -3, ...). */
export function dedupeDecisions(list: Decision[]): Decision[] {
  const out: Decision[] = [];
  const ids = new Set<string>();
  for (const d of list) {
    if (out.some((o) => nearDuplicate(o.constraint, d.constraint))) continue;
    let id = d.id;
    for (let i = 2; ids.has(id); i++) id = `${d.id}-${i}`;
    ids.add(id);
    out.push(id === d.id ? d : { ...d, id });
  }
  const kept = new Set(out.map((d) => d.id));
  return out.map((d) => {
    if (!d.supersededBy || kept.has(d.supersededBy)) return d;
    const { supersededBy: _drop, ...rest } = d;
    return rest;
  });
}

const ORDER: Record<DecisionSourceKind, number> = { adr: 0, rules: 1, postmortem: 2 };

/** Candidate decision files from a walk, ADRs first, then rules files (root first), then post-mortems. */
export function decisionSourcesOf(walk: WalkResult): { path: string; kind: DecisionSourceKind; size: number }[] {
  return walk.files
    .map((f) => ({ path: f.path, kind: classifyDecisionSource(f.path), size: f.size }))
    .filter((f): f is { path: string; kind: DecisionSourceKind; size: number } => f.kind !== undefined)
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.path.split("/").length - b.path.split("/").length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Extract decisions from the repo at `root`. Deterministic and offline. */
export async function extractDecisions(root: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const absRoot = path.resolve(root);
  const walk = opts.walk ?? (await walkProject(absRoot, opts.maxFiles ?? 20000));
  const known: Known = { files: new Set(walk.files.map((f) => f.path)), dirs: new Set(walk.dirs) };
  const candidates = decisionSourcesOf(walk).filter((f) => f.size <= MAX_SOURCE_BYTES);
  const adrs: AdrDraft[] = [];
  const others: Decision[] = [];
  const sources: string[] = [];
  for (const c of candidates) {
    let text: string;
    try {
      text = await fs.readFile(path.join(absRoot, c.path), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    sources.push(c.path);
    if (c.kind === "adr") {
      const a = parseAdr(c.path, text, known);
      if (a) adrs.push(a);
    } else if (c.kind === "rules") others.push(...parseRules(c.path, text, known));
    else others.push(...parsePostmortem(c.path, text, known));
  }
  linkAdrs(adrs);
  const adrDecisions: Decision[] = adrs.map(({ number: _n, file: _f, supersededByRef: _r, supersedesRef: _s, ...d }) => d);
  return { decisions: dedupeDecisions([...adrDecisions, ...others]), sources };
}

import { promises as fs } from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import type { HarnessSpec } from "../core/types.js";
import { loadSpec, projectPaths, readDotEnv } from "../core/config.js";
import { TARGET_DIRS } from "../generators/index.js";
import { DEFAULT_OUT_DIR, SPEC_FILENAME } from "../version.js";
import { banner } from "../ui/banner.js";
import { explainError, SilentExit } from "../ui/errors.js";
import { formatDuration, plural } from "../ui/format.js";
import { log } from "../ui/logger.js";
import { c, contentWidth, sym, wrapText } from "../ui/theme.js";
import { rootFor, selfCommand } from "./context.js";
import { findApiKey } from "./pipeline.js";

type Status = "ok" | "warn" | "fail" | "skip";
export interface Check {
  name: string;
  status: Status;
  detail?: string;
  hint?: string;
}

export function nodeVersionOk(version = process.versions.node, min = [20, 12, 0]): boolean {
  const v = version.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) > min[i]) return true;
    if ((v[i] ?? 0) < min[i]) return false;
  }
  return true;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function ping(url: string, timeoutMs = 5000): Promise<{ ok: boolean; ms: number; detail: string }> {
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    return { ok: true, ms: Date.now() - start, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, detail: (err as Error).message };
  }
}

export async function runChecks(root: string, opts: { online?: boolean; out?: string; apiKey?: string } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(
    nodeVersionOk()
      ? { name: "Node.js", status: "ok", detail: `v${process.versions.node}` }
      : { name: "Node.js", status: "fail", detail: `v${process.versions.node}`, hint: "decree-harness needs Node >= 20.12" },
  );

  try {
    const { key, source } = await findApiKey(root, opts.apiKey);
    checks.push(
      key
        ? { name: "Anthropic API key", status: "ok", detail: `set via ${source}` }
        : {
            name: "Anthropic API key",
            status: "warn",
            detail: "not set",
            hint: "export ANTHROPIC_API_KEY=sk-ant-... (or add it to .env). Needed to plan with Claude, chat, run and eval.",
          },
    );
  } catch (err) {
    checks.push({ name: "Anthropic API key", status: "fail", detail: explainError(err).message });
  }

  let spec: HarnessSpec | undefined;
  try {
    const loaded = await loadSpec(root);
    spec = loaded.spec;
    checks.push({
      name: SPEC_FILENAME,
      status: loaded.warnings.length ? "warn" : "ok",
      detail: `${plural(spec.tools.length, "tool")}, ${plural(spec.subagents.length, "subagent")}, ${plural(spec.evals.length, "eval")}${loaded.warnings.length ? `, ${loaded.warnings.length} warnings` : ""}`,
      hint: loaded.warnings[0],
    });
  } catch (err) {
    const e = explainError(err);
    const notFound = (err as { name?: string }).name === "SpecNotFoundError";
    checks.push({ name: SPEC_FILENAME, status: "fail", detail: notFound ? "not found" : e.message, hint: e.details?.slice(0, 3).join("; ") || e.hint });
  }

  if (spec) {
    const dotenv = await readDotEnv(root);
    const required = spec.env.filter((e) => e.required && e.name !== "ANTHROPIC_API_KEY");
    const missing = required.filter((e) => !process.env[e.name] && !dotenv[e.name] && e.default === undefined);
    if (!required.length) checks.push({ name: "Tool env vars", status: "ok", detail: "none required" });
    else if (!missing.length) checks.push({ name: "Tool env vars", status: "ok", detail: `${required.length} required, all set` });
    else
      checks.push({
        name: "Tool env vars",
        status: "warn",
        detail: `missing ${missing.map((e) => e.name).join(", ")}`,
        hint: "Tools that need them will fail at runtime. Set them in your shell or .env.",
      });

    const out = projectPaths(root, opts.out ?? DEFAULT_OUT_DIR).outDir;
    const rel = path.relative(root, out) || ".";
    if (!(await isDir(out))) {
      checks.push({ name: "Generated code", status: "warn", detail: `${rel}/ not found`, hint: `Run \`${selfCommand()} generate\`.` });
    } else {
      const missingTargets: string[] = [];
      for (const t of spec.targets) if (!(await isDir(path.join(out, TARGET_DIRS[t])))) missingTargets.push(TARGET_DIRS[t]);
      checks.push(
        missingTargets.length
          ? { name: "Generated code", status: "warn", detail: `${rel}/ is missing ${missingTargets.join(", ")}`, hint: `Run \`${selfCommand()} generate\`.` }
          : { name: "Generated code", status: "ok", detail: `${rel}/ (${spec.targets.join(", ")})` },
      );
    }
  }

  if (opts.online) {
    const r = await ping("https://api.anthropic.com");
    checks.push(
      r.ok
        ? { name: "api.anthropic.com", status: "ok", detail: `reachable (${r.detail}, ${formatDuration(r.ms)})` }
        : { name: "api.anthropic.com", status: "fail", detail: `unreachable: ${r.detail}`, hint: "Check network, proxy (HTTPS_PROXY) or firewall." },
    );
  } else {
    checks.push({ name: "Network", status: "skip", detail: "skipped (pass --online to check api.anthropic.com)" });
  }
  return checks;
}

const ICON: Record<Status, (s: string) => string> = {
  ok: () => c.green(sym.ok),
  warn: () => c.yellow(sym.warn),
  fail: () => c.red(sym.fail),
  skip: () => c.dim("○"),
};

export async function doctorCommand(opts: { online?: boolean; out?: string; json?: boolean }, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  const checks = await runChecks(root, opts);
  const failed = checks.filter((x) => x.status === "fail").length;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: failed === 0, checks }, null, 2)}\n`);
  } else {
    p.intro(banner("doctor"));
    const w = Math.max(...checks.map((x) => x.name.length));
    const pad = " ".repeat(w + 4);
    const width = contentWidth();
    const lines = checks.map((x) => {
      const detail = x.status === "skip" ? c.dim(x.detail ?? "") : x.detail ?? "";
      let line = wrapText(`${ICON[x.status]("")} ${x.status === "skip" ? c.dim(x.name.padEnd(w)) : x.name.padEnd(w)}  ${detail}`, width, pad);
      if (x.hint && x.status !== "ok") line += `\n${wrapText(`${pad}${c.dim(x.hint)}`, width, pad)}`;
      return line;
    });
    log.message(lines.join("\n"));
    const warns = checks.filter((x) => x.status === "warn").length;
    p.outro(failed ? c.red(`${failed} problem${failed === 1 ? "" : "s"} found`) : warns ? c.yellow(`OK with ${warns} warning${warns === 1 ? "" : "s"}`) : c.green("All good"));
  }
  if (failed) throw new SilentExit(1);
}

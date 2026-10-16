import type { CheckResult, Grader } from "./types.js";

/** Everything a grader may look at for one trial. */
export interface Observation {
  answer: string;
  toolCalls: { name: string; input: unknown; isError: boolean }[];
}

const lower = (s: string) => s.toLowerCase();

/** Strip markdown emphasis and quotes around an answer, for start/end checks. */
function bare(s: string): string {
  return s.trim().replace(/^[\s*_`"'“”]+|[\s*_`"'“”]+$/g, "");
}

function nonEmptyLines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** JSON from an answer: the whole answer, else the first ```json fence, else the outermost brackets. */
export function jsonFrom(answer: string): unknown {
  const t = answer.trim();
  const tries = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) tries.push(fence[1].trim());
  const a = t.indexOf("[");
  const o = t.indexOf("{");
  const start = a === -1 ? o : o === -1 ? a : Math.min(a, o);
  if (start !== -1) {
    const close = t[start] === "[" ? "]" : "}";
    const end = t.lastIndexOf(close);
    if (end > start) tries.push(t.slice(start, end + 1));
  }
  for (const s of tries) {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      /* next */
    }
  }
  return undefined;
}

export function countSentences(s: string): number {
  return s
    .replace(/\b(e\.g|i\.e|etc|vs|mr|dr)\./gi, "$1")
    .split(/[.!?]+(?:\s|$)/)
    .map((x) => x.trim())
    .filter((x) => /[a-z0-9]/i.test(x)).length;
}

function argMatches(actual: unknown, expected: string): boolean {
  if (actual === undefined || actual === null) return false;
  const a = lower(typeof actual === "string" ? actual : JSON.stringify(actual)).replace(/^"|"$/g, "");
  const e = lower(expected);
  return a === e || a.includes(e) || (e.length > 2 && e.includes(a) && a.length > 0);
}

export function grade(g: Grader, obs: Observation): CheckResult {
  const answer = obs.answer ?? "";
  const ans = lower(answer);
  const called = obs.toolCalls.map((t) => t.name);
  const calledList = called.length ? [...new Set(called)].join(", ") : "none";
  switch (g.type) {
    case "called": {
      const calls = obs.toolCalls.filter((t) => t.name === g.tool);
      if (!calls.length) return { name: `calls ${g.tool}`, passed: false, detail: `called: ${calledList}` };
      if (!g.args) return { name: `calls ${g.tool}`, passed: true };
      const ok = calls.some((c) => {
        const input = (c.input ?? {}) as Record<string, unknown>;
        return Object.entries(g.args!).every(([k, v]) => Object.hasOwn(input, k) && argMatches(input[k], v));
      });
      return { name: `calls ${g.tool} with ${Object.keys(g.args).join(", ")}`, passed: ok, detail: ok ? undefined : `input: ${JSON.stringify(calls[0].input).slice(0, 160)}` };
    }
    case "called_any": {
      const ok = called.some((n) => g.tools.includes(n));
      return { name: `uses ${g.tools.join(" / ")}`, passed: ok, detail: ok ? undefined : `called: ${calledList}` };
    }
    case "not_called": {
      const hit = [...new Set(called.filter((n) => g.tools.includes(n)))];
      return { name: `does not call ${g.tools.length > 3 ? `any of ${g.tools.length} acting tools` : g.tools.join(" / ")}`, passed: !hit.length, detail: hit.length ? `called ${hit.join(", ")}` : undefined };
    }
    case "no_tools":
      return { name: "calls no tool", passed: !called.length, detail: called.length ? `called: ${calledList}` : undefined };
    case "contains_all": {
      const missing = g.values.filter((v) => !ans.includes(lower(v)));
      return { name: `mentions ${g.values.map((v) => JSON.stringify(v)).join(", ")}`.slice(0, 120), passed: !missing.length, detail: missing.length ? `missing ${missing.map((v) => JSON.stringify(v)).join(", ")}` : undefined };
    }
    case "contains_any": {
      const ok = g.values.some((v) => ans.includes(lower(v)));
      return { name: g.label ?? `mentions one of ${g.values.length}`, passed: ok, detail: ok ? undefined : `none of: ${g.values.slice(0, 4).join(" | ")}` };
    }
    case "not_contains": {
      const hit = g.values.filter((v) => ans.includes(lower(v)));
      return { name: g.label ?? `avoids ${g.values.join(", ")}`, passed: !hit.length, detail: hit.length ? `found ${hit.map((v) => JSON.stringify(v)).join(", ")}` : undefined };
    }
    case "json": {
      const v = jsonFrom(answer);
      if (v === undefined) return { name: `valid JSON ${g.shape}`, passed: false, detail: "no JSON found" };
      const shapeOk = g.shape === "array" ? Array.isArray(v) : !!v && typeof v === "object" && !Array.isArray(v);
      if (!shapeOk) return { name: `valid JSON ${g.shape}`, passed: false, detail: `got ${Array.isArray(v) ? "array" : typeof v}` };
      if (g.keys) {
        const keys = Object.keys(v as object).sort();
        const want = [...g.keys].sort();
        if (keys.join(",") !== want.join(",")) return { name: `JSON keys ${want.join(", ")}`, passed: false, detail: `keys: ${keys.join(", ") || "none"}` };
      }
      const text = lower(JSON.stringify(v));
      const missing = (g.includes ?? []).filter((x) => !text.includes(lower(x)));
      if (missing.length) return { name: `valid JSON ${g.shape}`, passed: false, detail: `missing ${missing.join(", ")}` };
      // "Only JSON" means nothing around it; one ```json fence is tolerated.
      const stripped = answer.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      try {
        JSON.parse(stripped);
      } catch {
        return { name: `only JSON ${g.shape}`, passed: false, detail: "extra text around the JSON" };
      }
      return { name: `only JSON ${g.shape}`, passed: true };
    }
    case "max_words": {
      const n = answer.trim().split(/\s+/).filter(Boolean).length;
      return { name: `at most ${g.n} words`, passed: n <= g.n, detail: n > g.n ? `${n} words` : undefined };
    }
    case "max_sentences": {
      const n = countSentences(answer);
      return { name: `at most ${g.n} sentences`, passed: n <= g.n && n > 0, detail: n > g.n || !n ? `${n} sentences` : undefined };
    }
    case "bullets": {
      const lines = nonEmptyLines(answer);
      const bullets = lines.filter((l) => /^[-*•]\s+\S/.test(l)).length;
      const ok = bullets === g.n && lines.length === g.n;
      return { name: `exactly ${g.n} bullets, nothing else`, passed: ok, detail: ok ? undefined : `${bullets} bullets in ${lines.length} lines` };
    }
    case "line_count": {
      const n = nonEmptyLines(answer).filter((l) => !/^```/.test(l)).length;
      return { name: `exactly ${g.n} lines`, passed: n === g.n, detail: n === g.n ? undefined : `${n} lines` };
    }
    case "lowercase": {
      const upper = answer.match(/[A-Z]/g);
      return { name: "lowercase only", passed: !upper, detail: upper ? `${upper.length} capital letter(s)` : undefined };
    }
    case "starts_with": {
      const ok = lower(bare(answer)).startsWith(lower(g.phrase));
      return { name: `starts with ${JSON.stringify(g.phrase)}`, passed: ok, detail: ok ? undefined : `starts: ${JSON.stringify(bare(answer).slice(0, 30))}` };
    }
    case "ends_with": {
      const want = lower(g.phrase).replace(/[.!?]+$/, "");
      const got = lower(bare(answer)).replace(/[.!?]+$/, "");
      const ok = got.endsWith(want);
      return { name: `ends with ${JSON.stringify(g.phrase)}`, passed: ok, detail: ok ? undefined : `ends: ${JSON.stringify(bare(answer).slice(-30))}` };
    }
  }
}

export function gradeAll(graders: Grader[], obs: Observation): { checks: CheckResult[]; passed: boolean; score: number } {
  const checks = graders.map((g) => grade(g, obs));
  const ok = checks.filter((c) => c.passed).length;
  return { checks, passed: ok === checks.length, score: checks.length ? ok / checks.length : 1 };
}

/** Wilson score interval (95%): honest bounds for small n, which local runs always are. */
export function wilson(passed: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = passed / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

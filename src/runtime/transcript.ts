import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

/**
 * Append-only JSONL transcript at `<projectRoot>/.decree/runs/<timestamp>.jsonl`.
 * Every line passes through `scrub` (secret redaction) before it hits disk.
 * Failures to write are swallowed: a transcript must never break a run.
 */
export class Transcript {
  readonly file: string | undefined;
  private broken = false;

  constructor(projectRoot: string, private readonly scrub: (line: string) => string) {
    let file: string | undefined;
    try {
      const dir = path.join(projectRoot, ".decree", "runs");
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      for (let i = 0; i < 100 && !file; i++) {
        const candidate = path.join(dir, `${stamp}${i ? `-${i}` : ""}.jsonl`);
        try {
          closeSync(openSync(candidate, "wx"));
          file = candidate;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      }
    } catch {
      file = undefined;
    }
    this.file = file;
  }

  write(record: Record<string, unknown>): void {
    if (!this.file || this.broken) return;
    try {
      const line = this.scrub(JSON.stringify({ ts: new Date().toISOString(), ...record }));
      appendFileSync(this.file, `${line}\n`, "utf8");
    } catch {
      this.broken = true;
    }
  }
}

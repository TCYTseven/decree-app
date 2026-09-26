import { DECREE_VERSION } from "../version.js";
import { c } from "./theme.js";

/** A small, tasteful intro line: ` decree  v0.1.0 · agent harness generator` */
export function banner(subtitle = "agent harness generator"): string {
  const badge = c.bgCyan(c.black(c.bold(" decree ")));
  return `${badge} ${c.dim(`v${DECREE_VERSION} · ${subtitle}`)}`;
}

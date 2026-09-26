import type { DependencyInfo } from "../core/types.js";
import type { ScanContext } from "./context.js";
import type { ManifestResult } from "./manifests.js";

const JS_CLI_LIB = /from\s+['"](commander|yargs|yargs\/yargs|cac|citty|clipanion|sade|meow|@oclif\/core)['"]|require\(\s*['"](commander|yargs|cac|sade)['"]\s*\)/;

function kebab(s: string): string {
  return s.replace(/_/g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Detect whether the project ships a CLI and which subcommands it exposes. */
export function detectCli(
  ctx: ScanContext,
  manifests: ManifestResult,
  deps: DependencyInfo[],
  sources: Map<string, string>,
): { bin: string; commands: string[] } | undefined {
  const depNames = new Set(deps.map((d) => d.name));
  let bin: string | undefined = manifests.bins[0]?.name;
  const commands: string[] = [];
  const push = (c: string | undefined) => {
    if (c && /^[\w:.-]+$/.test(c) && c !== "help" && c !== "*" && !commands.includes(c)) commands.push(c);
  };

  for (const [file, text] of sources) {
    if (/\.[cm]?[jt]sx?$/.test(file) && JS_CLI_LIB.test(text)) {
      for (const m of text.matchAll(/\.command\(\s*['"`]([\w:-]+)/g)) push(m[1]);
      for (const m of text.matchAll(/\bnew\s+Command\(\s*['"`]([\w:-]+)['"`]\s*\)/g)) push(m[1]);
    } else if (file.endsWith(".py") && /\b(click|typer|argparse)\b/.test(text)) {
      for (const m of text.matchAll(/@(\w+)\.command\(\s*(?:name\s*=\s*)?(?:['"]([\w-]+)['"])?[^)]*\)\s*(?:@[^\n]*\n\s*)*(?:async\s+)?def\s+(\w+)/g))
        push(m[2] ?? kebab(m[3]!));
      for (const m of text.matchAll(/add_parser\(\s*['"]([\w-]+)['"]/g)) push(m[1]);
    } else if (file.endsWith(".go") && /spf13\/cobra/.test(text)) {
      for (const m of text.matchAll(/Use:\s*"([\w-]+)/g)) push(m[1]);
    } else if (file.endsWith(".rs") && /Subcommand/.test(text)) {
      const e = /#\[derive\([^)]*Subcommand[^)]*\)\]\s*(?:pub\s+)?enum\s+\w+\s*\{([\s\S]*?)\n\}/.exec(text);
      if (e) for (const m of e[1]!.matchAll(/^\s*([A-Z]\w*)\s*[,({]/gm)) push(kebab(m[1]!));
    }
  }
  // oclif-style commands directory
  for (const f of ctx.files) {
    const m = /^src\/commands\/(.+)\.(ts|js)$/.exec(f.path);
    if (m && depNames.has("@oclif/core")) push(m[1]!.replace(/\//g, ":").replace(/:index$/, ""));
  }

  if (!bin) {
    if (depNames.has("github.com/spf13/cobra") || depNames.has("github.com/urfave/cli/v2")) bin = manifests.name;
    else if ((depNames.has("clap") || depNames.has("structopt")) && ctx.has("src/main.rs")) bin = manifests.name;
  }
  if (!bin) return undefined;
  const filtered = commands.filter((c) => c !== bin && !manifests.bins.some((b) => b.name === c));
  return { bin, commands: filtered.slice(0, 60) };
}

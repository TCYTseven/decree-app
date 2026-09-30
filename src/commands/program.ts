import { Command, CommanderError } from "commander";
import { DECREE_VERSION, DEFAULT_MODEL, DEFAULT_OUT_DIR } from "../version.js";
import { formatCommanderError, handleError } from "../ui/errors.js";
import { setQuiet, setVerbose } from "../ui/logger.js";
import { c, detectColor, setColorEnabled, termWidth, wrapText } from "../ui/theme.js";
import { selfCommand } from "./context.js";

const EXAMPLES: [string, string][] = [
  ["", "interactive setup"],
  ["init --yes --offline", "no prompts, no API key needed"],
  ['init -g "Fix flaky tests" -t ts,mcp', "set the goal and targets up front"],
  ["chat", "talk to the generated agent"],
  ['run "Which orders are pending?" --json', "one-shot run, JSON output"],
  ['refine "make every tool read-only"', "edit the harness in plain English"],
  ["decisions for src/db", "decisions that apply to a path"],
  ["eval --filter orders", "run a subset of the evals"],
  ["mcp", "serve decisions over MCP"],
];

/** Examples block, laid out for the terminal width (description beside or above each command). */
function examplesHelp(): string {
  const self = selfCommand();
  const width = termWidth();
  const cmds = EXAMPLES.map(([args, d]) => [`$ ${self}${args ? ` ${args}` : ""}`, d] as const);
  const w = Math.max(...cmds.map(([x]) => x.length)) + 2;
  const side = 2 + w + Math.max(...cmds.map(([, d]) => d.length)) <= width;
  const lines = cmds.map(([x, d]) => (side ? `  ${x.padEnd(w)}${c.dim(d)}` : `  ${c.dim(`# ${d}`)}\n${wrapText(`  ${x}`, width, "      ")}`));
  const tail = wrapText(
    `decree.json is the source of truth: edit it, then run \`${self} generate\`. Installed globally, the shorter \`decree\` command works too.`,
    width,
  );
  return `\nExamples:\n${lines.join(side ? "\n" : "\n\n")}\n\n${tail}`;
}

function styleHelp(cmd: Command, color: boolean): void {
  // Wrap option descriptions even on narrow (60-column) terminals; commander's default gives up below 40.
  cmd.configureHelp({ minWidthToWrap: 24, helpWidth: termWidth() });
  cmd.configureOutput({ outputError: (str, write) => write(formatCommanderError(str)) });
  if (!color) return;
  cmd.configureHelp({
    minWidthToWrap: 24,
    helpWidth: termWidth(),
    styleTitle: (s) => c.bold(s),
    styleCommandText: (s) => c.cyan(s),
    styleSubcommandText: (s) => c.cyan(s),
    styleOptionText: (s) => c.green(s),
    styleArgumentText: (s) => c.yellow(s),
    styleDescriptionText: (s) => s,
  });
}

/** Build the commander program. Exported for tests and programmatic embedding. */
export function buildProgram(): Command {
  const color = detectColor();
  const program = new Command();
  program
    .name("decree-harness")
    .description("Scan a codebase and generate an AI agent harness for it: prompt, tools, subagents, guardrails and evals.")
    .version(DECREE_VERSION, "-v, --version", "print the version")
    .option("-C, --cwd <dir>", "run as if decree was started in <dir>")
    .option("--verbose", "print debug output and stack traces")
    .option("--no-color", "disable colored output")
    .helpOption("-h, --help", "show help")
    .addHelpText("after", examplesHelp)
    .exitOverride()
    .hook("preAction", (_root, action) => {
      const g = action.optsWithGlobals<{ verbose?: boolean; color?: boolean }>();
      setVerbose(Boolean(g.verbose));
      setQuiet(false);
      setColorEnabled(g.color !== false && detectColor());
    });
  styleHelp(program, color);

  const plannerOptions = (cmd: Command) =>
    cmd
      .option("-g, --goal <text>", "what the agent should do, in your words")
      .option("-t, --targets <list>", "comma-separated: typescript, python, mcp, claude-code (or all)")
      .option("--offline", "use the heuristic planner instead of Claude")
      .option("-m, --model <id>", `model for planning and the generated harness (default ${DEFAULT_MODEL})`)
      .option("--no-critique", "skip the critic pass (faster, cheaper)")
      .option("--api-key <key>", "Anthropic API key (default: ANTHROPIC_API_KEY or .env)");

  plannerOptions(
    program
      .command("init [dir]", { isDefault: true })
      .description("scan, plan and generate a harness (the default command)"),
  )
    .option("-o, --out <dir>", "output directory for generated code", DEFAULT_OUT_DIR)
    .option("-y, --yes", "non-interactive: accept defaults (automatic when not a TTY)")
    .option("-f, --force", "re-plan an existing decree.json and overwrite files you edited")
    .option("--dry-run", "show what would be written without writing anything")
    .action((dir, opts, cmd) => import("./init.js").then((m) => m.initCommand(dir, opts, cmd)));

  program
    .command("scan [dir]")
    .description("scan the project and write .decree/profile.json")
    .option("--json", "print the profile as JSON")
    .action((dir, opts, cmd) => import("./scan.js").then((m) => m.scanCommand(dir, opts, cmd)));

  plannerOptions(program.command("plan [dir]").description("scan + plan, writing decree.json only (no code)"))
    .option("-y, --yes", "don't ask before overwriting decree.json")
    .action((dir, opts, cmd) => import("./plan.js").then((m) => m.planCommand(dir, opts, cmd)));

  program
    .command("generate")
    .alias("gen")
    .description("render decree.json into runnable code")
    .option("-t, --targets <list>", "override decree.json targets")
    .option("-o, --out <dir>", "output directory", DEFAULT_OUT_DIR)
    .option("-f, --force", "overwrite files you edited")
    .option("--dry-run", "show what would change without writing")
    .option("--clean", "remove previously generated files that are no longer produced")
    .option("--json", "print what was written as JSON")
    .action((opts, cmd) => import("./generate.js").then((m) => m.generateCommand(opts, cmd)));

  program
    .command("refine <feedback...>")
    .description("change the harness in plain English (uses Claude), then regenerate")
    .option("-m, --model <id>", "model to use for refinement")
    .option("--api-key <key>", "Anthropic API key")
    .option("-o, --out <dir>", "output directory", DEFAULT_OUT_DIR)
    .option("--no-generate", "only update decree.json")
    .option("-f, --force", "overwrite generated files you edited")
    .option("--dry-run", "show the diff without writing")
    .action((feedback, opts, cmd) => import("./refine.js").then((m) => m.refineCommand(feedback, opts, cmd)));

  program
    .command("chat")
    .description("chat with your agent in the terminal (tools run locally)")
    .option("-m, --model <id>", "override the model in decree.json")
    .option("--api-key <key>", "Anthropic API key")
    .option("--dry-run-tools", "tools describe what they would do instead of executing")
    .action((opts, cmd) => import("./chat.js").then((m) => m.chatCommand(opts, cmd)));

  program
    .command("run [prompt...]")
    .description("run the agent once on a prompt (also reads stdin)")
    .option("--json", "print the full RunResult as JSON")
    .option("-y, --yes", "auto-approve every tool call (dangerous)")
    .option("-m, --model <id>", "override the model in decree.json")
    .option("--api-key <key>", "Anthropic API key")
    .option("--dry-run-tools", "tools describe what they would do instead of executing")
    .action((prompt, opts, cmd) => import("./run.js").then((m) => m.runCommand(prompt, opts, cmd)));

  program
    .command("eval")
    .description("run the evals in decree.json and report pass/fail")
    .option("--filter <text>", "only run evals whose id contains <text>")
    .option("--live-tools", "execute tools for real (default: dry-run)")
    .option("--concurrency <n>", "evals to run in parallel", "2")
    .option("-m, --model <id>", "override the agent model")
    .option("--api-key <key>", "Anthropic API key")
    .option("--json", "print results as JSON")
    .option("--push", "upload the results to your dashboard (needs `login` or DECREE_TOKEN)")
    .action((opts, cmd) => import("./eval.js").then((m) => m.evalCommand(opts, cmd)));

  program
    .command("doctor")
    .description("check your environment, API key, decree.json and generated code")
    .option("--online", "also check that api.anthropic.com is reachable")
    .option("-o, --out <dir>", "output directory", DEFAULT_OUT_DIR)
    .option("--json", "print results as JSON")
    .action((opts, cmd) => import("./doctor.js").then((m) => m.doctorCommand(opts, cmd)));

  program
    .command("tools")
    .description("list the tools in decree.json")
    .option("--json", "print tools as JSON")
    .action((opts, cmd) => import("./tools.js").then((m) => m.toolsCommand(opts, cmd)));

  const decisions = program
    .command("decisions")
    .description("the team decisions the agent follows: extract them, confirm them, check what applies to a path");
  const mutating = (cmd: Command) =>
    cmd
      .option("-o, --out <dir>", "output directory to regenerate", DEFAULT_OUT_DIR)
      .option("--no-generate", "only update decree.json")
      .option("-f, --force", "overwrite generated files you edited");
  decisions
    .command("list", { isDefault: true })
    .description("list the decisions in decree.json")
    .option("--status <status>", "only live, proposed or superseded decisions")
    .option("--json", "print decisions as JSON")
    .action((opts, cmd) => import("./decisions.js").then((m) => m.decisionsListCommand(opts, cmd)));
  mutating(
    decisions
      .command("extract")
      .description("find decisions in ADRs, CLAUDE.md/AGENTS.md rules and post-mortems, and merge them into decree.json")
      .option("--dry-run", "show what would be added without writing")
      .option("--json", "print the result as JSON"),
  ).action((opts, cmd) => import("./decisions.js").then((m) => m.decisionsExtractCommand(opts, cmd)));
  decisions
    .command("for <paths...>")
    .description("show what get_decisions returns for these files or directories")
    .option("--proposed", "include proposed decisions")
    .option("--json", "print the matching decisions as JSON")
    .action((paths, opts, cmd) => import("./decisions.js").then((m) => m.decisionsForCommand(paths, opts, cmd)));
  mutating(decisions.command("confirm <ids...>").description("mark proposed decisions live, so the agent follows them")).action((ids, opts, cmd) =>
    import("./decisions.js").then((m) => m.decisionsConfirmCommand(ids, opts, cmd)),
  );
  mutating(
    decisions
      .command("supersede <id>")
      .alias("reject")
      .description("retire a decision (with --by, name the decision that replaces it)")
      .option("--by <id>", "the decision that replaces it"),
  ).action((id, opts, cmd) => import("./decisions.js").then((m) => m.decisionsSupersedeCommand(id, opts, cmd)));

  program
    .command("schema")
    .description("print the JSON schema for decree.json")
    .action(() => import("./schema.js").then((m) => m.schemaCommand()));

  program
    .command("mcp")
    .description("serve get_decisions from decree.json over stdio, for Claude Code, Cursor or any MCP client")
    .action((opts, cmd) => import("./mcp.js").then((m) => m.mcpCommand(opts, cmd)));

  program
    .command("preview")
    .description("open a local dashboard to inspect, edit and try the harness")
    .option("-p, --port <port>", "port to listen on (a free one is picked if taken)", "4321")
    .option("--host <host>", "interface to bind (keep 127.0.0.1 unless you know why)", "127.0.0.1")
    .option("--no-open", "don't open the browser")
    .option("--api-key <key>", "Anthropic API key for the playground and evals")
    .action((opts, cmd) => import("./preview.js").then((m) => m.previewCommand(opts, cmd)));

  program
    .command("login")
    .description("connect this machine to your self-hosted Decree dashboard")
    .option("--url <url>", "dashboard address, e.g. https://decree.example.com (or set DECREE_API_URL)")
    .option("--token <token>", "save an existing API token instead of approving in the browser")
    .option("--no-browser", "print the approval link instead of opening it")
    .action((opts, cmd) => import("./login.js").then((m) => m.loginCommand(opts, cmd)));

  program
    .command("push")
    .description("sync decree.json to your dashboard (a changed spec becomes a new version)")
    .option("-m, --message <text>", "note shown next to this version")
    .option("--name <slug>", "harness name on the dashboard (default: decree.json name)")
    .option("--dry-run", "show what would be pushed without sending it")
    .option("--json", "print the result as JSON")
    .action((opts, cmd) => import("./push.js").then((m) => m.pushCommand(opts, cmd)));

  program
    .command("whoami")
    .description("show the dashboard account this machine pushes to")
    .option("--json", "print as JSON")
    .action((opts, cmd) => import("./whoami.js").then((m) => m.whoamiCommand(opts, cmd)));

  program
    .command("logout")
    .description("revoke this machine's dashboard token and forget it")
    .action((opts, cmd) => import("./logout.js").then((m) => m.logoutCommand(opts, cmd)));

  program.showHelpAfterError(c.dim(`  hint: Run \`${selfCommand()} --help\` for usage.`));
  for (const sub of program.commands) {
    sub.exitOverride();
    sub.showHelpAfterError(c.dim(`  hint: Run \`${selfCommand()} ${sub.name()} --help\` for usage.`));
    styleHelp(sub, color);
    for (const leaf of sub.commands) {
      leaf.exitOverride();
      leaf.showHelpAfterError(c.dim(`  hint: Run \`${selfCommand()} ${sub.name()} ${leaf.name()} --help\` for usage.`));
      styleHelp(leaf, color);
    }
  }
  return program;
}

/**
 * Parse argv and run. Resolves to the exit code instead of exiting, so it can
 * be called from tests. `argv` is the full process.argv (node, script, ...args).
 */
export async function runCli(argv: string[] = process.argv): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // help/version already printed; commander printed its own error message otherwise
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version" || err.code === "commander.help") return 0;
      return err.exitCode || 1;
    }
    return handleError(err);
  }
}

/** Entry point used by the bin: run, then exit with the right code. */
export async function main(argv: string[] = process.argv): Promise<void> {
  // Ctrl+C with nothing else listening (commands like chat/run install their own handlers).
  const onSigint = () => {
    if (process.listenerCount("SIGINT") > 1) return;
    process.stderr.write(`\n${c.dim("Cancelled.")}\n`);
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  // `decree-harness scan --json | head` closes the pipe early; that's not an error.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
      throw err;
    });
  }
  const code = await runCli(argv);
  process.off("SIGINT", onSigint);
  process.exitCode = code;
}

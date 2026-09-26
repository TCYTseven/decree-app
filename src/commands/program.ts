import { Command, CommanderError } from "commander";
import { DECREE_VERSION, DEFAULT_MODEL, DEFAULT_OUT_DIR } from "../version.js";
import { handleError } from "../ui/errors.js";
import { setQuiet, setVerbose } from "../ui/logger.js";
import { c, detectColor, setColorEnabled } from "../ui/theme.js";

const EXAMPLES = `
Examples:
  $ npx decree-harness                          scan, plan and generate interactively
  $ npx decree-harness init --yes --offline     non-interactive, no API key needed
  $ npx decree-harness init --goal "Triage failing CI runs" --targets typescript,mcp
  $ npx decree-harness chat                     talk to the generated agent
  $ npx decree-harness run "How many orders are pending?" --json
  $ npx decree-harness refine "make every tool read-only"
  $ npx decree-harness eval --filter orders

Docs: decree.json is the source of truth. Edit it, then run \`decree-harness generate\`.`;

function styleHelp(cmd: Command, color: boolean): void {
  if (!color) return;
  cmd.configureHelp({
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
    .description("Scan a codebase and generate an optimal AI agent harness for it.")
    .version(DECREE_VERSION, "-v, --version", "print the version")
    .option("-C, --cwd <dir>", "run as if decree was started in <dir>")
    .option("--verbose", "print debug output and stack traces")
    .option("--no-color", "disable colored output")
    .helpOption("-h, --help", "show help")
    .showHelpAfterError(c.dim("(run with --help for usage)"))
    .addHelpText("after", EXAMPLES)
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

  program
    .command("schema")
    .description("print the JSON schema for decree.json")
    .action(() => import("./schema.js").then((m) => m.schemaCommand()));

  for (const sub of program.commands) {
    sub.exitOverride();
    styleHelp(sub, color);
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

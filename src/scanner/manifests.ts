import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { DependencyInfo, ScriptInfo } from "../core/types.js";
import { isFixturePath, type ScanContext } from "./context.js";
import { parseToml, tget, tstr, ttable, type TomlTable, type TomlValue } from "./toml.js";

export interface ManifestResult {
  name?: string;
  description?: string;
  /** Source of the chosen name ("package.json", "pyproject.toml", ...). */
  nameSource?: string;
  scripts: ScriptInfo[];
  dependencies: DependencyInfo[];
  /** Executables the project ships: bin name -> entry (file path or "module:func"). */
  bins: { name: string; entry?: string; ecosystem: string }[];
  /** Package manager per ecosystem family ("js" | "python" | "go" | ...). */
  packageManagers: Map<string, string>;
  workspaces: string[];
  /** Manifest files that were found (relative paths). */
  manifestFiles: string[];
  /** Non-dependency hints for framework detection (e.g. "spring" from pom text). */
  hints: Set<string>;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeJson(text: string | null): Json | undefined {
  if (!text) return undefined;
  try {
    const v = JSON.parse(text);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function safeToml(text: string | null): TomlTable | undefined {
  if (!text) return undefined;
  return parseToml(text);
}

/** Parse a PEP 508 requirement string: "fastapi[all]>=0.110 ; python_version>'3.8'". */
export function parsePep508(spec: string): { name: string; version?: string } | undefined {
  const s = spec.split(";")[0]!.trim();
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!m) return undefined;
  const version = m[2]!.replace(/^\(|\)$/g, "").trim();
  return { name: m[1]!.toLowerCase().replace(/_/g, "-"), version: version || undefined };
}

export function parseRequirements(text: string): { name: string; version?: string }[] {
  const out: { name: string; version?: string }[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+#.*$/, "").trim();
    const m = /#egg=([\w.-]+)/.exec(line);
    if (m) {
      out.push({ name: m[1]!.toLowerCase() });
      continue;
    }
    if (!line || line.startsWith("#") || line.startsWith("-") || /^[a-z+]+:\/\//i.test(line)) continue;
    const d = parsePep508(line);
    if (d) out.push(d);
  }
  return out;
}

/** Make targets with their recipes. Recipes that use make variables fall back to `make <target>`. */
export function parseMakefile(text: string, source: string): ScriptInfo[] {
  const scripts: ScriptInfo[] = [];
  const lines = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^([A-Za-z0-9][A-Za-z0-9_.\-/ ]*?)\s*:(?![=:])(.*)$/.exec(line);
    if (!m || line.startsWith("\t")) continue;
    const recipe: string[] = [];
    let inline = m[2]!.includes(";") ? m[2]!.slice(m[2]!.indexOf(";") + 1).trim() : "";
    if (inline) recipe.push(inline);
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.startsWith("\t")) {
        const cmd = l.trim().replace(/^[@\-+]+/, "").trim();
        if (cmd && !cmd.startsWith("#")) recipe.push(cmd);
      } else if (l.trim() === "" || l.trim().startsWith("#")) continue;
      else break;
    }
    for (const target of m[1]!.split(/\s+/)) {
      if (!target || target.startsWith(".") || target.includes("%") || target.includes("/") || seen.has(target)) continue;
      seen.add(target);
      const joined = recipe.join(" && ");
      const usesMakeVars = /\$[({]|\$[@<^*?]/.test(joined);
      scripts.push({
        name: target,
        command: joined && !usesMakeVars ? joined : `make ${target}`,
        source,
      });
    }
  }
  return scripts;
}

export function parseJustfile(text: string, source: string): ScriptInfo[] {
  const scripts: ScriptInfo[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^@?([A-Za-z_][A-Za-z0-9_-]*)((?:\s+[^:=]+)?)\s*:(?!=)/.exec(line);
    if (!m) continue;
    const recipe: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (/^\s+\S/.test(l)) {
        const cmd = l.trim().replace(/^[@\-]+/, "").trim();
        if (cmd && !cmd.startsWith("#")) recipe.push(cmd);
      } else break;
    }
    const joined = recipe.join(" && ");
    scripts.push({
      name: m[1]!,
      command: joined && !/\{\{/.test(joined) && !m[2]!.trim() ? joined : `just ${m[1]}`,
      source,
    });
  }
  return scripts;
}

function taskfileScripts(text: string, source: string): ScriptInfo[] {
  try {
    const doc = parseYaml(text) as unknown;
    if (!isObj(doc) || !isObj(doc.tasks)) return [];
    const out: ScriptInfo[] = [];
    for (const [name, task] of Object.entries(doc.tasks)) {
      let cmds: string[] = [];
      if (typeof task === "string") cmds = [task];
      else if (Array.isArray(task)) cmds = task.filter((c): c is string => typeof c === "string");
      else if (isObj(task) && Array.isArray(task.cmds))
        cmds = task.cmds
          .map((c) => (typeof c === "string" ? c : isObj(c) && typeof c.cmd === "string" ? c.cmd : ""))
          .filter(Boolean);
      else if (isObj(task) && typeof task.cmd === "string") cmds = [task.cmd];
      const joined = cmds.join(" && ");
      out.push({ name, command: joined && !joined.includes("{{") ? joined : `task ${name}`, source });
    }
    return out;
  } catch {
    return [];
  }
}

function composeScripts(text: string, source: string): ScriptInfo[] {
  try {
    const doc = parseYaml(text) as unknown;
    if (!isObj(doc) || !isObj(doc.services)) return [];
    const flag = /^(docker-)?compose\.ya?ml$/.test(path.posix.basename(source)) ? "" : ` -f ${source}`;
    return Object.keys(doc.services).map((svc) => ({
      name: `compose:${svc}`,
      command: `docker compose${flag} up ${svc}`,
      source,
    }));
  } catch {
    return [];
  }
}

function procfileScripts(text: string, source: string): ScriptInfo[] {
  const out: ScriptInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(line.trim());
    if (m) out.push({ name: m[1]!, command: m[2]!.trim(), source });
  }
  return out;
}

function rakeScripts(text: string, source: string): ScriptInfo[] {
  const out: ScriptInfo[] = [];
  const re = /^\s*task\s+:?["']?([A-Za-z0-9_:]+)["']?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ name: m[1]!, command: `rake ${m[1]}`, source });
  return out;
}

function tomlScriptMap(tbl: TomlTable | undefined, source: string, runner: (name: string) => string): ScriptInfo[] {
  if (!tbl) return [];
  const out: ScriptInfo[] = [];
  for (const [name, v] of Object.entries(tbl)) {
    let cmd: string | undefined;
    if (typeof v === "string") cmd = v;
    else if (Array.isArray(v)) cmd = v.filter((x): x is string => typeof x === "string").join(" && ");
    else if (ttable(v)) {
      const t = v as TomlTable;
      cmd = tstr(t.cmd) ?? tstr(t.shell) ?? tstr(t.call) ?? tstr(t.script);
      if (!cmd && Array.isArray(t.sequence)) cmd = runner(name);
    }
    if (cmd) out.push({ name, command: cmd, source });
  }
  return out;
}

function depsFromTomlTable(
  tbl: TomlValue | undefined,
  ecosystem: DependencyInfo["ecosystem"],
  dev: boolean,
  skip: string[] = [],
): DependencyInfo[] {
  const t = ttable(tbl);
  if (!t) return [];
  const out: DependencyInfo[] = [];
  for (const [name, v] of Object.entries(t)) {
    if (skip.includes(name.toLowerCase())) continue;
    let version: string | undefined;
    if (typeof v === "string") version = v;
    else if (ttable(v)) version = tstr((v as TomlTable).version);
    out.push({ name: ecosystem === "pypi" ? name.toLowerCase().replace(/_/g, "-") : name, version, ecosystem, ...(dev ? { dev } : {}) });
  }
  return out;
}

function pep508List(v: TomlValue | undefined, dev: boolean): DependencyInfo[] {
  if (!Array.isArray(v)) return [];
  const out: DependencyInfo[] = [];
  for (const s of v) {
    if (typeof s !== "string") continue;
    const d = parsePep508(s);
    if (d) out.push({ name: d.name, version: d.version, ecosystem: "pypi", ...(dev ? { dev } : {}) });
  }
  return out;
}

const DEV_GROUP = /^(dev|devel|develop|development|test|tests|testing|lint|linting|docs|doc|typing|types|ci)$/i;

function unscoped(name: string): string {
  return name.replace(/^@[^/]+\//, "");
}

export async function parseManifests(ctx: ScanContext): Promise<ManifestResult> {
  const res: ManifestResult = {
    scripts: [],
    dependencies: [],
    bins: [],
    packageManagers: new Map(),
    workspaces: [],
    manifestFiles: [],
    hints: new Set(),
  };
  const setName = (name: string | undefined, source: string) => {
    if (name && !res.name) {
      res.name = name;
      res.nameSource = source;
    }
  };
  const setDesc = (d: string | undefined) => {
    if (d && !res.description) res.description = d.trim();
  };
  const addDeps = (deps: DependencyInfo[]) => res.dependencies.push(...deps);
  const note = (rel: string) => res.manifestFiles.push(rel);

  // ---------------- JavaScript / TypeScript ----------------
  const rootPkg = safeJson(await ctx.read("package.json"));
  if (rootPkg) {
    note("package.json");
    setName(typeof rootPkg.name === "string" ? rootPkg.name : undefined, "package.json");
    setDesc(typeof rootPkg.description === "string" ? rootPkg.description : undefined);
    if (isObj(rootPkg.scripts))
      for (const [name, cmd] of Object.entries(rootPkg.scripts))
        if (typeof cmd === "string") res.scripts.push({ name, command: cmd, source: "package.json" });
    const bin = rootPkg.bin;
    const pkgName = typeof rootPkg.name === "string" ? unscoped(rootPkg.name) : path.basename(ctx.root);
    if (typeof bin === "string") res.bins.push({ name: pkgName, entry: path.posix.normalize(bin), ecosystem: "npm" });
    else if (isObj(bin))
      for (const [k, v] of Object.entries(bin))
        res.bins.push({ name: k, entry: typeof v === "string" ? path.posix.normalize(v) : undefined, ecosystem: "npm" });
    const ws = Array.isArray(rootPkg.workspaces)
      ? rootPkg.workspaces
      : isObj(rootPkg.workspaces) && Array.isArray(rootPkg.workspaces.packages)
        ? rootPkg.workspaces.packages
        : [];
    for (const w of ws) if (typeof w === "string") res.workspaces.push(w);
    if (typeof rootPkg.packageManager === "string") {
      const pm = /^(npm|pnpm|yarn|bun)@?/.exec(rootPkg.packageManager);
      if (pm) res.packageManagers.set("js", pm[1]!);
    }
  }
  const pnpmWs = await ctx.read("pnpm-workspace.yaml");
  if (pnpmWs) {
    try {
      const doc = parseYaml(pnpmWs) as unknown;
      if (isObj(doc) && Array.isArray(doc.packages))
        for (const w of doc.packages) if (typeof w === "string") res.workspaces.push(w);
    } catch {
      /* ignore */
    }
  }

  // Every package.json (depth <= 3) contributes dependencies.
  const pkgFiles = ctx.files.filter((f) => f.name === "package.json" && f.depth <= 3 && !isFixturePath(f.path));
  for (const f of pkgFiles) {
    const pkg = f.path === "package.json" ? rootPkg : safeJson(await ctx.read(f.path));
    if (!pkg) continue;
    if (f.path !== "package.json") note(f.path);
    for (const [field, dev] of [
      ["dependencies", false],
      ["devDependencies", true],
      ["optionalDependencies", false],
      ["peerDependencies", false],
    ] as const) {
      const deps = pkg[field];
      if (!isObj(deps)) continue;
      for (const [name, v] of Object.entries(deps))
        addDeps([{ name, version: typeof v === "string" ? v : undefined, ecosystem: "npm", ...(dev ? { dev } : {}) }]);
    }
  }
  if (!res.packageManagers.has("js")) {
    const lock: [string, string][] = [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lockb", "bun"],
      ["bun.lock", "bun"],
      ["package-lock.json", "npm"],
      ["npm-shrinkwrap.json", "npm"],
    ];
    const hit = lock.find(([f]) => ctx.has(f));
    if (hit) res.packageManagers.set("js", hit[1]);
    else if (rootPkg) res.packageManagers.set("js", "npm");
  }

  // deno
  for (const f of ["deno.json", "deno.jsonc"]) {
    const text = await ctx.read(f);
    if (!text) continue;
    note(f);
    const doc = safeJson(text.replace(/^\s*\/\/.*$/gm, ""));
    if (doc && isObj(doc.tasks))
      for (const [name, cmd] of Object.entries(doc.tasks))
        if (typeof cmd === "string") res.scripts.push({ name, command: cmd, source: f });
    if (!res.packageManagers.has("js")) res.packageManagers.set("js", "deno");
  }

  // ---------------- Python ----------------
  const pyFiles = ctx.files.filter((f) => f.name === "pyproject.toml" && f.depth <= 2 && !isFixturePath(f.path));
  for (const f of pyFiles) {
    const toml = safeToml(await ctx.read(f.path));
    if (!toml) continue;
    note(f.path);
    const isRoot = f.path === "pyproject.toml";
    const project = ttable(toml.project);
    const poetry = ttable(tget(toml, "tool", "poetry"));
    if (isRoot || !res.name) {
      setName(tstr(project?.name) ?? tstr(poetry?.name), f.path);
      setDesc(tstr(project?.description) ?? tstr(poetry?.description));
    }
    addDeps(pep508List(project?.dependencies, false));
    const opt = ttable(project?.["optional-dependencies"]);
    if (opt) for (const [g, list] of Object.entries(opt)) addDeps(pep508List(list, DEV_GROUP.test(g)));
    const groups = ttable(toml["dependency-groups"]);
    if (groups) for (const [, list] of Object.entries(groups)) addDeps(pep508List(list, true));
    addDeps(pep508List(tget(toml, "tool", "uv", "dev-dependencies"), true));
    if (poetry) {
      addDeps(depsFromTomlTable(poetry.dependencies, "pypi", false, ["python"]));
      addDeps(depsFromTomlTable(poetry["dev-dependencies"], "pypi", true));
      const pg = ttable(poetry.group);
      if (pg) for (const [g, v] of Object.entries(pg)) addDeps(depsFromTomlTable(tget(v, "dependencies"), "pypi", DEV_GROUP.test(g) || g !== "main"));
    }
    for (const scripts of [ttable(project?.scripts), ttable(poetry?.scripts)]) {
      if (!scripts) continue;
      for (const [name, entry] of Object.entries(scripts))
        res.bins.push({ name, entry: typeof entry === "string" ? entry : tstr(tget(entry, "reference")), ecosystem: "pypi" });
    }
    if (isRoot) {
      res.scripts.push(...tomlScriptMap(ttable(tget(toml, "tool", "poe", "tasks")), f.path, (n) => `poe ${n}`));
      res.scripts.push(...tomlScriptMap(ttable(tget(toml, "tool", "pdm", "scripts")), f.path, (n) => `pdm run ${n}`));
      res.scripts.push(...tomlScriptMap(ttable(tget(toml, "tool", "hatch", "envs", "default", "scripts")), f.path, (n) => `hatch run ${n}`));
      if (poetry) res.packageManagers.set("python", "poetry");
      if (tget(toml, "tool", "uv")) res.packageManagers.set("python", "uv");
      if (tget(toml, "tool", "pdm")) res.packageManagers.set("python", "pdm");
      if (tget(toml, "tool", "pytest")) res.hints.add("pytest");
    }
  }
  const reqFiles = ctx.files.filter(
    (f) => f.depth <= 2 && !isFixturePath(f.path) && (/^requirements.*\.(txt|in)$/i.test(f.name) || /(^|\/)requirements\/[^/]+\.(txt|in)$/i.test(f.path)),
  );
  for (const f of reqFiles) {
    const text = await ctx.read(f.path);
    if (!text) continue;
    note(f.path);
    const dev = /dev|test|lint|doc/i.test(f.path);
    for (const d of parseRequirements(text)) addDeps([{ name: d.name, version: d.version, ecosystem: "pypi", ...(dev ? { dev } : {}) }]);
  }
  const setupPy = await ctx.read("setup.py");
  if (setupPy) {
    note("setup.py");
    setName(/\bname\s*=\s*['"]([^'"]+)['"]/.exec(setupPy)?.[1], "setup.py");
    setDesc(/\bdescription\s*=\s*['"]([^'"]+)['"]/.exec(setupPy)?.[1]);
    const ir = /install_requires\s*=\s*\[([^\]]*)\]/s.exec(setupPy);
    if (ir)
      for (const m of ir[1]!.matchAll(/['"]([^'"]+)['"]/g)) {
        const d = parsePep508(m[1]!);
        if (d) addDeps([{ name: d.name, version: d.version, ecosystem: "pypi" }]);
      }
    for (const m of setupPy.matchAll(/['"]([\w.-]+)\s*=\s*([\w.]+:[\w.]+)['"]/g))
      res.bins.push({ name: m[1]!, entry: m[2]!, ecosystem: "pypi" });
  }
  const pipfile = await ctx.read("Pipfile");
  if (pipfile) {
    note("Pipfile");
    const t = parseToml(pipfile);
    addDeps(depsFromTomlTable(t.packages, "pypi", false));
    addDeps(depsFromTomlTable(t["dev-packages"], "pypi", true));
    res.scripts.push(...tomlScriptMap(ttable(t.scripts), "Pipfile", (n) => `pipenv run ${n}`));
  }
  if (!res.packageManagers.has("python") || ctx.has("uv.lock")) {
    const py: [string, string][] = [
      ["uv.lock", "uv"],
      ["poetry.lock", "poetry"],
      ["pdm.lock", "pdm"],
      ["Pipfile.lock", "pipenv"],
      ["Pipfile", "pipenv"],
    ];
    const hit = py.find(([f]) => ctx.has(f));
    if (hit) res.packageManagers.set("python", hit[1]);
    else if (!res.packageManagers.has("python") && (pyFiles.length || reqFiles.length || setupPy))
      res.packageManagers.set("python", "pip");
  }

  // ---------------- Go ----------------
  const goMods = ctx.files.filter((f) => f.name === "go.mod" && f.depth <= 2 && !isFixturePath(f.path));
  for (const f of goMods) {
    const text = await ctx.read(f.path);
    if (!text) continue;
    note(f.path);
    const mod = /^module\s+(\S+)/m.exec(text)?.[1];
    if (f.path === "go.mod" && mod) setName(mod.split("/").pop(), "go.mod");
    const addGo = (line: string) => {
      const m = /^\s*([\w.\-/~]+\.[\w.\-/~]+)\s+(v[\w.\-+]+)(\s*\/\/\s*indirect)?/.exec(line);
      if (m && !m[3]) addDeps([{ name: m[1]!, version: m[2]!, ecosystem: "go" }]);
    };
    for (const block of text.matchAll(/^require\s*\(([^)]*)\)/gm)) for (const l of block[1]!.split("\n")) addGo(l);
    for (const m of text.matchAll(/^require\s+([^(\s].*)$/gm)) addGo(m[1]!);
    res.packageManagers.set("go", "go");
  }

  // ---------------- Rust ----------------
  const cargo = safeToml(await ctx.read("Cargo.toml"));
  if (cargo) {
    note("Cargo.toml");
    const pkg = ttable(cargo.package);
    setName(tstr(pkg?.name), "Cargo.toml");
    setDesc(tstr(pkg?.description));
    addDeps(depsFromTomlTable(cargo.dependencies, "cargo", false));
    addDeps(depsFromTomlTable(cargo["dev-dependencies"], "cargo", true));
    addDeps(depsFromTomlTable(tget(cargo, "workspace", "dependencies"), "cargo", false));
    const members = tget(cargo, "workspace", "members");
    if (Array.isArray(members)) for (const m of members) if (typeof m === "string") res.workspaces.push(m);
    const bins = cargo.bin;
    if (Array.isArray(bins))
      for (const b of bins) {
        const n = tstr(tget(b, "name"));
        if (n) res.bins.push({ name: n, entry: tstr(tget(b, "path")), ecosystem: "cargo" });
      }
    res.packageManagers.set("rust", "cargo");
  }
  for (const f of ctx.files.filter((f) => f.name === "Cargo.toml" && f.depth >= 1 && f.depth <= 2 && !isFixturePath(f.path))) {
    const t = safeToml(await ctx.read(f.path));
    if (!t) continue;
    note(f.path);
    addDeps(depsFromTomlTable(t.dependencies, "cargo", false));
    res.packageManagers.set("rust", "cargo");
  }

  // ---------------- Ruby ----------------
  const gemfile = await ctx.read("Gemfile");
  if (gemfile) {
    note("Gemfile");
    let devDepth = 0;
    for (const line of gemfile.split(/\r?\n/)) {
      const t = line.trim();
      if (/^group\b.*\bdo\b/.test(t)) {
        devDepth = /:(development|test)/.test(t) ? devDepth + 1 : devDepth;
        continue;
      }
      if (t === "end" && devDepth > 0) {
        devDepth--;
        continue;
      }
      const m = /^gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/.exec(t);
      if (m) addDeps([{ name: m[1]!, version: m[2], ecosystem: "rubygems", ...(devDepth > 0 ? { dev: true } : {}) }]);
    }
    res.packageManagers.set("ruby", "bundler");
  }
  const rakefile = await ctx.read("Rakefile");
  if (rakefile) res.scripts.push(...rakeScripts(rakefile, "Rakefile"));

  // ---------------- PHP ----------------
  const composer = safeJson(await ctx.read("composer.json"));
  if (composer) {
    note("composer.json");
    setName(typeof composer.name === "string" ? composer.name.split("/").pop() : undefined, "composer.json");
    setDesc(typeof composer.description === "string" ? composer.description : undefined);
    for (const [field, dev] of [["require", false], ["require-dev", true]] as const) {
      const deps = composer[field];
      if (isObj(deps))
        for (const [name, v] of Object.entries(deps))
          if (name !== "php" && !name.startsWith("ext-"))
            addDeps([{ name, version: typeof v === "string" ? v : undefined, ecosystem: "composer", ...(dev ? { dev } : {}) }]);
    }
    if (isObj(composer.scripts))
      for (const [name, v] of Object.entries(composer.scripts)) {
        const cmd = typeof v === "string" ? v : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" && ") : "";
        if (cmd) res.scripts.push({ name, command: cmd, source: "composer.json" });
      }
    if (Array.isArray(composer.bin))
      for (const b of composer.bin) if (typeof b === "string") res.bins.push({ name: path.posix.basename(b), entry: b, ecosystem: "composer" });
    res.packageManagers.set("php", "composer");
  }

  // ---------------- JVM ----------------
  const pom = await ctx.read("pom.xml");
  if (pom) {
    note("pom.xml");
    const artifact = /<project[\s\S]*?<artifactId>([^<]+)<\/artifactId>/.exec(pom.replace(/<parent>[\s\S]*?<\/parent>/, ""))?.[1];
    setName(artifact, "pom.xml");
    setDesc(/<description>([^<]+)<\/description>/.exec(pom)?.[1]);
    for (const m of pom.matchAll(
      /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/g,
    ))
      addDeps([{ name: `${m[1]}:${m[2]}`, version: m[3], ecosystem: "maven" }]);
    if (/spring-boot/.test(pom)) res.hints.add("spring");
    res.packageManagers.set("jvm", "maven");
  }
  const gradleFile = ctx.first("build.gradle.kts", "build.gradle");
  if (gradleFile) {
    const gradle = await ctx.read(gradleFile);
    note(gradleFile);
    if (gradle) {
      for (const m of gradle.matchAll(/\b(implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?\s*["']([\w.\-]+):([\w.\-]+)(?::([\w.\-]+))?["']/g))
        addDeps([{ name: `${m[2]}:${m[3]}`, version: m[4], ecosystem: "maven", ...(m[1] === "testImplementation" ? { dev: true } : {}) }]);
      if (/org\.springframework\.boot/.test(gradle)) res.hints.add("spring");
    }
    res.packageManagers.set("jvm", "gradle");
  }

  // ---------------- Task runners ----------------
  for (const f of ["Makefile", "makefile", "GNUmakefile"]) {
    const text = await ctx.read(f);
    if (text) {
      res.scripts.push(...parseMakefile(text, f));
      break;
    }
  }
  for (const f of ["justfile", "Justfile", ".justfile"]) {
    const text = await ctx.read(f);
    if (text) {
      res.scripts.push(...parseJustfile(text, f));
      break;
    }
  }
  for (const f of ["Taskfile.yml", "Taskfile.yaml", "taskfile.yml", "taskfile.yaml"]) {
    const text = await ctx.read(f);
    if (text) {
      res.scripts.push(...taskfileScripts(text, f));
      break;
    }
  }
  const procfile = await ctx.read("Procfile");
  if (procfile) res.scripts.push(...procfileScripts(procfile, "Procfile"));
  for (const f of ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"]) {
    const text = await ctx.read(f);
    if (text) {
      res.scripts.push(...composeScripts(text, f));
      break;
    }
  }

  // ---------------- Inferred defaults (only when nothing declares them) ----------------
  const has = (n: string) => res.scripts.some((s) => s.name === n);
  const pyDeps = new Set(res.dependencies.filter((d) => d.ecosystem === "pypi").map((d) => d.name));
  if (!has("test")) {
    if (pyDeps.has("pytest") || res.hints.has("pytest") || ctx.has("pytest.ini") || ctx.has("conftest.py")) {
      const pm = res.packageManagers.get("python");
      const prefix = pm === "poetry" ? "poetry run " : pm === "uv" ? "uv run " : pm === "pipenv" ? "pipenv run " : pm === "pdm" ? "pdm run " : "";
      res.scripts.push({ name: "test", command: `${prefix}pytest`, source: "inferred" });
    } else if (goMods.some((f) => f.path === "go.mod")) res.scripts.push({ name: "test", command: "go test ./...", source: "inferred" });
    else if (cargo) res.scripts.push({ name: "test", command: "cargo test", source: "inferred" });
    else if (pom) res.scripts.push({ name: "test", command: "mvn test", source: "inferred" });
    else if (gradleFile) res.scripts.push({ name: "test", command: `${ctx.has("gradlew") ? "./gradlew" : "gradle"} test`, source: "inferred" });
  }
  if (!has("build")) {
    if (goMods.some((f) => f.path === "go.mod")) res.scripts.push({ name: "build", command: "go build ./...", source: "inferred" });
    else if (cargo) res.scripts.push({ name: "build", command: "cargo build", source: "inferred" });
  }
  if (!has("lint") && (pyDeps.has("ruff") || ctx.has("ruff.toml") || ctx.has(".ruff.toml")))
    res.scripts.push({ name: "lint", command: "ruff check .", source: "inferred" });

  // Dedupe dependencies (first occurrence wins; a non-dev declaration beats a dev one).
  const depMap = new Map<string, DependencyInfo>();
  for (const d of res.dependencies) {
    const key = `${d.ecosystem}:${d.name}`;
    const prev = depMap.get(key);
    if (!prev) depMap.set(key, d);
    else if (prev.dev && !d.dev) depMap.set(key, { ...d, version: d.version ?? prev.version });
  }
  res.dependencies = [...depMap.values()];
  // Dedupe scripts by name+source.
  const seen = new Set<string>();
  res.scripts = res.scripts.filter((s) => {
    const k = `${s.source}#${s.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  res.workspaces = [...new Set(res.workspaces)];
  return res;
}

/** Pick one package manager, preferring the ecosystem of the primary language. */
export function choosePackageManager(pms: Map<string, string>, primaryLanguage?: string): string | undefined {
  const family: Record<string, string> = {
    TypeScript: "js", JavaScript: "js", Vue: "js", Svelte: "js", Astro: "js",
    Python: "python", Go: "go", Rust: "rust", Ruby: "ruby", PHP: "php",
    Java: "jvm", Kotlin: "jvm", Scala: "jvm",
  };
  const fam = primaryLanguage ? family[primaryLanguage] : undefined;
  if (fam && pms.has(fam)) return pms.get(fam);
  for (const f of ["js", "python", "go", "rust", "ruby", "php", "jvm"]) if (pms.has(f)) return pms.get(f);
  return undefined;
}

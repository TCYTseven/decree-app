import type { WalkResult } from "./walk.js";

interface Node {
  name: string;
  dirs: Map<string, Node>;
  files: string[];
  total: number; // files in subtree
}

function newNode(name: string): Node {
  return { name, dirs: new Map(), files: [], total: 0 };
}

export interface TreeOptions {
  maxDepth?: number; // default 3
  maxLines?: number; // default 150
}

/** Depth-limited ascii tree with per-directory caps ("… 34 more"). */
export function renderTree(rootName: string, walk: WalkResult, opts: TreeOptions = {}): string {
  const maxDepth = opts.maxDepth ?? 3;
  const maxLines = opts.maxLines ?? 150;
  const root = newNode(rootName);
  const ensureDir = (rel: string): Node => {
    let n = root;
    for (const seg of rel.split("/")) {
      let c = n.dirs.get(seg);
      if (!c) n.dirs.set(seg, (c = newNode(seg)));
      n = c;
    }
    return n;
  };
  for (const d of walk.dirs) ensureDir(d);
  for (const f of walk.files) {
    const i = f.path.lastIndexOf("/");
    const parent = i < 0 ? root : ensureDir(f.path.slice(0, i));
    parent.files.push(f.name);
  }
  const count = (n: Node): number => (n.total = n.files.length + [...n.dirs.values()].reduce((s, c) => s + count(c), 0));
  count(root);

  const perDirCap = [40, 16, 10, 8, 6];
  const lines: string[] = [`${rootName}/`];
  let truncated = false;
  const render = (n: Node, prefix: string, depth: number) => {
    const dirs = [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const files = [...n.files].sort((a, b) => a.localeCompare(b));
    const entries: { label: string; node?: Node }[] = [
      ...dirs.map((d) => ({ label: `${d.name}/`, node: d })),
      ...files.map((f) => ({ label: f })),
    ];
    const cap = perDirCap[Math.min(depth, perDirCap.length - 1)]!;
    const shown = entries.length > cap ? entries.slice(0, cap - 1) : entries;
    const hidden = entries.length - shown.length;
    shown.forEach((e, idx) => {
      if (lines.length >= maxLines) {
        truncated = true;
        return;
      }
      const last = idx === shown.length - 1 && hidden === 0;
      const branch = last ? "└── " : "├── ";
      if (e.node && depth + 1 >= maxDepth && (e.node.dirs.size || e.node.files.length)) {
        lines.push(`${prefix}${branch}${e.label} (${e.node.total} file${e.node.total === 1 ? "" : "s"})`);
        return;
      }
      lines.push(`${prefix}${branch}${e.label}`);
      if (e.node) render(e.node, prefix + (last ? "    " : "│   "), depth + 1);
    });
    if (hidden > 0 && lines.length < maxLines) lines.push(`${prefix}└── … ${hidden} more`);
  };
  render(root, "", 0);
  if (truncated || lines.length >= maxLines) {
    lines.length = Math.min(lines.length, maxLines - 1);
    lines.push("… (tree truncated)");
  }
  return lines.join("\n");
}

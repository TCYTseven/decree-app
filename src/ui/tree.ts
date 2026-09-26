import { c, sym } from "./theme.js";

export type FileStatus = "created" | "updated" | "unchanged" | "skipped" | "removed";

export interface TreeEntry {
  path: string; // POSIX, relative
  status: FileStatus;
}

interface Node {
  name: string;
  children: Map<string, Node>;
  status?: FileStatus; // leaf only
}

const LABEL: Record<FileStatus, (s: string) => string> = {
  created: (s) => c.green(s),
  updated: (s) => c.yellow(s),
  unchanged: (s) => c.dim(s),
  skipped: (s) => c.magenta(s),
  removed: (s) => c.red(s),
};

const TEXT: Record<FileStatus, string> = {
  created: "created",
  updated: "updated",
  unchanged: "unchanged",
  skipped: "skipped (edited by you)",
  removed: "removed",
};

function leaves(n: Node): FileStatus[] {
  if (!n.children.size) return n.status ? [n.status] : [];
  return [...n.children.values()].flatMap(leaves);
}

function sortNodes(a: Node, b: Node): number {
  const ad = a.children.size > 0;
  const bd = b.children.size > 0;
  if (ad !== bd) return ad ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Render written files as a tree. Directories whose files are all unchanged
 * collapse to a single line so re-runs stay short.
 */
export function renderFileTree(
  entries: TreeEntry[],
  rootLabel: string,
  opts: { collapseUnchanged?: boolean; maxLines?: number } = {},
): string {
  const collapse = opts.collapseUnchanged ?? true;
  const maxLines = opts.maxLines ?? 20;
  const root: Node = { name: rootLabel, children: new Map() };
  for (const e of entries) {
    const parts = e.path.split("/").filter(Boolean);
    let cur = root;
    parts.forEach((part, i) => {
      let next = cur.children.get(part);
      if (!next) {
        next = { name: part, children: new Map() };
        cur.children.set(part, next);
      }
      if (i === parts.length - 1) next.status = e.status;
      cur = next;
    });
  }
  // Directories to fold into one line: all-unchanged ones always, then uniform
  // ones (deepest first) until the tree fits in maxLines.
  const folded = new Set<Node>();
  const dirs: { node: Node; depth: number; size: number; uniform: boolean }[] = [];
  const collect = (n: Node, depth: number) => {
    for (const kid of n.children.values()) {
      if (!kid.children.size) continue;
      const st = leaves(kid);
      dirs.push({ node: kid, depth, size: st.length, uniform: st.length > 1 && st.every((x) => x === st[0]) });
      collect(kid, depth + 1);
    }
  };
  collect(root, 1);
  const count = (n: Node): number =>
    [...n.children.values()].reduce((a, k) => a + 1 + (k.children.size && !folded.has(k) ? count(k) : 0), 0);
  const isFoldedAncestor = (n: Node): boolean => dirs.some((d) => folded.has(d.node) && d.node !== n && contains(d.node, n));
  const contains = (a: Node, b: Node): boolean => [...a.children.values()].some((k) => k === b || contains(k, b));
  if (collapse) for (const d of dirs) if (d.uniform && leaves(d.node)[0] === "unchanged") folded.add(d.node);
  const candidates = dirs.filter((d) => d.uniform && !folded.has(d.node)).sort((a, b) => b.depth - a.depth || b.size - a.size);
  for (const d of candidates) {
    if (count(root) + 1 <= maxLines) break;
    if (!isFoldedAncestor(d.node)) folded.add(d.node);
  }

  const lines = [c.bold(rootLabel.endsWith("/") ? rootLabel : `${rootLabel}/`)];
  const walk = (node: Node, prefix: string) => {
    const all = [...node.children.values()].sort(sortNodes);
    // In a directory with changes, unchanged files are summarized in one line instead of listed.
    const mixed = collapse && all.some((k) => k.children.size || k.status !== "unchanged");
    const kids = mixed ? all.filter((k) => k.children.size || k.status !== "unchanged") : all;
    const hidden = all.length - kids.length;
    kids.forEach((kid, i) => {
      const last = i === kids.length - 1 && !hidden;
      const branch = c.dim(last ? "└── " : "├── ");
      const nextPrefix = prefix + c.dim(last ? "    " : "│   ");
      if (kid.children.size) {
        const st = leaves(kid);
        if (folded.has(kid)) {
          const label = `${st.length} ${st[0] === "skipped" ? "skipped" : st[0]}`;
          lines.push(
            st[0] === "unchanged"
              ? `${prefix}${branch}${c.dim(`${kid.name}/`)} ${c.dim(`${sym.dot} ${label}`)}`
              : `${prefix}${branch}${c.cyan(`${kid.name}/`)} ${c.dim(sym.dot)} ${LABEL[st[0]](label)}`,
          );
          return;
        }
        lines.push(`${prefix}${branch}${c.cyan(`${kid.name}/`)}`);
        walk(kid, nextPrefix);
      } else {
        const st = kid.status ?? "unchanged";
        const name = st === "unchanged" ? c.dim(kid.name) : st === "removed" ? c.strikethrough(kid.name) : kid.name;
        lines.push(`${prefix}${branch}${name} ${LABEL[st](TEXT[st])}`);
      }
    });
    if (hidden) lines.push(`${prefix}${c.dim(`└── ${hidden} unchanged file${hidden === 1 ? "" : "s"}`)}`);
  };
  walk(root, "");
  return lines.join("\n");
}

export function summarizeStatuses(entries: TreeEntry[]): string {
  const counts = new Map<FileStatus, number>();
  for (const e of entries) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  const order: FileStatus[] = ["created", "updated", "unchanged", "skipped", "removed"];
  return order
    .filter((s) => counts.get(s))
    .map((s) => LABEL[s](`${counts.get(s)} ${s}`))
    .join(c.dim(", "));
}

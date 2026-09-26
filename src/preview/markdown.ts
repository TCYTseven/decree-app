/**
 * A tiny, safe markdown renderer for the preview dashboard.
 *
 * Safety: the whole input is HTML-escaped FIRST; the renderer then only ever emits its own fixed set of
 * tags. Link targets are restricted to http(s), mailto and in-page anchors. The function is fully
 * self-contained (no imports, no outer references) because the page embeds it via `toString()` so the
 * browser and the unit tests run exactly the same code.
 *
 * Supports: ATX headings, paragraphs, bold/italic, inline code, fenced code blocks, (nested) bullet and
 * numbered lists, task list items, blockquotes, horizontal rules, GFM tables, and links.
 */
export function renderMarkdown(src: string): string {
  const MARK = String.fromCharCode(1);
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const inline = (raw: string): string => {
    const stash: string[] = [];
    const keep = (html: string): string => {
      stash.push(html);
      return MARK + (stash.length - 1) + MARK;
    };
    let s = esc(raw.split(MARK).join(""));
    s = s.replace(/`([^`]+)`/g, (_m, code: string) => keep("<code>" + code + "</code>"));
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
      const target = href.replace(/&amp;/g, "&");
      if (!/^(https?:\/\/|mailto:|#)/i.test(target)) return text;
      return keep('<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + text + "</a>");
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)'"])/g, (_m, pre: string, url: string) =>
      pre + keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>"),
    );
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>");
    s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
    const re = new RegExp(MARK + "(\\d+)" + MARK, "g");
    for (let i = 0; i < 3 && s.indexOf(MARK) !== -1; i++) s = s.replace(re, (_m, n: string) => stash[Number(n)] ?? "");
    return s;
  };

  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const isFence = (l: string) => /^\s{0,3}(```|~~~)/.exec(l);
  const isHeading = (l: string) => /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
  const isHr = (l: string) => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
  const isItem = (l: string) => /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(l);
  const isQuote = (l: string) => /^\s{0,3}>/.test(l);
  const isTableSep = (l: string) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(l) && l.indexOf("-") !== -1;
  const cells = (l: string): string[] => {
    let t = l.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
    return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  };
  const startsBlock = (l: string, next: string | undefined) =>
    !!isFence(l) || !!isHeading(l) || isHr(l) || !!isItem(l) || isQuote(l) || (l.indexOf("|") !== -1 && next !== undefined && isTableSep(next));

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = isFence(line);
    if (fence) {
      const marker = fence[1];
      const lang = line.trim().slice(3).trim().split(/\s+/)[0] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i++;
      const cls = lang ? ' class="lang-' + esc(lang.replace(/[^\w+-]/g, "")) + '"' : "";
      out.push("<pre><code" + cls + ">" + esc(body.join("\n")) + "</code></pre>");
      continue;
    }
    const h = isHeading(line);
    if (h) {
      const level = h[1].length;
      const text = h[2];
      const id = text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
      out.push("<h" + level + ' id="md-' + esc(id) + '">' + inline(text) + "</h" + level + ">");
      i++;
      continue;
    }
    if (isHr(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (isQuote(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && isQuote(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      out.push("<blockquote>" + renderMarkdown(body.join("\n")) + "</blockquote>");
      continue;
    }
    if (line.indexOf("|") !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : ""));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") !== -1) rows.push(cells(lines[i++]));
      const td = (tag: string, c: string, k: number) =>
        "<" + tag + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "") + ">" + inline(c) + "</" + tag + ">";
      out.push(
        '<div class="md-table"><table><thead><tr>' +
          head.map((c, k) => td("th", c, k)).join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + head.map((_c, k) => td("td", r[k] ?? "", k)).join("") + "</tr>").join("") +
          "</tbody></table></div>",
      );
      continue;
    }
    if (isItem(line)) {
      const stack: { indent: number; tag: string }[] = [];
      let html = "";
      while (i < lines.length) {
        const l = lines[i];
        const m = isItem(l);
        if (!m) {
          if (!l.trim()) {
            // A blank line ends the list unless the next line continues it.
            const nxt = lines[i + 1];
            if (nxt !== undefined && (isItem(nxt) || /^\s{2,}\S/.test(nxt))) {
              i++;
              continue;
            }
            break;
          }
          if (/^\s{2,}\S/.test(l) && !isFence(l)) {
            html += " " + inline(l.trim());
            i++;
            continue;
          }
          break;
        }
        const indent = m[1].replace(/\t/g, "    ").length;
        const tag = /^\d/.test(m[2]) ? "ol" : "ul";
        while (stack.length && indent < stack[stack.length - 1].indent) {
          html += "</li></" + stack.pop()!.tag + ">";
        }
        const top = stack[stack.length - 1];
        let open = !top || indent > top.indent;
        if (top && indent === top.indent && top.tag !== tag) {
          // "- a" followed by "1. b" at the same depth starts a new list.
          html += "</li></" + stack.pop()!.tag + ">";
          open = true;
        }
        if (open) {
          const start = tag === "ol" ? parseInt(m[2], 10) : 1;
          html += "<" + tag + (tag === "ol" && start !== 1 ? ' start="' + start + '"' : "") + ">";
          stack.push({ indent, tag });
        } else {
          html += "</li>";
        }
        let text = m[3];
        const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
        if (task) {
          text = task[2];
          html += '<li class="task"><span class="check' + (task[1] === " " ? "" : " done") + '" aria-hidden="true"></span>' + inline(text);
        } else {
          html += "<li>" + inline(text);
        }
        i++;
      }
      while (stack.length) html += "</li></" + stack.pop()!.tag + ">";
      out.push(html);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim());
    out.push("<p>" + para.map(inline).join("<br>") + "</p>");
  }
  return out.join("\n");
}

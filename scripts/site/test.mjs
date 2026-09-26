// UI test + screenshot run for site/. Usage: node test.mjs [--shots-only]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8765/";
const DIR = path.dirname(new URL(import.meta.url).pathname);
const SHOTS = path.join(DIR, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PAGES = ["index.html", "docs/index.html", "docs/commands.html", "docs/config.html", "docs/targets.html", "docs/safety.html", "docs/faq.html"];
const only = process.argv.includes("--shots-only");
const fullShots = !process.argv.includes("--no-full");

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, "--proxy-bypass-list=127.0.0.1;localhost"] : [],
});

const failures = [];
const notes = [];
function fail(msg) { failures.push(msg); console.log("FAIL", msg); }

// Google Fonts are served from a local cache (fetched once with curl through the agent proxy),
// because the sandbox proxy intermittently drops browser requests. Production loads them from Google.
const FC = path.join(DIR, "fontcache");
async function routeFonts(ctx) {
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => {
    const u = route.request().url();
    if (u.includes("fonts.googleapis.com")) return route.fulfill({ status: 200, contentType: "text/css", body: fs.readFileSync(path.join(FC, "fonts.css")), headers: { "access-control-allow-origin": "*" } });
    const f = path.join(FC, u.replace("https://fonts.gstatic.com/", "").replace(/\//g, "_"));
    if (fs.existsSync(f)) return route.fulfill({ status: 200, contentType: "font/woff2", body: fs.readFileSync(f), headers: { "access-control-allow-origin": "*" } });
    return route.abort();
  });
}

async function newPage(width, scheme) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 812 : 900 }, colorScheme: scheme, ignoreHTTPSErrors: true, deviceScaleFactor: 1 });
  await routeFonts(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("requestfailed", (r) => errors.push("requestfailed: " + r.url() + " " + (r.failure()?.errorText || "")));
  return { ctx, page, errors };
}

async function settle(page, name) {
  await page.evaluate(() => document.fonts.ready);
  if (name === "index.html") {
    await page.waitForFunction(() => { const c = document.querySelector("#term-init .t-caret"); return c && !c.hidden && c.closest(".ln") && !c.closest(".ln").hidden; }, null, { timeout: 20000 }).catch(() => fail("terminal animation did not finish"));
  }
  await page.waitForTimeout(150);
}

// ---------- screenshots, overflow, console errors ----------
for (const name of PAGES) {
  for (const width of [1440, 375, 360]) {
    for (const scheme of ["light", "dark"]) {
      const { ctx, page, errors } = await newPage(width, scheme);
      const res = await page.goto(BASE + name, { waitUntil: "networkidle" });
      if (!res || res.status() !== 200) fail(`${name} status ${res && res.status()}`);
      await settle(page, name);
      const ov = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: window.innerWidth }));
      if (ov.sw > ov.iw) {
        const culprits = await page.evaluate(() => {
          const out = [];
          for (const el of document.querySelectorAll("body *")) {
            const r = el.getBoundingClientRect();
            if (r.right > window.innerWidth + 1 && r.width > 0) out.push(el.tagName + "." + el.className + " " + Math.round(r.right));
          }
          return out.slice(0, 8);
        });
        fail(`${name} @${width} ${scheme}: horizontal overflow ${ov.sw} > ${ov.iw} ${culprits.join(" | ")}`);
      }
      if (errors.length) fail(`${name} @${width} ${scheme}: console errors: ${errors.join(" ; ")}`);
      const slug = name.replace(/\//g, "_").replace(".html", "");
      if (width !== 360) {
        await page.screenshot({ path: path.join(SHOTS, `${slug}-${width}-${scheme}-fold.png`) });
        await page.screenshot({ path: path.join(SHOTS, `${slug}-${width}-${scheme}.png`), fullPage: fullShots });
      }
      await ctx.close();
    }
  }
}
if (only) { await browser.close(); console.log(failures.length ? `${failures.length} failures` : "shots ok"); process.exit(failures.length ? 1 : 0); }

// ---------- link crawl ----------
{
  const { ctx, page } = await newPage(1440, "light");
  const seen = new Set();
  const queue = [BASE + "index.html"];
  const idsByPage = {};
  const links = [];
  while (queue.length) {
    const url = queue.shift();
    const clean = url.split("#")[0];
    if (seen.has(clean)) continue;
    seen.add(clean);
    const res = await page.goto(clean, { waitUntil: "domcontentloaded" });
    if (!res || res.status() !== 200) { fail(`broken link target ${clean} (${res && res.status()})`); continue; }
    idsByPage[clean] = await page.evaluate(() => [...document.querySelectorAll("[id]")].map((e) => e.id));
    const hrefs = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href));
    for (const h of hrefs) {
      links.push([clean, h]);
      if (h.startsWith(BASE) && !seen.has(h.split("#")[0])) queue.push(h);
    }
  }
  let internal = 0, external = new Set();
  for (const [from, h] of links) {
    if (!h.startsWith(BASE)) { external.add(h); continue; }
    internal++;
    const [target, frag] = h.split("#");
    if (frag && !(idsByPage[target] || []).includes(decodeURIComponent(frag))) fail(`missing anchor #${frag} on ${target} (from ${from})`);
  }
  notes.push(`crawl: ${seen.size} pages, ${internal} internal links checked, external: ${[...external].join(", ")}`);
  await ctx.close();
}

// ---------- copy buttons ----------
{
  const { ctx, page } = await newPage(1440, "light");
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE.replace(/\/$/, "") });
  await page.goto(BASE + "index.html", { waitUntil: "networkidle" });
  await page.click(".hero .copy-btn");
  let clip = await page.evaluate(() => navigator.clipboard.readText());
  if (clip !== "npx decree-harness") fail(`hero copy gave ${JSON.stringify(clip)}`);
  const copied = await page.getAttribute(".hero .copy-btn", "data-copied");
  if (copied === null) fail("hero copy button did not show copied state");
  await page.goto(BASE + "docs/index.html", { waitUntil: "networkidle" });
  await page.click(".code .copy-btn >> nth=0");
  clip = await page.evaluate(() => navigator.clipboard.readText());
  if (!clip.startsWith("export ANTHROPIC_API_KEY") || clip.includes("$ ")) fail(`docs copy gave ${JSON.stringify(clip)}`);
  notes.push(`copy: hero -> ${JSON.stringify("npx decree-harness")}, docs first block -> ${JSON.stringify(clip.split("\n")[0])}`);
  await ctx.close();
}

// ---------- theme toggle persistence ----------
{
  const { ctx, page } = await newPage(1440, "light");
  await page.goto(BASE + "index.html");
  await page.click("[data-theme-toggle]");
  await page.reload();
  const t = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  if (t !== "dark") fail(`theme toggle not persisted (${t})`);
  notes.push(`theme toggle: persisted ${t}, body bg ${bg}`);
  await ctx.close();
}

// ---------- keyboard order ----------
for (const name of ["index.html", "docs/config.html"]) {
  const { ctx, page } = await newPage(1440, "light");
  await page.goto(BASE + name, { waitUntil: "networkidle" });
  const order = [];
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(() => {
      const a = document.activeElement;
      const r = a.getBoundingClientRect();
      const ring = getComputedStyle(a).outlineStyle !== "none" || getComputedStyle(a).boxShadow !== "none";
      return `${a.tagName.toLowerCase()}${a.className ? "." + String(a.className).split(" ")[0] : ""}[${(a.getAttribute("aria-label") || a.textContent || "").trim().slice(0, 24)}]${ring ? "" : "(no ring)"}`;
    }));
  }
  if (!order[0].includes("skip-link")) fail(`${name}: first tab stop is not skip link: ${order[0]}`);
  if (order.some((o) => o.includes("(no ring)"))) fail(`${name}: focus without visible ring: ${order.filter((o) => o.includes("(no ring)")).join(", ")}`);
  notes.push(`tab order ${name}: ${order.join(" > ")}`);
  await ctx.close();
}

// ---------- basic a11y checks ----------
for (const scheme of ["light", "dark"]) {
  for (const name of PAGES) {
    const { ctx, page } = await newPage(1440, scheme);
    await page.goto(BASE + name, { waitUntil: "networkidle" });
    await settle(page, name);
    const r = await page.evaluate(() => {
      const issues = [];
      const accName = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || (el.querySelector("img[alt]")?.alt ?? "")).trim();
      document.querySelectorAll("img").forEach((i) => { if (!i.hasAttribute("alt")) issues.push("img without alt " + i.src); });
      document.querySelectorAll("button").forEach((b) => { if (!accName(b)) issues.push("button without name " + b.outerHTML.slice(0, 80)); });
      document.querySelectorAll("a[href]").forEach((a) => { if (!accName(a)) issues.push("link without name " + a.href); });
      document.querySelectorAll("svg").forEach((s) => { if (!s.getAttribute("aria-hidden") && !s.getAttribute("role")) issues.push("svg not hidden " + s.outerHTML.slice(0, 60)); });
      if (document.querySelectorAll("main").length !== 1) issues.push("main count " + document.querySelectorAll("main").length);
      if (!document.querySelector("header") || !document.querySelector("footer")) issues.push("missing header/footer landmark");
      if (!document.documentElement.lang) issues.push("missing lang");
      const hs = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter((h) => h.offsetParent !== null || h.closest("details"));
      if (document.querySelectorAll("h1").length !== 1) issues.push("h1 count " + document.querySelectorAll("h1").length);
      let prev = 0;
      for (const h of hs) { const l = +h.tagName[1]; if (prev && l > prev + 1) issues.push(`heading jump h${prev} -> h${l}: ${h.textContent.trim().slice(0, 30)}`); prev = l; }
      const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
      const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
      if (dup.length) issues.push("duplicate ids " + dup.join(","));
      // contrast
      const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
      const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bgOf = (el) => { let layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255 }; for (const c of layers.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) }; return base; };
      let checked = 0, worst = 99, worstEl = "";
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const els = new Set();
      while (walker.nextNode()) { const t = walker.currentNode; if (t.textContent.trim() && t.parentElement) els.add(t.parentElement); }
      for (const el of els) {
        const cs = getComputedStyle(el);
        if (el.closest("[hidden], .sr-only, .skip-link") || el.offsetParent === null && cs.position !== "fixed") continue;
        const fg = parse(cs.color); if (!fg) continue;
        const bg = bgOf(el);
        const L1 = lum(fg), L2 = lum(bg);
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
        const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
        checked++;
        if (ratio < worst) { worst = ratio; worstEl = el.tagName + "." + el.className + " '" + el.textContent.trim().slice(0, 20) + "'"; }
        if (ratio < need) issues.push(`contrast ${ratio.toFixed(2)} < ${need}: ${el.tagName}.${el.className} '${el.textContent.trim().slice(0, 30)}' ${cs.color} on rgb(${bg.r|0},${bg.g|0},${bg.b|0})`);
      }
      return { issues: [...new Set(issues)].slice(0, 15), checked, worst: worst.toFixed(2), worstEl };
    });
    if (r.issues.length) fail(`${name} (${scheme}) a11y: ${r.issues.join(" || ")}`);
    notes.push(`a11y ${name} ${scheme}: ${r.checked} text nodes checked, min contrast ${r.worst} (${r.worstEl})`);
    await ctx.close();
  }
}

// ---------- reduced motion ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", ignoreHTTPSErrors: true });
  await routeFonts(ctx);
  const page = await ctx.newPage();
  await page.goto(BASE + "index.html", { waitUntil: "networkidle" });
  const hiddenLines = await page.evaluate(() => document.querySelectorAll("#term-init .ln[hidden]").length);
  const cmd = await page.textContent("#term-init [data-type]");
  if (hiddenLines !== 0 || !cmd.includes("init")) fail(`reduced motion: ${hiddenLines} hidden lines, cmd=${cmd}`);
  notes.push(`reduced motion: terminal shown complete immediately (${hiddenLines} hidden lines)`);
  await ctx.close();
}

await browser.close();
console.log("\n" + notes.join("\n"));
console.log(failures.length ? `\n${failures.length} FAILURES` : "\nALL CHECKS PASSED");
process.exit(failures.length ? 1 : 0);

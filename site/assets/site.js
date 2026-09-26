/* decree-harness site: theme toggle, copy buttons, docs menu, terminal replay. */
(function () {
  "use strict";

  var root = document.documentElement;
  var STORE = "decree-theme";
  var reduceMotion = false;
  try { reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  /* ---------- live region ---------- */
  var live = document.getElementById("live");
  function announce(msg) {
    if (!live) return;
    live.textContent = "";
    window.setTimeout(function () { live.textContent = msg; }, 30);
  }

  /* ---------- theme ---------- */
  function systemDark() {
    try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) { return false; }
  }
  function currentTheme() {
    var t = root.getAttribute("data-theme");
    if (t === "light" || t === "dark") return t;
    return systemDark() ? "dark" : "light";
  }
  function labelToggle(btn) {
    var next = currentTheme() === "dark" ? "light" : "dark";
    btn.setAttribute("aria-label", "Switch to " + next + " theme");
    btn.setAttribute("title", "Switch to " + next + " theme");
  }
  var toggles = document.querySelectorAll("[data-theme-toggle]");
  Array.prototype.forEach.call(toggles, function (btn) {
    labelToggle(btn);
    btn.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { window.localStorage.setItem(STORE, next); } catch (e) {}
      Array.prototype.forEach.call(toggles, labelToggle);
      announce(next === "dark" ? "Dark theme" : "Light theme");
    });
  });

  /* ---------- copy ---------- */
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function textFor(btn) {
    var explicit = btn.getAttribute("data-copy");
    if (explicit) return explicit;
    var box = btn.closest(".code");
    var pre = box && box.querySelector("pre");
    if (!pre) return "";
    var clone = pre.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll(".c-prompt"), function (n) { n.remove(); });
    return clone.textContent.replace(/\n+$/, "");
  }
  Array.prototype.forEach.call(document.querySelectorAll(".copy-btn"), function (btn) {
    btn.addEventListener("click", function () {
      var text = textFor(btn);
      copyText(text).then(function (ok) {
        if (!ok) { announce("Copy failed"); return; }
        btn.setAttribute("data-copied", "");
        var label = btn.querySelector(".copy-label");
        var prev = label ? label.textContent : null;
        if (label) label.textContent = "Copied";
        announce("Copied to clipboard");
        window.setTimeout(function () {
          btn.removeAttribute("data-copied");
          if (label && prev !== null) label.textContent = prev;
        }, 1600);
      });
    });
  });

  /* ---------- docs menu (mobile) ---------- */
  var menuBtn = document.querySelector(".docs-menu-btn");
  if (menuBtn) {
    var side = menuBtn.closest(".docs-side");
    menuBtn.addEventListener("click", function () {
      var open = side.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  /* ---------- terminal ---------- */
  var term = document.querySelector("[data-term]");
  if (!term) return;

  var body = term.querySelector(".term-body");
  var tabs = Array.prototype.slice.call(term.querySelectorAll("[role=tab]"));
  var panels = Array.prototype.slice.call(term.querySelectorAll("[role=tabpanel]"));
  var replay = term.querySelector(".term-replay");
  var timers = [];
  var follow = true;

  panels.forEach(function (p) {
    var cmd = p.querySelector("[data-type]");
    if (cmd) cmd.setAttribute("data-full", cmd.textContent);
  });

  function clearTimers() { timers.forEach(function (t) { window.clearTimeout(t); }); timers = []; }
  function later(fn, ms) { timers.push(window.setTimeout(fn, ms)); }
  function stick() { if (follow) body.scrollTop = body.scrollHeight; }

  function showAll(panel) {
    var cmd = panel.querySelector("[data-type]");
    if (cmd) cmd.textContent = cmd.getAttribute("data-full");
    Array.prototype.forEach.call(panel.querySelectorAll(".ln"), function (l) { l.hidden = false; });
    var caret = panel.querySelector(".t-caret");
    if (caret) caret.hidden = false;
  }

  function play(panel) {
    clearTimers();
    follow = true;
    body.scrollTop = 0;
    if (reduceMotion) { showAll(panel); return; }
    var lines = Array.prototype.slice.call(panel.querySelectorAll(".ln"));
    lines.forEach(function (l, i) { if (i > 0) l.hidden = true; });
    var caret = panel.querySelector(".t-caret");
    if (caret) caret.hidden = true;
    var cmd = panel.querySelector("[data-type]");
    var full = cmd ? cmd.getAttribute("data-full") : "";
    if (cmd) cmd.textContent = "";
    var t = 350;
    for (var c = 1; c <= full.length; c++) {
      (function (n) { later(function () { cmd.textContent = full.slice(0, n); }, t); })(c);
      t += 22 + (c % 7 === 0 ? 30 : 0);
    }
    t += 380;
    lines.slice(1).forEach(function (l) {
      var pause = parseInt(l.getAttribute("data-pause") || "0", 10);
      t += 16 + pause;
      later(function () { l.hidden = false; stick(); }, t);
    });
    later(function () { if (caret) caret.hidden = false; stick(); }, t + 60);
  }

  function select(tab, autoplay) {
    tabs.forEach(function (tb) {
      var on = tb === tab;
      tb.setAttribute("aria-selected", on ? "true" : "false");
      tb.tabIndex = on ? 0 : -1;
    });
    var panel = null;
    panels.forEach(function (p) {
      var on = p.id === tab.getAttribute("aria-controls");
      p.hidden = !on;
      if (on) panel = p;
    });
    if (panel) { if (autoplay) play(panel); else { clearTimers(); showAll(panel); } }
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener("click", function () { select(tab, true); });
    tab.addEventListener("keydown", function (e) {
      var n = null;
      if (e.key === "ArrowRight") n = tabs[(i + 1) % tabs.length];
      else if (e.key === "ArrowLeft") n = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") n = tabs[0];
      else if (e.key === "End") n = tabs[tabs.length - 1];
      if (n) { e.preventDefault(); n.focus(); select(n, true); }
    });
  });

  ["wheel", "touchstart", "keydown", "mousedown"].forEach(function (ev) {
    body.addEventListener(ev, function () { follow = false; }, { passive: true });
  });

  if (replay) {
    replay.addEventListener("click", function () {
      var active = panels.filter(function (p) { return !p.hidden; })[0];
      if (active) play(active);
    });
  }

  var first = tabs[0];
  if (first) {
    if ("IntersectionObserver" in window && !reduceMotion) {
      var io = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) { io.disconnect(); select(first, true); }
      }, { threshold: 0.2 });
      io.observe(term);
    } else {
      select(first, false);
    }
  }
})();

import { apiFetch } from '../api.js';
import { EMBED, pref } from '../dom.js';

// "This machine" (top of the drawer): how the box this server runs on is doing —
// CPU / GPU / RAM with temperatures, network speed, disks, and a grade for the box's
// own internet link. Owner-only: loadProfile reveals it through showMachineCard, and
// GET /api/machine enforces the same gate.
//
// It polls, and only while it is actually on screen: the drawer open (phone) or the
// sidebar showing (desktop), the page visible, and the card not switched off in the
// shortcut picker. "On screen" is read off the drawer element itself rather than
// from library.js, so this module never imports it — the drawer-open event exists
// so panels don't have to. Split-view panes never show the card: each pane is a
// whole page, and five cards would poll five times.

const POLL_MS = 3000;
// The first answer after a quiet spell carries GPU / Wi-Fi figures from before it
// (asking is what restarts those probes), so the second question comes sooner.
const SOON_MS = 1000;
const ABORT_MS = 8000;
const STALE_MS = 10000;
const SLOTS = 40;   // points the server keeps: two minutes at its 3 s beat

const GRADE_WORDS = { excellent: "Excellent", good: "Good", average: "Average", mediocre: "Mediocre", bad: "Bad", offline: "Offline" };
const KIND_WORDS = { wired: "Ethernet", wifi: "Wi-Fi" };
const SVGNS = "http://www.w3.org/2000/svg";

let card = null, summary = null, details = null, drawer = null;
let where = null, clock = null, grade = null, gradeWord = null;
const tiles = {};
let allowed = false, timer = null, inflight = false, burst = 0;
let data = null, lastOk = 0;
const clocks = {};

const isNum = (v) => typeof v === "number" && isFinite(v);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const joinBits = (list) => list.filter(Boolean).join(" · ");

/* ---------- numbers into words ---------- */

const UNITS = ["B", "KB", "MB", "GB", "TB"];
// Rolls over at 1000, not 1024, so a 1 TB disk reads "1.0 TB" rather than "1007 GB".
function scaled(b) {
  let i = 0;
  while (b >= 1000 && i < UNITS.length - 1) { b /= 1024; i++; }
  return { v: b, u: UNITS[i] };
}
function size(b) {
  if (!isNum(b)) return "—";
  const s = scaled(b);
  return (s.v >= 100 || s.u === "B" ? Math.round(s.v) : s.v.toFixed(1)) + " " + s.u;
}
const rate = (b) => (isNum(b) ? size(b) + "/s" : "—");
// "1.2M", "310K": the compact tile has room for four characters.
function shortRate(b) {
  if (!isNum(b)) return "—";
  const s = scaled(b);
  return (s.v >= 10 || s.u === "B" ? Math.round(s.v) : s.v.toFixed(1)) + s.u.charAt(0);
}
function gib(b) { const g = b / 1073741824; return g >= 100 ? String(Math.round(g)) : g.toFixed(1); }
const percent = (v) => (isNum(v) ? Math.round(v) + "%" : "—");
const degrees = (v) => (isNum(v) ? Math.round(v) + " °C" : "");
const ms = (v) => (v < 1 ? "<1 ms" : (v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)) + " ms");
const tone = (v, warn, hot) => (!isNum(v) ? "" : v >= hot ? "hot" : v >= warn ? "warn" : "");
function setTone(node, t) { if (t) node.dataset.tone = t; else delete node.dataset.tone; }
function setPct(fill, v) { fill.style.setProperty("--pct", (isNum(v) ? Math.max(0, Math.min(100, v)) : 0) + "%"); }

// The box's own wall clock, so "is it the middle of the night there?" needs no maths.
function serverTime(tz) {
  if (!tz) return "";
  try {
    if (!clocks[tz]) clocks[tz] = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
    return clocks[tz].format(new Date());
  } catch (e) { return ""; }
}
function ago() {
  const s = Math.round((Date.now() - lastOk) / 1000);
  return s < 5 ? "just now" : s < 60 ? s + " s ago" : Math.round(s / 60) + " min ago";
}

/* ---------- the compact card ---------- */

function buildSummary() {
  summary.textContent = "";
  const top = el("span", "mc-top");
  const place = el("span", "mc-place");
  // The city may shorten to an ellipsis on a narrow sidebar; the clock may not.
  where = el("span", "mc-where", "This machine");
  clock = el("span", "mc-clock");
  place.append(where, clock);
  grade = el("span", "mc-grade");
  const dot = el("span", "mc-dot");
  dot.setAttribute("aria-hidden", "true");
  gradeWord = el("span", "mc-word", "Checking…");
  grade.append(dot, gradeWord);
  top.append(place, grade);

  const grid = el("span", "mc-tiles");
  for (const k of ["cpu", "gpu", "ram", "net"]) {
    const t = el("span", "mc-tile");
    const head = el("span", "mc-tl");
    const val = el("span", "mc-num", "—");
    head.append(el("span", "mc-lbl", k.toUpperCase()), val);
    const bar = el("span", "mc-bar");
    const fill = el("i");
    bar.appendChild(fill);
    const sub = el("span", "mc-sub", "—");
    t.append(head, bar, sub);
    // GPU until we know there is one; NET only stands in when there is not.
    if (k === "gpu" || k === "net") t.hidden = true;
    if (k === "net") bar.hidden = true;
    tiles[k] = { root: t, val, bar, fill, sub };
    grid.appendChild(t);
  }
  summary.append(top, grid);
}

function setTile(k, pct, sub, subTone) {
  const t = tiles[k];
  t.val.textContent = percent(pct);
  setPct(t.fill, pct);
  setTone(t.bar, tone(pct, 80, 95));
  t.sub.textContent = sub;
  setTone(t.sub, subTone);
}

function renderSummary(d) {
  const p = d.place || {};
  const now = serverTime(p.tz);
  where.textContent = p.label || "This machine";
  clock.textContent = now ? " · " + now : "";

  const l = d.link || {};
  grade.dataset.grade = l.grade || "";
  gradeWord.textContent = l.grade ? GRADE_WORDS[l.grade] || l.grade : "Checking…";
  grade.title = joinBits([KIND_WORDS[l.kind], isNum(l.ms) ? "internet " + ms(l.ms) : ""]);

  const c = d.cpu || {};
  setTile("cpu", c.pct, isNum(c.temp) ? degrees(c.temp) : "— °C", tone(c.temp, 85, 95));
  tiles.cpu.sub.title = isNum(c.temp) ? "" : "CPU temperature is off — open the card to see how to turn it on";

  const g = (d.gpus || [])[0];
  tiles.gpu.root.hidden = !g;
  if (g) setTile("gpu", g.pct, degrees(g.temp) || "—", tone(g.temp, 80, 90));

  const m = d.mem;
  setTile("ram", m && m.total ? (m.used / m.total) * 100 : null, m ? gib(m.used) + "/" + gib(m.total) + " G" : "—", "");

  tiles.net.root.hidden = !!g;
  if (!g) {
    tiles.net.val.textContent = d.net ? "↓" + shortRate(d.net.rx) : "—";
    tiles.net.sub.textContent = d.net ? "↑" + shortRate(d.net.tx) : "—";
  }
}

/* ---------- the details ---------- */

// A line graph of the last two minutes, drawn from the right so a fresh history
// grows in from the edge. A null is "not measured" and leaves a gap, never a dip.
function spark(values, max, floor) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "mc-spark");
  svg.setAttribute("viewBox", "0 0 100 16");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const vals = Array.isArray(values) ? values.slice(-SLOTS) : [];
  let hi = max || 0;
  if (!max) for (const v of vals) if (isNum(v) && v > hi) hi = v;
  // A floor keeps a quiet line quiet: 3 ms against 4 ms must not fill the box.
  hi = Math.max(hi, floor || 0) || 1;
  const step = 100 / (SLOTS - 1);
  let pts = [];
  const flush = () => {
    // A reading with gaps on both sides is still a reading: a short dash, not nothing.
    if (pts.length === 1) pts.unshift([+(pts[0][0] - step / 2).toFixed(1), pts[0][1]]);
    if (pts.length > 1) {
      const line = document.createElementNS(SVGNS, "polyline");
      line.setAttribute("points", pts.map((p) => p[0] + "," + p[1]).join(" "));
      svg.appendChild(line);
    }
    pts = [];
  };
  vals.forEach((v, i) => {
    if (!isNum(v)) { flush(); return; }
    const x = 100 - (vals.length - 1 - i) * step;
    const y = 15 - Math.max(0, Math.min(1, v / hi)) * 14;
    pts.push([+x.toFixed(1), +y.toFixed(1)]);
  });
  flush();
  return svg;
}
const sum = (a = [], b = []) => a.map((v, i) => (isNum(v) && isNum(b[i]) ? v + b[i] : null));

function row(label, lines, graph) {
  const r = el("div", "mc-row");
  r.appendChild(el("span", "mc-lbl", label));
  const box = el("div", "mc-lines");
  lines.forEach((t, i) => { if (t) box.appendChild(el("div", "mc-line" + (i ? " dim" : ""), t)); });
  if (graph) box.appendChild(graph);
  r.appendChild(box);
  details.appendChild(r);
  return box;
}

function renderDetails(d) {
  if (!d || details.hidden) return;
  details.textContent = "";
  const h = d.history || {};
  const off = d.off || {};

  const c = d.cpu || {};
  const cpuBox = row("CPU", [
    joinBits([percent(c.pct), degrees(c.temp), isNum(c.watts) ? Math.round(c.watts) + " W" : "", c.load && isNum(c.load[0]) ? "load " + c.load[0] : ""]),
    joinBits([c.model, c.threads ? c.threads + " threads" : ""]),
  ], spark(h.cpu, 100));
  if (off.cpuTemp) cpuBox.insertBefore(el("div", "mc-hint", "Temperature: " + off.cpuTemp), cpuBox.lastChild);

  (d.gpus || []).forEach((g, i) => {
    row(i ? "GPU" + (i + 1) : "GPU", [
      joinBits([
        percent(g.pct),
        degrees(g.temp),
        isNum(g.watts) ? Math.round(g.watts) + (isNum(g.wattsMax) ? " of " + Math.round(g.wattsMax) : "") + " W" : "",
      ]),
      joinBits([
        isNum(g.memTotal) ? "VRAM " + gib(g.memUsed || 0) + " of " + gib(g.memTotal) + " GB" : "",
        isNum(g.fan) ? "fan " + Math.round(g.fan) + "%" : "",
      ]),
      g.name,
    ], i === 0 ? spark(h.gpu, 100) : null);
  });

  const m = d.mem;
  if (m && m.total) {
    row("RAM", [
      size(m.used) + " of " + size(m.total) + " · " + percent((m.used / m.total) * 100),
      m.swapTotal ? "swap " + size(m.swapUsed) + " of " + size(m.swapTotal) : "",
    ], spark(h.ram, 100));
  }

  if (d.net) {
    row("NET", ["↓ " + rate(d.net.rx) + " · ↑ " + rate(d.net.tx)], spark(sum(h.rx, h.tx), 0, 16 * 1024));
  }

  const l = d.link || {};
  const w = l.wifi;
  row("LINK", [
    joinBits([KIND_WORDS[l.kind] || "Network", l.grade ? GRADE_WORDS[l.grade] : "checking…"]),
    l.grade === "offline" ? "No answer from the internet"
      : isNum(l.ms) ? joinBits([
        "internet " + ms(l.ms),
        isNum(l.jitter) ? "jitter " + ms(l.jitter) : "",
        isNum(l.loss) ? (l.loss ? l.loss + "% lost" : "no loss") : "",
      ]) : "",
    w ? joinBits(["signal " + w.signal + "%", w.band, w.ssid, isNum(w.rxMbps) ? w.rxMbps + " Mbps" : ""]) : "",
  ], spark(h.ms, 0, 20));

  if (d.disks && d.disks.length) {
    const box = row("DISK", [], null);
    for (const dk of d.disks) {
      const used = dk.total ? (1 - dk.free / dk.total) * 100 : null;
      const line = el("div", "mc-disk");
      const bar = el("span", "mc-bar");
      const fill = el("i");
      setPct(fill, used);
      setTone(bar, tone(used, 85, 95));
      bar.appendChild(fill);
      line.append(el("span", "mc-line", dk.label), el("span", "mc-line dim", size(dk.free) + " free of " + size(dk.total)), bar);
      box.appendChild(line);
    }
  }

  details.appendChild(el("div", "mc-foot", "Updated " + ago()));
}

function markStale() {
  if (!lastOk || Date.now() - lastOk < STALE_MS) return;
  card.classList.add("stale");
  const s = Math.round((Date.now() - lastOk) / 1000);
  where.textContent = "Can't reach server";
  clock.textContent = " · " + (s < 60 ? s + " s" : Math.round(s / 60) + " min");
  const foot = details.querySelector(".mc-foot");
  if (foot) foot.textContent = "Updated " + ago();
}

/* ---------- the loop ---------- */

function drawerShowing() {
  if (!drawer) return false;
  if (drawer.classList.contains("open")) return true;
  // Desktop: the sidebar is simply there. Phone, closed: parked off to the left.
  const r = drawer.getBoundingClientRect();
  return r.width > 0 && r.right > 1 && r.left < window.innerWidth - 1;
}
function running() {
  return allowed && !card.hidden && !card.classList.contains("nav-off") && !document.hidden && drawerShowing();
}
function kick() {
  if (inflight || timer || !running()) return;
  burst = 0;
  poll();
}

function poll() {
  timer = null;
  if (!running()) return;
  inflight = true;
  const ctl = new AbortController();
  const killer = setTimeout(() => ctl.abort(), ABORT_MS);
  apiFetch("/api/machine", { cache: "no-store", signal: ctl.signal })
    .then((r) => {
      // A server from before this card answers 404, a non-owner 403: go quiet
      // rather than nag. The next page load (after a restart) asks again.
      if (r.status === 404 || r.status === 403) { allowed = false; card.hidden = true; return null; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then((d) => {
      if (!d) return;
      data = d;
      lastOk = Date.now();
      card.classList.remove("stale");
      renderSummary(d);
      renderDetails(d);
    })
    .catch(() => markStale())
    .then(() => {
      clearTimeout(killer);
      inflight = false;
      if (running()) timer = setTimeout(poll, burst++ === 0 ? SOON_MS : POLL_MS);
    });
}

function setOpen(open) {
  summary.setAttribute("aria-expanded", open ? "true" : "false");
  details.hidden = !open;
  card.classList.toggle("open", open);
  if (open) renderDetails(data);
}

// Called by loadProfile once the account is known: owners get the card.
export function showMachineCard(ok) {
  if (!card) return;
  allowed = !!ok;
  card.hidden = !allowed;
  if (allowed) kick();
  else { clearTimeout(timer); timer = null; }
}

export function initMachine() {
  if (EMBED) return;
  const root = document.getElementById("machineCard");
  summary = document.getElementById("machineSummary");
  details = document.getElementById("machineDetails");
  drawer = document.getElementById("drawer");
  if (!root || !summary || !details) return;
  card = root;

  buildSummary();
  setOpen(pref("machineOpen") === "1");
  summary.addEventListener("click", () => {
    const open = summary.getAttribute("aria-expanded") !== "true";
    setOpen(open);
    pref("machineOpen", open ? "1" : "0");
  });

  document.addEventListener("plumi:drawer-open", kick);
  document.addEventListener("visibilitychange", kick);
  let resizeT = 0;
  window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(kick, 250); });
  // The shortcut picker switches the card on and off with a class; hearing that
  // here keeps the picker from having to know this card polls.
  new MutationObserver(kick).observe(card, { attributes: true, attributeFilter: ["class", "hidden"] });
}

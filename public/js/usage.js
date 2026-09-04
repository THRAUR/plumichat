import { reqJSON } from './api.js';
import { $ } from './dom.js';
import { curModel, models } from './models.js';
import { profileInfo } from './panels/perm.js';
import { clockTime } from './render.js';
import { factCard, openSheet, sheetActions, sheetButton, sheetNote, sheetOpenName, sheetSection } from './sheet.js';
import { activeStreams, reattachTries, viewKey } from './state.js';
import { currentTurnModel, currentTurnModelSrc, currentTurnRequested, fmtTokens, friendlyModel } from './stream.js';
import { limitResetMs, limitsState, setLimits, thinkingFor, windowUsage } from './tasks.js';

/* ---------- Usage + account chip (audit F5) ----------
   Three facts that were previously invisible: where the account sits in its
   5-hour window, how much thinking the live turn has done, and which model is
   actually serving it. The chip stays out of the way when idle and nothing is
   wrong — it only earns its line when there is a turn running or a limit to
   warn about. */
export let usageChip = $("usageChip");
export let drawerUsage = $("drawerUsage");
// The SDK reports a rate-limit STATUS, not a percentage, so the bar is a
// three-step indication and the honest detail (when it resets) is spelled out
// underneath it. Unknown statuses fall through to "we don't know" rather than 0%.
// The rate-limit event carries a STATUS ("allowed" / "warning" / "rejected") and
// a reset time. It carries no consumption figure at all. A previous version mapped
// each status onto an invented percentage (allowed = 25%, warning = 78%), which
// rendered a category as though it were a measurement — so the bar "jumped" from
// 25% to 78% when nothing had been measured. Removed deliberately: the two honest
// quantities are how far through the window we are, and how many tokens WE spent.
const WINDOW_MS = { five_hour: 5 * 3600e3, seven_day: 7 * 24 * 3600e3 };
export function limitTone(l) {
  if (!l || !l.status) return "";
  if (l.status === "rejected" || l.status === "exceeded") return "over";
  if (/warn/i.test(l.status) || (l.overage && /over|active/i.test(l.overage))) return "warn";
  return "";
}
// How far through the current window we are, by clock. Real, and useful: it says
// how long you have before it resets. Never a claim about consumption.
export function limitPct(l) {
  var ms = limitResetMs(l);
  if (!ms) return null;
  var span = WINDOW_MS[String((l && l.kind) || "").toLowerCase()] || WINDOW_MS.five_hour;
  var left = ms - Date.now();
  if (left <= 0) return 100;
  if (left >= span) return 0;
  return Math.max(0, Math.min(100, Math.round(((span - left) / span) * 100)));
}
export function limitResetText(l) {
  var ms = limitResetMs(l);
  if (!ms) return "";
  var mins = Math.round((ms - Date.now()) / 60000);
  if (mins <= 0) return "resets now";
  if (mins < 60) return "resets in " + mins + " min";
  return "resets at " + clockTime(ms);
}
export function limitWords(l) {
  if (!l || !l.status) return "Usage";
  if (l.status === "rejected" || l.status === "exceeded") return "5-hour limit reached";
  if (/warn/i.test(l.status)) return "5-hour limit close";
  return "5-hour window";
}
export function renderUsageChip() {
  renderDrawerUsage();   // the sidebar copy is always on screen, so always repaint it
  if (!usageChip) return;
  var running = !!activeStreams[viewKey] || !!reattachTries[viewKey];
  var tone = limitTone(limitsState);
  // Quiet unless it has something to say. This chip is a full-width rail directly
  // above the composer, so an always-on version parks "5-hour window" under every
  // answer — at 27% of the window that is three words of furniture reporting no
  // news, and it reads as an alert that keeps firing for nothing.
  //
  // It was made always-on to stop it "vanishing between turns and looking
  // broken". That worry is already answered elsewhere: renderDrawerUsage() runs
  // on the line above and NEVER hides, so the sidebar always states the figure
  // and the reset time. The rail is therefore free to appear only when it is
  // live (model + thinking tokens during a turn) or actually warning.
  if (!running && !tone) { usageChip.hidden = true; return; }
  var bits = [];
  if (running && currentTurnModel) bits.push({ cls: "uc-model", text: friendlyModel(currentTurnModel) });
  var think = thinkingFor(viewKey);
  if (running && think) bits.push({ cls: "uc-tok", text: fmtTokens(think) + " thinking" });
  if (tone || limitsState) bits.push({ cls: "", text: limitWords(limitsState) });
  if (!bits.length) bits.push({ cls: "", text: "Usage & account" });
  usageChip.innerHTML = "";
  bits.forEach(function (b, i) {
    if (i) {
      var sep = document.createElement("span"); sep.className = "uc-sep"; sep.textContent = "·";
      usageChip.appendChild(sep);
    }
    var s = document.createElement("span");
    if (b.cls) s.className = b.cls;
    s.textContent = b.text;
    usageChip.appendChild(s);
  });
  usageChip.classList.toggle("warn", tone === "warn");
  usageChip.classList.toggle("over", tone === "over");
  usageChip.hidden = false;
}

// The sidebar copy. Unlike the topbar chip this NEVER hides — the point is that a
// glance at the sidebar always answers "how much have I got left", so with no data
// it says so rather than vanishing and looking broken.
export function renderDrawerUsage() {
  if (!drawerUsage) return;
  var l = limitsState;
  var tone = limitTone(l);
  var pct = limitPct(l);
  var q = function (c) { return drawerUsage.querySelector(c); };
  q(".du-label").textContent = limitWords(l);
  // The right-hand figure is REAL: tokens this account has spent through PlumiChat
  // since the window opened. It is not a percentage of a quota — nothing tells us
  // the quota — so it is shown as a count, which cannot be misread as "73% used".
  var spent = windowUsage.input + windowUsage.output;
  q(".du-pct").textContent = spent ? fmtTokens(spent) : (pct == null ? "—" : pct + "%");
  q(".du-fill").style.width = (pct == null ? 0 : pct) + "%";
  var think = thinkingFor(viewKey);
  var running = !!activeStreams[viewKey] || !!reattachTries[viewKey];
  q(".du-sub").textContent = running && think ? fmtTokens(think) + " thinking"
    : (l ? limitResetText(l) : "no data yet");
  drawerUsage.classList.toggle("warn", tone === "warn");
  drawerUsage.classList.toggle("over", tone === "over");
}
// /api/version is readable by any signed-in account and cached server-side for
// 30s; keep one copy here so opening the sheet twice costs nothing.
export let versionInfo = null;
export function loadVersion(force) {
  // Cached, EXCEPT when we still have no usage figure: a page opened seconds after
  // a server restart asks before the engine has reported a window, and caching that
  // empty answer forever is what left the readout stuck on "no data yet" until the
  // next turn happened to arrive on this device.
  if (versionInfo && !force && limitsState) return Promise.resolve(versionInfo);
  return reqJSON("/api/version").then(function (d) {
    versionInfo = d;
    // The server remembers the last usage window across turns; adopt it so the
    // chip is populated on a cold load instead of waiting for the next turn to
    // report one. A live `limits` event always wins — it is strictly fresher.
    if (d && d.limits && !limitsState) { setLimits(d.limits); renderUsageChip(); }
    else if (d && d.limits) renderDrawerUsage();
    return d;
  }).catch(function () { return null; });   // an older server has no such route
}

export function openUsageSheet() {
  openSheet("usage", "Usage & account", function (body) {
    var l = limitsState;
    var pct = limitPct(l);
    var meter = document.createElement("div");
    meter.className = "limit-meter" + (limitTone(l) ? " " + limitTone(l) : "");
    meter.style.setProperty("--pct", (pct == null ? 0 : pct) + "%");
    var top = document.createElement("div"); top.className = "limit-meter-top";
    var lab = document.createElement("span"); lab.className = "limit-meter-label"; lab.textContent = limitWords(l);
    var val = document.createElement("span"); val.className = "limit-meter-pct";
    val.textContent = pct == null ? "—" : pct + "%";
    top.appendChild(lab); top.appendChild(val);
    var track = document.createElement("div"); track.className = "limit-meter-track";
    var fill = document.createElement("span"); fill.className = "limit-meter-fill"; track.appendChild(fill);
    meter.appendChild(top); meter.appendChild(track);
    var reset = document.createElement("div"); reset.className = "limit-meter-reset";
    if (l && limitResetText(l)) {
      reset.appendChild(document.createTextNode(limitResetText(l)));
    } else {
      reset.textContent = l ? "No reset time reported yet." : "Nothing reported yet — this fills in during a turn.";
    }
    meter.appendChild(reset);
    body.appendChild(meter);
    if (l && l.kind) sheetNote(body, "Window: " + l.kind + (l.overage ? " · overage " + l.overage : ""));
    sheetNote(body, "The bar is how far through the window the clock is, not how much you have spent — the rate-limit signal reports a status (" +
      ((l && l.status) || "unknown") + ") and a reset time, never a consumption figure.");

    sheetSection(body, "Spent in this window");
    factCard(body, "Through PlumiChat", windowUsage.turns ? windowUsage.turns + (windowUsage.turns === 1 ? " turn" : " turns") : "", [
      { label: "Input tokens", value: fmtTokens(windowUsage.input) },
      { label: "Output tokens", value: fmtTokens(windowUsage.output) },
      { label: "Cache reads", value: fmtTokens(windowUsage.cacheRead) },
      { label: "Est. cost", value: windowUsage.costUsd ? "$" + windowUsage.costUsd.toFixed(4) : "—" }
    ]);
    sheetNote(body, "Counted from each turn's own usage report, so it covers what this box spent — not other devices, and not turns from before the window rolled over or before the server last restarted.");

    sheetSection(body, "This turn");
    var running = !!activeStreams[viewKey] || !!reattachTries[viewKey];
    factCard(body, running ? "Running now" : "Last turn", running ? "Live" : "", [
      { label: "Model serving it", value: currentTurnModel || "—", changed: !!currentTurnModel },
      { label: "You picked", value: currentTurnRequested ? friendlyModel(currentTurnRequested) : models[curModel].short },
      { label: "Provenance", value: currentTurnModelSrc === "api" ? "Anthropic API echo" : (currentTurnModelSrc || "—") },
      { label: "Thinking (est.)", value: thinkingFor(viewKey) ? fmtTokens(thinkingFor(viewKey)) + " tokens" : "—" }
    ], running ? "ready" : "");

    sheetSection(body, "Account");
    factCard(body, profileInfo ? (profileInfo.name || "You") : "You", profileInfo && profileInfo.role ? "" : "", [
      { label: "Signed in as", value: profileInfo ? (profileInfo.email || profileInfo.name || "—") : "—" },
      { label: "Role", value: profileInfo ? profileInfo.role : "—" }
    ]);
    sheetNote(body, "Plan and organisation are not exposed by any PlumiChat route yet — the SDK knows them (accountInfo), the server does not publish them.");

    sheetSection(body, "Engine");
    var engBox = document.createElement("div");
    body.appendChild(engBox);
    var placeholder = document.createElement("div"); placeholder.className = "sheet-note";
    placeholder.textContent = "Reading versions…";
    engBox.appendChild(placeholder);
    loadVersion().then(function (v) {
      if (sheetOpenName !== "usage") return;
      engBox.innerHTML = "";
      if (!v) { sheetNote(engBox, "This server doesn't report its versions yet."); return; }
      factCard(engBox, "Versions", null, [
        { label: "Chat engine (Agent SDK)", value: v.sdk },
        { label: "Terminal CLI", value: v.cli },
        { label: "PlumiChat", value: (v.app || "") + (v.commit ? " · " + v.commit : "") },
        { label: "Node", value: v.node }
      ]);
    });
    var row = sheetActions(body);
    sheetButton(row, "Settings › Engine", "primary", function () {
      window.location.href = "/settings.html#engine";
    });
  });
}

export function initUsageChip() {
  if (drawerUsage) drawerUsage.addEventListener("click", openUsageSheet);
  renderDrawerUsage();
  // One retry a little later: the very first ask can land before the engine has
  // reported a usage window at all (a page opened right after a restart).
  setTimeout(function () { if (!limitsState) loadVersion(true); }, 20000);
  if (!usageChip) return;
  usageChip.addEventListener("click", openUsageSheet);
  // Ask once at boot. /api/version carries the usage window the engine last
  // saw, which is what lets the chip be populated before this device has run
  // a single turn; without this it stayed blank until the next turn reported.
  loadVersion();
}

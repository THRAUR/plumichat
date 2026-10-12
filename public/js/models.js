import { apiFetch } from './api.js';
import { saveDefaults } from './defaults.js';
import { closeFiles } from './panels/deliverables.js';
import { $, pref, toast } from './dom.js';
import { REFRESH_ICON } from './icons.js';
import { closeMenu } from './projects.js';
import { closeSkills } from './panels/skills.js';
import { activeStreams, reattachTries, viewKey } from './state.js';

/* ---------- Model + effort + fast picker ---------- */
// Static fallback only — the real list is fetched live from /api/models on boot
// (so it auto-updates and always matches what the account can actually use).
// `key` = selection identity (lets a "1M context" twin coexist with its base
// model, which share the same real `id`). `id` = the real model sent to the API.
export let models = [
  { key: "claude-opus-5-5", label: "Opus 5.5", short: "Opus 5.5", id: "claude-opus-5-5", fast: true, fam: "opus", latest: true },
  { key: "claude-sonnet-5-5", label: "Sonnet 5.5", short: "Sonnet 5.5", id: "claude-sonnet-5-5", fam: "sonnet", latest: true },
  { key: "claude-haiku-5-5", label: "Haiku 5.5", short: "Haiku 5.5", id: "claude-haiku-5-5", fam: "haiku", latest: true }
];
// A model's family. The menu no longer draws a header per family (see
// renderModelMenu); this is what lets a saved pick that has disappeared fall back
// to the same family's current model instead of to Sonnet.
export function familyOf(id) {
  return /opus/i.test(id) ? "opus" : /sonnet/i.test(id) ? "sonnet"
    : /haiku/i.test(id) ? "haiku" : /fable/i.test(id) ? "fable" : "x";
}

// Used only when a model reports no effort data (the offline fallback list). Live
// models carry their own exact effort levels (see modelEfforts()).
export let DEFAULT_EFFORTS = ["low", "medium", "high", "max"];
// Button text. "XHi" read as a typo; the five have to fit one row of a 320px phone.
export let effortShort = { low: "Low", medium: "Med", high: "High", xhigh: "X-High", max: "Max" };
// One plain line under the buttons for the level that is on, so the choice says
// what it trades: thinking time against speed and cost.
export let effortDesc = {
  low: "Fastest and cheapest. Least thinking.",
  medium: "Quicker, with some thinking.",
  high: "Thinks it through. A good default.",
  xhigh: "Thinks harder, for tricky problems.",
  max: "Thinks as long as it needs. Slowest, costs most."
};
export let curModel = 1;          // Sonnet 5.5
export let curEffort = "high";
export let fastOn = false;
export let modelsLive = true;     // false once we know we're showing the offline fallback
export let modelPicker = $("modelPicker");
export let modelBtn = $("modelBtn");
export let modelMenu = $("modelMenu");
export let modelLabel = $("modelLabel");

// Swap the static fallback for the account's LIVE model list (auto-updates as
// Anthropic grants new models). Every model is fully selectable. The server sends
// the latest lineup first, each marked `latest` with a one-line `desc` of what it
// is for, then the older versions; the menu shows the lineup and folds the rest
// (you can still pick any of them, exactly like Claude Code). A "1M context" twin
// is added for every model the SERVER marks `ctx1m` (it mirrors the CLI's own
// '[1m]' picker rows). The old client-side /sonnet-4/ test made the twin vanish
// the day Sonnet 5 shipped, and never offered it on Opus 5 / Fable 5.1 at all.
// Re-resolves the saved pick (see resolveModelKey).
export function applyModelList(list) {
  if (!list || !list.length) return;
  var seen = {}, out = [];
  list.forEach(function (m) {
    var fam = familyOf(m.id);
    // A server from before `latest` existed: the first of each family stands in.
    var latest = typeof m.latest === "boolean" ? m.latest : !seen[fam];
    seen[fam] = true;
    // label = menu text; short = collapsed-pill text (keeps the "· 1M" so the
    // mode shows when closed).
    out.push({ key: m.id, label: m.short, short: m.short, id: m.id, fast: !!m.fast,
               fam: fam, latest: latest, desc: m.desc || "", efforts: m.efforts });
    // 1M context: offered exactly where the server says the model supports it.
    if (m.ctx1m) {
      out.push({ key: m.id + "#1m", label: m.short, short: m.short + " · 1M",
                 id: m.id, fast: false, fam: fam, latest: latest, desc: "", ctx1m: true, efforts: m.efforts });
    }
  });
  models = out;
  // The account's model may land before OR after the live list — /api/models and
  // /api/settings/profile are two independent fetches. Whichever arrives second
  // has to win, so the pending account key is re-resolved here rather than only
  // in applyAccountDefaults().
  var mid = accountModelKey || pref("modelId"), idx = resolveModelKey(mid);
  if (idx < 0 || models[idx].key !== mid) {
    if (idx < 0) {
      models.forEach(function (m, i) { if (idx < 0 && m.fam === "sonnet" && m.latest && !m.ctx1m) idx = i; });
      if (idx < 0) idx = 0;
    }
    pref("modelId", models[idx].key);
  }
  curModel = idx;
  updateModelLabel(); renderModelMenu();
}
// Where a saved pick lands when the list no longer has it exactly. The CLI drops
// rows: the '[1m]' twins went the day each model shipped with a 1M window of its
// own, and a retired version eventually goes too. Falling straight back to Sonnet
// would quietly move an Opus user onto a smaller model, so try the same model
// without the 1M marker, then that family's current model. -1 = nothing close.
export function resolveModelKey(key) {
  if (!key) return -1;
  var idx = -1, base = String(key).replace(/#1m$/, ""), fam = familyOf(base);
  models.forEach(function (m, i) { if (idx < 0 && m.key === key) idx = i; });
  if (idx < 0) models.forEach(function (m, i) { if (idx < 0 && m.key === base) idx = i; });
  if (idx < 0 && fam !== "x") models.forEach(function (m, i) { if (idx < 0 && m.fam === fam && m.latest && !m.ctx1m) idx = i; });
  return idx;
}
// Fetch the account's live model list and apply it. cb(ok, count, live) reports the
// outcome: ok=false means the request itself failed (offline / not signed in);
// live=false means the server could only serve its built-in offline list (a
// transient blip on its side) — the full list usually returns on the next hit.
export function loadModels(cb) {
  return apiFetch("/api/models", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      var ok = !!(d && d.models && d.models.length);
      if (ok) { modelsLive = !!d.live; applyModelList(d.models); }
      if (cb) cb(ok, ok ? d.models.length : 0, !!(d && d.live));
    })
    .catch(function () { if (cb) cb(false, 0, false); });
}
// Manual refresh (the picker's ↻ button): re-fetch on demand and report back.
export function refreshModels(btn) {
  if (btn) btn.classList.add("spinning");
  loadModels(function (ok, n, live) {
    if (!ok) { if (btn) btn.classList.remove("spinning"); toast("Couldn't refresh models — check your connection", true); return; }
    // On success applyModelList has already rebuilt the menu (fresh button, no spin).
    toast(live ? ("Models updated · " + n + " available") : "Still on the offline list — try again in a moment", !live);
  });
}

export function modelCapsFast() { return !!models[curModel].fast; }
// The effort levels the current model actually accepts. null/undefined means the
// model didn't report any (offline fallback) → use the safe default set; an empty
// array means the model has no effort control at all (e.g. Haiku) → hide it.
export function modelEfforts() {
  var e = models[curModel] && models[curModel].efforts;
  return (e === null || e === undefined) ? DEFAULT_EFFORTS : e;
}
// The effort we'll actually send: the user's saved pick if this model supports it,
// otherwise the nearest sensible level (prefer High). null when the model has no
// effort control, so the send payload omits it entirely.
export function effectiveEffort() {
  var list = modelEfforts();
  if (!list.length) return null;
  if (list.indexOf(curEffort) >= 0) return curEffort;
  return list.indexOf("high") >= 0 ? "high" : list[list.length - 1];
}
export function updateModelLabel() {
  modelLabel.textContent = models[curModel].short + (fastOn && modelCapsFast() ? " · Fast" : "");
}

export function tickSvg() {
  return '<svg class="tick" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
}
// True once we know this account's model choice is being ignored server-side
// (a member on a workspace with allowMemberSwitch:false). Without saying so the
// picker just looks broken — you pick Opus and every turn runs on the default.
export let memberModelLocked = false;
export function setMemberModelLocked(v) { memberModelLocked = v; }   // set from the profile fetch
// A small explanatory line at the top of a picker. `muted` = information, not a
// change of state.
export function pickerNote(parent, text, muted) {
  var n = document.createElement("div");
  n.className = "picker-note" + (muted ? " muted" : "");
  n.textContent = text;
  parent.appendChild(n);
  return n;
}
// Changing model / effort / approval mid-turn cannot affect the turn already in
// flight — the SDK options were fixed when it started. Say which message it lands
// on, rather than letting the change look ignored.
export function turnRunning() { return !!activeStreams[viewKey] || !!reattachTries[viewKey]; }

// Whether the "Older models" fold is open. Set each time the menu opens — open
// exactly when the current pick is an older version, so its tick is never hidden
// — and flipped by the fold's own row.
var olderOpen = false;

// Scroll the menu itself until `el` is on screen, keeping the fold's own row in
// view where both fit. The older versions open BELOW a menu that is already at
// its height cap, so without this the fold looked like it had done nothing.
// Not scrollIntoView: that also scrolls the page the menu is anchored to.
function revealInMenu(el) {
  var row = modelMenu.querySelector(".mm-more");
  if (!el || !row) return;
  var want = Math.min(row.offsetTop - 6, el.offsetTop + el.offsetHeight + 6 - modelMenu.clientHeight);
  if (want > modelMenu.scrollTop) modelMenu.scrollTop = want;
}
var CHEV_SVG = '<svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';

// One model row. The lineup's rows carry the CLI's "what it's for" line under the
// name; an older version is a name only, because the CLI gives every Opus the same
// line and four identical lines in a row say nothing. Every button here is
// type="button": the menu sits inside the composer's <form>, where a bare <button>
// is a submit button.
function modelRow(m, i, older) {
  var b = document.createElement("button");
  b.type = "button";
  b.className = "model-item" + (older ? " older" : "");
  b.setAttribute("role", "option");
  b.setAttribute("aria-checked", i === curModel ? "true" : "false");
  var name = document.createElement("span"); name.className = "mname";
  var bb = document.createElement("b"); bb.textContent = m.label || m.short; name.appendChild(bb);
  if (!older && m.desc) { var d = document.createElement("span"); d.className = "mdesc"; d.textContent = m.desc; name.appendChild(d); }
  b.appendChild(name);
  if (m.ctx1m) { var t1 = document.createElement("span"); t1.className = "mtag ctx"; t1.textContent = "1M context"; b.appendChild(t1); }
  b.insertAdjacentHTML("beforeend", tickSvg());
  b.addEventListener("click", function () {
    curModel = i; pref("modelId", m.key);
    saveDefaults({ model: m.key });
    updateModelLabel(); renderModelMenu();
    closeModel();
  });
  return b;
}

export function renderModelMenu() {
  // Rebuilt on every change; keep the reader where they were in a menu that scrolls.
  var keep = modelMenu.scrollTop;
  modelMenu.innerHTML = "";
  if (memberModelLocked) {
    pickerNote(modelMenu, "Your workspace runs every turn on its default model — this picker won't change it. Ask the owner to allow model switching.", true);
  }
  if (turnRunning()) pickerNote(modelMenu, "A turn is running. A change here applies from your next message.");

  // Header: label + a refresh control. When we're on the offline fallback list
  // the label says so, so it's obvious why the list is short and why to refresh.
  var top = document.createElement("div"); top.className = "mm-top";
  var tl = document.createElement("span"); tl.className = "mm-top-label" + (modelsLive ? "" : " off");
  tl.textContent = modelsLive ? "Model" : "Model · offline list";
  top.appendChild(tl);
  var rb = document.createElement("button");
  rb.type = "button"; rb.className = "mm-refresh"; rb.setAttribute("aria-label", "Refresh model list"); rb.title = "Refresh model list";
  rb.innerHTML = REFRESH_ICON;
  rb.addEventListener("click", function (e) { e.stopPropagation(); refreshModels(rb); });
  top.appendChild(rb);
  modelMenu.appendChild(top);

  // The models. This menu used to draw a family header whenever the family changed
  // from one row to the next, which worked while the CLI listed one family at a
  // time. It stopped doing that — the current model of each family first, then
  // every older version in no family order — and the menu came out as nine headers
  // for four families, two of them over the same Sonnet. So no headers: the latest
  // lineup (which the server marks) is always on show, each row saying what it is
  // for, and the older versions fold under one row. A phone sees four choices and
  // the effort control without scrolling.
  var latest = [], older = [];
  models.forEach(function (m, i) { (m.latest ? latest : older).push(i); });
  if (!latest.length) { latest = older; older = []; }
  latest.forEach(function (i) { modelMenu.appendChild(modelRow(models[i], i, false)); });
  if (older.length) {
    var more = document.createElement("button");
    more.type = "button"; more.className = "mm-more";
    more.setAttribute("aria-expanded", olderOpen ? "true" : "false");
    more.innerHTML = '<span class="mm-more-label">Older models</span><span class="mm-count"></span>' + CHEV_SVG;
    more.querySelector(".mm-count").textContent = String(older.length);
    more.addEventListener("click", function (e) {
      e.stopPropagation();   // a fold, not a choice: the menu stays open
      olderOpen = !olderOpen; renderModelMenu();
      if (olderOpen) revealInMenu(modelMenu.querySelector(".mm-older"));
    });
    modelMenu.appendChild(more);
    if (olderOpen) {
      var box = document.createElement("div"); box.className = "mm-older";
      older.forEach(function (i) { box.appendChild(modelRow(models[i], i, true)); });
      modelMenu.appendChild(box);
    }
  }

  // Effort — only shown for models that expose it (Haiku 4.5 and older ids don't).
  // Options come straight from the model's own capabilities, so xhigh/max appear
  // exactly where they're supported and nowhere else. Picking one keeps the menu
  // open, because the line under the buttons is how you learn what it does.
  var effList = modelEfforts();
  if (effList.length) {
    var effOn = effectiveEffort();
    modelMenu.insertAdjacentHTML("beforeend", '<div class="mm-sep"></div>');
    var el = document.createElement("div"); el.className = "mm-label"; el.textContent = "Effort"; modelMenu.appendChild(el);
    var seg = document.createElement("div"); seg.className = "effort-seg";
    seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Effort");
    effList.forEach(function (e) {
      var o = document.createElement("button");
      o.type = "button";
      o.className = "effort-opt" + (e === effOn ? " on" : "");
      o.setAttribute("aria-pressed", e === effOn ? "true" : "false");
      o.textContent = effortShort[e] || e;
      o.addEventListener("click", function (ev) {
        ev.stopPropagation();
        curEffort = e; pref("effort", e); saveDefaults({ effort: e }); renderModelMenu();
      });
      seg.appendChild(o);
    });
    modelMenu.appendChild(seg);
    if (effortDesc[effOn]) {
      var ed = document.createElement("div"); ed.className = "effort-desc";
      ed.textContent = effortDesc[effOn]; modelMenu.appendChild(ed);
    }
  }

  // Fast mode, only where the model has it. A greyed-out "Opus models only" row
  // sat in every menu on every other model; the pill still says "· Fast" whenever
  // it is actually on.
  if (modelCapsFast()) {
    modelMenu.insertAdjacentHTML("beforeend", '<div class="mm-sep"></div>');
    var fast = document.createElement("button");
    fast.type = "button";
    fast.className = "mm-toggle";
    fast.setAttribute("role", "switch");
    fast.setAttribute("aria-checked", fastOn ? "true" : "false");
    fast.innerHTML = '<span class="mname"><b>Fast mode</b><span class="mdesc">Same model, faster replies. Costs more.</span></span><span class="switch"></span>';
    fast.addEventListener("click", function (e) {
      e.stopPropagation();
      fastOn = !fastOn; pref("fast", fastOn ? "1" : "0");
      saveDefaults({ fastMode: fastOn });
      updateModelLabel(); renderModelMenu();
    });
    modelMenu.appendChild(fast);
  }
  modelMenu.scrollTop = keep;
}

/* The account's answer, applied whenever it arrives. Called by loadProfile().
   accountModelKey is remembered because the model LIST may still be the offline
   fallback at this point; applyModelList() re-resolves against it once the live
   list lands, so the order of the two fetches stops mattering. */
export let accountModelKey = "";
export function applyAccountDefaults(d) {
  if (!d) return;
  if (typeof d.model === "string" && d.model) {
    accountModelKey = d.model;
    pref("modelId", d.model);
    var at = resolveModelKey(d.model);
    if (at >= 0) curModel = at;
  }
  if (d.effort && effortShort[d.effort]) { curEffort = d.effort; pref("effort", d.effort); }
  if (typeof d.fastMode === "boolean") { fastOn = d.fastMode; pref("fast", fastOn ? "1" : "0"); }
  updateModelLabel();
  if (modelPicker && modelPicker.classList.contains("open")) renderModelMenu();
}

export function closeModel() { modelPicker.classList.remove("open"); modelBtn.setAttribute("aria-expanded", "false"); }

export function initModelPicker() {
  // Restore prefs
  (function () {
    var at = resolveModelKey(pref("modelId"));
    if (at >= 0) curModel = at;
    var ef = pref("effort"); if (ef && effortShort[ef]) curEffort = ef;
    if (pref("fast") === "1") fastOn = true;
  })();

  // On first load, if we only got the offline list (or the call failed), retry once
  // shortly — this clears the common "only a few models show" case on its own.
  loadModels(function (ok, n, live) {
    if (!ok || !live) setTimeout(function () { loadModels(); }, 2000);
  });
  modelBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    var open = modelPicker.classList.toggle("open");
    modelBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      olderOpen = !!(models[curModel] && !models[curModel].latest);
      closeMenu(); closeSkills(); closeFiles(); renderModelMenu();
      if (olderOpen) revealInMenu(modelMenu.querySelector('.mm-older [aria-checked="true"]'));
    }
  });
  updateModelLabel();
  renderModelMenu();
}

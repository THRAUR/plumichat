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
  { key: "claude-opus-4-8", name: "Opus 4.8", short: "Opus 4.8", id: "claude-opus-4-8", fast: true, fam: "opus", newest: true },
  { key: "claude-sonnet-4-6", name: "Sonnet 4.6", short: "Sonnet 4.6", id: "claude-sonnet-4-6", fam: "sonnet", newest: true },
  { key: "claude-haiku-4-5-20251001", name: "Haiku 4.5", short: "Haiku 4.5", id: "claude-haiku-4-5-20251001", fam: "haiku", newest: true }
];
// The families, each with a 1–2 word note on what it does best. Used to group
// the picker into clearly-separated sections. Fable has its own entry now —
// without it Fable 5.1 dropped into the nameless "Other" bucket.
export let FAMILY = {
  opus:   { label: "Opus",   blurb: "Most capable" },
  sonnet: { label: "Sonnet", blurb: "Balanced" },
  haiku:  { label: "Haiku",  blurb: "Fastest" },
  fable:  { label: "Fable",  blurb: "Writing & voice" },
  x:      { label: "Other",  blurb: "" }
};
export function familyOf(id) {
  return /opus/i.test(id) ? "opus" : /sonnet/i.test(id) ? "sonnet"
    : /haiku/i.test(id) ? "haiku" : /fable/i.test(id) ? "fable" : "x";
}

// Used only when a model reports no effort data (the offline fallback list). Live
// models carry their own exact effort levels (see modelEfforts()).
export let DEFAULT_EFFORTS = ["low", "medium", "high", "max"];
export let effortShort = { low: "Low", medium: "Med", high: "High", xhigh: "XHi", max: "Max" };
export let curModel = 1;          // Sonnet 4.6
export let curEffort = "high";
export let fastOn = false;
export let modelsLive = true;     // false once we know we're showing the offline fallback
export let modelPicker = $("modelPicker");
export let modelBtn = $("modelBtn");
export let modelMenu = $("modelMenu");
export let modelLabel = $("modelLabel");

// Swap the static fallback for the account's LIVE model list (auto-updates as
// Anthropic grants new models). Every model is fully selectable; the picker is
// grouped by family (Opus / Sonnet / Haiku / Fable) and only the latest of each
// family is tagged "Newest" — older ones carry no tag (you can still pick any of
// them, exactly like Claude Code). A "1M context" twin is added for every model
// the SERVER marks `ctx1m` (it mirrors the CLI's own '[1m]' picker rows). The old
// client-side /sonnet-4/ test made the twin vanish the day Sonnet 5 shipped, and
// never offered it on Opus 5 / Fable 5.1 at all. Re-resolves the saved pick (an
// old/invalid id falls back to the newest Sonnet).
export function applyModelList(list) {
  if (!list || !list.length) return;
  var seen = {}, out = [];
  list.forEach(function (m) {
    var fam = familyOf(m.id);
    var newest = !seen[fam]; seen[fam] = true;
    // label = clean menu text (family header already names the family);
    // short = collapsed-pill text (keeps the "· 1M" so the mode shows when closed).
    out.push({ key: m.id, label: m.short, short: m.short, id: m.id, fast: !!m.fast,
               fam: fam, newest: newest, efforts: m.efforts });
    // 1M context: offered exactly where the server says the model supports it.
    if (m.ctx1m) {
      out.push({ key: m.id + "#1m", label: m.short, short: m.short + " · 1M",
                 id: m.id, fast: false, fam: fam, newest: false, ctx1m: true, efforts: m.efforts });
    }
  });
  models = out;
  // The account's model may land before OR after the live list — /api/models and
  // /api/settings/profile are two independent fetches. Whichever arrives second
  // has to win, so the pending account key is re-resolved here rather than only
  // in applyAccountDefaults().
  var mid = accountModelKey || pref("modelId"), idx = -1;
  models.forEach(function (m, i) { if (m.key === mid) idx = i; });
  if (idx < 0) {
    models.forEach(function (m, i) { if (idx < 0 && m.fam === "sonnet" && m.newest && !m.ctx1m) idx = i; });
    if (idx < 0) idx = 0;
    pref("modelId", models[idx].key);
  }
  curModel = idx;
  updateModelLabel(); renderModelMenu();
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

export function renderModelMenu() {
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

  var curFam = null;
  models.forEach(function (m, i) {
    // New family → emit a section header: bold family name + a 1–2 word note.
    if (m.fam !== curFam) {
      curFam = m.fam;
      var meta = FAMILY[curFam] || { label: curFam || "Models", blurb: "" };
      var h = document.createElement("div");
      h.className = "mm-fam" + (i === 0 ? " first" : "");
      var nm = document.createElement("span"); nm.className = "mm-fam-name"; nm.textContent = meta.label; h.appendChild(nm);
      if (meta.blurb) { var bl = document.createElement("span"); bl.className = "mm-fam-blurb"; bl.textContent = meta.blurb; h.appendChild(bl); }
      modelMenu.appendChild(h);
    }
    var b = document.createElement("button");
    b.className = "model-item";
    b.setAttribute("role", "option");
    b.setAttribute("aria-checked", i === curModel ? "true" : "false");
    var name = document.createElement("span"); name.className = "mname";
    var bb = document.createElement("b"); bb.textContent = m.label || m.short; name.appendChild(bb);
    b.appendChild(name);
    // Tag only the meaningful cases: the 1M-context twin, and the newest of a
    // family. Everything else (older versions) stays untagged but selectable.
    if (m.ctx1m) { var t1 = document.createElement("span"); t1.className = "mtag ctx"; t1.textContent = "1M context"; b.appendChild(t1); }
    else if (m.newest) { var t2 = document.createElement("span"); t2.className = "mtag new"; t2.textContent = "Newest"; b.appendChild(t2); }
    b.insertAdjacentHTML("beforeend", tickSvg());
    b.addEventListener("click", function () {
      curModel = i; pref("modelId", m.key);
      saveDefaults({ model: m.key });
      updateModelLabel(); renderModelMenu();
    });
    modelMenu.appendChild(b);
  });

  // Effort — only shown for models that expose it (Haiku and older ids don't).
  // Options come straight from the model's own capabilities, so xhigh/max appear
  // exactly where they're supported and nowhere else.
  var effList = modelEfforts();
  if (effList.length) {
    var effOn = effectiveEffort();
    modelMenu.insertAdjacentHTML("beforeend", '<div class="mm-sep"></div>');
    var el = document.createElement("div"); el.className = "mm-label"; el.textContent = "Effort"; modelMenu.appendChild(el);
    var hint = document.createElement("div"); hint.className = "effort-hint";
    hint.innerHTML = "<span>Faster</span><span>Smarter</span>"; modelMenu.appendChild(hint);
    var seg = document.createElement("div"); seg.className = "effort-seg";
    effList.forEach(function (e) {
      var o = document.createElement("button");
      o.className = "effort-opt" + (e === effOn ? " on" : "");
      o.textContent = effortShort[e] || e;
      o.addEventListener("click", function () {
        curEffort = e; pref("effort", e); saveDefaults({ effort: e }); renderModelMenu();
      });
      seg.appendChild(o);
    });
    modelMenu.appendChild(seg);
  }

  modelMenu.insertAdjacentHTML("beforeend", '<div class="mm-sep"></div>');
  var fast = document.createElement("button");
  fast.className = "mm-toggle";
  fast.disabled = !modelCapsFast();
  fast.setAttribute("aria-checked", (fastOn && modelCapsFast()) ? "true" : "false");
  fast.innerHTML = '<span class="mname"><b>Fast mode</b><span class="mdesc">' +
    (modelCapsFast() ? "Faster output on Opus" : "Opus models only") + '</span></span><span class="switch"></span>';
  fast.addEventListener("click", function () {
    if (!modelCapsFast()) return;
    fastOn = !fastOn; pref("fast", fastOn ? "1" : "0");
    saveDefaults({ fastMode: fastOn });
    updateModelLabel(); renderModelMenu();
  });
  modelMenu.appendChild(fast);
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
    models.forEach(function (m, i) { if (m.key === d.model) curModel = i; });
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
    var mid = pref("modelId");
    if (mid) models.forEach(function (m, i) { if (m.key === mid) curModel = i; });
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
    if (open) { closeMenu(); closeSkills(); closeFiles(); renderModelMenu(); }
  });
  updateModelLabel();
  renderModelMenu();
}

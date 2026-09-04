import { reqJSON } from '../api.js';
import { $, toast } from '../dom.js';
import { closeSheet, openSheet, sheetActions, sheetButton, sheetNote, sheetOpenName, sheetSection } from '../sheet.js';
import { activeSessionId, projName } from '../state.js';
import { fmtTokens, send } from '../stream.js';

/* ---------- Context ring, compact, rewind, fork (audit F4) ----------
   The four things the terminal does to a conversation that PlumiChat could only
   watch. The server reaches the SDK's session controls out-of-band (see
   server/context.js), so all of this works on the one-process-per-turn engine.

   The ring is deliberately cheap: it moves on its own after every turn from the
   `context` event the server derives from that turn's token usage, and only
   spends a (token-free, ~1s) fresh read when you actually open the sheet. */

export let ctxBtn = $("ctxBtn");

// sessionId -> snapshot { used, max, percent, model, categories, autoCompactAt, categoriesStale }
const known = {};
let sheetBusy = false;
// What the ring currently shows. updateSend() calls reflectContext on every
// keystroke (it is the one hook every view change also goes through), and
// rebuilding the SVG that often is pure waste — so redraw only on a real change.
let painted = "";

export function noteContext(sessionId, ctx) {
  if (!sessionId || !ctx) return;
  known[sessionId] = ctx;
  reflectContext();
}

function snap() { return activeSessionId ? known[activeSessionId] : null; }

// A page reload starts with an empty `known`, so the ring would sit blank on a
// conversation the server already has a figure for. Ask once per conversation for
// the CACHED snapshot — no `refresh`, so the server answers from memory and starts
// no CLI. A miss is silent: a conversation nobody has read yet simply has no ring
// until you tap it.
const asked = new Set();
function primeFromCache() {
  const project = projName(), id = activeSessionId;
  if (!project || !id || known[id] || asked.has(id)) return;
  asked.add(id);
  reqJSON(`/api/context?project=${encodeURIComponent(project)}&id=${encodeURIComponent(id)}`)
    .then((d) => { if (d && d.context) { known[id] = d.context; reflectContext(); } })
    .catch(() => { /* no snapshot, or not ours — the ring just stays unread */ });
}

// Tone thresholds mirror the terminal's own colouring: comfortable, getting full,
// and past the point where the next turn will compact itself.
function toneFor(pct) {
  if (pct == null) return "";
  if (pct >= 90) return "over";
  if (pct >= 70) return "warn";
  return "";
}

const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

// Repaint the composer's ring for whatever conversation is on screen. Hidden for a
// brand-new chat: there is no session to measure yet, and a 0% ring would read as
// a measurement rather than an absence.
export function reflectContext() {
  if (!ctxBtn) return;
  const s = snap();
  if (!activeSessionId) { ctxBtn.hidden = true; painted = ""; return; }
  if (!s) primeFromCache();
  const sig = `${activeSessionId}|${s ? s.percent : "?"}|${s ? s.used : "?"}|${s ? s.max : "?"}`;
  if (sig === painted) return;
  painted = sig;
  ctxBtn.hidden = false;
  const pct = s && typeof s.percent === "number" ? Math.max(0, Math.min(100, s.percent)) : null;
  ctxBtn.dataset.tone = toneFor(pct);
  // A turn's own usage tells us how much context is IN USE, but not the size of the
  // window it sits in — that only comes from a reading. So when the denominator is
  // unknown, show the numerator: "41k" is a real measurement, whereas any
  // percentage we could compute here would be one we invented. One tap on the ring
  // fills the window in, and it stays filled for the rest of the conversation.
  const used = s && s.used ? fmtTokens(s.used) : null;
  ctxBtn.setAttribute("aria-label", pct == null
    ? (used ? `${used} tokens in context` : "Context usage")
    : `Context ${pct}% full`);
  ctxBtn.title = pct == null
    ? (used ? `${used} tokens in context — tap to read the window` : "Context — tap to read")
    : `Context ${pct}% full${s && s.max ? ` (${fmtTokens(s.used)} of ${fmtTokens(s.max)})` : ""}`;
  const dash = pct == null ? 0 : (RING_C * pct) / 100;
  ctxBtn.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">' +
      `<circle class="ctx-track" cx="12" cy="12" r="${RING_R}" fill="none" stroke-width="2.6"></circle>` +
      `<circle class="ctx-fill" cx="12" cy="12" r="${RING_R}" fill="none" stroke-width="2.6"` +
        ` stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${RING_C.toFixed(2)}"` +
        ' transform="rotate(-90 12 12)"></circle>' +
    "</svg>" +
    `<span class="ctx-pct">${pct == null ? (used || "–") : pct + "%"}</span>`;
}

function pctOf(s) { return (s && typeof s.percent === "number") ? s.percent : null; }

// --- The sheet --------------------------------------------------------------

function buildContextSheet(box) {
  const s = snap();
  const pct = pctOf(s);

  const head = document.createElement("div");
  head.className = "ctx-head";
  head.dataset.tone = toneFor(pct);
  const dash = pct == null ? 0 : (RING_C * Math.max(0, Math.min(100, pct))) / 100;
  head.innerHTML =
    '<svg class="ctx-big" width="76" height="76" viewBox="0 0 24 24" aria-hidden="true">' +
      `<circle class="ctx-track" cx="12" cy="12" r="${RING_R}" fill="none" stroke-width="2.4"></circle>` +
      `<circle class="ctx-fill" cx="12" cy="12" r="${RING_R}" fill="none" stroke-width="2.4"` +
        ` stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${RING_C.toFixed(2)}"` +
        ' transform="rotate(-90 12 12)"></circle>' +
    "</svg>" +
    '<div class="ctx-headtx">' +
      `<strong>${pct == null ? (s && s.used ? `${fmtTokens(s.used)} tokens` : "Not read yet") : pct + "% full"}</strong>` +
      `<span>${s && s.max
        ? `${fmtTokens(s.used)} of ${fmtTokens(s.max)} tokens`
        : (s && s.used ? "in context — the window size has not been read yet" : "Tap Refresh for a reading")}</span>` +
      (s && s.model ? `<span class="ctx-dim">${s.model}</span>` : "") +
    "</div>";
  box.appendChild(head);

  if (s && s.autoCompactAt) {
    sheetNote(box, `Compacts itself automatically at ${fmtTokens(s.autoCompactAt)} tokens.`);
  }

  // Category bars. Free space and the deferred rows are shown as what they are —
  // the docs exclude deferred tool schemas from the usage math, so stacking them
  // into the "used" bar would overstate the fill.
  const cats = (s && s.categories) || [];
  if (cats.length) {
    sheetSection(box, s.categoriesStale ? "Breakdown (as of the last reading)" : "Breakdown");
    const max = s.max || cats.reduce((n, c) => n + c.tokens, 0) || 1;
    const list = document.createElement("div");
    list.className = "ctx-cats";
    cats.forEach((c) => {
      const row = document.createElement("div");
      row.className = "ctx-cat";
      if (c.free) row.dataset.kind = "free";
      if (c.deferred) row.dataset.kind = "deferred";
      row.innerHTML =
        `<span class="ctx-cat-nm">${c.name}</span>` +
        `<span class="ctx-cat-bar"><i style="width:${Math.min(100, (c.tokens / max) * 100).toFixed(1)}%"></i></span>` +
        `<span class="ctx-cat-tk">${fmtTokens(c.tokens)}</span>`;
      list.appendChild(row);
    });
    box.appendChild(list);
  } else if (s) {
    sheetNote(box, "No breakdown yet — Refresh reads it from the session (costs no tokens).");
  }

  const row = sheetActions(box);
  sheetButton(row, sheetBusy ? "Reading…" : "Refresh", "", refreshContext);
  sheetButton(row, "Compact now", "", () => {
    closeSheet();
    // /compact is a real CLI command; the turn machinery passes it straight
    // through and the SDK expands it, exactly as typing it would.
    send("/compact", []);
  });

  sheetSection(box, "This conversation");
  const row2 = sheetActions(box);
  sheetButton(row2, "Fork", "", doFork);
  sheetButton(row2, "Rewind files…", "", openRewind);
  sheetNote(box, "Fork copies the conversation into a new one — the original is untouched. " +
    "Rewind restores the files on disk to how they were at a chosen message; it does not delete messages.");
}

export function openContextSheet() {
  openSheet("context", "Context", buildContextSheet);
  // Always take a fresh reading on open. It spends a ~1s CLI start and no tokens,
  // and a ring you tapped should not answer with something from an hour ago.
  refreshContext();
}

// Redraw the sheet only if it is still the sheet on screen: a reading takes about
// a second, which is long enough to have closed it or opened another.
function repaintSheet() {
  if (sheetOpenName === "context") openSheet("context", "Context", buildContextSheet);
}

// reqJSON resolves with the BODY and throws the server's own error text on a
// non-2xx — there is no {ok, d} envelope here. Reading one anyway is how the
// first cut of this panel failed silently: every reading landed in a branch that
// showed "Not read yet" forever.
function refreshContext() {
  const project = projName(), id = activeSessionId;
  if (!project || !id || sheetBusy) return;
  sheetBusy = true;
  repaintSheet();
  reqJSON(`/api/context?project=${encodeURIComponent(project)}&id=${encodeURIComponent(id)}&refresh=1`)
    .then((d) => {
      sheetBusy = false;
      if (!d || !d.context) throw new Error("The context came back empty");
      known[id] = d.context;
      asked.add(id);
      reflectContext();
      repaintSheet();
    })
    .catch((e) => {
      sheetBusy = false;
      repaintSheet();
      toast(e.message || "Could not read the context", true);
    });
}

// --- Fork -------------------------------------------------------------------

function doFork() {
  const project = projName(), id = activeSessionId;
  if (!project || !id) return;
  toast("Forking…");
  reqJSON(`/api/sessions/${encodeURIComponent(id)}/fork`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project }),
  })
    .then((d) => {
      if (!d || !d.sessionId) throw new Error("Fork produced no conversation");
      closeSheet();
      // Ask the drawer to reload and open the copy, rather than importing
      // library.js: that module already needs reflectContext from here, and a
      // two-way import between a panel and the library is exactly the shape the
      // split was done to get rid of.
      document.dispatchEvent(new CustomEvent("plumi:open-session", {
        detail: { project, id: d.sessionId },
      }));
      toast("Forked — you're in the copy");
    })
    .catch((e) => toast(e.message || "Fork failed", true));
}

// --- Rewind -----------------------------------------------------------------

let points = [], preview = null;

function openRewind() {
  const project = projName(), id = activeSessionId;
  if (!project || !id) return;
  preview = null;
  openSheet("rewind", "Rewind files", (box) => sheetNote(box, "Reading the conversation…"));
  reqJSON(`/api/sessions/${encodeURIComponent(id)}/rewind-points?project=${encodeURIComponent(project)}`)
    .then((d) => {
      points = (d && d.points) || [];
      openSheet("rewind", "Rewind files", buildRewind);
    })
    .catch((e) => { closeSheet(); toast(e.message || "Could not list the messages", true); });
}

function buildRewind(box) {
  sheetNote(box, "Restores the files on disk to their state at the message you pick. " +
    "Your messages and the answers stay exactly where they are — only files change.");
  if (!points.length) {
    sheetNote(box, "Nothing to rewind to yet. Files are checkpointed from this conversation's next turn onwards.");
    return;
  }
  sheetSection(box, "Rewind to just before");
  const list = document.createElement("div");
  list.className = "rw-list";
  // Newest first: the message you want back is almost always a recent one.
  points.slice().reverse().forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rw-row";
    if (preview && preview.id === p.id) b.classList.add("sel");
    b.innerHTML = `<span class="rw-tx"></span>${p.at ? `<span class="rw-at">${new Date(p.at).toLocaleString()}</span>` : ""}`;
    b.querySelector(".rw-tx").textContent = p.text;
    b.addEventListener("click", () => askPreview(p));
    list.appendChild(b);
  });
  box.appendChild(list);

  if (preview) {
    sheetSection(box, "What would change");
    if (preview.error || !preview.canRewind) {
      sheetNote(box, preview.error || "Nothing was checkpointed at that message, so there is nothing to restore.");
    } else if (!preview.files.length) {
      sheetNote(box, "No file differs from that point — nothing to restore.");
    } else {
      const ul = document.createElement("div");
      ul.className = "rw-files";
      preview.files.forEach((f) => {
        const d = document.createElement("div");
        d.className = "rw-file";
        d.textContent = f;
        ul.appendChild(d);
      });
      box.appendChild(ul);
      sheetNote(box, `${preview.files.length} file${preview.files.length === 1 ? "" : "s"} · +${preview.insertions} −${preview.deletions}`);
      const row = sheetActions(box);
      sheetButton(row, "Restore these files", "danger", () => applyRewind(preview.id));
    }
  }
}

function askPreview(p) {
  const project = projName(), id = activeSessionId;
  preview = { id: p.id, files: [], insertions: 0, deletions: 0, canRewind: false, error: "Checking…" };
  openSheet("rewind", "Rewind files", buildRewind);
  reqJSON(`/api/sessions/${encodeURIComponent(id)}/rewind`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, messageId: p.id, dryRun: true }),
  })
    .then((d) => {
      preview = { id: p.id, ...d };
      openSheet("rewind", "Rewind files", buildRewind);
    })
    .catch((e) => { preview = null; openSheet("rewind", "Rewind files", buildRewind); toast(e.message || "Preview failed", true); });
}

function applyRewind(messageId) {
  const project = projName(), id = activeSessionId;
  toast("Restoring…");
  reqJSON(`/api/sessions/${encodeURIComponent(id)}/rewind`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, messageId, dryRun: false }),
  })
    .then((d) => {
      closeSheet();
      const n = (d.files || []).length;
      toast(d.skippedLinks
        ? `Restored, but ${d.skippedLinks} file(s) were skipped as unsafe links`
        : `Files restored${n ? ` (${n})` : ""}`);
    })
    .catch((e) => toast(e.message || "Rewind failed", true));
}

export function initContext() {
  if (!ctxBtn) return;
  ctxBtn.addEventListener("click", openContextSheet);
  reflectContext();
}

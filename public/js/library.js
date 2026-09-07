/* PlumiChat — projects, conversations and the drawer that lists them.

   The conversation library: fetching and rendering the drawer, pin/archive/rename/
   delete, opening a session, reflecting a running turn onto its row, the swipe
   gesture and the desktop sidebar's resize handle. */

import { apiFetch } from './api.js';
import { updateSend } from './composer.js';
import { $, EMBED, PANE, input, pref, toast } from './dom.js';
import { fpModal } from './files.js';
import { fetchSessions, loadSessionMessages, sessionsFailed } from './history.js';
import { ARCHIVE_SVG, PIN_SVG, UNARCHIVE_SVG } from './icons.js';
import { pickerLabel, renderMenu } from './projects.js';
import { clearMessages, renderMessages } from './render.js';
import { activeSessionId, activeStreams, draftFor, drafts, dropIdleDrafts, freshViewKey, projName, projects, sessionsCache, setActiveSessionId, setCurrent, setViewKey, startDraft, viewKey, viewToken } from './state.js';
import { friendlyModel, setStatus, setTurnModelInfo, syncRuns } from './stream.js';
import { waitingState } from './tasks.js';
import { flushQueued, renderTaskTray, refreshQueue } from './tray.js';
import { renderUsageChip } from './usage.js';

/* ---------- Conversation library drawer ---------- */
export let menuBtn = $("menuBtn");
export let drawer = $("drawer");
export let drawerOverlay = $("drawerOverlay");
export let drawerBody = $("drawerBody");
export let drawerClose = $("drawerClose");
export let newChatBtn = $("newChatBtn");
export let drawerSearchInput = $("drawerSearchInput");
export let opsNav = $("opsNav");
export let gridNav = $("gridNav");
export let themeToggle = $("themeToggle");
export let userChip = $("userChip");
export let topbarTitle = $("topbarTitle");

// On desktop (>=900px) the drawer is a persistent sidebar (no .open class),
// so "is the library on screen?" means open-on-mobile OR desktop.
// Embedded panes are always single-column with an overlay drawer — never the
// wide-screen persistent sidebar (a pane can be wider than 900px in the grid).
export function isDesktop() { if (EMBED) return false; try { return window.matchMedia("(min-width: 900px)").matches; } catch (e) { return false; } }
export function libraryVisible() { return drawer.classList.contains("open") || isDesktop(); }

// In grid (embed) mode, tell the parent dashboard this pane's current project +
// conversation title + session id, so its thin pane bar can show a live label
// and its saved profiles can capture WHICH conversation this pane is on.
export function postPaneMeta(project, title) {
  if (!EMBED || window.parent === window) return;
  try {
    window.parent.postMessage(
      { type: "plumi:meta", pane: PANE, project: project || "", title: title || "", session: activeSessionId || "" },
      location.origin
    );
  } catch (e) {}
}

// Split view: report live activity (busy) and pending prompts (attention) to
// the parent grid so the pane bar can show a status dot for this pane.
export let paneBusy = false, paneAttn = false;
export function updatePaneState() {
  if (!EMBED || window.parent === window) return;
  var busy = false, attn = false;
  Object.keys(activeStreams).forEach(function (k) {
    busy = true;
    (activeStreams[k].asks || []).forEach(function (a) { if (!a.answered) attn = true; });
  });
  if (busy === paneBusy && attn === paneAttn) return;
  paneBusy = busy; paneAttn = attn;
  try {
    window.parent.postMessage(
      { type: "plumi:state", pane: PANE, busy: busy, attention: attn },
      location.origin
    );
  } catch (e) {}
}

// The desktop topbar shows the active conversation title.
export function updateTopbarTitle() {
  if (!topbarTitle) return;
  var name = projName();
  var title = "New conversation";
  if (activeSessionId && name) {
    var list = sessionsCache[name] || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === activeSessionId) { title = list[i].title || "Untitled"; break; }
    }
  }
  // While a new conversation is still a draft (not yet in the cache), show its
  // live title — which flips from "New conversation" to the AI summary mid-turn.
  var liveDraft = draftFor(activeSessionId) || draftFor(viewKey);
  if (liveDraft && liveDraft.title) title = liveDraft.title;
  topbarTitle.textContent = title;
  postPaneMeta(name, title);
}

export let archOpen = {};   // per-project: is the "Archived" section expanded? (survives re-render)

// Pinned float to the top; otherwise newest first (mirrors the server's order).
export function convSort(a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0); }

export let PIN_LIMIT = 10;   // most conversations allowed in the top "Pinned" category

// Count active pins (pinned && not archived) across every project, optionally
// ignoring one conversation id (the one we're about to toggle).
export function pinnedCount(exceptId) {
  var n = 0;
  Object.keys(sessionsCache).forEach(function (proj) {
    (sessionsCache[proj] || []).forEach(function (s) {
      if (s.pinned && !s.archived && s.id !== exceptId) n++;
    });
  });
  return n;
}

// Toggle a conversation's pin / archive flag, persist it, and re-render.
export function setConvFlags(projectName, conv, patch) {
  // Enforce the pin ceiling before we touch the server, so the cap holds even
  // if a legacy account somehow has more than the limit already pinned.
  if (patch.pinned === true && pinnedCount(conv.id) >= PIN_LIMIT) {
    toast("Pin limit reached (" + PIN_LIMIT + "). Unpin one first.", true);
    return;
  }
  var body = { project: projectName };
  if ("pinned" in patch) body.pinned = patch.pinned;
  if ("archived" in patch) body.archived = patch.archived;
  apiFetch("/api/sessions/" + encodeURIComponent(conv.id) + "/flags", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      if (!res.ok) { toast((res.d && res.d.error) || "Couldn't update", true); return; }
      conv.pinned = !!res.d.pinned; conv.archived = !!res.d.archived;
      var list = sessionsCache[projectName] || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === conv.id) { list[i].pinned = conv.pinned; list[i].archived = conv.archived; break; }
      }
      list.sort(convSort);
      if (conv.archived) archOpen[projectName] = true; // reveal where it just went
      renderLibrary(drawerSearchInput.value);
      if ("pinned" in patch) toast(conv.pinned ? "Pinned to top" : "Unpinned");
      else if ("archived" in patch) toast(conv.archived ? "Archived" : "Unarchived");
    })
    .catch(function () { toast("Couldn't update", true); });
}

export function renderLibrary(filter) {
  var q = (filter || "").trim().toLowerCase();
  drawerBody.innerHTML = "";
  var shown = 0;
  var pinnedCollected = [];   // {c, el} hoisted from every project into a top "Pinned" group
  projects.forEach(function (p, pi) {
    var sessions = sessionsCache[p.name] || [];
    var list = sessions;
    // Inject every unsaved "New conversation" draft belonging to this project
    // (unless the real, persisted conversation has already replaced it in the
    // cache). More than one can exist: a new chat whose turn is still running
    // keeps its row while you start another.
    var rows = [];
    Object.keys(drafts).forEach(function (dk) {
      var d = drafts[dk];
      if (d.project !== p.name) return;
      if (sessions.some(function (s) { return s.id === d.key; })) return;
      rows.push({ id: d.key, title: d.title, _draft: true });
    });
    if (rows.length) list = rows.concat(sessions);
    var matches = list.filter(function (c) {
      return !q || (c.title || "").toLowerCase().indexOf(q) >= 0;
    });
    if (!matches.length) return;

    var group = document.createElement("div");
    group.className = "proj-group";
    var head = document.createElement("div");
    head.className = "proj-head";
    var nm = document.createElement("span"); nm.className = "proj-name"; nm.textContent = p.name;
    var ct = document.createElement("span"); ct.className = "proj-count"; ct.textContent = sessions.length;
    head.appendChild(nm); head.appendChild(ct);
    group.appendChild(head);

    function buildRow(c) {
      var row = document.createElement("div");
      row.className = "conv-row" + (c.pinned ? " pinned" : "");

      var btn = document.createElement("button");
      var isActive = p.name === projName() && (c._draft ? c.id === viewKey : c.id === activeSessionId);
      btn.className = "conv"
        + (isActive ? " active" : "")
        + (activeStreams[c.id] ? " streaming" : "")
        + (c._draft ? " draft" : "");
      btn.type = "button";
      var dot = document.createElement("span"); dot.className = "cdot";
      var title = document.createElement("span"); title.className = "ctitle"; title.textContent = c.title || "Untitled";
      btn.appendChild(dot); btn.appendChild(title);
      btn.addEventListener("click", function () {
        setCurrent(pi);
        pref("lastProject", p.name);
        pickerLabel.textContent = p.name;
        renderMenu();
        // The draft is just the on-screen new conversation — nothing to load.
        if (c._draft) { closeDrawer(); return; }
        openSession(p.name, c.id);
        closeDrawer();
      });

      row.appendChild(btn);

      // A draft isn't a real, persisted conversation yet — no row actions.
      if (!c._draft) {
        var pin = document.createElement("button");
        pin.className = "conv-cfg conv-pin" + (c.pinned ? " on" : "");
        pin.type = "button";
        pin.title = c.pinned ? "Unpin" : "Pin";
        pin.setAttribute("aria-label", c.pinned ? "Unpin conversation" : "Pin conversation");
        pin.innerHTML = PIN_SVG;

        var arch = document.createElement("button");
        arch.className = "conv-cfg conv-arch";
        arch.type = "button";
        arch.title = c.archived ? "Unarchive" : "Archive";
        arch.setAttribute("aria-label", c.archived ? "Unarchive conversation" : "Archive conversation");
        arch.innerHTML = c.archived ? UNARCHIVE_SVG : ARCHIVE_SVG;

        var ren = document.createElement("button");
        ren.className = "conv-cfg";
        ren.type = "button";
        ren.title = "Rename";
        ren.setAttribute("aria-label", "Rename conversation");
        ren.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>';

        var del = document.createElement("button");
        del.className = "conv-cfg conv-del";
        del.type = "button";
        del.title = "Delete";
        del.setAttribute("aria-label", "Delete conversation");
        del.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path></svg>';

        var cfgBtns = [pin, arch, ren, del];
        pin.addEventListener("click", function (e) { e.stopPropagation(); setConvFlags(p.name, c, { pinned: !c.pinned }); });
        arch.addEventListener("click", function (e) { e.stopPropagation(); setConvFlags(p.name, c, { archived: !c.archived }); });
        ren.addEventListener("click", function (e) { e.stopPropagation(); beginRename(row, btn, cfgBtns, p.name, c); });
        del.addEventListener("click", function (e) { e.stopPropagation(); beginDelete(row, btn, cfgBtns, p.name, c); });

        // The four buttons live in an absolutely-positioned overlay (see
        // .conv-actions) so they never steal width from the title.
        var actions = document.createElement("div");
        actions.className = "conv-actions";
        actions.appendChild(pin); actions.appendChild(arch); actions.appendChild(ren); actions.appendChild(del);
        row.appendChild(actions);
      }
      return row;
    }

    // Active pins are hoisted into the global top group; exclude them here so a
    // pinned conversation shows once (at the top), not twice.
    var pinnedRows = matches.filter(function (c) { return c.pinned && !c.archived && !c._draft; });
    var liveRows = matches.filter(function (c) { return !c.archived && !c.pinned; });
    var archivedRows = matches.filter(function (c) { return c.archived && !c._draft; });
    pinnedRows.forEach(function (c) { pinnedCollected.push({ c: c, el: buildRow(c) }); });

    // A project whose only conversations are pinned (now hoisted) shows no group.
    if (!liveRows.length && !archivedRows.length) return;
    shown++;

    liveRows.forEach(function (c) { group.appendChild(buildRow(c)); });
    if (archivedRows.length) {
      var det = document.createElement("details");
      det.className = "conv-archived";
      if (archOpen[p.name]) det.open = true;
      det.addEventListener("toggle", function () { archOpen[p.name] = det.open; });
      var sum = document.createElement("summary");
      sum.className = "conv-arch-sum";
      sum.textContent = "Archived (" + archivedRows.length + ")";
      det.appendChild(sum);
      archivedRows.forEach(function (c) { det.appendChild(buildRow(c)); });
      group.appendChild(det);
    }
    drawerBody.appendChild(group);
  });

  // The "Pinned" group is built last but lives above every project group.
  // Sort newest-first so its order is stable regardless of source project.
  if (pinnedCollected.length) {
    pinnedCollected.sort(function (a, b) { return (b.c.updatedAt || 0) - (a.c.updatedAt || 0); });
    var pinGroup = document.createElement("div");
    pinGroup.className = "proj-group pinned-group";
    var pinHead = document.createElement("div");
    pinHead.className = "proj-head";
    var pinIcon = document.createElement("span");
    pinIcon.className = "proj-pin-icon";
    pinIcon.innerHTML = PIN_SVG;
    var pinNm = document.createElement("span"); pinNm.className = "proj-name"; pinNm.textContent = "Pinned";
    var pinCt = document.createElement("span"); pinCt.className = "proj-count"; pinCt.textContent = pinnedCollected.length;
    pinHead.appendChild(pinIcon); pinHead.appendChild(pinNm); pinHead.appendChild(pinCt);
    pinGroup.appendChild(pinHead);
    pinnedCollected.forEach(function (item) { pinGroup.appendChild(item.el); });
    drawerBody.insertBefore(pinGroup, drawerBody.firstChild);
    shown++;
  }

  if (!shown) {
    var empty = document.createElement("div");
    empty.className = "drawer-empty";
    // Distinguish "you have no conversations" from "we couldn't ask" — a
    // transient 500/offline blip used to be reported as an empty history.
    var failed = projects.some(function (p) { return sessionsFailed[p.name]; });
    if (!q && failed) {
      empty.textContent = "Couldn't load your conversations. ";
      var again = document.createElement("button");
      // Reuses the stop-notice pill so it's styled without a CSS change (that
      // file belongs to another pass); .drawer-retry is the hook if it wants one.
      again.type = "button"; again.className = "notice-continue drawer-retry"; again.textContent = "Retry";
      again.addEventListener("click", function () { again.disabled = true; refreshLibrary(); });
      empty.appendChild(again);
    } else {
      empty.textContent = q ? ("No conversations match “" + q + "”") : "No conversations yet — say hello.";
    }
    drawerBody.appendChild(empty);
  }
}

// Fetch sessions for every project, then render the library.
export function refreshLibrary() {
  drawerBody.innerHTML = '<div class="drawer-empty">Loading…</div>';
  return Promise.all(projects.map(function (p) { return fetchSessions(p.name); }))
    .then(function () { renderLibrary(drawerSearchInput.value); });
}

// Inline-rename a conversation in the drawer: swap the row for a text field.
// Enter or blur saves; Escape cancels. Persisted via PATCH /api/sessions/:id.
export function beginRename(row, btn, cfgBtns, projectName, conv) {
  if (row.querySelector(".conv-rename") || row.querySelector(".conv-confirm")) return; // already editing/confirming
  var input = document.createElement("input");
  input.className = "conv-rename";
  input.type = "text";
  input.value = conv.title || "";
  input.maxLength = 200;
  row.classList.add("row-edit");   // hide the hover overlay while editing
  btn.style.display = "none"; cfgBtns.forEach(function (b) { b.style.display = "none"; });
  row.insertBefore(input, row.firstChild);
  input.focus(); input.select();

  var done = false;
  function finish(save) {
    if (done) return; done = true;
    var next = input.value.trim();
    if (input.parentNode) input.remove();
    row.classList.remove("row-edit");
    btn.style.display = ""; cfgBtns.forEach(function (b) { b.style.display = ""; });
    if (save && next && next !== conv.title) renameSession(projectName, conv, next);
  }
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", function () { finish(true); });
}

// Inline delete confirm: clicking the trash swaps the row's config buttons for
// a red Delete / Cancel pair, keeping the conversation title visible so you can
// see which one you're about to remove. Deletion is permanent (the SDK session
// log is erased), hence the explicit confirm.
export function beginDelete(row, btn, cfgBtns, projectName, conv) {
  if (row.querySelector(".conv-confirm") || row.querySelector(".conv-rename")) return; // already confirming/editing
  row.classList.add("row-edit");   // hide the hover overlay while confirming
  cfgBtns.forEach(function (b) { b.style.display = "none"; });
  var wrap = document.createElement("span");
  wrap.className = "conv-confirm";
  var yes = document.createElement("button");
  yes.type = "button"; yes.className = "cc-yes"; yes.textContent = "Delete";
  var no = document.createElement("button");
  no.type = "button"; no.className = "cc-no"; no.textContent = "Cancel";
  wrap.appendChild(yes); wrap.appendChild(no);
  row.appendChild(wrap);

  function restore() { if (wrap.parentNode) wrap.remove(); row.classList.remove("row-edit"); cfgBtns.forEach(function (b) { b.style.display = ""; }); }
  no.addEventListener("click", function (e) { e.stopPropagation(); restore(); });
  yes.addEventListener("click", function (e) {
    e.stopPropagation();
    yes.disabled = true; no.disabled = true;
    deleteConversation(projectName, conv, restore);
  });
}

export function deleteConversation(projectName, conv, restore) {
  apiFetch("/api/sessions/" + encodeURIComponent(conv.id) + "?project=" + encodeURIComponent(projectName), { method: "DELETE" })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      if (!res.ok) { toast((res.d && res.d.error) || "Delete failed", true); if (restore) restore(); return; }
      var list = sessionsCache[projectName] || [];
      sessionsCache[projectName] = list.filter(function (x) { return x.id !== conv.id; });
      // If we were viewing the deleted conversation, drop back to a fresh,
      // empty chat in the same project.
      if (conv.id === activeSessionId) {
        setActiveSessionId(null);
        setViewKey(freshViewKey());
        clearMessages();
        setStatus("hide");
        updateTopbarTitle();
        updateSend();
      }
      renderLibrary(drawerSearchInput.value);
      toast("Conversation deleted");
    })
    .catch(function () { toast("Delete failed", true); if (restore) restore(); });
}

export function renameSession(projectName, conv, title) {
  apiFetch("/api/sessions/" + encodeURIComponent(conv.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title, project: projectName })
  }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      if (!res.ok) { toast((res.d && res.d.error) || "Rename failed", true); return; }
      conv.title = res.d.title || title;
      var list = sessionsCache[projectName] || [];
      for (var i = 0; i < list.length; i++) { if (list[i].id === conv.id) { list[i].title = conv.title; break; } }
      renderLibrary(drawerSearchInput.value);
      if (conv.id === activeSessionId) updateTopbarTitle();
      toast("Renamed");
    })
    .catch(function () { toast("Rename failed", true); });
}

export function openSession(name, id) {
  // Opening an existing conversation abandons an unsent new chat — but keep any
  // draft that's mid-turn in the background (it still belongs in the drawer).
  dropIdleDrafts(id);
  setActiveSessionId(id);
  setViewKey(id);
  clearMessages();
  updateTopbarTitle();
  updateSend();
  // Returns the load, so a caller can append something (a stop notice) AFTER the
  // canonical transcript has painted instead of into the about-to-be-cleared view.
  return loadSessionMessages(name, id).then(function (res) {
    if (viewKey !== id) return; // user navigated away while this was loading
    if (!res.ok) { toast(res.d.error || "Could not load conversation", true); return; }
    renderMessages(res.d.messages || []);
    renderLibrary(drawerSearchInput.value);
    updateTopbarTitle();
    reflectStream(id);
    syncRuns(); // reattach if this conversation has a turn still running
  });
}

// When a conversation is shown, reflect any in-flight turn it has: keep the
// working indicator up and re-show permission/question prompts that arrived
// while it was off-screen (the live tokens themselves replay from disk).
export function reflectStream(key) {
  var s = activeStreams[key];
  renderTaskTray();
  renderUsageChip();
  if (!s) {
    setStatus("hide"); updateSend();
    // Coming back to a conversation whose turn finished while you were elsewhere:
    // anything you queued before switching away goes now (flushQueued only ever
    // fires for the conversation on screen, so this is where it lands).
    flushQueued(key);
    // ...and show whatever is parked for the conversation we just opened. The
    // queue is per-conversation and lives on the server, so switching chats is a
    // read, not a local lookup.
    refreshQueue(key);
    return;
  }
  // Re-bind this still-running turn to the CURRENT view instance so its live
  // events render here. clearMessages()/renderMessages() bump viewToken every
  // time the view is (re)built — including on boot and when reopening — which
  // would otherwise leave an attached stream's token stale and frozen. Mark it
  // attached so onDone reloads the canonical transcript (a fresh attach replays
  // the turn's buffered progress, but our live view began partway through it).
  s.token = viewToken;
  s.attached = true;
  // Restore this turn's model provenance (it's per-stream; the module-level
  // vars may still hold another conversation's turn — or nothing, post-refresh).
  setTurnModelInfo(s.model || "", s.modelSource || "", s.requested || "");
  // A turn parked on background agents keeps saying so when you come back to it.
  var w = waitingState[key];
  if (w && w.text) setStatus("working", w.text);
  else setStatus("working", s.model ? friendlyModel(s.model) + " · working…" : "Working…");
  (s.asks || []).forEach(function (item) { if (!item.answered && s.renderAsk) s.renderAsk(item); });
  updateSend();
}

// Best-effort display title for a conversation (cache → live draft).
export function convTitle(project, key) {
  var list = sessionsCache[project] || [];
  for (var i = 0; i < list.length; i++) { if (list[i].id === key) return list[i].title || ""; }
  var d = draftFor(key);
  if (d && d.title && d.title !== "New conversation") return d.title;
  return "";
}

// Jump to a specific conversation — used by the "needs your input" toast when a
// backgrounded turn raises a permission/question. Switches the project picker to
// its project and opens it; openSession → reflectStream then re-shows the pending
// prompt card that's been waiting in that conversation's stream.
export function goToConversation(project, key) {
  if (!project || !key) return;
  var idx = -1;
  projects.forEach(function (p, i) { if (p.name === project) idx = i; });
  if (idx >= 0) {
    setCurrent(idx);
    pref("lastProject", project);
    pickerLabel.textContent = project;
    renderMenu();
  }
  closeDrawer();
  if (String(key).indexOf("new:") === 0) return; // not persisted yet (won't happen for asks)
  openSession(project, key);
}

export let drawerTimer = null;
export function settleDrawer() { drawer.classList.add("settled"); drawerOverlay.classList.add("settled"); }
export function openDrawer() {
  refreshLibrary();
  clearTimeout(drawerTimer);
  drawer.classList.remove("settled"); drawerOverlay.classList.remove("settled");
  void drawer.offsetWidth;
  drawer.classList.add("open"); drawerOverlay.classList.add("open");
  drawer.setAttribute("aria-hidden", "false"); menuBtn.setAttribute("aria-expanded", "true");
  drawerTimer = setTimeout(settleDrawer, 320);
  // Panels that badge a drawer row (see refreshOpsTag) refresh on this instead of
  // on a timer, and hear it as an event so they never have to import this module.
  document.dispatchEvent(new CustomEvent("plumi:drawer-open"));
}
export function closeDrawer() {
  clearTimeout(drawerTimer);
  drawer.classList.remove("settled"); drawerOverlay.classList.remove("settled");
  void drawer.offsetWidth;
  drawer.classList.remove("open"); drawerOverlay.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true"); menuBtn.setAttribute("aria-expanded", "false");
  drawerTimer = setTimeout(settleDrawer, 320);
}
/* ---------- Drawer touch gestures (swipe to open / drag to close) ---------- */
// Native-app feel on the phone: drag in from the LEFT EDGE to pull the drawer
// open, or drag the open drawer/overlay left to close it. The drawer follows
// the finger 1:1, then commits by position + flick velocity. Overlay mode only
// (phone / embed pane) — the desktop persistent sidebar doesn't slide. Vertical
// scrolling always wins: the gesture engages only once movement is clearly
// horizontal, so lists inside the drawer still scroll normally.
export let DG_EDGE = 28;          // px from the left edge that can start an open-drag
export let DG_SLOP = 8;           // px of movement before we decide the direction
export let DG_FLICK = 0.3;        // px/ms — faster than this commits regardless of position
export let dgActive = false, dgEngaged = false, dgOpening = false;
export let dgStartX = 0, dgStartY = 0, dgLastX = 0, dgLastT = 0, dgVel = 0, dgW = 320, dgOut = 0;
export function dgSetOut(px) { // px = how far the drawer sticks out (0..width)
  dgOut = Math.max(0, Math.min(dgW, px));
  drawer.style.transform = "translateX(" + (dgOut - dgW) + "px)";
  drawerOverlay.style.opacity = String((dgOut / dgW).toFixed(3));
}
// Commit or cancel: put the class state where it belongs, then clear the inline
// drag styles one frame later so the transition animates from the finger's last
// position to the resting point (instead of jumping back and re-animating).
export function dgFinish(open) {
  drawer.classList.remove("dragging"); drawerOverlay.classList.remove("dragging");
  var already = drawer.classList.contains("open");
  if (open && !already) openDrawer();
  else if (!open && already) closeDrawer();
  else { drawer.classList.remove("settled"); drawerOverlay.classList.remove("settled"); void drawer.offsetWidth; }
  requestAnimationFrame(function () { drawer.style.transform = ""; drawerOverlay.style.opacity = ""; });
}
export function dgMove(e) {
  if (!dgActive) return;
  var t = e.touches[0];
  var dx = t.clientX - dgStartX, dy = t.clientY - dgStartY;
  if (!dgEngaged) {
    if (Math.abs(dx) < DG_SLOP && Math.abs(dy) < DG_SLOP) return;
    // Vertical intent, or dragging the wrong way → hand back to the browser.
    if (Math.abs(dy) > Math.abs(dx) || (dgOpening ? dx <= 0 : dx >= 0)) {
      dgActive = false;
      document.removeEventListener("touchmove", dgMove);
      return;
    }
    dgEngaged = true;
    dgW = drawer.getBoundingClientRect().width || 320;
    drawer.classList.remove("settled"); drawerOverlay.classList.remove("settled");
    drawer.classList.add("dragging"); drawerOverlay.classList.add("dragging");
  }
  e.preventDefault(); // engaged: the drawer owns this swipe, not the page scroll
  var dt = e.timeStamp - dgLastT;
  if (dt > 0) dgVel = (t.clientX - dgLastX) / dt;
  dgLastX = t.clientX; dgLastT = e.timeStamp;
  dgSetOut(dgOpening ? t.clientX : dgW + dx);
}
export function dgEnd() {
  if (!dgActive) return;
  dgActive = false;
  document.removeEventListener("touchmove", dgMove);
  if (!dgEngaged) return;
  dgEngaged = false;
  var frac = dgOut / dgW;
  var open = Math.abs(dgVel) > DG_FLICK ? dgVel > 0 : frac > 0.5;
  dgFinish(open);
}
/* ---------- Desktop sidebar resize (drag handle) ---------- */
// The width is saved as a RATIO of the viewport (vw), so a size picked on one
// display carries proportionally to another. Clamped so it always stays usable.
export let sbResizer = $("sidebarResizer");
export function applySidebarPref() {
  var pct = parseFloat(pref("sidebarVw") || "");
  var r = document.documentElement.style;
  if (pct > 0) r.setProperty("--sidebar-w", "clamp(230px, " + pct + "vw, 560px)");
  else r.removeProperty("--sidebar-w");
}
// Manual refresh: re-fetch the conversation list and re-sync any still-running
// turns (so a turn started elsewhere shows up and starts streaming live here).
export let drawerRefresh = $("drawerRefresh");

export function initLibrary() {
  // A forked conversation asks to be opened from panels/context.js. It arrives as
  // an event rather than a call so that panel never has to import this module —
  // this one already imports it, and a two-way pair is what the split removed.
  document.addEventListener("plumi:open-session", function (e) {
    var d = (e && e.detail) || {};
    if (!d.project || !d.id) return;
    refreshLibrary();
    openSession(d.project, d.id);
  });
  menuBtn.addEventListener("click", openDrawer);
  drawerClose.addEventListener("click", closeDrawer);
  drawerOverlay.addEventListener("click", closeDrawer);
  drawerSearchInput.addEventListener("input", function () { renderLibrary(drawerSearchInput.value); });

  document.addEventListener("touchstart", function (e) {
    if (isDesktop() || e.touches.length !== 1) return;
    if (fpModal.classList.contains("open")) return; // file browser sits on top
    var t = e.touches[0];
    var open = drawer.classList.contains("open");
    if (open) {
      // Close-drag only when the touch starts on the drawer or its overlay, so
      // gestures elsewhere (if anything ever overlays them) stay untouched.
      if (!drawer.contains(t.target) && t.target !== drawerOverlay) return;
    } else {
      if (t.clientX > DG_EDGE) return; // open-drag must start at the screen edge
    }
    dgActive = true; dgEngaged = false; dgOpening = !open;
    dgStartX = t.clientX; dgStartY = t.clientY;
    dgLastX = t.clientX; dgLastT = e.timeStamp; dgVel = 0;
    // Non-passive move listener exists ONLY while a candidate gesture is live, so
    // everyday scrolling never runs through a preventDefault-capable handler.
    document.addEventListener("touchmove", dgMove, { passive: false });
  }, { passive: true });
  document.addEventListener("touchend", dgEnd, { passive: true });
  document.addEventListener("touchcancel", dgEnd, { passive: true });

  if (sbResizer && !EMBED) {
    applySidebarPref();
    var sbActive = false;
    var sbMove = function (e) {
      if (!sbActive) return;
      var w = Math.max(230, Math.min(e.clientX, Math.min(560, window.innerWidth * 0.45)));
      document.documentElement.style.setProperty("--sidebar-w", w + "px");
    };
    var sbEnd = function () {
      if (!sbActive) return;
      sbActive = false;
      document.body.classList.remove("sb-resizing");
      document.removeEventListener("pointermove", sbMove);
      document.removeEventListener("pointerup", sbEnd);
      document.removeEventListener("pointercancel", sbEnd);
      var w = drawer.getBoundingClientRect().width;
      pref("sidebarVw", (w / window.innerWidth * 100).toFixed(2));
      applySidebarPref(); // switch from the live px value to the persisted ratio
    };
    sbResizer.addEventListener("pointerdown", function (e) {
      if (!isDesktop()) return;
      sbActive = true;
      document.body.classList.add("sb-resizing");
      // Track on the document, not the 14px handle: pointer capture is flaky in
      // some (especially touch) browsers, and without it the old element-scoped
      // move listener stopped firing the instant the pointer left the strip —
      // which read as "the handle doesn't drag at all".
      document.addEventListener("pointermove", sbMove);
      document.addEventListener("pointerup", sbEnd);
      document.addEventListener("pointercancel", sbEnd);
      try { sbResizer.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    sbResizer.addEventListener("dblclick", function () {
      pref("sidebarVw", "");
      applySidebarPref();
      toast("Sidebar width reset to automatic");
    });
  }

  if (drawerRefresh) drawerRefresh.addEventListener("click", function () {
    if (drawerRefresh.disabled) return;
    drawerRefresh.disabled = true;
    try { drawerRefresh.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 550, easing: "ease" }); } catch (e) {}
    refreshLibrary();
    Promise.resolve(syncRuns()).then(function () {
      // If the open conversation isn't actively streaming here, pull its latest
      // state from disk too (e.g. a turn that finished on another device).
      if (activeSessionId && !activeStreams[viewKey]) openSession(projName(), activeSessionId);
      toast("Conversations refreshed");
    }).then(function () { drawerRefresh.disabled = false; }, function () { drawerRefresh.disabled = false; });
  });
  newChatBtn.addEventListener("click", function () {
    setActiveSessionId(null);
    setViewKey(freshViewKey());
    startDraft();              // show a "New conversation" row in the drawer right away
    clearMessages();
    setStatus("hide");
    updateTopbarTitle();
    updateSend();
    renderLibrary(drawerSearchInput.value);
    closeDrawer();
    input.focus();
  });
  opsNav.addEventListener("click", function () { window.location.href = "/operations.html"; });
  if (gridNav) gridNav.addEventListener("click", function () { window.location.href = "/grid.html"; });
}

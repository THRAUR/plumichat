/* PlumiChat — a turn, from send() to the last event.

   This module owns the turn lifecycle (send / attachRun / syncRuns / consumeStream /
   stopCurrent), the live assistant bubble it streams into, the status bar above the
   composer, and the re-attach machinery that keeps a phone's dropped SSE pipe from
   turning into a fake 'final' answer. It also parks its streams when the page goes
   into the background — that is what lets the SERVER notice you are away and send a
   real Web Push instead of streaming into a tab nobody is looking at. */

import { apiFetch, reqJSON } from './api.js';
import { addPermissionCard, addQuestionCard, addSaveButton } from './cards.js';
import { updateSend } from './composer.js';
import { registerDeliverable } from './panels/deliverables.js';
import { input, messages, toast } from './dom.js';
import { extractDownloadFlags, makeDownloadBox } from './exports.js';
import { fetchSessions } from './history.js';
import { STOP_NOTICE_ICON, THINK_CARET, THINK_ICON } from './icons.js';
import { convTitle, drawerSearchInput, goToConversation, libraryVisible, openSession, renderLibrary, updatePaneState, updateTopbarTitle } from './library.js';
import { curModel, effectiveEffort, fastOn, modelCapsFast, models } from './models.js';
import { notifyAttention, notifyTurnDone } from './panels/notify.js';
import { noteContext } from './panels/context.js';
import { permAllowed, permMode } from './panels/perm.js';
import { addError, addNotice, addRow, addTool, addUser, makeFileBox, mdNode, scrollDown } from './render.js';
import { REATTACH_COOLDOWN_MS, activeSessionId, activeStreams, cur, draftFor, drafts, endingsSeen, projName, reattachTries, recentlyEnded, resetReattachTries, sessionsCache, setActiveSessionId, setCur, setViewKey, viewKey, viewToken } from './state.js';
import { addTurnUsage, clearTasks, emitTasksChanged, limitResetMs, noteTask, rekeyTaskState, setLimits, thinkingState, waitingState } from './tasks.js';
import { flushQueued, renderTaskTray } from './tray.js';

/* ---------- Live streaming assistant ---------- */
// The REAL model the server reported for the in-flight turn. Two grades of
// proof: source 'init' = what the SDK configured (echo of the request);
// source 'api' = the id Anthropic's API stamped on the response body itself —
// serving-side metadata the model cannot misreport. Never trust self-report.
export let currentTurnModel = "", currentTurnModelSrc = "", currentTurnRequested = "";
export function setTurnModelInfo(model, source, requested) {
  currentTurnModel = model; currentTurnModelSrc = source; currentTurnRequested = requested;
}
export function friendlyModel(id) {
  if (!id) return "";
  for (var i = 0; i < models.length; i++) if (models[i].id === id) return models[i].short;
  return String(id).replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-/g, " ");
}
// Same model, ignoring a dated snapshot suffix — picking the alias
// "claude-opus-4-8" matches the API's resolved "claude-opus-4-8-20260115".
export function sameModel(a, b) {
  var norm = function (s) { return String(s || "").toLowerCase().replace(/-\d{8}$/, ""); };
  return norm(a) === norm(b);
}
export function addModelTag(bubble, id, requested, source) {
  if (!bubble || !id || bubble.querySelector(".model-tag")) return;
  var t = document.createElement("div");
  var mismatch = requested && !sameModel(id, requested);
  t.className = "model-tag" + (mismatch ? " warn" : "");
  if (mismatch) {
    t.textContent = "⚠︎ served by " + id + " — you selected " + requested;
    t.title = "The Anthropic API reports this turn was served by a different model than the one you picked.";
  } else {
    t.textContent = "✓ " + id + (source === "api" ? " · Anthropic API" : "");
    t.title = source === "api"
      ? "Exact model id read from the Anthropic API response for this message — serving-side metadata, not the model's self-report."
      : "Model the session was configured with (API confirmation pending).";
  }
  // Tooltips don't exist on touch — tap the tag to read the explanation.
  t.addEventListener("click", function () { toast(t.title, mismatch); });
  bubble.appendChild(t);
}
// Compact token count: 12345 → "12.3k", 2500000 → "2.5M".
export function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(n);
}
// A small, tappable "what this turn cost" badge: input/output tokens + $ estimate.
export function addCostBadge(bubble, ev) {
  if (!bubble || bubble.querySelector(".cost-tag")) return;
  var u = ev.usage;
  var hasCost = (typeof ev.costUsd === "number");
  if (!u && !hasCost) return; // nothing worth showing
  var inTok = u ? (u.input + u.cacheRead + u.cacheWrite) : 0;
  var outTok = u ? u.output : 0;
  var parts = [];
  if (u) parts.push("↑" + fmtTokens(inTok) + " ↓" + fmtTokens(outTok));
  if (hasCost) parts.push("$" + (ev.costUsd < 0.01 ? ev.costUsd.toFixed(4) : ev.costUsd.toFixed(3)));
  var t = document.createElement("div");
  t.className = "cost-tag";
  t.textContent = parts.join("  ·  ");
  var bits = [];
  if (u) bits.push(inTok.toLocaleString() + " input (incl. cache) + " + outTok.toLocaleString() + " output tokens");
  if (typeof ev.durationMs === "number") bits.push("took " + (Math.round(ev.durationMs / 100) / 10) + "s");
  if (hasCost) bits.push("est. $" + ev.costUsd.toFixed(4));
  t.title = "This turn: " + bits.join(" · ");
  t.addEventListener("click", function () { toast(t.title); });
  bubble.appendChild(t);
}
export function ensureAssistant() {
  if (cur) return cur;
  var bubble = addRow("assistant", true);
  var p = document.createElement("p"); bubble.appendChild(p);
  // ONE text node, held onto and appended to. See addText for why.
  var node = document.createTextNode(""); p.appendChild(node);
  var caret = document.createElement("span"); caret.className = "caret"; bubble.appendChild(caret);
  setCur({ bubble: bubble, p: p, node: node, caret: caret, text: "", think: null });
  return cur;
}
// Extended thinking (reasoning) streams before the answer. We show it in a
// collapsible block above the reply — expanded while it streams, tucked away the
// moment the real answer begins so the response stays front-and-centre.
export function ensureThinking() {
  var c = ensureAssistant();
  if (c.think) return c.think;
  var details = document.createElement("details");
  details.className = "thinking"; details.open = true;
  var summary = document.createElement("summary");
  summary.innerHTML = THINK_ICON + '<span class="tk-label">Thinking…</span>' + THINK_CARET;
  details.appendChild(summary);
  var body = document.createElement("div"); body.className = "tk-body"; details.appendChild(body);
  var bodyNode = document.createTextNode(""); body.appendChild(bodyNode);
  c.bubble.insertBefore(details, c.p);   // reasoning always sits above the answer
  c.think = { details: details, body: body, node: bodyNode, label: summary.querySelector(".tk-label"), text: "", settled: false };
  return c.think;
}
export function addThinking(t) {
  var tk = ensureThinking();
  tk.text += t;
  tk.node.appendData(t);          // same reason as addText below
  scrollDown(false);
}
// Collapse the reasoning block once (when the answer starts, or the turn ends).
export function settleThinking() {
  if (!cur || !cur.think || cur.think.settled) return;
  cur.think.settled = true;
  cur.think.details.open = false;
  cur.think.details.classList.add("done");
  cur.think.label.textContent = "Thoughts";
}
export function addText(t) {
  settleThinking();               // answer has begun — tuck the reasoning away
  var c = ensureAssistant();
  c.text += t;
  // appendData on the one text node, NOT `textContent = the whole string`. The old
  // form threw the node away and rebuilt it from the entire answer on every single
  // delta — O(n²) across a turn, which a phone feels as the reply visibly slowing
  // down the longer it gets. `c.text` is still accumulated because
  // finalizeAssistant re-renders it as markdown at the end.
  c.node.appendData(t);
  c.bubble.appendChild(c.caret);
  scrollDown(false);
}
export function finalizeAssistant() {
  if (!cur) return;
  if (cur.caret.parentNode) cur.caret.remove();
  settleThinking();
  var hasThinking = !!(cur.think && cur.think.text);
  if (cur.text && cur.text.trim()) {
    var parsed = extractDownloadFlags(cur.text);
    cur.p.replaceWith(mdNode(parsed.clean));   // swap streamed plain text for rendered markdown
    parsed.docs.forEach(function (d) { cur.bubble.appendChild(makeDownloadBox(d.format, d.name, parsed.clean)); });
    parsed.files.forEach(function (f) { cur.bubble.appendChild(makeFileBox(f)); registerDeliverable(f); });
    addSaveButton(cur.bubble, parsed.clean);
    if (currentTurnModel) addModelTag(cur.bubble, currentTurnModel, currentTurnRequested, currentTurnModelSrc);
    if (cur.result) addCostBadge(cur.bubble, cur.result);
  } else if (cur.bubble.parentNode && !cur.text && !hasThinking) {
    cur.bubble.parentNode.remove();      // truly empty bubble — drop it
  } else if (!cur.text && cur.p.parentNode) {
    cur.p.remove();                      // reasoning-only turn — no empty answer <p>
  }
  setCur(null);
}

/* ---------- Send ---------- */
// The composer button swaps between Send (idle) and Stop (turn in flight).
// Live working/done indicator in the status bar above the composer.
export let statusBar = document.getElementById("statusBar");
export let statusLabel = document.getElementById("statusLabel");
export let statusInd = statusBar ? statusBar.querySelector(".sb-ind") : null;
export let statusHideT = null;
export let STATUS_DOTS = "<span></span><span></span><span></span>";
export let STATUS_CHECK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
export function setStatus(state, label) {
  if (!statusBar) return;
  if (statusHideT) { clearTimeout(statusHideT); statusHideT = null; }
  if (state === "working") {
    statusBar.hidden = false;
    // Only rebuild the dots when leaving another state, so the bob animation
    // doesn't restart on every streamed token.
    if (statusBar.classList.contains("done") || statusBar.dataset.dots !== "1") {
      statusBar.classList.remove("done");
      if (statusInd) statusInd.innerHTML = STATUS_DOTS;
      statusBar.dataset.dots = "1";
    }
    if (label && statusLabel.textContent !== label) statusLabel.textContent = label;
  } else if (state === "done") {
    statusBar.hidden = false;
    statusBar.classList.add("done");
    statusBar.dataset.dots = "";
    if (statusInd) statusInd.innerHTML = STATUS_CHECK;
    statusLabel.textContent = "Done";
    statusHideT = setTimeout(function () {
      statusBar.hidden = true; statusBar.classList.remove("done");
    }, 1600);
  } else { // hide
    statusBar.hidden = true;
    statusBar.classList.remove("done");
    statusBar.dataset.dots = "";
  }
}

export function shortTarget(input) {
  if (input == null) return "";
  if (typeof input === "string") return input.slice(0, 80);
  if (input.file_path) return String(input.file_path).split("/").slice(-2).join("/");
  if (input.path) return String(input.path);
  if (input.notebook_path) return String(input.notebook_path).split("/").slice(-2).join("/");
  if (input.command) return String(input.command).slice(0, 60);
  if (input.pattern) return String(input.pattern).slice(0, 60);
  if (input.url) return String(input.url).slice(0, 60);
  if (input.query) return String(input.query).slice(0, 60);
  if (input.questions && input.questions[0]) return String(input.questions[0].question || input.questions[0].header || "question").slice(0, 80);
  if (input.description) return String(input.description).slice(0, 60);
  return ""; // unknown shape — show just the tool name, never raw JSON
}

// Upload one device-picked file/picture to the caller's scoped folder and
// resolve to an absolute server path, so it rides the SAME path-reference
// pipeline as the disk picker (Claude opens it with its Read tool). The body
// is the raw file (octet-stream), keeping it clear of the global JSON parser.
export function uploadOne(file) {
  return apiFetch("/api/upload?name=" + encodeURIComponent(file.name || "file"), {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file
  }).then(function (r) {
    return r.text().then(function (t) {
      var d = {}; try { d = JSON.parse(t); } catch (e) { /* non-JSON error body */ }
      if (!r.ok) throw new Error(d.error || (r.status === 413 ? "File is too large (max 30 MB)" : "Upload failed (" + r.status + ")"));
      return d.path;
    });
  });
}

// Start a new turn: echo the user's message, upload any device files, POST it.
// `onFail` (optional) runs when the turn never STARTED — an upload error, a 409
// ("a turn is already running for this conversation") or a 429 ("too many turns
// running"). submit() uses it to give the typed message back.
export function send(text, atts, onFail) {
  var project = projName();
  if (!project) { toast("No project selected", true); if (onFail) onFail(); return; }

  var echo = addUser(text, atts, true);
  scrollDown(true);   // your own message always pulls the view down with it
  // Disk-picked files already have a server path; phone/computer files carry a
  // File object that we upload first. Both arrive at /api/chat as paths.
  var readyPaths = [], toUpload = [];
  atts.forEach(function (a) {
    if (a.kind === "server" && a.path) readyPaths.push(a.path);
    else if (a.file) toUpload.push(a.file);
  });

  // Bind this turn to the conversation it belongs to, so its stream can never
  // bleed into another conversation you switch to while it runs.
  currentTurnModel = ""; currentTurnModelSrc = ""; // reset; set when the server reports back
  currentTurnRequested = models[curModel].id;      // what YOU picked — compared against the API echo
  var stream = { convKey: viewKey, token: viewToken, asks: [], requested: models[curModel].id };
  stream.abort = newAbort();   // so parkStreams can hang up when the page hides
  // The turn never started until the POST is accepted; onFail/echo let us undo
  // the optimistic echo and hand the message back.
  stream.onFail = onFail;
  stream.echo = echo;
  activeStreams[stream.convKey] = stream;
  delete endingsSeen[stream.convKey];   // a new turn — its ending hasn't been seen
  delete recentlyEnded[stream.convKey];
  clearTasks(stream.convKey);           // background agents belong to one turn
  var sessionForPost = activeSessionId; // null = brand-new chat (server assigns the id)

  updateSend();
  setStatus("working", toUpload.length ? "Uploading…" : "Thinking…");

  Promise.all(toUpload.map(uploadOne)).then(function (uploaded) {
    if (stream.token === viewToken) setStatus("working", "Thinking…");
    consumeStream(stream, project, apiFetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: stream.abort ? stream.abort.signal : undefined,
      body: JSON.stringify({
        project: project, prompt: text, sessionId: sessionForPost,
        model: models[curModel].id, effort: effectiveEffort(),
        fastMode: (fastOn && modelCapsFast()), context1m: !!models[curModel].ctx1m,
        permissionMode: (permAllowed ? permMode : "default"),
        attachments: readyPaths.concat(uploaded)
      })
    }));
  }).catch(function (err) {
    delete activeStreams[stream.convKey];
    undoEcho(stream);
    if (stream.token === viewToken) {
      setStatus("hide");
      toast((err && err.message) ? err.message : "Could not send your attachment", true);
    }
    if (onFail) onFail(err);
    updateSend();
  });
}

// Discard an interrupted partial answer (see markInterrupted) — the caller is
// about to paint the authoritative version.
export function dropInterrupted() {
  if (!cur || !cur.interrupted) return;
  var row = cur.bubble.parentNode;
  if (row && row.parentNode) row.parentNode.removeChild(row);
  setCur(null);
}

// Remove the optimistically-echoed user bubble. Only for a turn that never got
// off the ground — otherwise the message really is part of the conversation.
export function undoEcho(stream) {
  var row = stream.echo && stream.echo.parentNode;
  if (row && row.parentNode) row.parentNode.removeChild(row);
  stream.echo = null;
}

// Reattach to a turn on the server (after a refresh, an iOS suspend, or a turn
// started in another tab). No user message is echoed — this just resumes
// following an existing run.
//
// `quiet` is for a run we already KNOW has ended: we attach only to collect the
// ending (its stop reason, its ping, its drawer re-sort), so we set the stream's
// token to a dead value and let the replayed transcript render nowhere. Without
// that, replaying a finished turn on top of the transcript we just loaded from
// disk would paint the whole thing twice for a second.
export function attachRun(project, key, quiet) {
  if (activeStreams[key]) return;            // already following it
  if (recentlyEnded[key] && Date.now() - recentlyEnded[key] < REATTACH_COOLDOWN_MS) return;
  var onScreen = (key === viewKey);
  var stream = {
    convKey: key, token: (onScreen && !quiet) ? viewToken : -1,
    asks: [], attached: true, quiet: !!quiet
  };
  activeStreams[key] = stream;
  if (onScreen && !quiet) {
    // The re-attach replays the turn from the server's buffer, so the partial we
    // kept on screen after the drop would sit duplicated above it. Dropping it
    // here is the "let a successful reattach replace it" half of the H2 fix.
    dropInterrupted();
    setStatus("working", "Working…");
  }
  delete reattachTries[key];
  updateSend();
  stream.abort = newAbort();   // so parkStreams can hang up when the page hides
  consumeStream(stream, project, apiFetch("/api/chat/attach?key=" + encodeURIComponent(key),
    stream.abort ? { signal: stream.abort.signal } : undefined));
}

// Ask the server which turns it knows about and reattach to each.
//
// Two kinds now. RUNNING ones are what this always did — a turn survives a page
// refresh. ENDED ones are the iOS fix (audit H2): the server keeps a finished run
// for ten minutes with its end reason and final result buffered, so a phone that
// was asleep when the turn finished collects the ending instead of being left
// with a half-written answer forever. `endingsSeen` makes that exactly-once —
// otherwise every wake-up would re-deliver the same ending for ten minutes.
export function syncRuns() {
  return reqJSON("/api/runs").then(function (d) {
    var runs = (d && d.runs) || [];
    runs.forEach(function (run) {
      if (!run.sessionId) return;
      if (run.status === "running") {
        delete endingsSeen[run.sessionId];   // a live turn — a new ending is coming
        attachRun(run.project, run.sessionId);       // no-op if already attached
      } else if (!endingsSeen[run.sessionId]) {
        endingsSeen[run.sessionId] = true;   // claim it before the async attach
        attachRun(run.project, run.sessionId, true); // collect the ending quietly
      }
    });
    if (libraryVisible()) renderLibrary(drawerSearchInput.value);
  }).catch(function () { /* offline / signed out — apiFetch already handled 401 */ });
}

/* ---------- Sleep: hang up while the page is in the background ----------
   The server only pushes "your task is ready" to a locked phone when NOTHING is
   attached to the run — and a phone that locks does not close its socket. iOS
   freezes the page with the connection half-open, so the server went on counting
   us as watching and stayed silent, in exactly the case Web Push exists for.
   So we hang up ourselves, synchronously, inside the visibilitychange handler —
   the last code that reliably runs before the page is frozen. Aborting the fetch
   tears the socket down at the OS level even after JS has stopped, which is a
   liveness signal no heartbeat could match, and it needs no new server route.
   Nothing is lost: the run keeps going on the server, which buffers the whole
   transcript and holds an ended run for ten minutes, and wakeSync re-attaches (or
   quietly collects the ending) the instant we are looked at again — the same path
   a dropped Wi-Fi connection has always taken. */
export function newAbort() { try { return new AbortController(); } catch (e) { return null; } }
export function parkStreams() {
  var keys = Object.keys(activeStreams);
  for (var i = 0; i < keys.length; i++) {
    var s = activeStreams[keys[i]];
    // Only streams that are already READING. Aborting a POST still in flight
    // could cancel a turn before the server registered its run, and then there
    // would be nothing left to come back to.
    if (!s || s.parked || !s.pumping || !s.abort) continue;
    s.parked = true;
    try { s.abort.abort(); } catch (e) { /* already gone */ }
  }
}
/* ---------- Wake-up: re-attach when the phone comes back ----------
   iOS suspends a backgrounded web app and kills its fetch, so the SSE pipe dies
   while the run keeps going on the server. Nothing used to re-establish it: you
   came back to "Connection lost" over a half-written answer. Now every signal
   that we are being looked at again re-syncs (debounced, because iOS fires
   several of them at once on unlock). */
export let wakeT = null;
export function wakeSync() {
  if (wakeT) clearTimeout(wakeT);
  wakeT = setTimeout(function () {
    wakeT = null;
    if (document.hidden) return;
    // Coming back is a fresh chance: forget how many re-attach attempts a stream
    // burned while the device was asleep and offline.
    resetReattachTries();
    syncRuns();
  }, 400);
}
/* ---------- Re-attach after a dropped stream ----------
   A dropped SSE pipe does NOT mean the turn failed — the run is alive on the
   server. Retry a few times with backoff before admitting anything is wrong;
   a successful re-attach replaces the interrupted partial answer with the real
   transcript. */
// `reattachTries` is declared in state.js beside activeStreams (see the note
// there) — several modules read it, and one of them reads it during start-up.
export let REATTACH_MAX = 3;
export function reattachAfterDrop(project, key, err) {
  var n = (reattachTries[key] || 0) + 1;
  reattachTries[key] = n;
  if (n > REATTACH_MAX) {
    delete reattachTries[key];
    if (key === viewKey) {
      finalizeAssistant();              // now it really is all we're going to get
      setStatus("hide");
      addError("Connection lost", (err && err.message) ? err.message : "The stream dropped and could not be resumed.", true);
    } else {
      toast("A background turn disconnected: " + ((err && err.message) ? err.message : "error"), true);
    }
    updateSend();
    return;
  }
  setTimeout(function () {
    if (activeStreams[key]) { delete reattachTries[key]; return; }  // something beat us to it
    syncRuns().then(function () {
      if (activeStreams[key]) { delete reattachTries[key]; return; }
      reattachAfterDrop(project, key, err);
    });
  }, 600 * Math.pow(2, n - 1));   // 600ms, 1.2s, 2.4s
}

// Shared streaming engine for both a fresh POST and a reattach. `stream` holds
// the conversation identity; `responsePromise` resolves to the fetch Response.
export function consumeStream(stream, project, responsePromise) {
  // Is this stream's conversation the one currently on screen?
  function live() { return stream.token === viewToken; }

  // Render (or, after a round-trip, re-render) one buffered prompt card.
  function renderAsk(item) {
    if (item.answered) return;
    var onResolved = function () { item.answered = true; updatePaneState(); if (live()) setStatus("working", "Working…"); };
    if (item.ev.kind === "question") addQuestionCard(item.ev, onResolved);
    else addPermissionCard(item.ev, onResolved);
  }
  stream.renderAsk = renderAsk;

  responsePromise.then(function (res) {
    if (!res.ok) {
      // The turn was refused outright — 409 "a turn is already running for this
      // conversation", 429 "too many turns running", 400, 403… Flag it so onErr
      // knows the run does NOT exist server-side and must not be re-attached to.
      stream.startFailed = true;
      return res.json().catch(function () { return { error: res.statusText }; })
        .then(function (d) { var e = new Error(d.error || "Request failed"); e.status = res.status; throw e; });
    }
    var reader = res.body.getReader();
    // From here on the run exists server-side and we are reading it, so hanging
    // up costs nothing — parkStreams only ever touches a stream that got this far.
    stream.pumping = true;
    var decoder = new TextDecoder();
    var buf = "";
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        buf += decoder.decode(r.value, { stream: true });
        var frames = buf.split("\n\n");
        buf = frames.pop();
        frames.forEach(function (frame) {
          var line = frame.replace(/^data: /, "").trim();
          if (!line) return;
          var ev; try { ev = JSON.parse(line); } catch (e) { return; }
          handleEvent(ev);
        });
        return pump();
      });
    }
    return pump();
  }).then(onDone).catch(onErr);

  function onDone() {
    var key = stream.convKey;
    delete activeStreams[key];
    delete reattachTries[key];
    recentlyEnded[key] = Date.now();
    var ended = stream.ended;
    var onView = (key === viewKey);
    // Stopped/errored has to be decided FIRST. The old code checked "was this
    // stream attached?" first and took the reload-from-disk branch for every
    // reattached stream — and since the stop reason and the Continue button are
    // not in the session log, tapping Stop after switching conversations showed
    // nothing at all.
    var halted = !!(ended && (ended.status === "stopped" || ended.status === "error"));
    // System ping if the app is backgrounded — or, on a quiet reattach, the offer
    // to enable pings, since a quiet reattach IS a turn that ended while away.
    notifyTurnDone(project, key, ended, stream.quiet);
    if (onView && (stream.attached || !live())) {
      // Reattached mid-turn (refresh / another device / a run that ended while
      // the phone slept): our live render began partway through the message, so
      // reload the canonical, complete transcript from disk…
      var loaded = openSession(project, key);
      // …then settle the status and re-add the stop notice, which the session log
      // cannot carry. Both have to happen AFTER the reload: openSession clears the
      // view and reflectStream resets the status bar when it finds no live stream.
      if (loaded) {
        loaded.then(function () {
          if (viewKey !== key) return;
          if (halted) { setStatus("hide"); addStopNotice(project, key, ended); }
          else { setStatus("done"); flushQueued(key); }
        });
      }
    } else if (live()) {
      finalizeAssistant();
      if (halted) {
        setStatus("hide");
        addStopNotice(project, key, ended);
      } else {
        setStatus("done");
        // Anything typed while this turn was running goes out now. A STOPPED or
        // errored turn deliberately does not flush: you stopped it for a reason,
        // and the queued message is still one tap away in the composer.
        flushQueued(key);
      }
    }
    renderTaskTray();
    updateSend();
    // Refresh history so this conversation appears / re-sorts in the drawer.
    fetchSessions(project).then(function () {
      // The turn is persisted now; the real session row replaces the draft.
      delete drafts[key];
      updateTopbarTitle();
      if (libraryVisible()) renderLibrary(drawerSearchInput.value);
    });
  }

  function onErr(err) {
    var key = stream.convKey;
    delete activeStreams[key];

    // (a) The turn never started: the server refused the POST. There is no run to
    // re-attach to — undo the optimistic echo, surface the server's own words
    // (a 409/429 must not read as a generic failure) and hand the message back.
    if (stream.startFailed) {
      undoEcho(stream);
      clearTasks(key);
      if (live()) setStatus("hide");
      toast((err && err.message) ? err.message : "Could not send", true);
      if (stream.onFail) stream.onFail(err);
      updateSend();
      return;
    }

    // (b) We already had the ending in hand when the pipe died (it dropped between
    // 'ended' and 'done'). The turn is over — finish it normally instead of
    // hunting for a run that is no longer running.
    if (stream.ended) { onDone(); return; }

    // (b2) WE hung up, on purpose, because the page went into the background
    // (see parkStreams). Nothing is wrong: the run continues on the server and
    // wakeSync re-attaches the moment the screen comes back. Treating this as a
    // dropped pipe would burn the re-attach budget against a frozen page and end
    // in a "Connection lost" the user never had.
    if (stream.parked) {
      // The turn IS still running, so the composer must keep saying so — that is
      // what reattachTries means everywhere else ("running, just not
      // attached right now"). wakeSync clears it wholesale on the way back in.
      reattachTries[key] = 1;
      markInterrupted();
      updateSend();
      return;
    }

    // (c) The pipe dropped but the RUN IS STILL GOING server-side — an iOS
    // suspend, a Wi-Fi blip, a locked phone. Do NOT finalize the partial answer:
    // dressing it with Copy/Save/Download as if it were the finished reply is
    // exactly the lie that made the app feel broken. Mark it interrupted, keep
    // the text, and let a successful re-attach replace it from disk.
    markInterrupted();
    if (live()) setStatus("working", "Reconnecting…");
    reattachAfterDrop(project, key, err);
    updateSend();
  }

  // Subdued "this answer is mid-flight, we lost the pipe" state. The caret keeps
  // blinking on purpose: the turn genuinely has not stopped.
  function markInterrupted() {
    if (!live() || !cur) return;
    cur.bubble.classList.add("interrupted");
    cur.interrupted = true;
  }

  function handleEvent(ev) {
    // The server may assign the real session id mid-stream (new chats). Re-key
    // the stream so it's tracked under its real conversation identity.
    if (ev.type === "session") {
      if (stream.convKey !== ev.sessionId) {
        var oldKey = stream.convKey;
        var wasLive = live();
        delete activeStreams[oldKey];
        stream.convKey = ev.sessionId;
        activeStreams[ev.sessionId] = stream;
        rekeyTaskState(oldKey, ev.sessionId);   // the agents tray follows the conversation
        if (wasLive) { setActiveSessionId(ev.sessionId); setViewKey(ev.sessionId); }
        // Re-key the drawer's draft row onto the real session id so it stops
        // being a placeholder and tracks the now-persisted conversation.
        if (drafts[oldKey]) {
          drafts[ev.sessionId] = drafts[oldKey];
          drafts[ev.sessionId].key = ev.sessionId;
          delete drafts[oldKey];
          if (libraryVisible()) renderLibrary(drawerSearchInput.value);
        }
      }
      return;
    }
    // AI-generated drawer title arrived (new conversations). Update the draft,
    // the cached session row, the topbar, and the drawer — all without a refresh.
    if (ev.type === "title") {
      var td = draftFor(ev.sessionId);
      if (td) td.title = ev.title;
      var arr = sessionsCache[project] || [];
      for (var ti = 0; ti < arr.length; ti++) {
        if (arr[ti].id === ev.sessionId) { arr[ti].title = ev.title; break; }
      }
      if (activeSessionId === ev.sessionId || viewKey === ev.sessionId) updateTopbarTitle();
      if (libraryVisible()) renderLibrary(drawerSearchInput.value);
      return;
    }
    // The turn finished — remember why so onDone can show the right thing.
    if (ev.type === "ended") {
      // `stalled` — the server's background-wait valve ended it, not a human.
      // Same 'stopped' status (Continue still applies), different wording.
      stream.ended = { status: ev.status, reason: ev.reason, stalled: !!ev.stalled };
      // We have this run's ending in hand: syncRuns must not re-deliver it from
      // the server's ten-minute ended-run window on every wake-up.
      endingsSeen[stream.convKey] = true;
      delete waitingState[stream.convKey];
      emitTasksChanged(stream.convKey);
      return;
    }

    /* ---- Background agents, limits, thinking: additive, and the reason a turn
       no longer dies at the first result. The engine keeps the CLI iterating
       while background work is pending and resumes by itself, exactly as the
       terminal does — so the client must not treat a 'result' as the end either
       (it never did: only the stream CLOSING ends a turn here). We keep the state;
       the agents tray and turn controls that render it read window.PLUMI_TASKS. */
    if (ev.type === "waiting") {
      waitingState[stream.convKey] = { tasks: ev.tasks || 0, text: ev.text || "" };
      emitTasksChanged(stream.convKey);
      if (live()) {
        // Close off the answer that just landed so the resumed one starts its own
        // bubble (and takes its own cost badge), then say what we're waiting for.
        finalizeAssistant();
        setStatus("working", ev.text || "Waiting on background agents…");
      }
      return;
    }
    if (ev.type === "task") { noteTask(stream.convKey, ev); return; }
    if (ev.type === "limits") {
      setLimits({ status: ev.status || "", resetsAt: ev.resetsAt || null,
                  kind: ev.kind || "", overage: ev.overage || "", at: Date.now() });
      emitTasksChanged(stream.convKey);
      return;
    }
    // The window is spent and the reset time is known: offer to carry the work on
    // by itself. Rendered where the turn stopped, so it reads as part of the
    // conversation rather than a system banner somewhere else.
    if (ev.type === "limitPause") {
      addResumeOffer(stream.convKey, ev);
      return;
    }
    if (ev.type === "thinkingTokens") {
      thinkingState[stream.convKey] = ev.estimated || 0;
      emitTasksChanged(stream.convKey);
      return;
    }
    // Terminal usage/cost from the SDK. Stash it on the live assistant bubble so
    // finalizeAssistant can badge the response with tokens + estimated cost.
    // Count every finished turn toward the window total, whether or not this
    // conversation is the one on screen — consumption is account-wide.
    if (ev.type === "result") { addTurnUsage(ev); if (live() && cur) cur.result = ev; return; }
    // The context ring, derived server-side from the turn's own token usage — no
    // extra call was made for it, so it costs the turn nothing.
    if (ev.type === "context") { noteContext(ev.sessionId, ev.context); return; }
    // The real model serving this turn (ground truth; 'api' = confirmed by the
    // Anthropic API response itself). Flag loudly if it isn't what was picked.
    if (ev.type === "model") {
      stream.model = ev.model;
      stream.modelSource = ev.source || "api";
      if (!stream.requested && ev.requested) stream.requested = ev.requested; // reattach path
      if (stream.modelSource === "api" && stream.requested &&
          !sameModel(ev.model, stream.requested) && !stream.mismatchTold) {
        stream.mismatchTold = true;
        toast("Model mismatch — the API served " + ev.model + ", you selected " + stream.requested, true);
      }
      if (live()) {
        currentTurnModel = ev.model;
        currentTurnModelSrc = stream.modelSource;
        currentTurnRequested = stream.requested || "";
        setStatus("working", friendlyModel(ev.model) + " · working…");
      }
      return;
    }
    // Buffer prompts so they survive switching away and reappear on return.
    if (ev.type === "ask") {
      var item = { ev: ev, answered: false };
      stream.asks.push(item);
      updatePaneState();
      notifyAttention(project, stream.convKey, ev);   // ping if the app is backgrounded
      if (live()) renderAsk(item);
      else {
        var label = convTitle(project, stream.convKey);
        toast((label ? "“" + label + "” needs your input" : "Another conversation needs your input") + " — tap to open",
          false, function () { goToConversation(project, stream.convKey); });
      }
      return;
    }
    if (!live()) return; // backgrounded conversation — never render into the current view
    if (ev.type === "thinking") {
      addThinking(ev.text);
      setStatus("working", (currentTurnModel ? friendlyModel(currentTurnModel) + " · " : "") + "thinking…");
    } else if (ev.type === "text") {
      addText(ev.text);
      setStatus("working", (currentTurnModel ? friendlyModel(currentTurnModel) + " · " : "") + "responding…");
    } else if (ev.type === "tool") {
      finalizeAssistant();
      addTool(ev.name, ev.input ? shortTarget(ev.input) : "", true);
      setStatus("working", "Running " + ev.name + "…");
    } else if (ev.type === "notice") {
      finalizeAssistant();
      addNotice(ev.text, ev.phase);
      setStatus("working", ev.phase === "start" ? ev.text : "Working…");
    } else if (ev.type === "error") {
      finalizeAssistant();
      addError("Error", ev.message, true);
    }
    // 'result' carries no text — assistant text already streamed live via deltas.
  }
}

// Stop the on-screen turn. The server aborts it and reports the reason, which
// surfaces as a stop notice (with a Continue button) via the stream's ended.
export function stopCurrent() {
  var key = viewKey;
  if (!activeStreams[key] && !reattachTries[key]) return;
  if (/^new:/.test(String(key))) { toast("Starting up — try again in a moment."); return; }
  setStatus("working", "Stopping…");
  apiFetch("/api/chat/stop", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: key, reason: "Stopped by you" })
  }).then(function (r) {
    if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || "Stop failed"); });
  }).catch(function (e) { toast(e.message || "Stop failed", true); });
}

// Centered notice shown when a turn stops/errors, with a one-click Continue.
/* The offer to carry on when the usage window reopens.

   The whole point is that the person is about to stop watching, so the card
   states the actual clock time it will resume, not "in 2 hours" — a relative
   figure is unreadable once you have walked away from it. Arming is server-side
   (POST /api/resume/arm); nothing here needs to stay open, which is exactly why
   a browser timer would have been the wrong shape for this. */
export function addResumeOffer(key, ev) {
  var resetMs = limitResetMs({ resetsAt: ev.resetsAt });
  if (!resetMs || resetMs <= Date.now()) return;   // nothing sensible to offer

  var when = new Date(resetMs);
  var clock = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  var sameDay = when.toDateString() === new Date().toDateString();
  var whenText = clock + (sameDay ? "" : " on " + when.toLocaleDateString([], { weekday: "long" }));

  var n = document.createElement("div");
  n.className = "notice stop resume-offer";
  n.innerHTML = '<span class="nico">' + STOP_NOTICE_ICON + "</span>";
  var s = document.createElement("span");
  s.className = "ntext";
  s.textContent = (ev.kind === "seven_day" ? "Weekly" : "Usage") +
    " limit reached — the next window opens at " + whenText + ".";
  n.appendChild(s);

  var no = document.createElement("button");
  no.type = "button"; no.className = "notice-dismiss"; no.textContent = "Not now";
  no.addEventListener("click", function () { n.remove(); });

  var yes = document.createElement("button");
  yes.type = "button"; yes.className = "notice-continue"; yes.textContent = "Continue at " + clock;
  yes.addEventListener("click", function () {
    yes.disabled = true; yes.textContent = "Arming…";
    apiFetch("/api/resume/arm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key, resetsAt: ev.resetsAt, kind: ev.kind || "" })
    }).then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || "could not arm"); }); })
      .then(function () {
        n.classList.add("armed");
        s.textContent = "Picking this back up at " + whenText + ". You can close the app.";
        yes.remove();
        no.textContent = "Cancel";
        no.onclick = null;
        no.addEventListener("click", function () {
          apiFetch("/api/resume/cancel", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: key })
          }).catch(function () {}).then(function () { n.remove(); });
        });
      })
      .catch(function (err) {
        yes.disabled = false; yes.textContent = "Continue at " + clock;
        toast((err && err.message) || "Could not schedule that", true);
      });
  });

  n.appendChild(no); n.appendChild(yes);
  messages.appendChild(n);
  scrollDown(false);
}

export function addStopNotice(project, key, ended) {
  var n = document.createElement("div");
  n.className = "notice stop";
  n.innerHTML = '<span class="nico">' + STOP_NOTICE_ICON + "</span>";
  // Three endings, three different sentences. A turn the server ended because a
  // background agent went silent is NOT "you stopped it" — saying so sends people
  // hunting for a Stop they never pressed. Continue is offered in every case.
  var label;
  if (ended && ended.stalled) label = "Ended: " + (ended.reason || "background work stopped responding") + ".";
  else if (ended && ended.status === "stopped") label = ended.reason ? ("Stopped — " + ended.reason) : "You stopped the agent.";
  else label = "The agent stopped before finishing" + (ended && ended.reason ? (": " + ended.reason) : ".");
  var s = document.createElement("span"); s.className = "ntext"; s.textContent = label;
  n.appendChild(s);
  var cont = document.createElement("button");
  cont.type = "button"; cont.className = "notice-continue"; cont.textContent = "Continue";
  cont.addEventListener("click", function () {
    if (activeStreams[viewKey]) return; // a turn is already running
    n.remove();
    send("continue", []);
  });
  n.appendChild(cont);
  messages.appendChild(n);
  scrollDown(false);
}

export function initStream() {
  window.addEventListener("pagehide", function () { parkStreams(); });

  // One handler for both halves of the same transition: hang up on the way out,
  // re-attach on the way back in.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) parkStreams(); else wakeSync();
  });
  window.addEventListener("online", wakeSync);
  window.addEventListener("focus", wakeSync);
  window.addEventListener("pageshow", function (e) { if (e.persisted) wakeSync(); });
}

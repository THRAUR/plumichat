/* PlumiChat — turning messages into DOM.

   Message rows, markdown rendering and sanitising, the day separators and time /
   thinking / cost tags, and the scroll behaviour (including the Live toggle that
   stops the reader being yanked to the bottom mid-read). */

import { addSaveButton, copyText, enhanceCodeBlocks } from './cards.js';
import { clearConvFiles, registerDeliverable } from './panels/deliverables.js';
import { $, messages, toast } from './dom.js';
import { extractDownloadFlags, makeDownloadBox } from './exports.js';
import { fpDownload } from './files.js';
import { DL_ICON, THINK_CARET, THINK_ICON } from './icons.js';
import { splitQuote } from './quote.js';
import { bumpViewToken, setCur } from './state.js';
import { addCostBadge, addModelTag } from './stream.js';

/* ---------- Message rendering ---------- */
export let jumpBottom = $("jumpBottom");
export let stayLiveBtn = $("stayLiveBtn");
// Following the newest output has two layers: "stay live" is a sticky preference
// the user sets with the toggle, and "detached" is the temporary pause that starts
// the moment they scroll up to read something older. Only scrollDown(true) — their
// own send, opening a conversation, the jump button — overrides both.
export let stayLive = true;
export let detached = false;
export function nearBottom() { return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120; }
export function scrollDown(force) {
  if (force) detached = false;
  if (force || (stayLive && !detached)) {
    messages.scrollTop = messages.scrollHeight;
    if (jumpBottom) jumpBottom.hidden = true;
  } else if (jumpBottom) {
    // New content arrived while the view is parked — offer a way back down.
    jumpBottom.hidden = false;
  }
}
export function paintStayLive() {
  if (!stayLiveBtn) return;
  stayLiveBtn.classList.toggle("off", !stayLive);
  stayLiveBtn.setAttribute("aria-pressed", stayLive ? "true" : "false");
  stayLiveBtn.title = stayLive
    ? "Following new output — tap to stay where you are"
    : "Staying put — tap to follow new output";
  var t = stayLiveBtn.querySelector(".sl-text");
  if (t) t.textContent = stayLive ? "Live" : "Paused";
}
export function clearMessages() {
  messages.innerHTML = '<div class="day-sep">Today</div>';
  detached = false;
  if (jumpBottom) jumpBottom.hidden = true;
  compactNoticeEl = null;
  setCur(null);        // drop any half-built streaming bubble from the previous view
  bumpViewToken();     // invalidate background streams' live-rendering into this view
  clearConvFiles();    // reset the deliverables tray for the conversation we're opening
}

export function addRow(kind, animate) {
  var row = document.createElement("div");
  row.className = "row " + kind + (animate ? " enter" : "");
  if (animate) setTimeout(function () { row.classList.remove("enter"); }, 400);
  var bubble = document.createElement("div");
  bubble.className = "bubble";
  row.appendChild(bubble);
  messages.appendChild(row);
  scrollDown(false);
  return bubble;
}

export function addUser(text, atts, animate) {
  var b = addRow("user", animate);
  if (atts && atts.length) {
    var wrap = document.createElement("div");
    wrap.className = "msg-atts";
    atts.forEach(function (a) {
      var chip = document.createElement("div");
      chip.className = "chip" + (a.kind === "img" ? " img" : "");
      var ico;
      if (a.kind === "img" && a.url) ico = '<img class="thumb" src="' + a.url + '" alt="" />';
      else if (a.kind === "voice") ico = '<svg class="cico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10a7 7 0 0 0 14 0"></path></svg>';
      else if (a.kind === "server" && a.dir) ico = '<svg class="cico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>';
      else if (a.kind === "server") ico = '<svg class="cico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="14" width="20" height="8" rx="2"></rect><rect x="2" y="2" width="20" height="8" rx="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>';
      else ico = '<svg class="cico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
      chip.innerHTML = ico;
      var nm = document.createElement("span"); nm.className = "cname"; nm.textContent = a.name;
      chip.appendChild(nm);
      // Same stored-XSS sink as renderAttachments: build the node, don't parse it.
      if (a.meta) { var cm = document.createElement("span"); cm.className = "cmeta"; cm.textContent = a.meta; chip.appendChild(cm); }
      wrap.appendChild(chip);
    });
    b.appendChild(wrap);
  }
  // A leading reply-blockquote (our quote-a-passage wire format) renders as a
  // styled quote above the message — both on live echo and on history replay,
  // since both paths feed the same raw text through here.
  var parts = splitQuote(text);
  if (parts.quote) {
    var q = document.createElement("div"); q.className = "msg-quote"; q.textContent = parts.quote;
    b.appendChild(q);
  }
  if (parts.body) { var t = document.createElement("div"); t.textContent = parts.body; b.appendChild(t); }
  return b;   // so send() can un-echo the message if the turn never starts
}

export function addTool(name, target, animate) {
  var b = addRow("tool", animate);
  var g = document.createElement("span"); g.className = "gear"; g.textContent = "⚙";
  // Named so the stylesheet can pin it as a fixed Silkscreen tag: without a
  // class it was plain inline text and "Bash" wrapped to "Ba / sh" whenever the
  // command beside it was long.
  var n = document.createElement("span"); n.className = "tname"; n.textContent = name;
  b.appendChild(g); b.appendChild(n);
  if (target) { var t = document.createElement("span"); t.className = "tgt"; t.textContent = target; b.appendChild(t); }
  scrollDown(false);
}

export function addError(title, detail, animate) {
  var b = addRow("error", animate);
  var et = document.createElement("div"); et.className = "etitle"; et.textContent = "⚠ " + title;
  b.appendChild(et);
  if (detail) { var d = document.createElement("div"); d.textContent = detail; b.appendChild(d); }
  scrollDown(false);
}

// Small centered system line (e.g. compaction) — never a chat bubble.
export let compactNoticeEl = null;
export function noticeIcon(done) {
  return done
    ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'
    : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';
}
export function fillNotice(el, text, done) {
  el.innerHTML = '<span class="nico">' + noticeIcon(done) + "</span>";
  var s = document.createElement("span"); s.className = "ntext"; s.textContent = text;
  el.appendChild(s);
  el.classList.toggle("pending", !done);
}
export function addNotice(text, phase) {
  // "done" updates the in-place "compacting…" line rather than stacking a new one.
  if (phase === "done" && compactNoticeEl) {
    fillNotice(compactNoticeEl, text, true);
    compactNoticeEl = null; scrollDown(false); return;
  }
  var n = document.createElement("div");
  n.className = "notice";
  fillNotice(n, text, phase !== "start");
  messages.appendChild(n);
  if (phase === "start") compactNoticeEl = n;
  scrollDown(false);
}

// A download box for a REAL on-disk file the AI generated with the document
// Skills (a python-pptx / pptxgenjs deck, an openpyxl workbook, a reportlab PDF,
// …). Unlike makeDownloadBox (which converts the answer's markdown on demand),
// this streams the actual saved file via /api/download — the server re-checks the
// path is inside the user's own area before sending a byte.
// The one basename helper (the file picker's fpBase was the same thing, minus
// Windows separators). "/" answers "/" so a root path still has a label.
export function basenameOf(p) {
  var s = String(p || "").replace(/[\/\\]+$/, "");
  if (!s) return String(p || "") ? "/" : "";
  var m = s.match(/[^\/\\]+$/);
  return m ? m[0] : s;
}
export function makeFileBox(file) {
  var fname = (file.name && file.name.trim()) ? file.name.trim() : basenameOf(file.path);
  var ext = (basenameOf(file.path).match(/\.([a-z0-9]+)$/i) || [])[1];
  var box = document.createElement("div"); box.className = "dl-box";
  var head = document.createElement("div"); head.className = "dl-box-head";
  var icon = document.createElement("span"); icon.className = "dl-box-icon"; icon.innerHTML = DL_ICON;
  var info = document.createElement("div"); info.className = "dl-box-info";
  var ttl = document.createElement("div"); ttl.className = "dl-box-title"; ttl.textContent = fname;
  var sub = document.createElement("div"); sub.className = "dl-box-sub";
  sub.textContent = ext ? (ext.toUpperCase() + " · ready to download") : "Ready to download";
  info.appendChild(ttl); info.appendChild(sub);
  head.appendChild(icon); head.appendChild(info);
  var actions = document.createElement("div"); actions.className = "dl-box-actions";
  var b = document.createElement("button"); b.type = "button"; b.className = "dl-box-fmt primary";
  b.textContent = "Download";
  b.addEventListener("click", function () { fpDownload(file.path); });
  actions.appendChild(b);
  box.appendChild(head); box.appendChild(actions);
  return box;
}

// Render markdown (tables, code, lists) safely; null if libs unavailable.
export function renderMarkdown(text) {
  try {
    if (window.marked) {
      var html = window.marked.parse(text, { breaks: true, gfm: true });
      return window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
    }
  } catch (e) {}
  return null;
}
// Stamp every link in a rendered answer. Done in a DOM pass AFTER sanitising on
// purpose: renderMarkdown calls DOMPurify.sanitize(html) with no config, and the
// default ALLOWED_ATTR does NOT include `target` — a target="_blank" written by
// marked is silently dropped, so a link emitted "correctly" still navigated the
// standalone web app away from itself. Setting it on real nodes we just built
// can't be stripped, and it lets us mark same-document anchors as in-app.
export function markLinks(root) {
  var links = root.querySelectorAll("a[href]");
  for (var i = 0; i < links.length; i++) {
    var a = links[i], href = a.getAttribute("href") || "";
    a.classList.add("md-link");
    if (href.charAt(0) === "#") { a.classList.add("md-inline"); continue; }
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
}
export function mdNode(text) {
  var html = renderMarkdown(text);
  var md = document.createElement("div"); md.className = "md";
  if (html != null) { md.innerHTML = html; enhanceCodeBlocks(md); markLinks(md); }
  else { md.style.whiteSpace = "pre-wrap"; md.textContent = text; }
  return md;
}

/* ---------- History metadata (timestamps, thinking, cost) ----------
   /api/session returns `at` on every line, `usage`/`costUsd` on the first block
   of an assistant turn, and a 'thinking' role for extended-thinking blocks. All
   three used to vanish the moment you reloaded: a conversation replayed from
   disk looked cheaper, faster and less considered than it actually was. */
export function sameDayAs(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
export function dayLabel(ts) {
  var d = new Date(ts), now = new Date();
  if (sameDayAs(d, now)) return "Today";
  if (sameDayAs(d, new Date(now.getTime() - 86400000))) return "Yesterday";
  var opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  try { return d.toLocaleDateString(undefined, opts); } catch (e) { return d.toDateString(); }
}
export function clockTime(ts) {
  try { return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }
  catch (e) { return ""; }
}
export function addDaySep(text) {
  var d = document.createElement("div"); d.className = "day-sep"; d.textContent = text;
  messages.appendChild(d);
}
// Hang the log's own timestamp off a bubble. Returns the bubble so callers can
// chain it onto addUser's return value.
export function addTimeTag(bubble, at) {
  if (!bubble || !at) return bubble;
  var t = document.createElement("span"); t.className = "msg-time";
  t.textContent = clockTime(at);
  try { t.title = new Date(at).toLocaleString(); } catch (e) {}
  bubble.appendChild(t);
  return bubble;
}
// A replayed extended-thinking block: the same collapsible shape the live stream
// builds, but on its own row — on replay there is no in-flight answer bubble to
// tuck it into, and the thinking may well have produced no text at all.
export function addThinkingFinal(text, at) {
  var b = addRow("thinking", false);
  var details = document.createElement("details");
  details.className = "thinking done";
  var summary = document.createElement("summary");
  summary.innerHTML = THINK_ICON + '<span class="tk-label">Thoughts</span>' + THINK_CARET;
  details.appendChild(summary);
  var body = document.createElement("div"); body.className = "tk-body"; body.textContent = text;
  details.appendChild(body);
  b.appendChild(details);
  addTimeTag(b, at);
}

export function addAssistantFinal(text, model, meta) {
  var b = addRow("assistant", false);
  var parsed = extractDownloadFlags(text);
  b.appendChild(mdNode(parsed.clean));
  parsed.docs.forEach(function (d) { b.appendChild(makeDownloadBox(d.format, d.name, parsed.clean)); });
  parsed.files.forEach(function (f) { b.appendChild(makeFileBox(f)); registerDeliverable(f); });
  if (parsed.clean && parsed.clean.trim()) addSaveButton(b, parsed.clean);
  // History replay: the model id stored on this message's SDK log line — the
  // same API-echoed value shown live, so provenance survives reloads/devices.
  if (model) addModelTag(b, model, "", "api");
  // …and the tokens/cost the log recorded, through the SAME badge the live turn
  // uses (history.js deliberately returns `usage` in the live event's shape).
  if (meta && (meta.usage || typeof meta.costUsd === "number")) addCostBadge(b, meta);
  if (meta) addTimeTag(b, meta.at);
}

export function renderMessages(list) {
  clearMessages();
  // clearMessages() seeds a static "Today", which is only right for a fresh chat.
  // A replay with real timestamps emits its own separators — starting it with an
  // unconditional "Today" above a message from March would be a lie.
  var dated = list.some(function (m) { return !!m.at; });
  if (dated) messages.innerHTML = "";
  var lastDay = "";
  list.forEach(function (m) {
    if (m.at) {
      var lbl = dayLabel(m.at);
      if (lbl !== lastDay) { lastDay = lbl; addDaySep(lbl); }
    }
    // Unknown roles are skipped on purpose: /api/session gained 'thinking' (and
    // per-message at/usage/costUsd) and will gain more — a replay must never
    // break on a shape it doesn't render yet. ('error' was handled here once but
    // the history layer has never emitted it — that branch was dead.)
    if (m.role === "user") addTimeTag(addUser(m.text, null, false), m.at);
    else if (m.role === "tool") addTool(m.name, m.target, false);
    else if (m.role === "notice") addNotice(m.text);
    else if (m.role === "thinking") addThinkingFinal(m.text, m.at);
    else if (m.role === "assistant") addAssistantFinal(m.text, m.model, m);
  });
  scrollDown(true);
}

export function initRender() {
  try { stayLive = localStorage.getItem("plumi.stayLive") !== "0"; } catch (e) {}
  messages.addEventListener("scroll", function () {
    var nb = nearBottom();
    detached = !nb;
    if (jumpBottom) jumpBottom.hidden = nb;
  }, { passive: true });
  if (jumpBottom) {
    jumpBottom.addEventListener("click", function () { scrollDown(true); });
  }
  if (stayLiveBtn) {
    stayLiveBtn.addEventListener("click", function () {
      stayLive = !stayLive;
      try { localStorage.setItem("plumi.stayLive", stayLive ? "1" : "0"); } catch (e) {}
      paintStayLive();
      if (stayLive) scrollDown(true);
    });
    paintStayLive();
  }
  /* ---------- Links inside answers ----------
     The main client is an iPhone home-screen web app: no address bar, no back
     button. A link that navigates IN PLACE strands the reader somewhere they can
     only escape by force-quitting PlumiChat. One delegated handler on #messages (so
     it survives every re-render and every replayed transcript): our own pages stay
     in-app, everything external is handed to a new context, and anything the OS
     owns (mailto:, tel:) is left completely alone. */
  messages.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a.md-link") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#") return;   // same-document anchor
    var url; try { url = new URL(href, location.href); } catch (err) { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;  // let the OS have it
    e.preventDefault();
    if (url.origin === location.origin) { location.href = url.href; return; }
    // A standalone web app can refuse window.open outright. Park the address behind
    // a tappable toast rather than swallowing the tap, which is the very failure
    // mode this handler exists to end.
    var w = null;
    try { w = window.open(url.href, "_blank", "noopener"); } catch (err2) {}
    if (!w) toast("Couldn't open that link — tap to copy it", false, function () { copyText(url.href); });
  });
}

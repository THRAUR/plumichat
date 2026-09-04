/* PlumiChat — the two interactive cards a turn can put in the transcript: a permission
   request parked on canUseTool, and a question the agent asked. Plus the copy and
   save-to-file buttons every answer gets. */

import { apiFetch, reqJSON } from './api.js';
import { messages, toast } from './dom.js';
import { makeDownloadMenu } from './exports.js';
import { COPIED_ICON, COPY_ICON, QUESTION_ICON, SHIELD_ICON } from './icons.js';
import { scrollDown } from './render.js';
import { promptSheet } from './sheet.js';
import { projName } from './state.js';
import { shortTarget } from './stream.js';

/* ---------- Interactive cards: permission + Claude's questions ---------- */
// POST the user's decision back to the parked canUseTool call on the server.
// Rejects with the server's own message so the card can say what really happened:
// a 404 means the prompt expired (the turn moved on without you) and a 403 means
// it isn't your conversation — painting "Allowed" over either was a lie.
export function respond(id, response) {
  return reqJSON("/api/respond", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: id, response: response })
  });
}
// Shared outcome painter for both ask cards: optimistic label, corrected on the
// server's answer.
export function paintAskResult(el, okText, okCls, promise) {
  el.className = "ask-result " + okCls;
  el.textContent = "Sending…";
  promise.then(function () {
    el.className = "ask-result " + okCls;
    el.textContent = okText;
  }, function (err) {
    el.className = "ask-result denied";
    el.textContent = (err && err.status === 404)
      ? "Too late — this request expired."
      : ("Not sent — " + ((err && err.message) ? err.message : "the server refused it."));
  });
}

export function askHead(iconHtml, titleText) {
  var head = document.createElement("div"); head.className = "ask-head";
  var ic = document.createElement("span"); ic.className = "ask-ico"; ic.innerHTML = iconHtml;
  var t = document.createElement("span"); t.className = "ask-title"; t.textContent = titleText;
  head.appendChild(ic); head.appendChild(t);
  return head;
}

// A permission request: Claude wants to run a non-safe tool (Write/Edit/Bash…).
export function addPermissionCard(ev, onResolved) {
  var card = document.createElement("div");
  card.className = "ask-card perm enter";
  setTimeout(function () { card.classList.remove("enter"); }, 400);
  card.appendChild(askHead(SHIELD_ICON, "Permission required"));

  var body = document.createElement("div"); body.className = "ask-body";
  var tool = document.createElement("span"); tool.className = "ask-tool"; tool.textContent = ev.tool;
  body.appendChild(tool);
  var tgt = ev.input ? shortTarget(ev.input) : "";
  if (tgt && !(ev.input && ev.input.command)) {
    var ts = document.createElement("span"); ts.className = "ask-target"; ts.textContent = tgt; body.appendChild(ts);
  }
  card.appendChild(body);

  // Show the full shell command for Bash so the user knows what they approve.
  if (ev.input && ev.input.command) {
    var cmd = document.createElement("pre"); cmd.className = "ask-cmd"; cmd.textContent = String(ev.input.command);
    card.appendChild(cmd);
  }

  var actions = document.createElement("div"); actions.className = "ask-actions";
  function decide(resp, resultText, resultCls) {
    return function () {
      actions.remove();
      var done = document.createElement("div");
      card.appendChild(done);
      paintAskResult(done, resultText, resultCls, respond(ev.id, resp));
      if (onResolved) onResolved();
    };
  }
  var deny = document.createElement("button"); deny.type = "button"; deny.className = "ask-btn deny"; deny.textContent = "Deny";
  deny.addEventListener("click", decide({ allow: false }, "Denied", "denied"));
  var once = document.createElement("button"); once.type = "button"; once.className = "ask-btn"; once.textContent = "Allow once";
  once.addEventListener("click", decide({ allow: true, always: false }, "Allowed", "allowed"));
  var always = document.createElement("button"); always.type = "button"; always.className = "ask-btn primary"; always.textContent = "Allow always";
  always.addEventListener("click", decide({ allow: true, always: true }, "Allowed for this chat", "allowed"));
  actions.appendChild(deny); actions.appendChild(once); actions.appendChild(always);
  card.appendChild(actions);

  messages.appendChild(card);
  scrollDown(false);
}

// A question card: Claude called AskUserQuestion and wants the user to choose.
export function addQuestionCard(ev, onResolved) {
  var card = document.createElement("div");
  card.className = "ask-card ques enter";
  setTimeout(function () { card.classList.remove("enter"); }, 400);
  card.appendChild(askHead(QUESTION_ICON, "Claude is asking"));

  var questions = (ev.input && ev.input.questions) || [];
  var state = questions.map(function () { return { chosen: [], other: "" }; });

  questions.forEach(function (q, qi) {
    var qWrap = document.createElement("div"); qWrap.className = "ask-q";
    if (q.header) { var h = document.createElement("div"); h.className = "ask-q-header"; h.textContent = q.header; qWrap.appendChild(h); }
    var qt = document.createElement("div"); qt.className = "ask-q-text"; qt.textContent = q.question || ""; qWrap.appendChild(qt);

    var multi = !!q.multiSelect;
    var opts = document.createElement("div"); opts.className = "ask-opts";
    (q.options || []).forEach(function (opt) {
      var b = document.createElement("button"); b.type = "button"; b.className = "ask-opt";
      var lab = document.createElement("span"); lab.className = "ask-opt-label"; lab.textContent = opt.label; b.appendChild(lab);
      if (opt.description) { var d = document.createElement("span"); d.className = "ask-opt-desc"; d.textContent = opt.description; b.appendChild(d); }
      b.addEventListener("click", function () {
        var arr = state[qi].chosen;
        var idx = arr.indexOf(opt.label);
        if (multi) {
          if (idx >= 0) { arr.splice(idx, 1); b.classList.remove("on"); }
          else { arr.push(opt.label); b.classList.add("on"); }
        } else {
          state[qi].chosen = [opt.label];
          Array.prototype.forEach.call(opts.children, function (c) { c.classList.remove("on"); });
          b.classList.add("on");
        }
      });
      opts.appendChild(b);
    });
    qWrap.appendChild(opts);

    var other = document.createElement("input");
    other.type = "text"; other.className = "ask-other"; other.placeholder = "Other…";
    other.addEventListener("input", function () { state[qi].other = other.value; });
    qWrap.appendChild(other);

    card.appendChild(qWrap);
  });

  var actions = document.createElement("div"); actions.className = "ask-actions";
  var sendB = document.createElement("button"); sendB.type = "button"; sendB.className = "ask-btn primary"; sendB.textContent = "Send answer";
  sendB.addEventListener("click", function () {
    var selections = questions.map(function (q, qi) {
      var chosen = state[qi].chosen.slice();
      if (state[qi].other && state[qi].other.trim()) chosen.push(state[qi].other.trim());
      return { header: q.header || q.question || ("Question " + (qi + 1)), chosen: chosen };
    });
    actions.remove();
    Array.prototype.forEach.call(card.querySelectorAll(".ask-opt, .ask-other"), function (el) { el.disabled = true; });
    var done = document.createElement("div");
    card.appendChild(done);
    paintAskResult(done, "Answer sent", "allowed", respond(ev.id, { selections: selections }));
    if (onResolved) onResolved();
  });
  actions.appendChild(sendB);
  card.appendChild(actions);

  messages.appendChild(card);
  scrollDown(false);
}

// Copy text to the clipboard. navigator.clipboard requires a secure context
// (HTTPS or localhost), but this app is ALSO reachable over plain HTTP on the
// tailnet — so fall back to a hidden-textarea execCommand("copy") there.
export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise(function (resolve, reject) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error("copy failed"));
    } catch (e) { reject(e); }
  });
}

// Build a copy-to-clipboard button. getText() is read at click time so a
// re-rendered code block always copies its current contents. Briefly shows a
// "Copied" confirmation, then reverts.
export function makeCopyBtn(getText, className, label) {
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  if (label) btn.title = label; else btn.title = "Copy";
  btn.setAttribute("aria-label", label || "Copy");
  function paint(icon, text) { btn.innerHTML = icon + (label ? "<span>" + text + "</span>" : ""); }
  paint(COPY_ICON, label);
  var revertT = null;
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    copyText(getText() || "").then(function () {
      btn.classList.add("copied");
      paint(COPIED_ICON, "Copied");
      if (revertT) clearTimeout(revertT);
      revertT = setTimeout(function () { btn.classList.remove("copied"); paint(COPY_ICON, label); }, 1600);
    }).catch(function () { toast("Copy failed", true); });
  });
  return btn;
}

// Add a copy button to every fenced code block so the user can grab just the
// code inside the "box" (not the whole answer). Run after markdown is rendered.
export function enhanceCodeBlocks(root) {
  var pres = root.querySelectorAll("pre");
  Array.prototype.forEach.call(pres, function (pre) {
    var code = pre.querySelector("code");
    if (!code || pre.querySelector(".code-copy")) return;
    pre.classList.add("has-copy");
    pre.appendChild(makeCopyBtn(function () { return code.textContent || ""; }, "code-copy", ""));
  });
}

export function addSaveButton(bubble, text) {
  var actions = document.createElement("div");
  actions.className = "bubble-actions";
  var btn = document.createElement("button");
  btn.className = "save-btn";
  btn.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg><span>Save to file</span>';
  btn.addEventListener("click", function () {
    if (btn.classList.contains("saved")) return;
    promptSheet({
      title: "Save to file",
      message: "Relative to the project " + projName() + ".",
      value: "plumi/output.md",
      submitLabel: "Save",
      onSubmit: saveAs,
    });
  });
  function saveAs(fname) {
    apiFetch("/api/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: projName(), filename: fname, content: text })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok) {
          btn.classList.add("saved");
          btn.querySelector("span").textContent = "Saved " + res.d.path;
          btn.querySelector("svg").outerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        } else { toast(res.d.error || "Save failed", true); }
      }).catch(function (e) { toast(e.message, true); });
  }
  // Copy the whole answer (raw markdown source) — the common case.
  actions.appendChild(makeCopyBtn(function () { return text; }, "copy-btn", "Copy"));
  actions.appendChild(btn);
  actions.appendChild(makeDownloadMenu(text));
  bubble.appendChild(actions);
}

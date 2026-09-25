/* Plumi — PlumiBot's pixel-art bird, doing what the agent is doing.

   Nothing here draws him. The art, the rig and the loops belong to the PlumiBot
   project, which builds them into ONE self-contained file (GSAP core included),
   /vendor/plumi/plumi-animation.js; index.html loads it as a classic script
   before app.js. It defines <plumi-animation> and window.Plumi. This module only
   decides which loop plays where:

     - the status pill: a 1x Plumi in place of the three dots, acting out the turn
       (pondering, typing, reading, painting, asking, dozing through a reconnect,
       and a small cheer on Done);
     - an empty conversation: a 3x Plumi waves once, then idles;
     - the Images panel: Plumi paints while a picture renders;
     - a live error row: Plumi shrugs, once.

   If the bundle is missing, ready() is false and everything here does nothing:
   the pill keeps its dots and the empty state keeps its words. The file is a
   build output: loops are changed at their source, never edited here. */

// Everything the pill can show. Every one of these is 42px tall at 1x with the
// ground at 40, which is what lets them swap inside a pill of fixed height.
const PILL_LOOPS = ["ponder", "type", "read", "paint", "ask", "sleep", "oops", "idle", "cheer"];

// Tools that look things up rather than change them. Plumi reads for these.
const READ_TOOLS = /^(Read|Grep|Glob|LS|NotebookRead|WebFetch|WebSearch|ToolSearch|ListMcpResourcesTool|ReadMcpResourceTool|ReadMcpResourceDirTool)$/;

let pill = null;        // the <plumi-animation> in the status pill
let pillFrame = null;

export function ready() {
  return !!(window.Plumi && window.Plumi.animations && window.customElements &&
    window.customElements.get("plumi-animation"));
}

function stageOf(name) { return window.Plumi.animations[name].stage; }

// The in-app Reduce motion switch (theme.js) sets data-reduce-motion on <html>;
// the component itself only knows the OS setting, so say it explicitly.
function motion() {
  return document.documentElement.getAttribute("data-reduce-motion") === "1" ? "reduce" : "auto";
}

/* A box that holds Plumi at a fixed spot while his loops change. Stages differ
   (the easel makes "paint" wider, the desk sits left of "type"), so each loop is
   shifted until the sprite's own x=0 lands in the same place, and the box is as
   wide as the widest loop needs. Without this he hops sideways on every switch. */
function frameFor(names, scale) {
  let k = 0, w = 0, h = 0;
  names.forEach(function (n) { k = Math.max(k, stageOf(n).x); });
  names.forEach(function (n) {
    const s = stageOf(n);
    w = Math.max(w, k - s.x + s.w);
    h = Math.max(h, s.h);
  });
  return { k: k, w: w * scale, h: h * scale, scale: scale };
}

function makeEl(frame, cls) {
  const box = document.createElement("span");
  box.className = cls;
  box.setAttribute("aria-hidden", "true");
  box.style.width = frame.w + "px";
  box.style.height = frame.h + "px";
  const el = document.createElement("plumi-animation");
  el.setAttribute("scale", String(frame.scale));
  el.setAttribute("motion", motion());
  box.appendChild(el);
  return { box: box, el: el };
}

// Switch a Plumi to `name`. Asking again for the loop already showing does
// nothing, so a status update per streamed token never restarts him; asking
// again for a one-shot (the Done cheer) plays it from the top.
function setLoop(el, frame, name, loop) {
  if (el.getAttribute("name") === name && el.hasAttribute("loop") === loop) {
    if (!loop) { el.seek(0); el.play(); }
    return;
  }
  el.style.marginLeft = (frame.k - stageOf(name).x) * frame.scale + "px";
  if (loop) el.setAttribute("loop", ""); else el.removeAttribute("loop");
  el.setAttribute("name", name);
}

/** The loop for a tool the agent is running. */
export function loopForTool(name) {
  name = String(name || "");
  if (/generate_image/.test(name)) return "paint";
  if (name === "AskUserQuestion") return "ask";
  if (READ_TOOLS.test(name) || /__(recall|search|read|fetch|get|list)/.test(name)) return "read";
  return "type";
}

/* The status pill's Plumi, driven by setStatus() in stream.js.
   state "working" + a loop name switches to it (no name keeps the current one);
   "done" cheers once; anything else leaves him be — the pill hides, and the
   component pauses itself when it is not on screen. */
export function pillPlumi(state, loop) {
  if (!pill) return;
  if (state === "working") {
    if (loop) setLoop(pill, pillFrame, loop, true);
    else if (!pill.hasAttribute("loop")) setLoop(pill, pillFrame, "ponder", true);  // first use, or after Done
  } else if (state === "done") {
    setLoop(pill, pillFrame, "cheer", false);
  }
}

/* The greeting for an empty conversation. clearMessages() puts a fresh one in
   the list every time, so each new chat gets its own wave; the stylesheet shows
   it only while the list has no rows (the same :has() test as the words). */
export function helloPlumi() {
  if (!ready()) return null;
  const scale = window.matchMedia && window.matchMedia("(min-width: 900px)").matches ? 4 : 3;
  const frame = frameFor(["wave", "idle"], scale);
  const p = makeEl(frame, "hello-plumi");
  setLoop(p.el, frame, "wave", false);
  p.el.addEventListener("plumi-end", function () { setLoop(p.el, frame, "idle", true); }, { once: true });
  return p.box;
}

/** A standalone Plumi (the Images panel's painter, the error shrug). */
export function plumiBox(name, scale, opts) {
  if (!ready()) return null;
  opts = opts || {};
  const frame = frameFor([name], scale);
  const p = makeEl(frame, "plumi-box" + (opts.className ? " " + opts.className : ""));
  setLoop(p.el, frame, name, !opts.once);
  // A one-shot stays on its key pose afterwards (the shrug), not the rest pose
  // it returns to — a still bird standing in an error row says nothing.
  if (opts.once) {
    p.el.addEventListener("plumi-end", function () {
      p.el.seek(window.Plumi.animations[name].poster || 0);
    });
  }
  return p.box;
}

export function initPlumi() {
  if (!ready()) return;
  const bar = document.getElementById("statusBar");
  if (bar) {
    pillFrame = frameFor(PILL_LOOPS, 1);
    const p = makeEl(pillFrame, "sb-plumi");
    pill = p.el;
    bar.insertBefore(p.box, bar.firstChild);
    bar.classList.add("has-plumi");
  }
  // The page's first paint is the static markup, which clearMessages() has not
  // touched yet; give that empty list its greeting too.
  const list = document.getElementById("messages");
  if (list && !list.querySelector(".row, .notice, .hello-plumi")) {
    const h = helloPlumi();
    if (h) list.appendChild(h);
  }
}

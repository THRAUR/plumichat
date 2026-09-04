/* PlumiChat — the handful of things every other module reaches for: the $ helper,
   the four elements the whole page hangs off, the embed-mode flags, the device-local
   preference store and the toast. Imports nothing, so it is always the first module
   evaluated and nothing can read a half-built binding out of it. */

export let $ = function (id) { return document.getElementById(id); };
export let messages = $("messages");
export let input = $("input");
export let sendBtn = $("sendBtn");
export let composer = $("composer");
export let toastWrap = $("toastWrap");

/* ---------- Grid-pane (embed) mode ----------
   This page can run inside an <iframe> as one pane of the multi-chat grid
   (grid.html). When embedded we (1) namespace UI prefs per pane so panes don't
   clobber each other or the standalone app, (2) keep the conversation drawer an
   overlay (never the desktop sidebar) regardless of the pane's width, and
   (3) seed the initial project from the URL. The standalone app (no params) is
   completely unaffected: PREF_NS stays "" and EMBED stays false. */
export let QS = new URLSearchParams(location.search);
export let EMBED = QS.get("embed") === "1";
export let PANE = QS.get("pane") || "";
export let SEED_PROJECT = QS.get("project") || "";
export let SEED_CONV = QS.get("c") || "";
// A deep link is consumed once: the boot clears it after opening that
// conversation, so a later reload resumes normally instead of jumping back.
export function clearSeedConv() { SEED_CONV = ""; }
// Launched from the installed app's "New chat" shortcut (manifest.webmanifest):
// land on an empty composer instead of resuming the last conversation.
export let NEW_CHAT = QS.get("new") === "1";
export let PREF_NS = PANE ? (":" + PANE) : "";
/* tiny device-local UI prefs only (not conversation data). In embed mode the
   key is suffixed with the pane id, so each pane remembers its own project /
   model / effort independently. */
export function pref(k, v) {
  var key = "plumi.pref." + k + PREF_NS;
  try {
    if (v === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, v);
  } catch (e) {}
}

/* ---------- Toasts ---------- */
// An optional onClick makes the toast a button (e.g. "tap to open"); those stay
// up a little longer and are clickable (the toast-wrap is pointer-events:none).
export function toast(msg, isErr, onClick) {
  var t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "") + (onClick ? " action" : "");
  t.textContent = msg;
  var hideT, gone = false;
  function dismiss() {
    if (gone) return; gone = true;
    clearTimeout(hideT);
    t.classList.remove("show");
    setTimeout(function () { if (t.parentNode) t.remove(); }, 220);
  }
  if (onClick) {
    t.setAttribute("role", "button");
    t.tabIndex = 0;
    var fire = function (e) { if (e) e.preventDefault(); dismiss(); onClick(); };
    t.addEventListener("click", fire);
    t.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") fire(e); });
  }
  toastWrap.appendChild(t);
  requestAnimationFrame(function () { t.classList.add("show"); });
  hideT = setTimeout(dismiss, onClick ? 6500 : 2600);
}

export function initEmbedClasses() {
  if (EMBED) {
    document.documentElement.classList.add("embed");
    document.body.classList.add("embed");
  }
}

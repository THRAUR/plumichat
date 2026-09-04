import { toast } from '../dom.js';
import { goToConversation } from '../library.js';
import { draftFor, sessionsCache } from '../state.js';

/* ---------- "Ping me when it's done" — notify on background completion ---------- */
// On a phone a long turn often finishes while PlumiChat is in another tab or the
// screen is off. If the user has allowed notifications we surface a system ping.
// We never ask on load (no nag) — only a soft, one-time invite the first time a
// turn actually completes while the app is hidden.
export let swReg = null;
export let notifyAskPending = false;
export let NOTIFY_ASKED_KEY = "plumi_notify_softasked";
export function notifyAsked() { try { return !!localStorage.getItem(NOTIFY_ASKED_KEY); } catch (e) { return false; } }
export function markNotifyAsked() { try { localStorage.setItem(NOTIFY_ASKED_KEY, "1"); } catch (e) {} }
export function canNotify() { return ("Notification" in window) && Notification.permission === "granted"; }
export function showDoneNotification(title, body, data) {
  if (!canNotify()) return;
  var opts = { body: body, tag: "plumi-turn-done", renotify: true, icon: "/favicon-512.png" };
  if (data) opts.data = data;
  try {
    if (swReg && swReg.showNotification) swReg.showNotification(title, opts);
    else new Notification(title, opts);   // desktop fallback (mobile needs the SW)
  } catch (e) {}
}
export function convTitleByKey(p, key) {
  var list = sessionsCache[p] || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === key) return list[i].title || null;
  var d = draftFor(key);
  if (d && d.title) return d.title;
  return null;
}
// `away` — we are only NOW collecting the ending of a turn that finished while
// the app was in the background (a quiet reattach on wake-up). There is nothing
// to ping for, since the answer is on screen — but it is still exactly the moment
// worth offering pings for, and since the page parks its stream while hidden it
// is the only moment left that can make that offer.
export function notifyTurnDone(p, key, ended, away) {
  if (!document.hidden && !away) return;  // only when PlumiChat was in the background
  if (document.hidden && canNotify()) {
    var title = convTitleByKey(p, key) || "PlumiChat";
    var body = "Your task is ready.";
    if (ended && ended.stalled) body = "The turn ended — " + (ended.reason || "background work stopped responding") + ".";
    else if (ended && ended.status === "stopped") body = "The turn was stopped.";
    else if (ended && ended.status === "error") body = "The turn hit an error.";
    showDoneNotification(title, body, { project: p, key: key });
    return;
  }
  if (canNotify()) return;               // permission is already granted — nothing to offer
  // No permission yet — remember there was a real reason to ask, so we can make
  // a gentle, gesture-driven offer when the user comes back to the app (or right
  // now, if this IS the user coming back).
  if (("Notification" in window) && Notification.permission === "default" && !notifyAsked()) {
    notifyAskPending = true;
    if (!document.hidden) offerNotifications();
  }
}
// The one-time "want pings?" offer. Only ever fires when a turn really did finish
// while the app was away (notifyAskPending) and the browser has not been asked
// before — it is a toast with a tap target, never a bare permission prompt.
export function offerNotifications() {
  if (!notifyAskPending) return;
  if (!("Notification" in window) || Notification.permission !== "default" || notifyAsked()) return;
  notifyAskPending = false;
  markNotifyAsked();
  toast("Get a ping when PlumiChat finishes while you're away? Tap to allow.", false, function () {
    if (!("Notification" in window)) return;
    Notification.requestPermission().then(function (perm) {
      if (perm === "granted") toast("Done — I'll ping you when a task finishes in the background.");
    }).catch(function () {});
  });
}
// A turn stalled waiting for YOU (a permission prompt or a question) while the
// app is backgrounded — ping so you can come unblock it, not just when it ends.
export function notifyAttention(p, key, ev) {
  if (!document.hidden) return;
  if (canNotify()) {
    var title = convTitleByKey(p, key) || "PlumiChat";
    var body = (ev && ev.kind === "question")
      ? "Claude is asking you something." : "Claude needs your permission to continue.";
    showDoneNotification(title, body, { project: p, key: key });
    return;
  }
  if (("Notification" in window) && Notification.permission === "default" && !notifyAsked()) {
    notifyAskPending = true;
  }
}

export function initNotify() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").then(function (reg) { swReg = reg; }).catch(function () {});
    // Notification tapped while PlumiChat is already open — jump to that conversation.
    navigator.serviceWorker.addEventListener("message", function (ev) {
      var d = ev.data || {};
      if (d.type === "plumi:open" && (d.project || d.key)) goToConversation(d.project, d.key);
    });
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    // Returning to the app: clear any pings we posted while away…
    if (swReg && swReg.getNotifications) {
      swReg.getNotifications({ tag: "plumi-turn-done" })
        .then(function (ns) { ns.forEach(function (n) { n.close(); }); }).catch(function () {});
    }
    // …and, at most once ever, softly offer to enable notifications — but only if a
    // turn really did finish while the app was hidden (notifyAskPending).
    offerNotifications();
  });
}

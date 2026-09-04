import { reqJSON } from '../api.js';
import { $, toast } from '../dom.js';
import { markNotifyAsked } from './notify.js';

/* ---------- Notifications: the client half of Web Push ----------
   sw.js has handled `push` and `notificationclick` for a while, but nothing ever
   SUBSCRIBED — so the server had nowhere to send anything and "ping me when it's
   done" quietly did nothing whenever iOS had the app suspended, which is the only
   time it matters. This is that missing half. */
export let pushInfo = null;      // last /api/push/key answer
export function b64ToBytes(base64url) {
  var pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  var b64 = (base64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  var raw = atob(b64);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
// navigator.serviceWorker.ready is the reliable handle: swReg above is filled in
// by an async register() that may not have resolved when the drawer is opened.
export function pushReg() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return Promise.resolve(null);
  return navigator.serviceWorker.ready.catch(function () { return null; });
}
export function currentPushSub() {
  return pushReg().then(function (reg) {
    if (!reg || !reg.pushManager) return null;
    return reg.pushManager.getSubscription().catch(function () { return null; });
  });
}
export function paintNotifyRow() {
  var nav = $("notifyNav"), tag = $("notifyTag");
  if (!nav || !tag) return;
  if (!pushInfo || !pushInfo.available) { nav.hidden = true; return; }
  nav.hidden = false;
  currentPushSub().then(function (sub) {
    var on = !!sub && Notification.permission === "granted";
    tag.className = "nav-tag" + (on ? " on" : "");
    tag.textContent = on ? "On" : (Notification.permission === "denied" ? "Blocked" : "Off");
  });
}
// enable=true subscribes this browser; false drops it. Returns a promise so the
// soft-ask toast can chain onto it.
export function setPush(enable) {
  if (!pushInfo || !pushInfo.available || !pushInfo.publicKey) {
    toast("Push isn't configured on this server", true);
    return Promise.resolve(false);
  }
  if (!enable) {
    return currentPushSub().then(function (sub) {
      if (!sub) { paintNotifyRow(); return false; }
      var endpoint = sub.endpoint;
      return reqJSON("/api/push/unsubscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: endpoint })
      }).catch(function () { return null; })
        .then(function () { return sub.unsubscribe().catch(function () { return false; }); })
        .then(function () { paintNotifyRow(); toast("Notifications off on this device"); return false; });
    });
  }
  // Permission first: subscribe() on a browser that hasn't been asked throws, and
  // on iOS the request must ride a real user gesture (this runs from a tap).
  var ask = (Notification.permission === "granted")
    ? Promise.resolve("granted")
    : Notification.requestPermission();
  return Promise.resolve(ask).then(function (perm) {
    if (perm !== "granted") {
      markNotifyAsked();
      paintNotifyRow();
      toast(perm === "denied"
        ? "Notifications are blocked for PlumiChat in your browser settings"
        : "Notifications stay off", perm === "denied");
      return false;
    }
    return pushReg().then(function (reg) {
      if (!reg || !reg.pushManager) throw new Error("This browser can't do push notifications");
      return reg.pushManager.getSubscription().then(function (existing) {
        if (existing) return existing;
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToBytes(pushInfo.publicKey)
        });
      });
    }).then(function (sub) {
      // The server accepts the raw PushSubscription JSON or the same wrapped —
      // send the raw shape, and re-subscribing the same endpoint just replaces it.
      return reqJSON("/api/push/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON ? sub.toJSON() : sub)
      });
    }).then(function () {
      markNotifyAsked();
      paintNotifyRow();
      toast("Notifications on — I'll ping this device when a turn finishes");
      return true;
    }).catch(function (e) {
      paintNotifyRow();
      toast((e && e.message) || "Couldn't turn notifications on", true);
      return false;
    });
  });
}

export function initPushRow() {
  (function setupNotifyNav() {
    var nav = $("notifyNav");
    if (!nav || !("Notification" in window)) return;
    nav.addEventListener("click", function () {
      currentPushSub().then(function (sub) {
        var on = !!sub && Notification.permission === "granted";
        setPush(!on);
      });
    });
    // The key route doubles as the availability probe: with no VAPID keys
    // configured it answers available:false, which is our cue to hide the row
    // rather than offer a button that cannot work.
    reqJSON("/api/push/key").then(function (d) { pushInfo = d; paintNotifyRow(); })
      .catch(function () { /* older server — the row stays hidden */ });
  })();
}

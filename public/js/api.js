/* PlumiChat — the one fetch wrapper. Imported by every module that talks to the
   server; see the note below for why nothing calls fetch() directly. */

import { EMBED } from './dom.js';

/* ---------- The one fetch wrapper ----------
   EVERY server call in the app goes through apiFetch. Two reasons:
   (1) 401. The home-screen web app has no address bar, so before this an expired
       session (30-day idle, or a PIN change on another device) turned every call
       into "Could not load…" with no way out but force-quitting the app. We send
       the user to /login with a ?next= back to exactly where they were.
   (2) errors. reqJSON below parses the server's {error:"…"} body so callers can
       show the real message — a 429 ("too many turns running") or a 409 ("a turn
       is already running for this conversation") must not read as a generic failure. */
export let authRedirected = false;   // many parallel calls can 401 at once — redirect once
export function goToLogin() {
  if (authRedirected) return;
  authRedirected = true;
  var next = "/login?next=" + encodeURIComponent(location.pathname + location.search);
  // A grid pane is an <iframe>: log in at the top level, or the form would be
  // trapped inside a pane the size of a postage stamp.
  try {
    if (EMBED && window.top && window.top !== window) { window.top.location.href = next; return; }
  } catch (e) { /* cross-origin top (never happens here) — fall through */ }
  location.href = next;
}
export function apiFetch(url, opts) {
  return fetch(url, opts).then(function (r) {
    if (r.status === 401) {
      goToLogin();
      // Neither resolve nor reject: we are navigating away, and every caller in
      // this file would otherwise paint "Could not load…" over the redirect (or,
      // for the several chains with no .catch, raise an unhandled rejection).
      return new Promise(function () {});
    }
    return r;
  });
}
// apiFetch + JSON, rejecting with the server's own error text on a non-2xx.
export function reqJSON(url, opts) {
  return apiFetch(url, opts).then(function (r) {
    return r.text().then(function (t) {
      var d = {}; try { d = JSON.parse(t); } catch (e) { /* non-JSON body */ }
      if (!r.ok) { var e2 = new Error(d.error || ("Request failed (" + r.status + ")")); e2.status = r.status; throw e2; }
      return d;
    });
  });
}

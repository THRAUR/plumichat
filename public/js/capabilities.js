// public/js/capabilities.js — hide what this machine cannot do, and say why.
//
// The server answers GET /api/capabilities with one row per optional feature (see
// server/capabilities.js). This module applies those rows to the side menu.
//
// Two rules that keep it safe to call from anywhere:
//   1. It only ever HIDES. Role gating (profile.js, panels/engine.js) decides what
//      you are ALLOWED to see; this decides what can WORK here. A row must pass
//      both, and because this never un-hides, the order the two run in cannot
//      accidentally reveal an owner-only row to a member.
//   2. It is never the security boundary. Every route behind these rows is gated
//      server-side; a hidden button is tidiness, not enforcement.
//
// Fetched once and shared — several panels want the same answer and it cannot
// change without a server restart.

import { reqJSON } from "./api.js";

var cache = null;

export function capabilities() {
  if (!cache) {
    cache = reqJSON("/api/capabilities").catch(function () {
      // Offline, or a server too old to answer. Assume everything works rather
      // than blanking the menu — the routes themselves still refuse properly.
      return null;
    });
  }
  return cache;
}

// nav row id -> the capability that has to be available for it to do anything.
var GATED_ROWS = {
  terminalNav: "terminal",
  sitesNav: "sites",
  opsNav: "operations",
  engineNav: "engineUpdates",
  deployNav: "deploy",
  restartServerNav: "processRestart",
};

export function applyCapabilityGating() {
  return capabilities().then(function (caps) {
    if (!caps) return null;
    Object.keys(GATED_ROWS).forEach(function (id) {
      var cap = caps[GATED_ROWS[id]];
      if (!cap || cap.available) return;
      var el = document.getElementById(id);
      if (!el) return;
      el.hidden = true;
      // Kept on the element so the reason is discoverable in devtools when someone
      // asks "why is there no Terminal row on my Mac?" — the answer is right here
      // rather than only in the server log they never see.
      el.setAttribute("data-unavailable", cap.reason || "not available on this machine");
    });
    return caps;
  });
}

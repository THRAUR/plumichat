/* PlumiChat — the account's chat defaults (model, effort, fast, 1M, approval mode).

   These used to live in localStorage via pref(), which made them per-DEVICE and
   per-BROWSER: pick Opus + bypass on the Mac and the phone still opened on
   whatever it last saw, and a split-view pane — a separate document — started
   from the defaults again. They are a property of the ACCOUNT, so the server
   owns them and every device and pane reads the same answer.

   localStorage is kept, but demoted to a CACHE: it is what paints the composer
   on the very first frame, before /api/settings/profile has answered, so the
   pill does not visibly flip from "Sonnet 5 / Ask" to your real choice a beat
   later. The server value overwrites it the moment it lands.

   This module imports nothing from models.js or perm.js on purpose. Those two
   own their state and expose applyAccountDefaults(); if this module reached back
   into them the three would form an import cycle. */

import { apiFetch } from './api.js';

// Coalesce: changing model then effort then fast in one visit to the menu is one
// write, not three. Also means a burst of clicks cannot outrun the network.
let pending = null;
let timer = 0;

export function saveDefaults(patch) {
  pending = Object.assign(pending || {}, patch);
  if (timer) return;
  timer = setTimeout(function () {
    const body = pending;
    pending = null; timer = 0;
    if (!body) return;
    // Deliberately quiet. This rides along with a choice the person already saw
    // take effect locally; a failed sync must not put an error toast over a
    // menu that did the right thing. The next change retries the whole patch.
    apiFetch("/api/settings/defaults", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).catch(function () {});
  }, 250);
}

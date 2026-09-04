import { apiFetch, reqJSON } from './api.js';
import { sessionsCache } from './state.js';

/* ---------- History fetching ---------- */
// A transient 500/401 must NOT wipe the cached list — doing that made the drawer
// announce "No conversations yet" for a conversation history that is perfectly
// fine on disk. Keep the last good list and let the caller offer a retry.
export let sessionsFailed = {};   // project -> true when the last fetch failed
export function fetchSessions(name) {
  return reqJSON("/api/sessions?project=" + encodeURIComponent(name))
    .then(function (d) {
      sessionsFailed[name] = false;
      sessionsCache[name] = d.sessions || [];
      return sessionsCache[name];
    })
    .catch(function () {
      sessionsFailed[name] = true;
      if (!sessionsCache[name]) sessionsCache[name] = [];  // first-ever load — nothing to keep
      return sessionsCache[name];
    });
}
export function loadSessionMessages(name, id) {
  return apiFetch("/api/session?project=" + encodeURIComponent(name) + "&id=" + encodeURIComponent(id))
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
}

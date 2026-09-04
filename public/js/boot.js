/* PlumiChat — what happens on load: fetch the projects, then decide which conversation
   this device lands on (a ?c= deep link, a 'New chat' shortcut, the last project's
   latest thread, or the most recent thread anywhere) and re-attach to any turn still
   running on the server. */

import { apiFetch } from './api.js';
import { showFirstRun } from './onboarding.js';
import { updateSend } from './composer.js';
import { EMBED, NEW_CHAT, PANE, SEED_CONV, SEED_PROJECT, clearSeedConv, pref, toast } from './dom.js';
import { goToConversation, refreshLibrary, updateTopbarTitle } from './library.js';
import { openLatestOrEmpty, openMostRecentOrEmpty, pickerLabel, renderMenu } from './projects.js';
import { clearMessages } from './render.js';
import { freshViewKey, projName, projects, setActiveSessionId, setCurrent, setProjects, setViewKey, startDraft } from './state.js';
import { setStatus, syncRuns } from './stream.js';

/* ---------- Boot ---------- */
// Drop the ONE-SHOT deep-link params (?c=, ?new=) once they've been acted on,
// but keep the ones that define this page instance. history.replaceState used to
// rewrite the URL to a bare pathname, which threw away embed=1 & pane= — so a
// grid pane that had been opened on a conversation reloaded as a broken
// standalone chat inside its iframe.
export function stripSeedParams() {
  try {
    var keep = new URLSearchParams();
    if (EMBED) keep.set("embed", "1");
    if (PANE) keep.set("pane", PANE);
    if (SEED_PROJECT) keep.set("project", SEED_PROJECT);
    var q = keep.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : ""));
  } catch (e) {}
}

export function loadProjects(isRefresh) {
  apiFetch("/api/projects").then(function (r) { return r.json(); }).then(function (data) {
    setProjects(data.projects || []);
    if (!projects.length) {
      // A brand-new install has nothing in the workspace yet. Two things used to go
      // wrong here, and both were this early return: the picker label said "No
      // projects" while renderMenu() never ran, so opening the picker showed an
      // EMPTY menu with no "New project" item in it — there was literally no way to
      // make one — and the only hint was a toast that had already faded.
      pickerLabel.textContent = "No project";
      renderMenu();      // "New project…" must exist even when the list is empty
      showFirstRun();    // and a blocking welcome explains the choice properly
      return;
    }
    // An explicit ?project= WINS over the saved last project. The other way round
    // meant a notification tap or a grid pane opened whichever conversation you
    // happened to be in last, then failed to find ?c= in it: "Could not load
    // conversation".
    var idx = 0, last = SEED_PROJECT || pref("lastProject"), haveLast = false;
    if (last) projects.forEach(function (p, i) { if (p.name === last) { idx = i; haveLast = true; } });
    setCurrent(idx);
    pickerLabel.textContent = projName();
    renderMenu();
    // Populate the persistent desktop sidebar (mobile fetches on drawer open).
    if (!isRefresh && SEED_CONV) {
      // Deep-link from a notification tap: open the exact conversation.
      var seedProj = haveLast ? last : projName();
      goToConversation(seedProj, SEED_CONV);
      // The topbar title comes from sessionsCache, which refreshLibrary() fills.
      // Without re-running it afterwards a notification tap paints the header as
      // "New conversation" until the next render (present before the split too).
      refreshLibrary().then(updateTopbarTitle).catch(function () {});
      clearSeedConv();
      stripSeedParams();
    } else if (isRefresh) {
      toast("Projects refreshed (" + projects.length + ")");
      refreshLibrary();
    } else if (!isRefresh && NEW_CHAT) {
      // "New chat" app shortcut: an empty composer in the usual project. Drop the
      // param so a later reload resumes normally instead of blanking the view again.
      setActiveSessionId(null); setViewKey(freshViewKey()); startDraft(projName());
      clearMessages(); setStatus("hide"); updateTopbarTitle(); updateSend();
      refreshLibrary();
      stripSeedParams();
    } else if (haveLast) {
      // Returning or seeded device: resume the saved/URL project's latest chat.
      openLatestOrEmpty(projName());
      refreshLibrary();
    } else {
      // Fresh device, no saved/seeded project: land on the single most-recent
      // conversation across ALL projects (or a new chat) — not just the first
      // project's top thread. Show an empty draft now so nothing flashes while we
      // fetch every project's sessions to find the global latest.
      setActiveSessionId(null); setViewKey(freshViewKey()); startDraft(projName());
      clearMessages(); setStatus("hide"); updateTopbarTitle(); updateSend();
      refreshLibrary().then(openMostRecentOrEmpty);
    }
    syncRuns(); // reattach to any turn still running on the server
  }).catch(function () { pickerLabel.textContent = "Error"; toast("Could not load projects", true); });
}

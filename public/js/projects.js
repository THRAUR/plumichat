import { apiFetch } from './api.js';
import { loadProjects } from './boot.js';
import { updateSend } from './composer.js';
import { $, pref, toast } from './dom.js';
import { fetchSessions } from './history.js';
import { drawerSearchInput, libraryVisible, openSession, renderLibrary, updateTopbarTitle } from './library.js';
import { clearMessages } from './render.js';
import { current, freshViewKey, projName, projects, sessionsCache, setActiveSessionId, setCurrent, setProjects, setViewKey, startDraft, viewKey } from './state.js';
import { setStatus } from './stream.js';

/* ---------- Project picker ---------- */
export let picker = $("picker");
export let pickerBtn = $("pickerBtn");
export let pickerMenu = $("pickerMenu");
export let pickerLabel = $("pickerLabel");

export function renderMenu() {
  pickerMenu.innerHTML = "";
  // Projects go in their own scroll box so a long list never pushes the
  // "New project" / "Refresh" actions off the bottom of the menu.
  var list = document.createElement("div"); list.className = "picker-list";
  projects.forEach(function (p, i) {
    var b = document.createElement("button");
    b.className = "picker-item";
    b.setAttribute("role", "option");
    b.setAttribute("aria-checked", i === current ? "true" : "false");
    var pn = document.createElement("span"); pn.className = "pname";
    var n = document.createElement("span"); n.textContent = p.name;
    var pp = document.createElement("span"); pp.className = "ppath"; pp.textContent = p.path;
    pn.appendChild(n); pn.appendChild(pp);
    b.appendChild(pn);
    b.insertAdjacentHTML("beforeend",
      '<svg class="tick" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>');
    b.addEventListener("click", function () { selectProject(i); closeMenu(); });
    list.appendChild(b);
  });
  pickerMenu.appendChild(list);
  var sep = document.createElement("div"); sep.className = "picker-sep"; pickerMenu.appendChild(sep);
  var add = document.createElement("button");
  add.className = "picker-item picker-new";
  add.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg><span>New project…</span>';
  // stopPropagation is load-bearing, not defensive. showNewProjectForm() replaces
  // pickerMenu's contents synchronously, which DETACHES this very button from the
  // document. The click then bubbles to the global dismiss handler, whose test is
  // `picker.contains(e.target)` — and a detached node is contained by nothing, so
  // it read as a click outside the picker and closed the menu. The form was still
  // there underneath, which is why a second click on the picker appeared to "work":
  // it was just re-opening a menu that had already become the form.
  add.addEventListener("click", function (e) { e.stopPropagation(); showNewProjectForm(); });
  pickerMenu.appendChild(add);
  var nw = document.createElement("button");
  nw.className = "picker-item picker-new";
  nw.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg><span>Refresh projects…</span>';
  nw.addEventListener("click", function () { closeMenu(); loadProjects(true); });
  pickerMenu.appendChild(nw);
}

// Swap the picker menu to an inline "new project" form. Clicks inside #picker
// don't close the menu (see the document click handler), so this stays open.
export function showNewProjectForm() {
  pickerMenu.innerHTML = "";
  var form = document.createElement("div"); form.className = "picker-form";
  var inp = document.createElement("input");
  inp.type = "text"; inp.className = "picker-input"; inp.placeholder = "New project name";
  inp.maxLength = 80; inp.autocapitalize = "off"; inp.spellcheck = false;
  var err = document.createElement("div"); err.className = "picker-err"; err.hidden = true;
  var row = document.createElement("div"); row.className = "picker-form-row";
  var cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "picker-mini"; cancel.textContent = "Cancel";
  var create = document.createElement("button"); create.type = "button"; create.className = "picker-mini primary"; create.textContent = "Create";
  function fail(msg) { err.textContent = msg; err.hidden = false; create.disabled = false; cancel.disabled = false; inp.disabled = false; inp.focus(); }
  function submit() {
    var name = inp.value.trim();
    if (!name) { inp.focus(); return; }
    err.hidden = true; create.disabled = true; cancel.disabled = true; inp.disabled = true;
    createProject(name).catch(function (e) { fail(e.message || "Could not create project"); });
  }
  create.addEventListener("click", submit);
  cancel.addEventListener("click", function (e) { e.stopPropagation(); renderMenu(); }); // same detach trap as above
  inp.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.stopPropagation(); renderMenu(); }
  });
  row.appendChild(cancel); row.appendChild(create);
  form.appendChild(inp); form.appendChild(err); form.appendChild(row);
  pickerMenu.appendChild(form);
  inp.focus();
}

// Create a project on the server, then refresh the list and switch to it.
export function createProject(name) {
  return apiFetch("/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name })
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (!r.ok) throw new Error(d.error || ("Request failed (" + r.status + ")"));
      return d;
    });
  }).then(function (created) {
    return apiFetch("/api/projects").then(function (r) { return r.json(); }).then(function (data) {
      setProjects(data.projects || []);
      var idx = 0; projects.forEach(function (p, i) { if (p.name === created.name) idx = i; });
      selectProject(idx); // sets current + label + pref, re-renders menu, opens chat
      closeMenu();
      toast(created.git === false ? ('Created "' + created.name + '" (git unavailable)') : ('Created project "' + created.name + '"'));
    });
  });
}
export function openMenu() {
  picker.classList.add("open");
  pickerBtn.setAttribute("aria-expanded", "true");
  var cur = pickerMenu.querySelector('.picker-item[aria-checked="true"]');
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
}
export function closeMenu() { picker.classList.remove("open"); pickerBtn.setAttribute("aria-expanded", "false"); }
export function selectProject(i) {
  setCurrent(i);
  var name = projName();
  pref("lastProject", name);
  pickerLabel.textContent = name;
  renderMenu();
  openLatestOrEmpty(name);
}

// Restore the project's most recent conversation, or start an empty chat.
export function openLatestOrEmpty(name) {
  setActiveSessionId(null);
  setViewKey(freshViewKey());
  startDraft(name);
  clearMessages();
  setStatus("hide");
  updateTopbarTitle();
  updateSend();
  // Same guard openSession has: the fetch can land AFTER the user has switched
  // project (or opened a conversation), and without this the late .then yanks
  // the view back to the previous project's latest chat.
  var myKey = viewKey;
  fetchSessions(name).then(function (sessions) {
    if (viewKey !== myKey || projName() !== name) return;
    var pick = null;
    for (var i = 0; i < sessions.length; i++) { if (!sessions[i].archived) { pick = sessions[i]; break; } }
    if (pick) {
      openSession(name, pick.id); // opens the latest non-archived → discards the draft
    } else if (libraryVisible()) {
      renderLibrary(drawerSearchInput.value); // no history → show the draft row
    }
  });
}

// Fresh device with no saved/seeded project: land on the single most-recently-
// active conversation across EVERY project (by session-log mtime), instead of
// the first project's top thread. If there's no history anywhere, keep the empty
// draft. Requires every project's sessions to already be in sessionsCache.
export function openMostRecentOrEmpty() {
  var best = null, bestProj = null, bestIdx = current;
  projects.forEach(function (p, i) {
    (sessionsCache[p.name] || []).forEach(function (s) {
      if (s.archived) return; // archived chats don't count as "most recent"
      if (!best || s.updatedAt > best.updatedAt) { best = s; bestProj = p.name; bestIdx = i; }
    });
  });
  if (!best) { if (libraryVisible()) renderLibrary(drawerSearchInput.value); return; }
  setCurrent(bestIdx);
  pickerLabel.textContent = bestProj;
  renderMenu();
  openSession(bestProj, best.id);
}

export function initProjectPicker() {
  pickerBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    picker.classList.contains("open") ? closeMenu() : openMenu();
  });
}

// public/js/onboarding.js — the first thing a brand-new install shows.
//
// PlumiChat works *inside a project*, and a project is just a directory under
// WORKSPACES_ROOT. On a fresh box there are none, which used to leave the picker
// showing an empty menu and a toast that faded before you read it: no explanation,
// and no way to make one. This is that explanation, and both ways out of it.
//
// It is deliberately NOT dismissible. There is nothing useful behind it — every
// other surface needs a project to act on — so an escape hatch would only produce
// a confusing empty app. It closes when a project exists, and not before.

import { apiFetch } from "./api.js";

var el = null;

function h(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function firstRunOpen() { return !!el; }

export function closeFirstRun() {
  if (!el) return;
  el.remove();
  el = null;
}

export function showFirstRun() {
  if (el) return;
  el = h("div", "firstrun-overlay");
  // role=dialog + aria-modal so a screen reader treats the rest of the page as
  // inert, matching the fact that it visually is.
  var win = h("div", "firstrun");
  win.setAttribute("role", "dialog");
  win.setAttribute("aria-modal", "true");
  win.setAttribute("aria-labelledby", "firstrunTitle");

  var head = h("div", "firstrun-head");
  var title = h("span", "firstrun-title", "Welcome to PlumiChat");
  title.id = "firstrunTitle";
  head.appendChild(title);
  win.appendChild(head);

  var body = h("div", "firstrun-body");
  body.appendChild(h("p", "firstrun-lede",
    "PlumiChat works inside a project — a folder on this machine that Claude can read and change. You don't have one yet."));

  /* ---------------------------------------------------- create a project --- */
  var cardA = h("div", "firstrun-card");
  cardA.appendChild(h("div", "firstrun-card-title", "Start something new"));
  cardA.appendChild(h("div", "firstrun-card-note",
    "Creates an empty folder in your workspace and initialises a git repository in it."));
  var rowA = h("div", "firstrun-row");
  var nameInput = h("input", "firstrun-input");
  nameInput.type = "text";
  nameInput.placeholder = "my-project";
  nameInput.maxLength = 80;
  nameInput.autocapitalize = "off";
  nameInput.spellcheck = false;
  var createBtn = h("button", "firstrun-btn primary", "Create");
  createBtn.type = "button";
  rowA.appendChild(nameInput);
  rowA.appendChild(createBtn);
  cardA.appendChild(rowA);
  var errA = h("div", "firstrun-err");
  errA.hidden = true;
  cardA.appendChild(errA);
  body.appendChild(cardA);

  /* ------------------------------------------------- point at existing code -- */
  var cardB = h("div", "firstrun-card");
  cardB.appendChild(h("div", "firstrun-card-title", "Use code you already have"));
  cardB.appendChild(h("div", "firstrun-card-note",
    "Pick the folder your repositories live in. Each folder inside it becomes a project. This changes where PlumiChat looks and needs a restart afterwards."));

  var browseBtn = h("button", "firstrun-btn", "Choose a folder…");
  browseBtn.type = "button";
  var browseWrap = h("div", "firstrun-browse");
  browseWrap.hidden = true;
  var crumb = h("div", "firstrun-crumb");
  var listEl = h("div", "firstrun-list");
  var rowB = h("div", "firstrun-row end");
  var useBtn = h("button", "firstrun-btn primary", "Use this folder");
  useBtn.type = "button";
  rowB.appendChild(useBtn);
  browseWrap.appendChild(crumb);
  browseWrap.appendChild(listEl);
  browseWrap.appendChild(rowB);
  cardB.appendChild(browseBtn);
  cardB.appendChild(browseWrap);
  var errB = h("div", "firstrun-err");
  errB.hidden = true;
  cardB.appendChild(errB);
  body.appendChild(cardB);

  win.appendChild(body);
  el.appendChild(win);
  document.body.appendChild(el);
  nameInput.focus();

  /* ------------------------------------------------------------- behaviour -- */
  function fail(box, msg) {
    box.textContent = msg;
    box.hidden = false;
  }
  function busy(on) {
    createBtn.disabled = on;
    useBtn.disabled = on;
    browseBtn.disabled = on;
    nameInput.disabled = on;
  }

  function create() {
    var name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    errA.hidden = true;
    busy(true);
    apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ("Request failed (" + r.status + ")"));
        return d;
      });
    }).then(function () {
      // Reload rather than patch state in place: every module's idea of "the
      // current project" is set during boot, and this is a once-per-install path
      // where a clean start is worth more than a smooth one.
      window.location.reload();
    }).catch(function (e) {
      busy(false);
      fail(errA, e.message || "Could not create the project");
    });
  }
  createBtn.addEventListener("click", create);
  nameInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); create(); }
  });

  /* --- a folder-only browser, built on the same /api/files the picker uses --- */
  var cwd = "";
  function draw(data) {
    cwd = data.path;
    crumb.textContent = data.path;
    listEl.innerHTML = "";
    if (data.parent) {
      var up = h("button", "firstrun-dir up", "↑  ..");
      up.type = "button";
      up.addEventListener("click", function () { go(data.parent); });
      listEl.appendChild(up);
    }
    var dirs = (data.entries || []).filter(function (e) { return e.type === "dir"; });
    if (!dirs.length) {
      listEl.appendChild(h("div", "firstrun-empty", "No folders in here — you can still use it."));
    }
    dirs.forEach(function (d) {
      var b = h("button", "firstrun-dir", d.name);
      b.type = "button";
      b.addEventListener("click", function () {
        go(data.path.replace(/\/+$/, "") + "/" + d.name);
      });
      listEl.appendChild(b);
    });
  }
  function go(p) {
    errB.hidden = true;
    apiFetch("/api/files" + (p ? "?path=" + encodeURIComponent(p) : ""))
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error(d.error || "Could not open that folder");
          return d;
        });
      })
      .then(draw)
      .catch(function (e) { fail(errB, e.message || "Could not open that folder"); });
  }
  browseBtn.addEventListener("click", function () {
    browseBtn.hidden = true;
    browseWrap.hidden = false;
    go("");
  });

  useBtn.addEventListener("click", function () {
    if (!cwd) return;
    errB.hidden = true;
    busy(true);
    apiFetch("/api/setup/workspace-root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: cwd }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ("Request failed (" + r.status + ")"));
        return d;
      });
    }).then(function (d) {
      // The root only moves on the next start (see the route's comment), so say so
      // plainly instead of reloading into a page that would look unchanged.
      body.innerHTML = "";
      body.appendChild(h("p", "firstrun-lede", "Workspace set to:"));
      body.appendChild(h("div", "firstrun-crumb", d.path));
      body.appendChild(h("p", "firstrun-card-note",
        "Restart PlumiChat for this to take effect — stop the server and run it again. Every folder inside that directory will then appear as a project."));
    }).catch(function (e) {
      busy(false);
      fail(errB, e.message || "Could not set the workspace folder");
    });
  });
}

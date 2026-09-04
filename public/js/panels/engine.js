import { reqJSON } from '../api.js';
import { $, toast } from '../dom.js';
import { closeDrawer } from '../library.js';
import { renderModelMenu, setMemberModelLocked } from '../models.js';
import { closeSheet, factCard, openSheet, sheetActions, sheetButton, sheetNote, sheetOpenName } from '../sheet.js';

/* ===================== Engine · Deploy · Notifications ==================== */
// Called from loadProfile once we know who is signed in. Every route these rows
// touch is gated server-side (owner-only for engine/deploy, per-user for push),
// so revealing a row is UI tidiness, never the guard itself.
export function setupOwnerRows(p) {
  var eng = $("engineNav"), dep = $("deployNav"), plug = $("pluginsNav"), ops = $("opsNav");
  if (eng) eng.hidden = !p.isOwner;
  if (dep) dep.hidden = !p.isOwner;
  // Operations was visible to everyone while every /api/ops/* route is owner-only,
  // so a member could open a board that could not load a single thing — one of the
  // "members see admin-only controls that 403" papercuts in the audit.
  if (ops) ops.hidden = !p.isOwner;
  // Plugins & MCP is owner-only for the same reason /api/plugins is: an install
  // runs a marketplace-declared command on this box.
  if (plug) plug.hidden = !p.isOwner;
  if (p.isOwner) { refreshEngineTag(); refreshDeployTag(); refreshOpsTag(); }
  // A member's model choice can be overridden server-side. Find out once, quietly.
  if (!p.isAdmin && !p.isOwner) {
    reqJSON("/api/settings/workspace").then(function (w) {
      if (!w || w.allowMemberSwitch !== false) return;
      setMemberModelLocked(true);
      renderModelMenu();
    }).catch(function () { /* older server / offline — leave the picker as it is */ });
  }
}

/* ---------- Engine (owner): versions + an update badge ----------
   Settings already owns the real panel, including the two-step dry-run → apply
   gate. This is a read-only summary with a deep link into it — duplicating the
   gate would be two places to get a staged engine update wrong. */
export let engineStatusCache = null;
export function loadEngineStatus(refresh) {
  return reqJSON("/api/engine/status" + (refresh ? "?refresh=1" : ""))
    .then(function (d) { engineStatusCache = d; return d; })
    .catch(function () { return null; });   // a server without the route: stay silent
}
export function refreshEngineTag() {
  var tag = $("engineTag");
  loadEngineStatus(false).then(function (d) {
    if (!tag) return;
    if (!d) { tag.hidden = true; return; }
    tag.hidden = false;
    tag.className = "nav-tag" + (d.updateAvailable ? " due" : "");
    tag.textContent = d.updateAvailable ? "Update" : "Current";
  });
}
export function engineSheetBody(body, d) {
  if (!d) {
    sheetNote(body, "Couldn't read the engine status. The Engine panel in Settings has the full picture.");
  } else {
    var sdk = d.sdk || {}, cli = d.cli || {};
    factCard(body, "Chat engine · Agent SDK", sdk.behind ? (sdk.behind + " behind") : "Current", [
      { label: "Installed", value: sdk.installed },
      { label: "Latest published", value: sdk.latest, changed: !!(sdk.latest && sdk.installed && sdk.latest !== sdk.installed) },
      { label: "Bundled CLI", value: sdk.bundledCli }
    ], sdk.behind ? "pending" : "ready");
    factCard(body, "Terminal CLI · claude", cli.behind ? (cli.behind + " behind") : "Current", [
      { label: "Installed", value: cli.installed },
      { label: "Latest published", value: cli.latest, changed: !!(cli.latest && cli.installed && cli.latest !== cli.installed) },
      { label: "Stable channel", value: cli.stable }
    ], cli.behind ? "pending" : "ready");
    sheetNote(body, "These are two separate installs: updating one does nothing to the other. Nothing here changes either — staging and applying live in Settings.");
  }
  var row = sheetActions(body);
  // One tap for the whole walk. It only appears when there is something to take,
  // and it refuses while a turn is running: the install deletes node_modules and
  // every turn spawns its CLI from in there. The server arms a rollback that
  // outlives the restart, so the worst case is "came back on the old version".
  var behind = d && ((d.sdk && d.sdk.behind) || (d.cli && d.cli.behind));
  if (behind) {
    sheetButton(row, "Update and restart", "primary", function (b) {
      b.disabled = true; b.textContent = "Updating…";
      var target = (d.sdk && d.sdk.behind) ? ((d.cli && d.cli.behind) ? "both" : "sdk") : "cli";
      reqJSON("/api/engine/ship", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: target }),
      })
        .then(function (r) {
          if (r && r.restarting) {
            b.textContent = "Restarting…";
            sheetNote(body, "Staged, verified and installed. The server is restarting; this page will reconnect on its own. If it does not come back the previous version is restored automatically.");
            // The restart drops every stream, so nudge a reload once the port answers.
            waitForServer();
          } else if (r && r.job && r.job.upToDate) {
            // Finished successfully with nothing to install — say so, rather than
            // reporting a no-op as a failure the way this used to.
            b.textContent = "Already up to date";
            sheetNote(body, r.job.note || "The live server is already on this version.");
          } else {
            b.disabled = false; b.textContent = "Update and restart";
            sheetNote(body, (r && (r.error || (r.job && r.job.note))) || "The update did not run.");
          }
        })
        .catch(function (e) {
          b.disabled = false; b.textContent = "Update and restart";
          sheetNote(body, (e && e.message) || "The update could not be started.");
        });
    });
  }
  sheetButton(row, "Open Settings › Engine", "", function () {
    window.location.href = "/settings.html#engine";
  });
  sheetButton(row, "Re-check", "", function (b) {
    b.disabled = true; b.textContent = "Checking…";
    loadEngineStatus(true).then(function (fresh) {
      if (sheetOpenName !== "engine") return;
      openSheet("engine", "Engine", function (nb) { engineSheetBody(nb, fresh); });
      refreshEngineTag();
    });
  });
}
/* ---------- Deploy (owner): pull the live clone, then (separately) restart ----------
   This box runs the code twice: this checkout is the DEV copy, and a second clone
   is what PM2 actually serves. POST /api/deploy/pull fast-forwards that clone and
   nothing else — it never restarts, because the request asking for the deploy is
   streaming through the very process a restart would kill. So the restart stays a
   second, deliberate tap, and only appears once the pull has actually moved. */
export let deployStatusCache = null;
export function loadDeployStatus() {
  return reqJSON("/api/deploy/status")
    .then(function (d) { deployStatusCache = d; return d; })
    .catch(function () { return null; });
}
export function refreshDeployTag() {
  var tag = $("deployTag");
  loadDeployStatus().then(function (d) {
    if (!tag) return;
    if (!d) { tag.hidden = true; return; }
    tag.hidden = false;
    tag.className = "nav-tag" + (d.inSync ? "" : " due");
    tag.textContent = d.inSync ? "In sync" : "Behind";
  });
}
/* ---------- Operations badge ----------
   /api/ops/status existed with no caller at all: it reports what the runner is
   doing and — added for this — how many finished tasks are waiting on a human.
   That last number is the one worth a badge, because a task in `needs_approval`
   has stopped doing anything, so nothing else on screen would ever mention it.

   Demand-driven, never polled: once when the profile loads, and again whenever the
   drawer opens. The board's own 2.5s poll was just replaced with SSE; putting a
   timer back into the chat page to watch the same data would be daft. */
export function refreshOpsTag() {
  var tag = $("opsTag");
  if (!tag) return;
  reqJSON("/api/ops/status").then(function (d) {
    var waiting = (d && d.needsApproval) || 0;
    if (waiting) {
      tag.hidden = false;
      tag.className = "nav-tag due";      // amber: this one is waiting on YOU
      tag.textContent = waiting + " to review";
      return;
    }
    if (d && d.busy) {
      var n = (d.running || []).length;
      tag.hidden = false;
      tag.className = "nav-tag on";
      tag.textContent = n ? (n + " running") : (d.queued + " queued");
      return;
    }
    tag.hidden = true;   // idle boards say nothing at all
  }).catch(function () { if (tag) tag.hidden = true; });
}

export function shortSha(x) { return x ? String(x).slice(0, 7) : null; }
export function deploySheetBody(body, d) {
  if (!d) {
    sheetNote(body, "Couldn't read the deploy status — this server may not have the route yet.");
    return;
  }
  var live = d.live || {}, dev = d.dev || {};
  factCard(body, "Live server", d.inSync ? "Deployed" : "Behind", [
    { label: "Branch", value: live.branch },
    { label: "On commit", value: live.short || shortSha(live.head), changed: !d.inSync },
    { label: "Its upstream", value: shortSha(live.upstream) },
    { label: "Path", value: live.path }
  ], d.inSync ? "ready" : "pending");
  // The DEV copy, as the server resolved it — not "this checkout": the server
  // runs FROM the live clone, and a tree is always in sync with itself.
  factCard(body, "Dev copy", null, [
    { label: "Branch", value: dev.branch },
    { label: "On commit", value: dev.short || shortSha(dev.head) },
    { label: "Path", value: dev.path }
  ]);
  if (d.inSync) {
    sheetNote(body, "The live server is on the same commit as the dev copy — nothing to deploy. Commit and push in dev first, then come back.");
  } else {
    sheetNote(body, "Pull fast-forwards the live clone from GitHub, and runs npm ci there only if the lockfile moved and no turn is running. It never commits, never pushes and never restarts anything. A dev commit that hasn't been pushed yet can't be pulled.");
  }

  var step2 = document.createElement("div");
  step2.className = "sheet-step";
  step2.textContent = "Step 2 · Restart — only needed for a server change, and only after the pull has landed.";
  var row = sheetActions(body);
  var pull = sheetButton(row, "Pull into the live clone", "primary", function (b) {
    b.disabled = true; b.textContent = "Pulling…";
    reqJSON("/api/deploy/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(function (r) {
        b.textContent = r.moved ? ("Pulled " + shortSha(r.from) + " → " + shortSha(r.to)) : "Nothing to pull";
        if (r.moved) toast("Live clone updated");
        else if (!d.inSync) toast("Nothing new on GitHub yet — push from the dev copy first, then pull again.", true);
        else toast("The live clone was already up to date");
        refreshDeployTag();
        // The server withholds restartRequired whenever the live clone's
        // node_modules is not known-complete (npm ci failed, or was skipped
        // because a turn was running) — a restart into that state can fail to
        // boot and take the remote lifeline with it. Say so, loudly, in the
        // step-2 slot, and offer NO restart button.
        if (r.warning) {
          step2.className = "sheet-step live";
          step2.innerHTML = "";
          var wb = document.createElement("b"); wb.textContent = "Do not restart yet. ";
          step2.appendChild(wb);
          step2.appendChild(document.createTextNode(r.warning));
          toast(r.warning, true);
          return;
        }
        if (!r.restartRequired) {
          step2.textContent = "No restart needed — frontend changes are live on a reload.";
          return;
        }
        // The pull really moved: NOW offer the restart, as its own visibly
        // separate step with its own tap.
        step2.className = "sheet-step live";
        step2.innerHTML = "";
        var t = document.createElement("b"); t.textContent = "Step 2 · Restart required. ";
        step2.appendChild(t);
        step2.appendChild(document.createTextNode("Server code changed — the running process is still on the old build."));
        var r2 = sheetActions(step2);
        sheetButton(r2, "Restart the server", "warn", function () {
          var rs = $("restartServerNav");
          // Reuse the existing restart flow verbatim (confirm → POST → poll
          // /api/health → reload). One restart path, one place to get it right.
          if (rs) { closeSheet(); rs.click(); }
          else toast("This account can't restart the server", true);
        });
      })
      .catch(function (e) {
        b.disabled = false; b.textContent = "Pull into the live clone";
        toast((e && e.message) || "Pull failed", true);
      });
  });
  if (d.inSync) pull.disabled = true;
  sheetButton(row, "Re-check", "", function (b) {
    b.disabled = true; b.textContent = "Checking…";
    loadDeployStatus().then(function (fresh) {
      if (sheetOpenName !== "deploy") return;
      openSheet("deploy", "Deploy", function (nb) { deploySheetBody(nb, fresh); });
    });
  });
  body.appendChild(step2);
}

export function initEngineAndDeploy() {
  // Refresh the ops badge every time the drawer is opened — see refreshOpsTag.
  document.addEventListener("plumi:drawer-open", function () {
    var tag = $("opsTag");
    if (tag && !$("opsNav")?.hidden) refreshOpsTag();
  });
  (function setupEngineNav() {
    var nav = $("engineNav");
    if (!nav) return;
    nav.addEventListener("click", function () {
      closeDrawer();
      openSheet("engine", "Engine", function (body) {
        if (engineStatusCache) { engineSheetBody(body, engineStatusCache); return; }
        sheetNote(body, "Reading versions…");
        loadEngineStatus(false).then(function (d) {
          if (sheetOpenName !== "engine") return;
          openSheet("engine", "Engine", function (nb) { engineSheetBody(nb, d); });
        });
      });
    });
  })();

  (function setupDeployNav() {
    var nav = $("deployNav");
    if (!nav) return;
    nav.addEventListener("click", function () {
      closeDrawer();
      openSheet("deploy", "Deploy", function (body) {
        sheetNote(body, "Comparing the live server with this checkout…");
        loadDeployStatus().then(function (d) {
          if (sheetOpenName !== "deploy") return;
          openSheet("deploy", "Deploy", function (nb) { deploySheetBody(nb, d); });
        });
      });
    });
  })();
}


// After a one-tap engine update the server is replaced underneath us. Poll until
// the port answers again, then reload so the page is running the new build. Any
// status counts as alive — a 401 still proves Express is serving.
export function waitForServer() {
  var tries = 0;
  var tick = function () {
    tries++;
    fetch("/api/health", { cache: "no-store" })
      .then(function () { window.location.reload(); })
      .catch(function () { if (tries < 60) setTimeout(tick, 2000); });
  };
  setTimeout(tick, 6000);
}
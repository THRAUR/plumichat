import { reqJSON } from '../api.js';
import { $, toast } from '../dom.js';
import { openSheet, sheetActions, sheetButton, sheetNote, sheetOpenName, sheetSection } from '../sheet.js';
import { closeDrawer } from '../library.js';
import { projName } from '../state.js';

/* ---------- Plugins & MCP (audit F6) ----------
   Owner-only. Two things the engine loads that PlumiChat could not see or change:
   the MCP servers a turn can call, and the Claude Code plugins installed on the
   box. Both are read through /api/mcp and /api/plugins; the install path names
   where the code comes from and takes a second, deliberate tap, because a plugin
   install runs a marketplace-declared command on this machine. */

export let pluginsNav = $("pluginsNav");

let mcp = null;          // { servers: [...], at }
let cat = null;          // { installed: [...], available: [...] }
let filter = "";
let busy = "";           // a plugin id being installed/removed, or "mcp"/"cat"
let confirming = null;   // the plugin awaiting its second tap
let showAll = false;

const SHORTLIST = 12;    // available plugins shown before you search or expand

function repaint() {
  if (sheetOpenName === "plugins") openSheet("plugins", "Plugins & MCP", build);
}

// --- Loading ----------------------------------------------------------------

function loadMcp(refresh) {
  const project = projName();
  if (!project || busy === "mcp") return;
  busy = "mcp"; repaint();
  reqJSON(`/api/mcp?project=${encodeURIComponent(project)}`)
    .then((d) => { mcp = d; })
    .catch((e) => toast(e.message || "Could not read the MCP servers", true))
    .then(() => { busy = ""; repaint(); });
}

function loadCatalogue(refresh) {
  if (busy === "cat") return;
  busy = "cat"; repaint();
  reqJSON("/api/plugins" + (refresh ? "?refresh=1" : ""))
    .then((d) => { cat = d; })
    .catch((e) => toast(e.message || "Could not read the plugin catalogue", true))
    .then(() => { busy = ""; repaint(); });
}

export function openPluginsSheet() {
  confirming = null; filter = ""; showAll = false;
  openSheet("plugins", "Plugins & MCP", build);
  if (!mcp) loadMcp();
  if (!cat) loadCatalogue();
}

// --- Rendering --------------------------------------------------------------

const STATUS_LABEL = {
  connected: "Connected", failed: "Failed", "needs-auth": "Needs sign-in",
  pending: "Connecting…", disabled: "Disabled",
};
// Only 'connected' is good news; 'needs-auth' is actionable but not an error, so
// it gets its own tone rather than being painted red or green.
const STATUS_TONE = {
  connected: "ok", failed: "bad", "needs-auth": "warn", pending: "", disabled: "",
};

function build(box) {
  sheetSection(box, "MCP servers");
  if (!mcp && busy === "mcp") {
    sheetNote(box, "Asking the engine… servers connect in the background, so this takes a few seconds.");
  } else if (!mcp) {
    sheetNote(box, "Not read yet.");
  } else if (!mcp.servers.length) {
    sheetNote(box, "No MCP servers are configured for this project.");
  } else {
    const list = document.createElement("div");
    list.className = "pl-list";
    mcp.servers.forEach((s) => {
      const row = document.createElement("div");
      row.className = "pl-row";
      row.dataset.tone = STATUS_TONE[s.status] || "";
      const nm = document.createElement("div");
      nm.className = "pl-nm";
      nm.textContent = s.name;
      const tag = document.createElement("span");
      tag.className = "pl-tag";
      tag.textContent = STATUS_LABEL[s.status] || s.status;
      nm.appendChild(tag);
      const sub = document.createElement("div");
      sub.className = "pl-sub";
      // What it is and what it can do — the two facts that make a server row worth
      // reading. The error replaces both when there is one, because then nothing
      // else about the row matters.
      sub.textContent = s.error
        ? s.error
        : [s.scope, s.transport, s.tools.length ? `${s.tools.length} tools` : null]
          .filter(Boolean).join(" · ");
      row.appendChild(nm); row.appendChild(sub);
      if (s.url && !s.error) {
        const u = document.createElement("div");
        u.className = "pl-url";
        u.textContent = s.url;
        row.appendChild(u);
      }
      list.appendChild(row);
    });
    box.appendChild(list);
  }
  const mrow = sheetActions(box);
  sheetButton(mrow, busy === "mcp" ? "Reading…" : "Refresh servers", "", () => loadMcp(true));
  sheetButton(mrow, "Reload engine", "", reloadEngine);
  sheetNote(box, "A server that needs sign-in has to be authorised where it was added — " +
    "claude.ai connectors in your claude.ai settings, others with `claude mcp`. Reload engine " +
    "picks up whatever changed on disk.");

  // --- Plugins
  const installed = (cat && cat.installed) || [];
  sheetSection(box, `Installed plugins${installed.length ? ` (${installed.length})` : ""}`);
  if (!cat && busy === "cat") sheetNote(box, "Reading the catalogue…");
  else if (!installed.length) sheetNote(box, "None installed. The engine's built-in skills and agents are unaffected.");
  else {
    const list = document.createElement("div");
    list.className = "pl-list";
    installed.forEach((p) => list.appendChild(pluginRow(p, true)));
    box.appendChild(list);
  }

  const available = (cat && cat.available) || [];
  sheetSection(box, `Available${available.length ? ` (${available.length})` : ""}`);
  if (available.length) {
    const search = document.createElement("input");
    search.className = "pl-search";
    search.type = "search";
    search.placeholder = "Search plugins";
    search.value = filter;
    search.addEventListener("input", () => {
      filter = search.value;
      // Rebuild in place rather than through repaint(): reopening the sheet would
      // blur the field and drop the keyboard on every keystroke.
      renderAvailable();
    });
    box.appendChild(search);
    const holder = document.createElement("div");
    holder.className = "pl-avail";
    box.appendChild(holder);
    const renderAvailable = () => {
      const qq = filter.trim().toLowerCase();
      const m = qq ? available.filter((p) => (p.name + " " + p.description).toLowerCase().includes(qq)) : available;
      const list = (qq || showAll) ? m.slice(0, 60) : m.slice(0, SHORTLIST);
      holder.innerHTML = "";
      if (!list.length) { holder.appendChild(note("Nothing matches that.")); return; }
      const wrap = document.createElement("div");
      wrap.className = "pl-list";
      list.forEach((p) => wrap.appendChild(pluginRow(p, false)));
      holder.appendChild(wrap);
      if (!qq && !showAll && m.length > list.length) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "pl-more";
        more.textContent = `Show all ${m.length}`;
        more.addEventListener("click", () => { showAll = true; renderAvailable(); });
        holder.appendChild(more);
      }
    };
    renderAvailable();
  } else if (cat) {
    sheetNote(box, "No marketplace is configured, so there is nothing to offer.");
  }

  const prow = sheetActions(box);
  sheetButton(prow, busy === "cat" ? "Reading…" : "Refresh catalogue", "", () => loadCatalogue(true));
  sheetNote(box, "Installing a plugin runs a command its marketplace declares, on this machine, " +
    "as you. Each install names its origin and asks twice.");
}

function note(text) {
  const p = document.createElement("div");
  p.className = "sheet-note";
  p.textContent = text;
  return p;
}

function pluginRow(p, isInstalled) {
  const row = document.createElement("div");
  row.className = "pl-row";
  const nm = document.createElement("div");
  nm.className = "pl-nm";
  nm.textContent = p.name;
  if (p.version) {
    const v = document.createElement("span");
    v.className = "pl-tag";
    v.textContent = "v" + p.version;
    nm.appendChild(v);
  } else if (!isInstalled && p.installs) {
    const v = document.createElement("span");
    v.className = "pl-tag";
    v.textContent = p.installs.toLocaleString() + " installs";
    nm.appendChild(v);
  }
  row.appendChild(nm);
  if (p.description) {
    const d = document.createElement("div");
    d.className = "pl-sub";
    d.textContent = p.description;
    row.appendChild(d);
  }

  const acts = document.createElement("div");
  acts.className = "pl-acts";
  if (isInstalled) {
    acts.appendChild(mini("Remove", "danger", () => mutate("/api/plugins/uninstall", p, "Removed")));
  } else if (confirming === p.id) {
    const warn = document.createElement("div");
    warn.className = "pl-warn";
    warn.textContent = p.origin
      ? `Installs from ${p.origin} and runs its declared install command here.`
      : `Installs from the ${p.marketplace} marketplace and runs its declared install command here.`;
    row.appendChild(warn);
    acts.appendChild(mini(busy === p.id ? "Installing…" : "Install", "go",
      () => mutate("/api/plugins/install", p, "Installed")));
    acts.appendChild(mini("Cancel", "", () => { confirming = null; repaint(); }));
  } else {
    acts.appendChild(mini("Install", "", () => { confirming = p.id; repaint(); }));
  }
  row.appendChild(acts);
  return row;
}

function mini(label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pl-btn" + (cls ? " " + cls : "");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function mutate(url, p, done) {
  if (busy) return;
  busy = p.id; repaint();
  reqJSON(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: p.id }),
  })
    .then(() => {
      confirming = null;
      toast(`${done}: ${p.name}. It applies to your next turn.`);
      cat = null;
      loadCatalogue(true);
    })
    .catch((e) => toast(e.message || "That did not work", true))
    .then(() => { busy = ""; repaint(); });
}

function reloadEngine() {
  const project = projName();
  if (!project) return;
  toast("Reloading…");
  reqJSON("/api/mcp/reload", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project }),
  })
    .then((d) => {
      toast(`Engine reloaded — ${d.commands} commands, ${d.agents} agents, ` +
        `${d.plugins.length} plugins, ${d.mcpServers} MCP servers` +
        (d.errors ? ` (${d.errors} errors)` : ""));
      mcp = null; loadMcp();
    })
    .catch((e) => toast(e.message || "Reload failed", true));
}

export function initPlugins() {
  if (!pluginsNav) return;
  pluginsNav.addEventListener("click", () => {
    closeDrawer();
    openPluginsSheet();
  });
}

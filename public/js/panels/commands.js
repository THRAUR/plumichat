import { autoGrow } from '../composer.js';
import { $, input } from '../dom.js';
import { GENERIC_SKILL_ICON } from '../icons.js';
import { skillBlurb, skillIconFor, skillLabel, skillList } from './skills.js';

/* ---------- Slash commands: the type-ahead + the full palette (audit F2) ----------
   The old picker listed the 12 skills in ~/.claude/skills and nothing else, while
   the CLI actually exposes ~74 commands and expands "/id args" NATIVELY from the
   prompt (verified on this install). Two surfaces now share ONE command list:

     · the inline type-ahead below (fast on a keyboard, unchanged in feel), and
     · .cmd-palette — searchable, grouped, big tap targets — opened by the /
       button in the composer, by Cmd/Ctrl-K, or from the type-ahead's last row.

   Sources, in priority order: GET /api/commands if a later server ever publishes
   one (we ask and shrug at a 404 — this ships before the restart that would
   activate it), otherwise GET /api/skills plus the bundled command set below.
   Either way we send "/cmd args" straight through: for an installed skill the
   server rewrites it into a "use this skill" instruction, and for a bundled one
   the CLI's own slash expansion picks it up. */
export let slashMenu = $("slashMenu");
export let slashOpen = false, slashItems = [], slashIdx = -1;

// Verified against a real engine probe: the
// skills the CLI bundles, minus the terminal-only ones (doctor, color), which
// cannot do anything through the SDK. Superseded the moment /api/commands exists.
export let BUILTIN_COMMANDS = [
  { id: "deep-research", name: "Deep research", description: "Research a question across many sources", args: "<question>" },
  { id: "code-review", name: "Code review", description: "Review the current diff, a PR or a branch", args: "[low|high|max]" },
  { id: "simplify", name: "Simplify", description: "Clean up the changed code — reuse, clarity, efficiency", args: "" },
  { id: "verify", name: "Verify", description: "Check that a change actually works", args: "<what to check>" },
  { id: "debug", name: "Debug", description: "Track down why something is failing", args: "<the symptom>" },
  { id: "run", name: "Run it", description: "Launch this project and see the change working", args: "" },
  { id: "batch", name: "Batch", description: "Apply the same change across many files", args: "<the change>" },
  { id: "dataviz", name: "Data viz", description: "Build a chart, dashboard or visualisation", args: "<what to plot>" },
  { id: "design-sync", name: "Design sync", description: "Pull a design system in from Claude Design", args: "" },
  { id: "schedule", name: "Schedule", description: "Run something on a cron schedule", args: "<what, when>" },
  { id: "loop", name: "Loop", description: "Repeat a prompt on an interval", args: "<interval> <prompt>" },
  { id: "claude-api", name: "Claude API", description: "Reference for models, pricing, tools and caching", args: "<question>" },
  { id: "update-config", name: "Update config", description: "Change settings.json — hooks, permissions, env", args: "<the change>" },
  { id: "fewer-permission-prompts", name: "Fewer prompts", description: "Build an allowlist from your own transcripts", args: "" },
  { id: "workflow-authoring", name: "Workflow authoring", description: "Reference for writing a workflow script", args: "" },
  { id: "security-review", name: "Security review", description: "Security review of the pending changes", args: "" }
];
// The merged list. Rebuilt whenever /api/skills lands, so a newly installed skill
// appears with no client change.
export let commandList = [];
export let commandIds = {};
export function rebuildCommands(extra) {
  var out = [], seen = {};
  (extra || []).forEach(function (c) {
    if (!c || !c.id || seen[c.id]) return;
    seen[c.id] = true; out.push(c);
  });
  // Anything from the bundled/skill fallbacks below runs in the chat engine.
  var asChat = function (c) { return c.where ? c : Object.assign({ where: "chat" }, c); };
  skillList.forEach(function (s) {
    if (seen[s.id]) return;
    seen[s.id] = true;
    out.push(asChat({ id: s.id, name: skillLabel(s), description: skillBlurb(s), args: "<what to make>", group: "skill" }));
  });
  BUILTIN_COMMANDS.forEach(function (c) {
    if (seen[c.id]) return;
    seen[c.id] = true;
    out.push(asChat({ id: c.id, name: c.name, description: c.description, args: c.args, group: "builtin" }));
  });
  /* Cluster by group before rendering. renderCmdList emits a heading whenever the
     group changes, and the rows arrive sorted by NAME — so a mixed list produced
     "Terminal only / Built in / Terminal only / Built in…" forty times over. Rank
     the groups, keep names alphabetical inside each, and there are exactly three
     headings. Built in first because it is what most people came for; Terminal
     only last because those cannot run in the chat engine at all. */
  var rank = { builtin: 0, skill: 1, terminal: 2 };
  out.sort(function (a, b) {
    var ra = rank[a.where === "terminal" ? "terminal" : (a.group || "builtin")] || 0;
    var rb = rank[b.where === "terminal" ? "terminal" : (b.group || "builtin")] || 0;
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
  commandList = out;
  commandIds = seen;
  if (slashOpen) openSlash(slashQuery() || "");
  if (cmdPaletteOpen) renderCmdList();
  syncCmdWarn();
}
export function cmdIconFor(c) {
  return c.group === "skill" ? skillIconFor({ id: c.id }) : GENERIC_SKILL_ICON;
}
export function cmdMatch(q) {
  if (!q) return commandList.slice();
  q = q.toLowerCase();
  var starts = [], has = [];
  commandList.forEach(function (c) {
    var id = c.id.toLowerCase(), nm = String(c.name || "").toLowerCase(), d = String(c.description || "").toLowerCase();
    if (id.indexOf(q) === 0) starts.push(c);
    else if (id.indexOf(q) >= 0 || nm.indexOf(q) >= 0 || d.indexOf(q) >= 0) has.push(c);
  });
  return starts.concat(has);
}
// Drop "/<id> " into the composer and let the user add the arguments. We never
// auto-send: a command with no arguments is usually not what was meant.
export function useCommand(c) {
  if (!c) return;
  closeSlash(); closeCmdPalette();
  // A terminal-only command cannot run in the chat engine — the SDK answers
  // "/btw isn't available in this environment" — so putting it in the composer
  // would just produce that message. Hand it to the Terminal instead, which runs
  // the real interactive CLI. panels/terminal.js listens; an event rather than an
  // import, because that module already imports this one's neighbours.
  if (c.where === "terminal") {
    document.dispatchEvent(new CustomEvent("plumi:terminal-command", { detail: { cmd: "/" + c.id } }));
    return;
  }
  input.value = "/" + c.id + " ";
  autoGrow(); input.focus();
  try { var n = input.value.length; input.setSelectionRange(n, n); } catch (e) {}
}

/* --- the inline type-ahead (a bare "/token", no space yet) --- */
export function slashQuery() {
  var m = input.value.match(/^\/([a-z0-9:_-]*)$/i);
  return m ? m[1].toLowerCase() : null;
}
export function renderSlashMenu() {
  slashMenu.innerHTML = "";
  slashItems.forEach(function (c, i) {
    var b = document.createElement("button");
    b.className = "slash-item" + (i === slashIdx ? " on" : "");
    b.type = "button"; b.setAttribute("role", "option");
    b.setAttribute("aria-selected", i === slashIdx ? "true" : "false");
    b.innerHTML = '<span class="sl-ic">' + cmdIconFor(c) + '</span>' +
      '<span class="sl-text"><b></b><span class="sl-desc"></span></span>';
    b.querySelector("b").textContent = "/" + c.id + (c.args ? " " + c.args : "");
    b.querySelector(".sl-desc").textContent = c.description || "";
    // mousedown (not click) so the tap fires before the field can blur/close.
    b.addEventListener("mousedown", function (e) { e.preventDefault(); chooseSlash(i); });
    slashMenu.appendChild(b);
  });
  // The escape hatch to the full, searchable, grouped list — the type-ahead only
  // shows the top handful, and on a phone this is the tappable way to browse.
  var all = document.createElement("button");
  all.className = "slash-item"; all.type = "button";
  all.innerHTML = '<span class="sl-ic">' + GENERIC_SKILL_ICON + '</span>' +
    '<span class="sl-text"><b></b><span class="sl-desc"></span></span>';
  all.querySelector("b").textContent = "See all commands";
  all.querySelector(".sl-desc").textContent = commandList.length + " available · search them";
  all.addEventListener("mousedown", function (e) { e.preventDefault(); openCmdPalette(slashQuery() || ""); });
  slashMenu.appendChild(all);
}
export function openSlash(q) {
  slashItems = cmdMatch(q).slice(0, 8);
  if (slashIdx < 0 || slashIdx >= slashItems.length) slashIdx = 0;
  renderSlashMenu();
  slashMenu.hidden = false; slashMenu.classList.add("open"); slashOpen = true;
}
export function closeSlash() {
  if (!slashOpen && slashMenu.hidden) return;
  slashOpen = false; slashIdx = -1;
  slashMenu.classList.remove("open"); slashMenu.hidden = true;
}
export function chooseSlash(i) { useCommand(slashItems[i]); }
export function syncSlash() {
  var q = slashQuery();
  if (q === null) { closeSlash(); return; }
  slashIdx = 0; openSlash(q);
}
/* --- the full palette --- */
export let cmdPalette = $("cmdPalette"), cmdOverlay = $("cmdOverlay"),
    cmdInput = $("cmdInput"), cmdListEl = $("cmdList"), cmdBtn = $("cmdBtn");
export let cmdPaletteOpen = false, cmdRows = [], cmdIdx = 0;
export function renderCmdList() {
  if (!cmdListEl) return;
  var q = cmdInput ? cmdInput.value.replace(/^\//, "").trim() : "";
  cmdRows = cmdMatch(q);
  cmdListEl.innerHTML = "";
  if (!cmdRows.length) {
    var none = document.createElement("div"); none.className = "cmd-empty";
    none.textContent = q ? ("Nothing matches “" + q + "”") : "No commands available.";
    cmdListEl.appendChild(none);
    return;
  }
  if (cmdIdx >= cmdRows.length) cmdIdx = 0;
  var lastGroup = null;
  cmdRows.forEach(function (c, i) {
    var g = c.where === "terminal" ? "Terminal only"
      : (c.group === "builtin" ? "Built in" : "Skills");
    if (g !== lastGroup) {
      lastGroup = g;
      var h = document.createElement("div"); h.className = "cmd-group"; h.textContent = g;
      cmdListEl.appendChild(h);
    }
    var b = document.createElement("button");
    b.type = "button"; b.className = "cmd-row" + (i === cmdIdx ? " on" : "");
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", i === cmdIdx ? "true" : "false");
    var nm = document.createElement("span"); nm.className = "cmd-row-name";
    var bb = document.createElement("b"); bb.textContent = "/" + c.id; nm.appendChild(bb);
    // The argument hint rides with the name, so a narrow phone ellipsises the
    // description instead of the thing that says what to type next.
    if (c.args) { var ar = document.createElement("i"); ar.textContent = " " + c.args; nm.appendChild(ar); }
    var ds = document.createElement("span"); ds.className = "cmd-row-desc"; ds.textContent = c.description || "";
    b.appendChild(nm); b.appendChild(ds);
    b.addEventListener("click", function () { useCommand(c); });
    cmdListEl.appendChild(b);
  });
}
export function openCmdPalette(seed) {
  if (!cmdPalette) return;
  closeSlash();
  cmdPaletteOpen = true; cmdIdx = 0;
  cmdPalette.hidden = false; cmdOverlay.hidden = false;
  // One frame between "in the DOM" and "open", or the transition never runs.
  requestAnimationFrame(function () {
    cmdPalette.classList.add("open"); cmdOverlay.classList.add("open");
  });
  if (cmdInput) { cmdInput.value = seed || ""; }
  renderCmdList();
  setTimeout(function () { try { cmdInput.focus(); } catch (e) {} }, 40);
}
export function closeCmdPalette() {
  if (!cmdPalette || !cmdPaletteOpen) return;
  cmdPaletteOpen = false;
  cmdPalette.classList.remove("open"); cmdOverlay.classList.remove("open");
  setTimeout(function () {
    if (cmdPaletteOpen) return;
    cmdPalette.hidden = true; cmdOverlay.hidden = true;
  }, 160);
}
/* --- "/hello" is not a command --- */
// An unknown single "/word" costs a wasted turn: the CLI answers "Unknown
// command: /hello" with zero output and the user is left wondering. Say so in
// the composer, before the tap.
export let cmdWarn = $("cmdWarn");
export function syncCmdWarn() {
  if (!cmdWarn) return;
  var m = input.value.match(/^\/([a-z0-9:_-]+)(?:\s|$)/i);
  var tok = m ? m[1].toLowerCase() : "";
  // Only warn once the list has actually loaded — before that everything would
  // look unknown. A path like "/home/you/…" is ordinary text and never a command.
  if (!tok || !commandList.length || commandIds[tok] || input.value.indexOf("/", 1) > 0) {
    cmdWarn.hidden = true; return;
  }
  cmdWarn.innerHTML = "";
  var b = document.createElement("b"); b.textContent = "/" + tok;
  cmdWarn.appendChild(b);
  cmdWarn.appendChild(document.createTextNode(" isn't a command — it will come back as “Unknown command”. Tap / to browse, or drop the slash."));
  cmdWarn.hidden = false;
}

export function initCommands() {
  input.addEventListener("input", syncSlash);
  // Registered before the composer's own Enter-to-send handler, so while the menu
  // is open the arrows/Enter/Tab/Esc drive the menu and never submit the message.
  input.addEventListener("keydown", function (e) {
    if (!slashOpen || !slashItems.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopImmediatePropagation(); slashIdx = (slashIdx + 1) % slashItems.length; renderSlashMenu(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopImmediatePropagation(); slashIdx = (slashIdx - 1 + slashItems.length) % slashItems.length; renderSlashMenu(); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopImmediatePropagation(); chooseSlash(slashIdx); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeSlash(); }
  });

  if (cmdBtn) cmdBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    cmdPaletteOpen ? closeCmdPalette() : openCmdPalette("");
  });
  if (cmdOverlay) cmdOverlay.addEventListener("click", closeCmdPalette);
  if (cmdInput) {
    cmdInput.addEventListener("input", function () { cmdIdx = 0; renderCmdList(); });
    cmdInput.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); cmdIdx = (cmdIdx + 1) % Math.max(1, cmdRows.length); renderCmdList(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); cmdIdx = (cmdIdx - 1 + cmdRows.length) % Math.max(1, cmdRows.length); renderCmdList(); }
      else if (e.key === "Enter") { e.preventDefault(); useCommand(cmdRows[cmdIdx]); }
      else if (e.key === "Escape") { e.preventDefault(); closeCmdPalette(); input.focus(); }
    });
  }
  // Cmd/Ctrl-K, for the desktop half of "feels like the terminal".
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      cmdPaletteOpen ? closeCmdPalette() : openCmdPalette("");
    }
  });

  input.addEventListener("input", syncCmdWarn);
  rebuildCommands();   // seed from the static skill list; the fetches refine it
}

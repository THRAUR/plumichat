import { apiFetch } from '../api.js';
import { rebuildCommands } from './commands.js';
import { autoGrow } from '../composer.js';
import { closeFiles } from './deliverables.js';
import { $, input } from '../dom.js';
import { GENERIC_SKILL_ICON } from '../icons.js';
import { closeModel } from '../models.js';
import { closeMenu } from '../projects.js';

// The document things PlumiChat can build, shown in the composer "what PlumiChat can
// make" sheet. Which IDs are live comes from the server (/api/skills, single
// source of truth in claude.js); this map only supplies the human-facing label,
// icon and a starter prompt that's dropped into the input when tapped.
export let SKILL_META = {
  pptx: { label: "Slides",      blurb: "Pitch decks & presentations",  starter: "Create a slide deck about " },
  docx: { label: "Word document", blurb: "Letters, reports, memos",    starter: "Write a Word document: " },
  xlsx: { label: "Spreadsheet", blurb: "Tables, budgets, formulas",    starter: "Build a spreadsheet that " },
  pdf:  { label: "PDF",         blurb: "Polished, print-ready files",   starter: "Create a PDF that " }
};
export let SKILL_ICON = {
  pptx: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.6"></rect><line x1="12" y1="16" x2="12" y2="20"></line><line x1="8" y1="20" x2="16" y2="20"></line></svg>',
  docx: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"></path><polyline points="14 3 14 7 18 7"></polyline><line x1="8.5" y1="12.5" x2="15" y2="12.5"></line><line x1="8.5" y1="16" x2="15" y2="16"></line></svg>',
  xlsx: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.6"></rect><line x1="3" y1="9.5" x2="21" y2="9.5"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9.5" y1="4" x2="9.5" y2="20"></line><line x1="15" y1="4" x2="15" y2="20"></line></svg>',
  pdf:  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"></path><polyline points="14 3 14 7 18 7"></polyline><path d="M9 19.5v-6h1.6a1.4 1.4 0 0 1 0 2.8H9"></path></svg>'
};
// Every skill installed on the box: [{ id, name, description }], filled live from
// /api/skills (which reads ~/.claude/skills). Seeded with the four document skills
// so the sheet is populated before the fetch returns. SKILL_META only supplies a
// friendlier label / blurb / starter for those four; any other skill renders
// straight from its own frontmatter name + description — nothing is filtered out.
export let skillList = ["pptx", "docx", "xlsx", "pdf"].map(function (id) {
  return { id: id, name: SKILL_META[id].label, description: SKILL_META[id].blurb };
});
export function skillLabel(s) {
  if (SKILL_META[s.id]) return SKILL_META[s.id].label;
  return String(s.name || s.id).replace(/[-_]+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}
export function skillBlurb(s) {
  if (SKILL_META[s.id]) return SKILL_META[s.id].blurb;
  var d = String(s.description || "").trim();
  return d.length > 84 ? d.slice(0, 80).replace(/\s+\S*$/, "") + "…" : d;
}
export function skillIconFor(s) { return SKILL_ICON[s.id] || GENERIC_SKILL_ICON; }
// What drops into the composer when a skill is chosen: a friendly starter for the
// four document skills, otherwise the terminal-style "/id " token (the server
// turns a leading "/id" into a "use this skill" instruction on send).
export function skillStarter(s) { return SKILL_META[s.id] ? SKILL_META[s.id].starter : ("/" + s.id + " "); }
/* ---------- Skills / "what PlumiChat can make" sheet ---------- */
export let skillsPicker = $("skillsPicker"), skillsBtn = $("skillsBtn"), skillsMenu = $("skillsMenu");
export function prefillComposer(text) {
  input.value = text;
  autoGrow();            // resizes + flips the send button on (calls updateSend)
  input.focus();
  try { var n = input.value.length; input.setSelectionRange(n, n); } catch (e) {}
}
export function renderSkillsMenu() {
  skillsMenu.innerHTML = "";
  var head = document.createElement("div"); head.className = "sk-head";
  head.textContent = "What PlumiChat can make"; skillsMenu.appendChild(head);
  skillList.forEach(function (s) {
    var b = document.createElement("button");
    b.className = "skill-item"; b.type = "button"; b.setAttribute("role", "menuitem");
    b.innerHTML = '<span class="sk-ic">' + skillIconFor(s) + '</span>' +
      '<span class="sk-text"><b></b><span class="sk-desc"></span></span>';
    b.querySelector("b").textContent = skillLabel(s);
    b.querySelector(".sk-desc").textContent = skillBlurb(s);
    b.addEventListener("click", function () { prefillComposer(skillStarter(s)); closeSkills(); });
    skillsMenu.appendChild(b);
  });
  var foot = document.createElement("div"); foot.className = "sk-foot";
  foot.textContent = "Tap one, or type / in the box — or just ask in your own words.";
  skillsMenu.appendChild(foot);
}
export function closeSkills() { skillsPicker.classList.remove("open"); skillsBtn.setAttribute("aria-expanded", "false"); }

export function initSkills() {
  skillsBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    var open = skillsPicker.classList.toggle("open");
    skillsBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) { closeMenu(); closeModel(); closeFiles(); renderSkillsMenu(); }
  });
  renderSkillsMenu();
  // Replace the static fallback list with whatever skills are actually enabled
  // server-side, so the sheet never advertises something that isn't on.
  apiFetch("/api/skills", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (d && Array.isArray(d.skills) && d.skills.length) {
        // Server returns rich objects ({id,name,description}); keep every one with an
        // id so a newly installed skill appears without any client change.
        skillList = d.skills.filter(function (s) { return s && s.id; });
        renderSkillsMenu();
      }
      rebuildCommands();   // the "/" type-ahead and the palette share this list
    }).catch(function () { rebuildCommands(); });
  // Optimistic probe for a richer command source. No server publishes this yet —
  // a 404 (or an HTML error page from an older build) simply leaves us on the
  // skills + bundled list above, which is why nothing here reports a failure.
  apiFetch("/api/commands", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json().catch(function () { return null; }) : null; })
    .then(function (d) {
      var list = d && (d.commands || d.slashCommands);
      if (!Array.isArray(list) || !list.length) return;
      rebuildCommands(list.filter(function (c) { return c && c.id; }).map(function (c) {
        return {
          id: c.id, name: c.name || c.id, description: c.description || "",
          args: c.args || c.argumentHint || "",
          // `where` says which engine can run it: 'chat' goes to the composer,
          // 'terminal' opens the Terminal instead (the CLI has ~25 commands the
          // SDK refuses — /btw, /bug, /branch, /resume …).
          where: c.where === "terminal" ? "terminal" : "chat",
          group: c.where === "terminal" ? "terminal"
            : (c.group === "skill" || c.source === "skill" ? "skill" : "builtin")
        };
      }));
    }).catch(function () {});
}

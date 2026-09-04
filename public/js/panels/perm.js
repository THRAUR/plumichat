import { closeFiles } from './deliverables.js';
import { $, pref } from '../dom.js';
import { saveDefaults } from '../defaults.js';
import { closeModel, pickerNote, tickSvg, turnRunning } from '../models.js';
import { closeMenu } from '../projects.js';
import { closeSkills } from './skills.js';

/* ---------- Approval / "restriction" mode ---------- */
// Lets the owner decide how often PlumiChat stops to ask. Owner/admin only — a
// member's turn is always forced to "Ask first" server-side (acceptEdits/bypass
// skip the very check that keeps a member inside their own home), so we don't
// even reveal the control to them. Persisted device-locally like the model pick.
export let permPicker = $("permPicker"), permBtn = $("permBtn"), permMenu = $("permMenu"), permLabel = $("permLabel");
export let PERM_MODES = [
  { id: "default", label: "Ask first", short: "Ask", desc: "PlumiChat checks with you before edits or commands. Safest." },
  { id: "acceptEdits", label: "Auto-accept edits", short: "Edits", desc: "File edits go through automatically; still asks before running commands." },
  { id: "bypassPermissions", label: "Skip all approvals", short: "Bypass", desc: "No prompts at all — PlumiChat works unattended. Use with care.", warn: true }
];
export let permMode = pref("permMode") || "default";
export let permAllowed = false; // flipped on for owner/admin in loadProfile
export function setPermAllowed(v) { permAllowed = v; }
// The whole /api/settings/profile answer, kept so the usage sheet and the
// owner-only drawer rows don't each have to re-fetch it.
export let profileInfo = null;
export function setProfileInfo(v) { profileInfo = v; }
/* The account's approval mode, applied when loadProfile() answers. The server
   clamps a member's to 'default' before it ever gets here — acceptEdits and
   bypass make the SDK skip canUseTool, which IS the member confinement — so this
   can only ever relax the control for someone already allowed to relax it. */
export function applyAccountPerm(mode) {
  if (!mode) return;
  if (!PERM_MODES.some(function (m) { return m.id === mode; })) return;
  permMode = mode; pref("permMode", mode);
  updatePermLabel();
  if (permPicker && permPicker.classList.contains("open")) renderPermMenu();
}

export function permMeta() { var f = PERM_MODES.filter(function (m) { return m.id === permMode; }); return f[0] || PERM_MODES[0]; }
export function updatePermLabel() {
  var m = permMeta();
  if (permLabel) permLabel.textContent = m.short;
  if (permBtn) permBtn.classList.toggle("warn", !!m.warn);
  if (permPicker) permPicker.classList.toggle("armed", permMode !== "default");
}
export function renderPermMenu() {
  if (!permMenu) return;
  permMenu.innerHTML = "";
  var head = document.createElement("div"); head.className = "perm-head"; head.textContent = "When can PlumiChat act on its own?"; permMenu.appendChild(head);
  if (turnRunning()) pickerNote(permMenu, "A turn is running. A change here applies from your next message.");
  PERM_MODES.forEach(function (m) {
    var b = document.createElement("button"); b.type = "button";
    b.className = "perm-item" + (m.warn ? " warn" : "");
    b.setAttribute("role", "option"); b.setAttribute("aria-selected", m.id === permMode ? "true" : "false");
    b.innerHTML = '<span class="pm-text"><b></b><span class="pm-desc"></span></span>' + tickSvg();
    b.querySelector("b").textContent = m.label;
    b.querySelector(".pm-desc").textContent = m.desc;
    b.addEventListener("click", function () {
      permMode = m.id; pref("permMode", permMode); saveDefaults({ permissionMode: permMode });
      updatePermLabel(); renderPermMenu(); closePerm();
    });
    permMenu.appendChild(b);
  });
}
export function closePerm() { if (permPicker) { permPicker.classList.remove("open"); if (permBtn) permBtn.setAttribute("aria-expanded", "false"); } }

export function initPermPicker() {
  if (!PERM_MODES.some(function (m) { return m.id === permMode; })) permMode = "default";
  if (permBtn) permBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    var open = permPicker.classList.toggle("open");
    permBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) { closeMenu(); closeModel(); closeSkills(); closeFiles(); renderPermMenu(); }
  });
  updatePermLabel();
}

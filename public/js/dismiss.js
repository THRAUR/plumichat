import { closeCmdPalette, closeSlash, slashMenu } from './panels/commands.js';
import { closeFiles, filesPicker } from './panels/deliverables.js';
import { input } from './dom.js';
import { closeDrawer } from './library.js';
import { closeModel, modelPicker } from './models.js';
import { closePerm, permPicker } from './panels/perm.js';
import { closeMenu, picker } from './projects.js';
import { closeSheet } from './sheet.js';
import { closeSkills, skillsPicker } from './panels/skills.js';

/* ---------- Global dismiss ---------- */

export function initGlobalDismiss() {
  document.addEventListener("click", function (e) {
    if (!picker.contains(e.target)) closeMenu();
    if (!modelPicker.contains(e.target)) closeModel();
    if (permPicker && !permPicker.contains(e.target)) closePerm();
    if (!skillsPicker.contains(e.target)) closeSkills();
    if (!filesPicker.contains(e.target)) closeFiles();
    if (slashMenu && !slashMenu.contains(e.target) && e.target !== input) closeSlash();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      closeMenu(); closeModel(); closePerm(); closeSkills(); closeFiles(); closeDrawer(); closeSlash();
      closeCmdPalette(); closeSheet();
    }
  });
}

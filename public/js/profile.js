import { apiFetch } from './api.js';
import { applyCapabilityGating } from "./capabilities.js";
import { setupOwnerRows } from './panels/engine.js';
import { userChip } from './library.js';
import { applyAccountPerm, permPicker, setPermAllowed, setProfileInfo, updatePermLabel } from './panels/perm.js';
import { applyAccountDefaults } from './models.js';

// Reflect the signed-in account in the drawer's user chip — avatar (photo or
// initials), name and email — so a profile photo set in Settings appears here
// too, not only in Settings.
export function loadProfile() {
  apiFetch("/api/settings/profile", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (p) {
      if (!p) return;
      setProfileInfo(p);
      // Model / effort / approval belong to the ACCOUNT, not to this browser, so
      // they arrive here rather than out of localStorage. Applied BEFORE the
      // userChip guard for the same reason the owner rows are: a split-view pane
      // has no chip, and it needs your defaults exactly as much as the main
      // window does — that pane is the whole reason these moved off the device.
      if (p.chatDefaults) {
        applyAccountDefaults(p.chatDefaults);
        applyAccountPerm(p.chatDefaults.permissionMode);
      }
      // Owner-only side-menu rows (engine, deploy) and the members' model-override
      // hint both need to know who this is — do it before the userChip guard, so
      // an embedded pane with no chip still gets them.
      setupOwnerRows(p);
      if (!userChip) return;
      // Set the IMAGE and nothing else. How an avatar frames its photo — cover,
      // centred, no repeat — is stated once in plume.css, so this page and the
      // Settings page cannot end up drawing the same photo two different ways.
      // The `has-img` class is what drops the tint and hides the initial.
      var av = userChip.querySelector(".avatar");
      if (av) {
        if (p.avatar) {
          av.style.backgroundImage = 'url("' + p.avatar + '")';
          av.textContent = "";
          av.classList.add("has-img");
        } else {
          av.style.backgroundImage = "";
          av.textContent = (p.initials || "A").toUpperCase();
          av.classList.remove("has-img");
        }
      }
      var nm = userChip.querySelector(".user-name"); if (nm) nm.textContent = p.name || "You";
      var rl = userChip.querySelector(".user-role"); if (rl) rl.textContent = p.email || p.role || "";
      // Reveal the "Restart server" menu item only for granted accounts.
      var rsNav = document.getElementById("restartServerNav");
      if (rsNav) rsNav.hidden = !p.canPowerOff;
      // Reveal the "Terminal" menu item only for the OWNER — it opens a real,
      // unsandboxed shell on the box. The /terminal WebSocket enforces the same
      // owner-only gate server-side, so this is UI tidiness, not the actual guard.
      var tNav = document.getElementById("terminalNav");
      if (tNav) tNav.hidden = !p.isOwner;
      // Same for "Sites" — it enumerates what this box is hosting, which is the
      // owner's business alone (/api/sites is owner-gated server-side too).
      var sNav = document.getElementById("sitesNav");
      if (sNav) sNav.hidden = !p.isOwner;
      // Reveal the approval-mode selector only for owner/admin (members are pinned
      // to "Ask first" server-side, so the control would be a no-op for them).
      // NB: p.role is a display LABEL ("Owner · Workspace admin"), never compare
      // it to raw role ids — that kept this pill invisible for everyone.
      if (p.isOwner || p.isAdmin) {
        setPermAllowed(true);
        if (permPicker) { permPicker.hidden = false; updatePermLabel(); }
      }
      // Role gating has finished; now remove anything this machine cannot do.
      // Only ever hides, so it can safely run last — see js/capabilities.js.
      applyCapabilityGating();
    })
    .catch(function () { /* not signed in / offline — leave defaults */ });
}

export function initProfile() {
  if (userChip) {
    userChip.addEventListener("click", function () { window.location.href = "/settings.html"; });
  }

  loadProfile();
}

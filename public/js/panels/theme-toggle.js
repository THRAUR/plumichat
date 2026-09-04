import { MOON_ICON, SUN_ICON } from '../icons.js';
import { themeToggle } from '../library.js';

/* ---------- Theme toggle (sidebar footer) ---------- */
export function syncThemeIcon() {
  if (!themeToggle || !window.PlumiTheme) return;
  // In dark mode, offer the sun (switch to light); in light mode, offer the moon.
  themeToggle.innerHTML = window.PlumiTheme.get() === "light" ? MOON_ICON : SUN_ICON;
}

export function initThemeToggle() {
  if (themeToggle && window.PlumiTheme) {
    syncThemeIcon();
    themeToggle.addEventListener("click", function () { window.PlumiTheme.toggle(); syncThemeIcon(); });
    window.addEventListener("plumi-theme", syncThemeIcon);
  }
}

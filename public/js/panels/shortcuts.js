// "Show" (drawer): which shortcuts keep permanent space on the sidebar. The whole
// sidebar is one scroller now, so every shortcut you never use costs you a
// conversation you could have seen without scrolling. Turning one off hides the row
// without losing the feature — this picker doubles as a launcher for whatever is off.

export function initShortcutPicker() {
  (function setupShortcutPicker() {
    var btn = document.getElementById("shortcutShowBtn");
    var panel = document.getElementById("shortcutPicker");
    if (!btn || !panel) return;

    var KEY = "plumi.shortcuts.hidden";
    // Icon and label are read off the nav row itself, so a shortcut only has to be
    // described once — in the markup — and this list never drifts from the sidebar.
    var FEATURES = [
      { id: "notepad", nav: "notepadNav" },
      { id: "grid", nav: "gridNav" },
      { id: "ops", nav: "opsNav" },
      { id: "terminal", nav: "terminalNav" },
      { id: "sites", nav: "sitesNav", also: "sitesList" },
      { id: "restart", nav: "restartServerNav" },
    ];
    var EYE_ON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    var EYE_OFF = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6.5 10-6.5c1.2 0 2.3.2 3.3.6"></path><path d="M19.5 8.4c1.8 1.7 2.5 3.6 2.5 3.6s-3.5 6.5-10 6.5c-1.6 0-3-.3-4.2-.8"></path><line x1="3" y1="3" x2="21" y2="21"></line></svg>';

    // What's stored is the set that's OFF, not the set that's ON: a shortcut added in
    // a later version then appears by default rather than staying invisible until
    // someone thinks to come looking in here.
    var hidden = load();

    function load() {
      try {
        var v = JSON.parse(localStorage.getItem(KEY));
        return Array.isArray(v) ? v : [];
      } catch (e) { return []; }
    }
    function save() {
      try { localStorage.setItem(KEY, JSON.stringify(hidden)); } catch (e) { /* private mode — the choice just won't outlive the tab */ }
    }

    function apply() {
      FEATURES.forEach(function (f) {
        var off = hidden.indexOf(f.id) >= 0;
        var nav = document.getElementById(f.nav);
        if (nav) nav.classList.toggle("nav-off", off);
        // Sites keeps its unfolded list in a separate element — hide both together.
        var also = f.also && document.getElementById(f.also);
        if (also) also.classList.toggle("nav-off", off);
      });
    }

    function toggle(id) {
      var i = hidden.indexOf(id);
      if (i >= 0) hidden.splice(i, 1); else hidden.push(id);
      save();
      apply();
    }

    function build() {
      panel.textContent = "";
      var offered = 0;
      FEATURES.forEach(function (f) {
        var nav = document.getElementById(f.nav);
        // The [hidden] attribute is what permission uses (loadProfile sets it from the
        // account), so only offer what this account is actually allowed to open —
        // ticking a box here must never reveal Terminal to a member.
        if (!nav || nav.hidden) return;
        offered++;
        var off = hidden.indexOf(f.id) >= 0;
        var name = (nav.querySelector(".nav-label") || {}).textContent || f.id;

        var row = document.createElement("div");
        row.className = "pick-row" + (off ? " off" : "");

        var open = document.createElement("button");
        open.type = "button";
        open.className = "pick-open";
        open.title = "Open " + name;
        var ic = nav.querySelector(".nav-ic");
        if (ic) open.appendChild(ic.cloneNode(true));
        var text = document.createElement("span");
        text.textContent = name;
        open.appendChild(text);
        open.addEventListener("click", function () { setOpen(false); nav.click(); });

        var eye = document.createElement("button");
        eye.type = "button";
        eye.className = "pick-eye";
        eye.innerHTML = off ? EYE_OFF : EYE_ON;
        eye.setAttribute("aria-pressed", off ? "false" : "true");
        eye.setAttribute("aria-label", (off ? "Show " : "Hide ") + name + " on the sidebar");
        eye.title = off ? "Keep on the sidebar" : "Hide from the sidebar";
        eye.addEventListener("click", function () { toggle(f.id); build(); });

        row.appendChild(open);
        row.appendChild(eye);
        panel.appendChild(row);
      });

      var hint = document.createElement("div");
      hint.className = "pick-hint";
      hint.textContent = offered
        ? "Tap a name to open it. Tap the eye to keep it on the sidebar."
        : "No shortcuts on this account.";
      panel.appendChild(hint);
    }

    function setOpen(on) {
      btn.setAttribute("aria-expanded", on ? "true" : "false");
      panel.hidden = !on;
      var scroll = document.getElementById("drawerScroll");
      if (scroll) scroll.classList.toggle("picking", on);
      if (on) build();
    }

    btn.addEventListener("click", function () { setOpen(btn.getAttribute("aria-expanded") !== "true"); });
    apply();
  })();
}

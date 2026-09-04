/* PlumiChat shared theme controller — load synchronously in <head> BEFORE the stylesheet
   so the correct theme is applied before first paint (no flash). */
(function () {
  "use strict";
  function systemMode() {
    try { return localStorage.getItem("plumi_theme_mode") === "system"; } catch (e) { return false; }
  }
  function osTheme() {
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  }
  function read() {
    try {
      // "System" mode tracks the OS live — ignore any stored snapshot so a
      // day→night OS switch flips PlumiChat too, on every page, without a reload.
      if (systemMode()) return osTheme();
      var t = localStorage.getItem("plumi_theme");
      if (t === "light" || t === "dark") return t;
      return osTheme(); // first visit: respect the OS preference
    } catch (e) {}
    return "dark";
  }
  /* ---------- palettes ----------
     A PALETTE is the set of colours; a THEME is still just light or dark. They
     are kept separate on purpose: `data-theme` is read as "light"/"dark" by four
     CSS selectors and two JS comparisons elsewhere in the product, so palettes
     ride on their own `data-palette` attribute and every one of those keeps
     working. A palette also declares which mode it belongs to, and setting one
     sets both attributes.

     `bar` mirrors that palette's --bg (the iOS status bar / Android address bar
     colour). `s3` mirrors its --surface-3, which is what an accent TEXT colour
     has to stay legible against — see worstBackdrop below. Both are duplicated
     from plume.css because this file runs BEFORE the stylesheet, by design: the
     theme has to be on <html> before first paint or the app flashes. */
  // `preview` is [--bg, --surface-2, --text, --accent] — the four values a
  // palette card paints itself with. They are literals rather than var() reads
  // because the card is NESTED: plume.css scopes a palette to html[data-palette],
  // so a swatch inside the page cannot resolve another scheme's tokens, and
  // redeclaring all 43 of them per palette just to preview four would be exactly
  // the token duplication plume.css exists to end.
  var PALETTES = {
    phosphor:  { label: "Phosphor",          dark: true,  bar: "#141210", s3: [50, 44, 34],
                 preview: ["#141210", "#262119", "#F2ECDD", "#E8A06F"] },
    paper:     { label: "Paper",             dark: false, bar: "#F8F6F1", s3: [228, 222, 209],
                 preview: ["#F8F6F1", "#F1EDE4", "#1A1813", "#E0915E"] },
    tokyo:     { label: "Tokyo Night",       dark: true,  bar: "#1A1B26", s3: [41, 46, 66],
                 preview: ["#1A1B26", "#24283B", "#C0CAF5", "#7AA2F7"] },
    mocha:     { label: "Catppuccin Mocha",  dark: true,  bar: "#1E1E2E", s3: [69, 71, 90],
                 preview: ["#1E1E2E", "#313244", "#CDD6F4", "#FAB387"] },
    nord:      { label: "Nord",              dark: true,  bar: "#2E3440", s3: [67, 76, 94],
                 preview: ["#2E3440", "#3B4252", "#ECEFF4", "#88C0D0"] },
    gruvbox:   { label: "Gruvbox",           dark: true,  bar: "#282828", s3: [80, 73, 69],
                 preview: ["#282828", "#3C3836", "#EBDBB2", "#FE8019"] },
    dracula:   { label: "Dracula",           dark: true,  bar: "#282A36", s3: [68, 71, 90],
                 preview: ["#282A36", "#383A4C", "#F8F8F2", "#BD93F9"] },
    latte:     { label: "Catppuccin Latte",  dark: false, bar: "#EFF1F5", s3: [220, 224, 232],
                 preview: ["#EFF1F5", "#E6E9EF", "#4C4F69", "#FE640B"] },
    solarized: { label: "Solarized"     ,   dark: false, bar: "#FDF6E3", s3: [224, 217, 195],
                 preview: ["#FDF6E3", "#EEE8D5", "#073642", "#2074AF"] }
  };
  var DEFAULT_PALETTE = { dark: "phosphor", light: "paper" };

  // Which palette to use for each mode. Remembered per mode so the light/dark
  // toggle — and System following the OS — flips between the two palettes the
  // person actually chose, instead of snapping back to the built-ins.
  function paletteFor(mode) {
    try {
      var id = localStorage.getItem("plumi_palette_" + mode);
      if (id && PALETTES[id] && PALETTES[id].dark === (mode === "dark")) return id;
    } catch (e) {}
    return DEFAULT_PALETTE[mode];
  }
  function activePalette() {
    var id = document.documentElement.getAttribute("data-palette");
    return PALETTES[id] ? id : paletteFor(read());
  }

  // Keep the browser/OS chrome (iOS status bar, Android address bar) the same
  // colour as the app. index.html ships a media-qualified <meta theme-color>
  // pair as the no-JS default, but the user can override the OS scheme — and the
  // spec picks the FIRST meta whose media matches, so an override has to be
  // inserted AHEAD of that pair.
  var barMeta;
  function applyBarColor(paletteId) {
    try {
      var head = document.head || document.documentElement;
      if (!barMeta) {
        barMeta = document.createElement("meta");
        barMeta.setAttribute("name", "theme-color");
        barMeta.setAttribute("data-plumi", "bar");
        head.insertBefore(barMeta, head.firstChild);
      }
      var p = PALETTES[paletteId] || PALETTES.phosphor;
      barMeta.setAttribute("content", p.bar);
    } catch (e) {}
  }
  function apply(t, paletteId) {
    if (!paletteId || !PALETTES[paletteId] || PALETTES[paletteId].dark !== (t === "dark")) {
      paletteId = paletteFor(t);
    }
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.setAttribute("data-palette", paletteId);
    applyBarColor(paletteId);
    // A custom accent's TEXT variant is derived against the palette's surfaces,
    // so it has to be recomputed whenever the palette changes.
    try {
      var a = localStorage.getItem("plumi_accent");
      if (a && typeof applyAccent === "function") applyAccent(a);
    } catch (e) {}
  }
  apply(read());

  // Follow the OS colour scheme live while in System mode (the media query fires
  // whenever the OS flips light/dark, e.g. on a schedule).
  try {
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    var onOS = function () {
      if (!systemMode()) return;
      var t = osTheme(); apply(t);
      try { window.dispatchEvent(new CustomEvent("plumi-theme", { detail: t })); } catch (e) {}
    };
    if (mq.addEventListener) mq.addEventListener("change", onOS);
    else if (mq.addListener) mq.addListener(onOS);
  } catch (e) {}

  function hexToRgb(h) {
    h = String(h).replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // Plume splits the accent in two: --accent is a FILL and --accent-text is the
  // colour the same idea takes when it is a word or a stroked icon. A custom
  // accent has to supply BOTH, or every accented label in the product keeps the
  // terracotta it was picked to replace.
  function lum(rgb) {
    var a = rgb.map(function (v) {
      v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function contrast(a, b) {
    var l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function toHex(rgb) {
    return "#" + rgb.map(function (v) {
      return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
    }).join("");
  }
  // The backdrop an accent TEXT colour has to survive is NOT the page
  // background. --accent-text is the colour of an accented label inside a menu,
  // a chip, a card or a tinted button, and those are painted --surface-2 and
  // --surface-3. Deriving against --bg passes the one surface the colour is
  // least often on: the shipped paper terracotta measured 4.77 on --bg and 3.85
  // on --surface-3, so every accented label in a menu was below AA on paper
  // while the check said it passed.
  // --surface-3 is the right target because in every palette it is the surface
  // furthest from the text — the lightest in a dark scheme, the darkest in a
  // light one — and the derivation runs against --accent-dim OVER it, because an
  // accented label is usually sitting on its own tint: a selected chip, an armed
  // button, the open conversation. Clearing that clears every surface above it.
  // Each palette carries its own s3 in PALETTES, so a custom accent is derived
  // against the scheme it is actually going to be read on — Nord's #434C5E is
  // nothing like Gruvbox's #504945, and one shared constant would be wrong for
  // at least one of them.
  var DIM_ALPHA = 0.16;
  function worstBackdrop(rgb) {
    var p = PALETTES[activePalette()] || PALETTES.phosphor;
    return rgb.map(function (v, i) { return v * DIM_ALPHA + p.s3[i] * (1 - DIM_ALPHA); });
  }

  // Walk the accent toward the far end of the page until it clears AA against
  // that backdrop. The old picker offered an amber that scored 2.0:1 as
  // text on white; this makes any accent — including one typed in later —
  // legible without asking the person who picked it to know that.
  function readable(rgb, bgRgb) {
    var target = lum(bgRgb) > 0.5 ? [0, 0, 0] : [255, 255, 255];
    var out = rgb.slice();
    for (var i = 0; i < 24 && contrast(out, bgRgb) < 4.5; i++) {
      out = out.map(function (v, k) { return v + (target[k] - v) * 0.08; });
    }
    return out;
  }
  function applyAccent(hex) {
    var r = document.documentElement.style;
    if (!hex) {
      r.removeProperty("--accent"); r.removeProperty("--accent-dim");
      r.removeProperty("--accent-line"); r.removeProperty("--accent-text");
      r.removeProperty("--on-accent");
      return;
    }
    var rgb = hexToRgb(hex), c = rgb.join(", ");
    var textBg = worstBackdrop(rgb);   /* the active palette's tinted --surface-3 */
    r.setProperty("--accent", hex);
    r.setProperty("--accent-dim", "rgba(" + c + ", 0.15)");
    r.setProperty("--accent-line", "rgba(" + c + ", 0.38)");
    r.setProperty("--accent-text", toHex(readable(rgb, textBg)));
    // Ink ON the fill: pick whichever of Plume's two inks actually reads on it,
    // rather than guessing from a luminance threshold. A mid-tone like sage sits
    // right on that threshold, and the wrong side of it puts cream on green at
    // 2.4:1 — which is the label on every primary button in the product.
    var DARK_INK = [26, 16, 6], LIGHT_INK = [248, 246, 241];
    r.setProperty("--on-accent",
      contrast(DARK_INK, rgb) >= contrast(LIGHT_INK, rgb) ? "#1A1006" : "#F8F6F1");
  }
  try { var savedAccent = localStorage.getItem("plumi_accent"); if (savedAccent) applyAccent(savedAccent); } catch (e) {}

  // Presentation prefs from Settings that must hold on EVERY page: "Reduce
  // motion" and "Compact density". Reflected as <html> attributes so any page's
  // CSS can react; motion also gets a global !important reset injected once here
  // (each page has its own stylesheet — this is the single place that covers all).
  var motionStyle;
  function applyMotion() {
    var reduce = false;
    try { reduce = localStorage.getItem("plumi_pref_motion") === "1"; } catch (e) {}
    var r = document.documentElement;
    if (reduce) r.setAttribute("data-reduce-motion", "1"); else r.removeAttribute("data-reduce-motion");
    if (reduce && !motionStyle) {
      motionStyle = document.createElement("style");
      motionStyle.textContent =
        'html[data-reduce-motion="1"] *, html[data-reduce-motion="1"] *::before, html[data-reduce-motion="1"] *::after {' +
        'animation-duration:0.001ms !important;animation-iteration-count:1 !important;' +
        'transition-duration:0.001ms !important;scroll-behavior:auto !important;}';
      (document.head || document.documentElement).appendChild(motionStyle);
    }
  }
  function applyDensity() {
    var compact = false;
    try { compact = localStorage.getItem("plumi_pref_density") === "1"; } catch (e) {}
    if (compact) document.documentElement.setAttribute("data-density", "compact");
    else document.documentElement.removeAttribute("data-density");
  }
  applyMotion();
  applyDensity();

  // Cross-document sync: `storage` fires in every OTHER document sharing this
  // localStorage (other tabs, the split-view page and each of its iframe panes),
  // so a theme/accent change made anywhere applies everywhere instantly.
  try {
    window.addEventListener("storage", function (e) {
      if (!e || !e.key) return;
      if (e.key === "plumi_theme" && (e.newValue === "light" || e.newValue === "dark")) {
        if (!systemMode()) { // a manual pick elsewhere; System mode ignores stored theme
          apply(e.newValue);
          try { window.dispatchEvent(new CustomEvent("plumi-theme", { detail: e.newValue })); } catch (err) {}
        }
      } else if (e.key === "plumi_theme_mode") {
        var t = read(); apply(t);
        try { window.dispatchEvent(new CustomEvent("plumi-theme", { detail: t })); } catch (err) {}
      } else if (e.key === "plumi_palette_dark" || e.key === "plumi_palette_light") {
        var pt = read(); apply(pt);
        try { window.dispatchEvent(new CustomEvent("plumi-palette", { detail: activePalette() })); } catch (err) {}
      } else if (e.key === "plumi_accent") {
        applyAccent(e.newValue || "");
        try { window.dispatchEvent(new CustomEvent("plumi-accent", { detail: e.newValue || "" })); } catch (err) {}
      } else if (e.key === "plumi_pref_motion") {
        applyMotion();
      } else if (e.key === "plumi_pref_density") {
        applyDensity();
      }
    });
  } catch (e) {}

  window.PlumiTheme = {
    get: function () { return document.documentElement.getAttribute("data-theme") || "dark"; },
    getMode: function () { try { return localStorage.getItem("plumi_theme_mode") === "system" ? "system" : "manual"; } catch (e) { return "manual"; } },
    // Write the mode BEFORE the theme so another tab's `storage` handler never
    // sees "manual theme, system mode" (or the reverse) for a frame.
    setMode: function (m) { try { localStorage.setItem("plumi_theme_mode", m === "system" ? "system" : "manual"); } catch (e) {} },
    // set() deliberately does NOT touch the mode: Settings calls it right after
    // choosing System, to paint the OS's current scheme.
    set: function (t) {
      t = (t === "light") ? "light" : "dark";
      apply(t);
      try { localStorage.setItem("plumi_theme", t); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent("plumi-theme", { detail: t })); } catch (e) {}
      return t;
    },
    // An explicit toggle is a decision, so it also LEAVES System mode. Without
    // this the sidebar toggle appeared to work and silently reverted on the next
    // load (read() ignores the stored theme while the mode is "system").
    toggle: function () {
      this.setMode("manual");
      return this.set(this.get() === "light" ? "dark" : "light");
    },
    // Re-read the presentation prefs (motion/density) after Settings changes them
    // in THIS document — storage events only fire in other tabs, so the page that
    // made the change calls this to apply it immediately.
    refreshPrefs: function () { applyMotion(); applyDensity(); },
    /* ---------- palettes ---------- */
    palettes: function () {
      return Object.keys(PALETTES).map(function (id) {
        return { id: id, label: PALETTES[id].label, dark: PALETTES[id].dark,
                 bar: PALETTES[id].bar, preview: PALETTES[id].preview.slice() };
      });
    },
    getPalette: function () { return activePalette(); },
    // Picking a palette is also picking its mode — Nord IS dark — so this sets
    // both, and remembers it as THE palette for that mode. Like toggle(), an
    // explicit pick leaves System mode; otherwise read() would ignore the stored
    // theme and the choice would appear to work and revert on the next load.
    setPalette: function (id) {
      if (!PALETTES[id]) return activePalette();
      var mode = PALETTES[id].dark ? "dark" : "light";
      try { localStorage.setItem("plumi_palette_" + mode, id); } catch (e) {}
      this.setMode("manual");
      apply(mode, id);
      try { localStorage.setItem("plumi_theme", mode); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent("plumi-theme", { detail: mode })); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent("plumi-palette", { detail: id })); } catch (e) {}
      return id;
    },
    getAccent: function () { try { return localStorage.getItem("plumi_accent") || ""; } catch (e) { return ""; } },
    setAccent: function (hex) {
      try { if (hex) localStorage.setItem("plumi_accent", hex); else localStorage.removeItem("plumi_accent"); } catch (e) {}
      applyAccent(hex);
      try { window.dispatchEvent(new CustomEvent("plumi-accent", { detail: hex })); } catch (e) {}
      return hex;
    }
  };
})();

/* PlumiChat shared UI helpers — settings.html, operations.html, grid.html.
   ------------------------------------------------------------------------
   The three secondary pages were ported from a design tool and each shipped its
   own copy of: an HTML-escape helper, an inline-SVG helper, the check/x icons,
   a JSON fetch wrapper, a toast, relative-time formatting and the sheet/overlay
   "settled" animation dance. The copies had already drifted — settings' toast
   interpolated raw text into innerHTML while operations' escaped it, which is a
   stored-XSS hole in one page and not the other. This file is the single copy.

   Plain classic script (no modules, no build step) exposing window.PlumiUI.
   Load it with <script src="/ui.js"> AFTER /theme.js and BEFORE the page's own
   inline script. Everything here is defensive: a page that loads it and calls
   nothing is unaffected. */
(function () {
  "use strict";

  /* ---------- escaping ---------- */
  // The one true escape. Uses the DOM's own serializer rather than a regex chain
  // so there is nothing to get subtly wrong.
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  // esc() escapes `&`, `<` and `>` but NOT quotes, because the DOM serializer has
  // no reason to: in TEXT position they are harmless. Inside an ATTRIBUTE they are
  // the whole attack. Use this one whenever the value lands between quotes.
  function escAttr(s) {
    return esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Byte sizes, for the engine panel's reclaimable-disk figures and the ops patch
  // size. Deliberately 1 decimal at MB and above — "852.3 MB" reads; "852 MB"
  // rounds away the thing you are deciding about.
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
    return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  /* ---------- inline icons ---------- */
  // Every icon in these pages is a stroked 24x24 path set; `ic` wraps one.
  function ic(path, size) {
    var w = size || 14;
    return '<svg width="' + w + '" height="' + w + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var ICONS = {
    check: '<polyline points="20 6 9 17 4 12"></polyline>',
    x: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
    info: '<circle cx="12" cy="12" r="9"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>'
  };

  /* ---------- JSON API ---------- */
  // One redirect per page load, ever. Operations polls every 2.5s; without this
  // latch an expired session would queue a dozen navigations before the first
  // one committed.
  var redirecting = false;
  function toLogin() {
    if (redirecting) return;
    redirecting = true;
    var next = location.pathname + location.search + location.hash;
    location.href = "/login?next=" + encodeURIComponent(next);
  }

  // JSON fetch that throws the SERVER'S message. Callers show `err.message`
  // verbatim — several server routes (ops retry, engine update) explain exactly
  // why they refused, and paraphrasing them client-side loses that.
  //
  // A 401 means the session expired or the PIN changed on another device. The
  // home-screen web app has no address bar, so without this the only way out is
  // to force-quit the app (audit H3).
  function api(method, url, body) {
    var opt = { method: method, headers: {}, cache: "no-store" };
    if (body !== undefined && body !== null) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401) { toLogin(); throw new Error("Signed out — taking you to the login screen"); }
        if (!r.ok) {
          var e = new Error((d && d.error) || ("Request failed (" + r.status + ")"));
          e.status = r.status;
          throw e;
        }
        return d;
      });
    });
  }

  // For a route that may not be deployed yet. Resolves to null on 404/405 (and
  // on a network failure) instead of throwing, so a panel can degrade to a
  // "not available" line rather than showing a broken UI. Real errors from a
  // route that DOES exist still reject.
  function apiOptional(method, url, body) {
    return api(method, url, body).catch(function (err) {
      if (err && (err.status === 404 || err.status === 405)) return null;
      throw err;
    });
  }

  /* ---------- toasts ---------- */
  var toastsEl = null;
  function toastHost() {
    if (toastsEl && toastsEl.isConnected) return toastsEl;
    toastsEl = document.querySelector(".ui-toasts");
    if (!toastsEl) {
      toastsEl = document.createElement("div");
      // Fixed unless the page mounts it inside a positioned shell itself.
      toastsEl.className = "ui-toasts fixed";
      document.body.appendChild(toastsEl);
    }
    return toastsEl;
  }
  // kind: "ok" | "bad" | "info". `text` is ALWAYS escaped — a member-controlled
  // string (a folder name, a server error) reaches this on both pages.
  function toast(kind, text) {
    var host = toastHost();
    var t = document.createElement("div");
    t.className = "ui-toast enter " + (kind || "info");
    var path = kind === "ok" ? ICONS.check : kind === "bad" ? ICONS.x : ICONS.info;
    t.innerHTML = '<span class="ic">' + ic(path, 15) + "</span><span>" + esc(text) + "</span>";
    host.appendChild(t);
    setTimeout(function () { t.classList.remove("enter"); }, 320);
    setTimeout(function () {
      t.classList.add("out");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 240);
    }, 2600);
    return t;
  }

  /* ---------- relative time ---------- */
  // "just now" / "5m ago" / "3h ago" / "2d ago". Returns "" for a missing or
  // unparseable timestamp so a caller can concatenate it without a guard.
  function relTime(iso) {
    if (!iso) return "";
    var then = new Date(iso).getTime();
    if (isNaN(then)) return "";
    var s = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (s < 45) return "just now";
    var m = Math.floor(s / 60); if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60); if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }
  // The mirror image: "in 3d" / "in 20m" / "due now" for a future instant.
  function relUntil(iso) {
    if (!iso) return "";
    var ms = new Date(iso).getTime() - Date.now();
    if (isNaN(ms)) return "";
    if (ms <= 0) return "due now";
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return "in " + d + "d";
    if (h > 0) return "in " + h + "h";
    if (m > 0) return "in " + m + "m";
    return "in <1m";
  }

  /* ---------- sheet / overlay ---------- */
  // Drives the open/close transition and the `.settled` latch (see ui.css).
  // Returns { open, close, isOpen, el, overlay }. Pass { onClose } to be told
  // when a dismissal happened (overlay tap, Escape, or an explicit close).
  function sheet(sheetEl, overlayEl, opts) {
    opts = opts || {};
    var timer = null;
    function settle() {
      if (sheetEl) sheetEl.classList.add("settled");
      if (overlayEl) overlayEl.classList.add("settled");
    }
    function unsettle() {
      if (sheetEl) sheetEl.classList.remove("settled");
      if (overlayEl) overlayEl.classList.remove("settled");
    }
    function isOpen() { return !!(sheetEl && sheetEl.classList.contains("open")); }
    function open() {
      clearTimeout(timer);
      unsettle();
      if (sheetEl) void sheetEl.offsetWidth; // force a reflow so the transition runs
      if (sheetEl) sheetEl.classList.add("open");
      if (overlayEl) overlayEl.classList.add("open");
      timer = setTimeout(settle, 320);
    }
    function close(silent) {
      var was = isOpen();
      clearTimeout(timer);
      unsettle();
      if (sheetEl) void sheetEl.offsetWidth;
      if (sheetEl) sheetEl.classList.remove("open");
      if (overlayEl) overlayEl.classList.remove("open");
      timer = setTimeout(settle, 320);
      if (was && !silent && typeof opts.onClose === "function") opts.onClose();
    }
    if (overlayEl) overlayEl.addEventListener("click", function () { close(); });
    if (opts.escape !== false) {
      document.addEventListener("keydown", function (e) { if (e.key === "Escape" && isOpen()) close(); });
    }
    return { open: open, close: close, isOpen: isOpen, el: sheetEl, overlay: overlayEl };
  }

  /* ---------- clipboard ---------- */
  // The async Clipboard API needs a secure context (https:// or localhost). Over
  // plain http://100.x it is undefined, so fall back to the old execCommand path.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        var okk = document.execCommand("copy");
        document.body.removeChild(ta);
        if (okk) resolve(); else reject(new Error("copy failed"));
      } catch (e) { reject(e); }
    });
  }

  window.PlumiUI = {
    esc: esc,
    escAttr: escAttr,
    fmtBytes: fmtBytes,
    ic: ic,
    icons: ICONS,
    api: api,
    apiOptional: apiOptional,
    toast: toast,
    relTime: relTime,
    relUntil: relUntil,
    sheet: sheet,
    copyText: copyText
  };
})();

import { apiFetch } from '../api.js';
import { toast } from '../dom.js';
import { confirmSheet } from '../sheet.js';

// "Restart server" (drawer): reload the PlumiChat server after an update or fix.
// Revealed only to the owner + owner-granted accounts (loadProfile). It's a quick
// process restart — projects and conversations are untouched — so we confirm, fire
// it, then poll /api/health and reload once the new process answers. The heavier
// machine controls (restart / shut down the PC) live in Settings → Security.

export function initServerRestart() {
  (function setupServerRestart() {
    var nav = document.getElementById("restartServerNav");
    if (!nav) return;
    nav.addEventListener("click", function () {
      confirmSheet({
        title: "Restart the server?",
        message: "PlumiChat goes offline for a few seconds and this page reloads once it is back. "
          + "Projects and conversations are untouched; a turn that is running will not survive it.",
        confirmLabel: "Restart now",
        danger: true,
        onConfirm: doRestart,
      });
    });
    function doRestart() {
      nav.disabled = true;
      var label = nav.querySelector(".nav-label");
      var was = label ? label.textContent : "";
      if (label) label.textContent = "Restarting…";
      apiFetch("/api/system/restart", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error((res.d && res.d.error) || "Couldn't restart");
          toast("Restarting… hang tight");
          // Let the restart begin, then poll health and reload when the new process
          // answers (require seeing it go down first to avoid a false early hit).
          setTimeout(function () {
            var sawDown = false, n = 0;
            (function poll() {
              n++;
              apiFetch("/api/health", { cache: "no-store" }).then(function (r) {
                if (!r.ok) { sawDown = true; return setTimeout(poll, 600); }
                if (sawDown || n > 8) return location.reload();
                setTimeout(poll, 600);
              }).catch(function () { sawDown = true; setTimeout(poll, 600); });
            })();
          }, 1200);
        })
        .catch(function (e) {
          nav.disabled = false; if (label) label.textContent = was;
          toast(e.message || "Couldn't restart", true);
        });
    }
  })();
}

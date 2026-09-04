import { apiFetch } from '../api.js';
import { $, toast } from '../dom.js';
import { closeDrawer } from '../library.js';
import { relTime } from './notepad.js';
import { confirmSheet } from '../sheet.js';

/* ===================== Terminal (owner-only) =========================== */
// A real interactive shell on the box, streamed over a WebSocket (/terminal) and
// rendered with xterm.js, so the owner can run the interactive `claude` CLI —
// above all Claude Design's /design-sync — and answer its y/n prompts here. The
// server refuses the socket for anyone but the owner; the menu entry is likewise
// revealed only for the owner (see loadProfile).
//
// The shell PERSISTS on the server across disconnects: "Minimize" hides the panel
// but keeps it running, so you can step away and come back — or reopen on another
// device, which re-attaches to the SAME shell and replays recent output to catch
// up. It ends only when you type `exit`, hit "End", or the server restarts. If the
// socket drops (phone sleeps, Wi‑Fi blip), we auto-reconnect and replay.
//
// Frames: browser→server is JSON text ({t:'i'} keys, {t:'r'} resize, {t:'k'} end);
// server→browser is BINARY for PTY bytes and TEXT JSON for control ({t:'end'}).

export function initTerminal() {
  (function setupTerminal() {
    var nav = $("terminalNav");
    var modal = $("termModal"), overlay = $("termOverlay"), surface = $("termSurface");
    var minBtn = $("termMin"), endBtn = $("termEnd"), conn = $("termConn"), targetBtn = $("termTarget");
    var chooser = $("termChooser"), chooserList = $("termChooserList");
    if (!nav || !modal || !surface) return;

    var term = null, fit = null, ws = null, ro = null;
    var open = false;        // panel visible
    var active = false;      // a shell session is meant to exist (until End / exit)
    var reconnectT = null;
    // Exponential backoff for reconnects. The old fixed 1.5s timer hammered a box
    // that was down (a restart takes ~10s) forever and never told you how it was
    // going; now the wait grows to a 20s cap and the badge counts the attempts.
    var reconnectTries = 0;
    var wasReconnect = false;   // did THIS socket come from a dropped one?
    var RECONNECT_BASE = 1200, RECONNECT_CAP = 20000;
    var pending = [];        // input queued until the socket is open (e.g. Design sync)
    var targetCwd = "";      // design-system dir, for the Design sync button
    var sessionCwd = "";     // folder THIS shell was spawned in (re-sent so reconnects land right)

    function setConn(state, label) {
      if (!conn) return;
      conn.setAttribute("data-state", state === "on" ? "on" : "off");
      conn.textContent = label;
    }

    function sendResize() {
      if (ws && ws.readyState === 1 && term) {
        try { ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows })); } catch (e) {}
      }
    }
    function fitNow() {
      if (!term || !fit) return;
      if (!surface.clientHeight || !surface.clientWidth) return; // hidden — don't fit to 0
      try { fit.fit(); } catch (e) { return; }
      sendResize();
    }

    function ensureTerm() {
      if (term) return;
      var TermCtor = window.Terminal;
      var FitCtor = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
      if (!TermCtor) return;
      term = new TermCtor({
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 13, scrollback: 5000,
        theme: { background: "#0a0b0d", foreground: "#e6e6e6", cursor: "#e6e6e6", selectionBackground: "rgba(120,160,255,0.35)" },
      });
      if (FitCtor) { fit = new FitCtor(); term.loadAddon(fit); }
      term.open(surface);
      term.onData(function (d) {
        if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: "i", d: d })); } catch (e) {} }
      });
      if (window.ResizeObserver) { ro = new ResizeObserver(function () { fitNow(); }); ro.observe(surface); }
    }

    // Silently drop the current socket without triggering a reconnect (used when we
    // deliberately replace or end it).
    function teardownWs() {
      if (ws) { try { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); } catch (e) {} ws = null; }
    }

    function connect() {
      if (reconnectT) { clearTimeout(reconnectT); reconnectT = null; }
      teardownWs();
      if (term) term.reset(); // clean slate so the server's replay paints cleanly
      var proto = location.protocol === "https:" ? "wss://" : "ws://";
      // ?cwd is honoured only when the server has NO live session yet (fresh spawn);
      // for a reconnect to an existing shell it's ignored, so re-sending is harmless.
      var url = proto + location.host + "/terminal" + (sessionCwd ? ("?cwd=" + encodeURIComponent(sessionCwd)) : "");
      setConn("off", "Connecting…");
      try { ws = new WebSocket(url); }
      catch (e) { setConn("off", "Offline"); scheduleReconnect(); return; }
      ws.binaryType = "arraybuffer";
      ws.onopen = function () {
        wasReconnect = reconnectTries > 0;  // remember it for onInfo, then…
        reconnectTries = 0;                 // …a good socket resets the backoff
        setConn("on", "Connected");
        fitNow();
        while (pending.length) { var d = pending.shift(); try { ws.send(JSON.stringify({ t: "i", d: d })); } catch (e) {} }
        try { term.focus(); } catch (e) {}
      };
      ws.onmessage = function (ev) {
        if (typeof ev.data === "string") {          // control frame
          var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m && m.t === "end") onEnded();
          // The server now greets every attach with what we actually landed on.
          // Before this, a shell that had survived a server restart (tmux keeps
          // it) and a brand-new empty one looked identical — you could type into
          // a fresh shell believing your work was still there.
          else if (m && m.t === "info") onInfo(m);
          return;
        }
        if (term) term.write(new Uint8Array(ev.data)); // raw PTY bytes
      };
      ws.onclose = function () {
        ws = null;
        if (!active) { setConn("off", "Ended"); return; }
        setConn("off", "Reconnecting…");
        scheduleReconnect();
      };
      ws.onerror = function () { /* onclose follows */ };
    }

    function scheduleReconnect() {
      if (!active || reconnectT) return;
      reconnectTries++;
      // 1.2s, 2.4s, 4.8s … capped at 20s, with a little jitter so several open
      // devices don't all knock at the same instant.
      var wait = Math.min(RECONNECT_CAP, RECONNECT_BASE * Math.pow(2, reconnectTries - 1));
      wait = Math.round(wait * (0.85 + Math.random() * 0.3));
      setConn("off", "Reconnecting… (" + reconnectTries + ")");
      reconnectT = setTimeout(function () { reconnectT = null; if (active) connect(); }, wait);
    }

    // {t:'info', cwd, startedAt, tmux, sessionName, reattached} — say plainly
    // whether this is your old shell or a brand-new one. Nothing is written INTO
    // the PTY: the shell may be showing a full-screen TUI (the `claude` CLI) that
    // a stray line would corrupt until its next repaint.
    function onInfo(m) {
      sessionCwd = m.cwd || sessionCwd;
      setConn("on", m.reattached ? "Re-attached" : "Connected");
      if (!wasReconnect) return;    // a deliberate start needs no announcement
      wasReconnect = false;
      if (m.reattached) toast("Re-attached to your shell — started " + relTime(m.startedAt));
      else toast("The old shell is gone — this is a new one" + (m.cwd ? " in " + m.cwd : ""), true);
    }

    function onEnded() {
      active = false;
      if (reconnectT) { clearTimeout(reconnectT); reconnectT = null; }
      setConn("off", "Ended");
      if (term) term.write("\r\n\x1b[90m[session ended — open Terminal to start a new one]\x1b[0m\r\n");
    }

    // Refetch on EVERY open (no cache guard) so the live-session card reflects the
    // server's current state — a shell may have been started, or ended, on another
    // device since last time.
    function loadTargets() {
      apiFetch("/api/terminal/targets", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d) return;
          targetCwd = d.designSyncCwd || "";
          if (targetBtn) targetBtn.hidden = !targetCwd;
          renderChooser(d.targets || [], d.live || null);
        })
        .catch(function () {});
    }

    // Build the "open in…" list. Uses textContent only (never innerHTML) — the
    // labels/paths come from the server but there's no reason to trust-render them.
    // When the server reports a live shell, a distinct "resume" card is prepended so
    // you can rejoin it (with its age + folder) from any device.
    function renderChooser(list, live) {
      if (!chooserList) return;
      chooserList.textContent = "";
      if (live && live.cwd) chooserList.appendChild(buildLiveCard(live, list));
      list.forEach(function (t) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "term-choice" + (t.id === "home" ? " is-home" : "");
        var name = document.createElement("span");
        name.className = "term-choice-name";
        name.textContent = t.label;
        var path = document.createElement("span");
        path.className = "term-choice-path";
        path.textContent = t.hint || t.cwd || "";
        b.appendChild(name); b.appendChild(path);
        b.addEventListener("click", function () { startInProject(t.cwd); });
        chooserList.appendChild(b);
      });
    }

    // The distinct card for a shell already running on the server. Tapping it
    // re-attaches (startInProject re-sends the cwd; the server ignores it for an
    // existing session and just replays the buffer, so we land on the live screen).
    // Two cases, and the second is why the shell runs under tmux at all:
    //   live.live true  — this server owns the PTY right now.
    //   live.live false + resumable — a shell from BEFORE the last server restart
    //   is still sitting in tmux with your work in it. Saying "Live session" there
    //   would be a lie, and saying nothing made a restart look like it had thrown
    //   the session away.
    function buildLiveCard(live, list) {
      var waiting = live.live === false && live.resumable;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "term-choice term-live" + (waiting ? " term-waiting" : "");
      b.title = (waiting ? "Shell waiting in " : "Live shell in ") + live.cwd +
        " — started " + new Date(live.startedAt).toLocaleString();

      var top = document.createElement("div");
      top.className = "term-live-top";
      var badge = document.createElement("span");
      badge.className = "term-live-badge";
      badge.textContent = waiting ? "Waiting to re-attach" : "Live session";
      var age = document.createElement("span");
      age.className = "term-live-age";
      var when = "started " + relTime(live.startedAt);
      if (waiting && live.waiting > 1) when += " · " + live.waiting + " shells";
      else if (live.clients > 1) when += " · " + live.clients + " devices";
      age.textContent = when;
      top.appendChild(badge); top.appendChild(age);

      var name = document.createElement("span");
      name.className = "term-choice-name";
      name.textContent = (waiting ? "Re-attach — " : "Resume — ") + labelForCwd(live.cwd, list);
      var path = document.createElement("span");
      path.className = "term-choice-path";
      path.textContent = live.cwd;

      b.appendChild(top); b.appendChild(name); b.appendChild(path);
      b.addEventListener("click", function () { startInProject(live.cwd); });
      return b;
    }

    // Friendly name for the folder a live shell lives in — reuse the picker's own
    // label when one matches, else fall back to the folder's basename.
    function labelForCwd(cwd, list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].cwd === cwd) return list[i].id === "home" ? "home folder" : list[i].label;
      }
      var parts = String(cwd || "").replace(/\/+$/, "").split("/");
      return parts[parts.length - 1] || cwd || "shell";
    }

    function showPanel() {
      open = true;
      closeDrawer();
      overlay.classList.add("open"); modal.classList.add("open");
      modal.setAttribute("aria-hidden", "false");
    }
    function hidePanel() {
      open = false;
      overlay.classList.remove("open"); modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
    }
    // Swap the modal body between the project picker and the live terminal. The
    // key bar belongs to the terminal view only — the chooser is a tap list.
    function showChooserView() { if (chooser) chooser.hidden = false; surface.hidden = true; showKeys(false); }
    function showTerminalView() { if (chooser) chooser.hidden = true; surface.hidden = false; showKeys(true); }

    // Nav click. A shell that's still running (minimized earlier) resumes straight
    // away; otherwise we ask which project to start in first — the shell then spawns
    // already cd'd into that folder (see startInProject).
    function openTerminal() {
      showPanel();
      loadTargets();
      if (active) {
        showTerminalView();
        ensureTerm();
        if (!term) { setConn("off", "Unavailable"); return; }
        if (!ws || ws.readyState > 1) connect();  // socket died while away — re-attach
        else setConn("on", "Connected");          // already live (was just minimized)
        setTimeout(fitNow, 240);
      } else {
        showChooserView();
        setConn("off", "Pick a project");
      }
    }

    // Spawn a fresh shell in the chosen folder (blank = home). Show the terminal view
    // first so xterm opens on a laid-out element rather than a hidden one.
    function startInProject(cwd) {
      showTerminalView();
      ensureTerm();
      if (!term) { setConn("off", "Unavailable"); return; }
      sessionCwd = cwd || "";
      active = true;
      reconnectTries = 0;      // a deliberate start — begin the backoff from zero
      connect();
      setTimeout(fitNow, 240);
    }

    // "Minimize" IS hidePanel(): the shell (and, if possible, the socket) stays
    // alive, so you come back via the menu — or open on another device to catch up.

    // End: actually close the shell for good. Confirm, because a running task dies.
    function endSession() {
      if (active) {
        confirmSheet({
          title: "End the terminal session?",
          message: "This closes the shell for good — anything running in it stops. "
            + "Minimize (–) instead to keep it running and come back later.",
          confirmLabel: "End session",
          danger: true,
          onConfirm: closeShell,
        });
        return;
      }
      closeShell();
    }
    function closeShell() {
      active = false;
      if (reconnectT) { clearTimeout(reconnectT); reconnectT = null; }
      if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: "k" })); } catch (e) {} }
      teardownWs();
      setConn("off", "Ended");
      hidePanel();
    }

    // Design sync: shortcut past the picker straight into the design-system folder
    // with `claude` launched, one step from typing /design-sync. Fresh → spawn there;
    // already running → cd + launch in the live shell (queued until the socket opens).
    function designSync() {
      showPanel();
      loadTargets();
      if (!active) {
        startInProject(targetCwd || "");
        if (active) pending.push("claude\r");
      } else {
        showTerminalView();
        ensureTerm();
        if (!term) { setConn("off", "Unavailable"); return; }
        var cmd = (targetCwd ? "cd '" + targetCwd + "' && " : "") + "claude\r";
        if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: "i", d: cmd })); } catch (e) {} try { term.focus(); } catch (e) {} }
        else pending.push(cmd);
      }
    }

    /* The on-screen key bar (see index.html). Everything goes down the same
       {t:"i"} channel as a keystroke, so the shell cannot tell the difference.
       Two details that matter on a phone:
       - pointerdown + preventDefault, NOT click: a click would move focus off the
         terminal, which dismisses the on-screen keyboard between every key.
       - queue into `pending` when the socket is still connecting, exactly as the
         Design sync button does, so an early tap is not silently dropped. */
    var keysBar = document.getElementById("termKeys");
    if (keysBar) {
      keysBar.addEventListener("pointerdown", function (e) {
        var b = e.target.closest("button[data-k]");
        if (!b) return;
        e.preventDefault();          // keep focus (and the keyboard) on the terminal
        var d = b.getAttribute("data-k");
        if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: "i", d: d })); } catch (err) {} }
        else pending.push(d);
        try { if (term) term.focus(); } catch (err) {}
      });
    }
    function showKeys(on) { if (keysBar) keysBar.hidden = !on; }

    /* A terminal-only slash command picked from the chat palette (see
       panels/commands.js). It cannot run in the chat engine, so it arrives here
       instead: open the terminal, then TYPE the command without a newline. Not
       Enter — the shell may still be starting claude, and a command that ran
       itself in the wrong place would be worse than one you press ⏎ on yourself.
       The key bar right underneath is how you do that. */
    document.addEventListener("plumi:terminal-command", function (e) {
      var cmd = (e && e.detail && e.detail.cmd) || "";
      if (!cmd) return;
      var wasActive = active;
      openTerminal();
      // A fresh shell queues `claude\r` first; give it a moment to be at a prompt
      // that can receive the text, rather than racing its startup.
      setTimeout(function () {
        if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: "i", d: cmd })); } catch (err) {} }
        else pending.push(cmd);
        try { if (term) term.focus(); } catch (err) {}
      }, wasActive ? 250 : 2500);
      toast(cmd + " is a terminal command — typed it in the Terminal, press ⏎ to run");
    });

    nav.addEventListener("click", openTerminal);
    if (minBtn) minBtn.addEventListener("click", hidePanel);
    if (endBtn) endBtn.addEventListener("click", endSession);
    if (targetBtn) targetBtn.addEventListener("click", designSync);
    // A stray tap on the dimmed overlay just minimizes (safe — keeps the shell
    // running); ending is deliberate via the ✕. Escape is a live terminal key, so
    // it's left for the shell rather than bound to close.
    if (overlay) overlay.addEventListener("click", hidePanel);
    window.addEventListener("resize", function () { if (open) fitNow(); });
  })();
}

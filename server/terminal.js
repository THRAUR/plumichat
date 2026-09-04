// Owner-only interactive terminal over a WebSocket, with a PERSISTENT session.
//
// This is the ONE place in PlumiChat that hands out a real, unsandboxed shell on the
// box, so it is locked to the OWNER account only — never admins, never members.
// It exists so the owner can drive the interactive `claude` CLI from inside PlumiChat
// (most importantly Claude Design's `/design-sync`, which is a built-in feature of
// the interactive CLI, not an SDK/MCP tool — see memory design-sync-feasibility)
// and answer its y/n prompts, without leaving for the Ubuntu terminal.
//
// Persistence, two layers deep:
//   1. The PTY lives on the server independent of any one WebSocket. Close the
//      panel, switch devices, or drop off Wi‑Fi and the shell keeps running; the
//      next connection re-attaches to the SAME shell and replays recent output.
//      Because it's a single shared session, several devices can attach at once —
//      input and output are shared.
//   2. The shell itself runs inside TMUX. A PM2 restart kills this process and
//      every PTY it owns, but tmux's server is a daemon that outlives us, so the
//      interactive `claude` the owner had running is still there afterwards and
//      the next connection attaches straight back into it. Without this, "restart
//      the server" silently threw away a running Claude session and handed back a
//      pristine shell that merely looked the same — the bug this layer exists for.
// The session now ends only when the shell exits (`exit`) or the owner hits "End";
// a server restart no longer ends it. Boxes without tmux fall back to a bare login
// shell, which behaves exactly as before.
//
// Wire protocol:
//   browser → server : JSON text frames — {t:'i',d} keystrokes, {t:'r',c,r} resize,
//                       {t:'k'} end-the-session.
//   server → browser : BINARY frames = raw PTY output (xterm writes them straight
//                       through); TEXT frames = control — {t:'end'} when the shell
//                       has exited, and {t:'info',…} once on attach describing what
//                       we attached to (tmux session name, new vs re-attached).
//                       Clients ignore control frames they don't know.
import { WebSocketServer } from 'ws';
// node-pty is an OPTIONAL dependency: it is a native module, and a machine without
// build tools (most often a fresh Windows one) cannot compile it. A STATIC import
// here would take the whole server down with it, so it is loaded defensively and
// its absence costs you the terminal panel and nothing else. capabilities.js
// reports the same fact to the UI.
let pty = null;
try { pty = (await import('node-pty')).default; }
catch { console.warn('[terminal] node-pty unavailable — the terminal panel is disabled'); }

export function terminalSupported() { return pty !== null; }
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WORKSPACES_ROOT } from './sandbox.js';
import { defaultShell, findTmux, findEnvBin, tmpRoot, IS_WINDOWS } from './platform.js';

const HOME = os.homedir();
// { bin, args } — a login shell on Unix, PowerShell on Windows. See platform.js
// for why '-l' cannot simply be passed everywhere.
const SHELL = defaultShell();
// Ring buffer of recent PTY output, replayed to a (re)connecting client so it can
// catch up. Big enough to hold a full-screen TUI repaint or two; trimmed to the
// tail beyond that. A fresh connect also nudges a resize, so TUIs repaint cleanly.
const MAX_BUFFER = 768 * 1024;

// Where projects live — each immediate subdirectory becomes a "start the shell
// here" choice in the picker shown when the terminal opens. Same root the rest of
// the app contains paths inside (sandbox.js), so the terminal and the file browser
// cannot disagree about what a "project" is.
const PROJECTS_ROOT = WORKSPACES_ROOT;

// Optional one-tap shortcut: a folder to open with `claude` already running, one
// step from typing a slash command (the button is labelled "Design sync" because
// /design-sync is the CLI-only feature it was built for). Unset -> the button never
// appears, which is the default: this is a convenience, not a feature to configure.
const DESIGN_SYSTEM_CWD = process.env.PLUMI_DESIGN_SYNC_DIR || '';

// Extra folders to list ABOVE the projects, for trees that live outside the
// workspace root. Comma-separated "Label=/abs/path" pairs, or bare paths. Empty by
// default — a fresh install has nothing outside its workspace worth pinning.
const EXTRA_DIRS = String(process.env.PLUMI_TERMINAL_DIRS || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((entry, i) => {
    const eq = entry.indexOf('=');
    const label = eq > 0 ? entry.slice(0, eq).trim() : path.basename(entry);
    const cwd = eq > 0 ? entry.slice(eq + 1).trim() : entry;
    return { id: 'x' + i, label, cwd: path.resolve(cwd.replace(/^~(?=$|\/)/, HOME)) };
  });

// Choices for the "open the terminal in…" picker: HOME first (the "no project"
// option), then the extra dirs (e.g. the live server), then every real subdirectory
// of PROJECTS_ROOT, alphabetised — so the shell can spawn straight into the right
// folder. `designSyncCwd` is the path the Design sync button uses (null when absent).
export function terminalTargets() {
  const targets = [
    { id: 'home', label: 'No project', hint: 'Start in your home folder (~)', cwd: HOME },
  ];
  for (const d of EXTRA_DIRS) {
    if (isDir(d.cwd)) targets.push({ id: d.id, label: d.label, hint: d.cwd, cwd: d.cwd });
  }
  let names = [];
  try {
    names = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.')) // skip dot-dirs (the app's own data folders)
      .map((e) => e.name);
  } catch { names = []; }
  names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  for (const name of names) {
    const cwd = path.join(PROJECTS_ROOT, name);
    targets.push({ id: 'p:' + name, label: name, hint: cwd, cwd });
  }
  return { targets, designSyncCwd: isDir(DESIGN_SYSTEM_CWD) ? DESIGN_SYSTEM_CWD : null };
}

function isDir(p) {
  try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; }
}

/* --------------------------- environment hygiene -------------------------- */

// PM2 captured the environment of the Claude Code session that first started the
// app, so this process carries CLAUDECODE=1, CLAUDE_CODE_SESSION_ID, CLAUDE_EFFORT
// and TMPDIR=/tmp/claude-<uid> from a session that ended months ago. Handing that
// to the owner's shell means their interactive `claude` boots wearing another
// session's identity and writes its temp files into a doubly-nested claude dir —
// the same breakage scrubbedEnv() fixes for agent turns in server/claude.js.
// (Duplicated rather than imported because claude.js does not export it.)
//
// NOTE: unlike the agent env we deliberately do NOT strip the app's own secrets.
// This is the owner's real, unsandboxed login shell — they can `cat .env` in it —
// and removing them would only break tooling that legitimately reads them.
const INHERITED_CLAUDE_ENV = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_EFFORT', 'TMPPREFIX', 'TMP', 'TEMP',
];

// The owner's terminal gets the REAL environment (not the scrubbed agent env in
// claude.js), minus the inherited markers above. Make sure ~/.local/bin — where
// `claude` lives — is on PATH even if the parent process's PATH is minimal.
function terminalEnv() {
  const env = { ...process.env };
  for (const k of INHERITED_CLAUDE_ENV) delete env[k];
  env.TMPDIR = tmpRoot();
  const localBin = path.join(HOME, '.local', 'bin');
  if (!String(env.PATH || '').split(path.delimiter).includes(localBin)) {
    env.PATH = localBin + path.delimiter + (env.PATH || '');
  }
  env.TERM = 'xterm-256color';
  return env;
}

/* ----------------------------------- tmux --------------------------------- */

const NAME_PREFIX = 'plumi-';
// Belt to terminalEnv()'s braces: tmux hands a NEW session the environment of
// whichever client first started its server, which may not be us. Running the
// shell through `env -u` guarantees the markers are gone inside the session no
// matter who woke the tmux daemon.
const ENV_BIN = findEnvBin();
const SCRUB_ARGS = [...INHERITED_CLAUDE_ENV.flatMap((k) => ['-u', k]), 'TMPDIR=' + tmpRoot()];

let tmuxBin; // undefined = not looked up yet, null = definitively unavailable

// platform.js finds the binary; this proves it actually RUNS before we commit to
// spawning a session against it. Null on Windows, where tmux does not exist and the
// terminal falls back to a plain PTY.
function tmuxBinary() {
  if (tmuxBin !== undefined) return tmuxBin;
  const bin = findTmux();
  if (!bin) { tmuxBin = null; return tmuxBin; }
  try { execFileSync(bin, ['-V'], { stdio: 'ignore', timeout: 2000, env: terminalEnv() }); tmuxBin = bin; }
  catch { tmuxBin = null; }
  return tmuxBin;
}

function tmux(args, opts = {}) {
  const bin = tmuxBinary();
  if (!bin) return null;
  try {
    return execFileSync(bin, args, {
      encoding: 'utf8', timeout: 2500, env: terminalEnv(),
      stdio: ['ignore', 'pipe', 'ignore'], ...opts,
    });
  } catch { return null; } // "no server running" also exits non-zero — that's just "none"
}

// Live tmux sessions. Cached for a beat because terminalSessionInfo() is called on
// every open of the picker and a fork per call would be silly; any state change we
// cause ourselves busts the cache explicitly.
let sessionsCache = { at: 0, list: [] };
function tmuxSessions() {
  if (Date.now() - sessionsCache.at < 1000) return sessionsCache.list;
  const out = tmux(['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_path}\t#{session_attached}']);
  const list = String(out || '').split('\n').filter(Boolean).map((line) => {
    const [name, created, cwd, attached] = line.split('\t');
    return { name, startedAt: (Number(created) || 0) * 1000, cwd: cwd || '', attached: Number(attached) || 0 };
  });
  sessionsCache = { at: Date.now(), list };
  return list;
}
const forgetSessions = () => { sessionsCache = { at: 0, list: [] }; };

// One stable tmux session name per folder, so re-opening the terminal on the same
// project lands back in the same shell. tmux keys sessions by NAME alone and two
// different folders can share a basename (…/a/design-system vs …/b/design-system),
// so a short digest of the full path rides along. tmux also treats '.' and ':' as
// address separators, hence the strict slug.
function sessionNameFor(cwd) {
  const base = cwd === HOME ? 'home' : path.basename(cwd);
  const slug = String(base).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'shell';
  return NAME_PREFIX + slug + '-' + crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 6);
}

// The single owner session (owner-only tool → one shared, persistent shell).
// { term, clients:Set<ws>, buffer:Buffer, cols, rows, alive:boolean, cwd, startedAt,
//   tmuxName:string|null, reattached:boolean }
let session = null;

function spawnSession(cwd) {
  if (!pty) throw new Error('The terminal needs node-pty, which is not installed on this machine.');
  const env = terminalEnv();
  const resolvedCwd = isDir(cwd) ? cwd : HOME;
  const bin = tmuxBinary();

  let term, tmuxName = null, reattached = false;
  if (bin && ENV_BIN) {
    tmuxName = sessionNameFor(resolvedCwd);
    // Ask BEFORE spawning: `new-session -A` is attach-or-create and reports nothing
    // about which one it did, but that difference is exactly what the owner needs
    // to be told ("re-attached" vs a brand-new shell).
    reattached = tmuxSessions().some((s) => s.name === tmuxName);
    // -u forces UTF-8 output (this owner's paths are often Traditional Chinese),
    // -A attaches to <name> or creates it, -c sets the start directory for a NEW
    // session (ignored on attach, which is what we want — the old cwd wins).
    term = pty.spawn(bin, [
      '-u', 'new-session', '-A', '-s', tmuxName, '-c', resolvedCwd,
      '--', ENV_BIN, ...SCRUB_ARGS, SHELL.bin, ...SHELL.args,
    ], { name: 'xterm-256color', cols: 80, rows: 24, cwd: resolvedCwd, env });
    forgetSessions();
  } else {
    // No tmux (or no `env`): a plain shell. This is always the Windows path.
    // Losing restart-survival is a downgrade, not a breakage.
    term = pty.spawn(SHELL.bin, SHELL.args, {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: resolvedCwd, env,
    });
  }

  const s = {
    term, clients: new Set(), buffer: Buffer.alloc(0), cols: 80, rows: 24, alive: true,
    cwd: resolvedCwd, startedAt: Date.now(), tmuxName, reattached,
  };

  term.onData((d) => {
    const chunk = Buffer.from(d, 'utf8');
    let b = Buffer.concat([s.buffer, chunk]);
    if (b.length > MAX_BUFFER) b = Buffer.from(b.subarray(b.length - MAX_BUFFER));
    s.buffer = b;
    for (const ws of s.clients) { try { ws.send(chunk); } catch { /* gone */ } }
  });
  term.onExit(() => {
    s.alive = false;
    forgetSessions();
    for (const ws of s.clients) { try { ws.send(JSON.stringify({ t: 'end' })); } catch {} }
    if (session === s) session = null;
  });
  return s;
}

function getSession(cwd) {
  if (session && session.alive) return session;
  session = spawnSession(cwd);
  return session;
}

function endSession() {
  const s = session;
  session = null;
  if (!s) return;
  try { s.term.kill(); } catch {}
  // Killing the PTY only DETACHES a tmux client — the session, and the interactive
  // `claude` inside it, would keep running and the next attach would silently
  // resume it. "End" has to mean end, so tear the tmux session down explicitly.
  if (s.tmuxName) tmux(['kill-session', '-t', s.tmuxName]);
  forgetSessions();
}

// Snapshot for the picker's "resume" card. Two cases, and the second one is the
// point of running under tmux at all:
//   live:true  — this process owns a PTY right now.
//   live:false — we own nothing, but a shell from BEFORE the last server restart
//                is still sitting in tmux with the owner's work in it. Reporting
//                null here (as this used to) is what made a restart look like it
//                had thrown the session away, when it hadn't.
export function terminalSessionInfo() {
  if (session && session.alive) {
    return {
      startedAt: session.startedAt, cwd: session.cwd, clients: session.clients.size,
      live: true, tmux: !!session.tmuxName, sessionName: session.tmuxName,
      reattached: !!session.reattached,
    };
  }
  const survivors = tmuxSessions()
    .filter((s) => s.name.startsWith(NAME_PREFIX))
    .sort((a, b) => b.startedAt - a.startedAt);
  if (!survivors.length) return null;
  const s = survivors[0];
  return {
    startedAt: s.startedAt, cwd: s.cwd, clients: 0,
    live: false, tmux: true, sessionName: s.name, reattached: false,
    // "There is a shell waiting for you" — the client can say so instead of
    // presenting the picker as if nothing were running.
    resumable: true, waiting: survivors.length,
  };
}

// Attach the /terminal WebSocket to an existing http.Server. `noServer` mode: we
// claim only our own path on 'upgrade', so this coexists with anything else that
// might want WebSockets later (today nothing else does).
export function attachTerminal(server, { currentUser }) {
  // No PTY module -> do not mount the /terminal upgrade handler at all. A route
  // that exists but always throws is worse than one that is honestly absent.
  if (!pty) return;

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = ''; }
    if (pathname !== '/terminal') return; // not ours — leave it for another handler

    // OWNER-ONLY GATE. currentUser reads the very same signed session cookie the
    // HTTP side uses (it takes the raw req), so this is identical auth — we just
    // additionally demand role === 'owner'. Everyone else (admins, members,
    // anonymous) is refused before any shell is touched.
    let user = null;
    try { user = currentUser(req); } catch { user = null; }
    if (!user || user.role !== 'owner') {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachClient(ws, req));
  });
}

function attachClient(ws, req) {
  let cwd = HOME;
  try {
    const q = new URL(req.url, 'http://localhost').searchParams.get('cwd');
    if (isDir(q)) cwd = q;
  } catch { /* keep home */ }

  const existed = !!(session && session.alive);
  const s = getSession(cwd);
  s.clients.add(ws);

  // Tell the client WHAT it just attached to, so it can say "re-attached to your
  // running shell" instead of quietly presenting a new one as if nothing had
  // happened. Unknown control frames are ignored by older clients.
  try {
    ws.send(JSON.stringify({
      t: 'info', cwd: s.cwd, startedAt: s.startedAt, tmux: !!s.tmuxName,
      sessionName: s.tmuxName || null,
      // Either this process already had the shell, or tmux still had it from
      // before the last restart — both mean "your old session, not a new one".
      reattached: existed || !!s.reattached,
    }));
  } catch { /* the socket died before we could greet it */ }

  // Replay recent output so this client (a new device, or a reconnect) catches up
  // to the current screen. A freshly spawned shell has nothing to replay.
  if (existed && s.buffer.length) { try { ws.send(Buffer.from(s.buffer)); } catch {} }

  // For an already-running session, nudge a resize a moment after attach so any
  // full-screen TUI (claude) repaints cleanly for the newcomer even if their size
  // matches the current one. A fresh PTY that re-attached to a surviving tmux
  // session needs the same nudge: tmux sizes its window to the smallest attached
  // client, so without it the repaint can arrive at the old geometry.
  if (existed || s.reattached) {
    setTimeout(() => {
      if (!s.alive) return;
      try { s.term.resize(s.cols, Math.max(1, s.rows - 1)); s.term.resize(s.cols, s.rows); } catch {}
    }, 60);
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i' && typeof msg.d === 'string') {
      try { s.term.write(msg.d); } catch {}
    } else if (msg.t === 'r' && msg.c > 0 && msg.r > 0) {
      s.cols = Math.floor(msg.c); s.rows = Math.floor(msg.r);
      try { s.term.resize(s.cols, s.rows); } catch {}
    } else if (msg.t === 'k') {
      endSession();
    }
  });

  // Detaching a client NEVER kills the shell — that's the whole point of
  // persistence. The PTY lives until it exits, "End", or a server restart.
  const detach = () => { s.clients.delete(ws); };
  ws.on('close', detach);
  ws.on('error', detach);
}

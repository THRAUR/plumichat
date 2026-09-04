// PlumiChat v1 server — Express + Claude Agent SDK + SSE streaming.
// Multi-user: real accounts (email + 6-digit PIN), single-use invites, and
// per-user sandboxed project folders. The HTTP Basic-auth lifeline is preserved
// underneath everything (maps to the owner) so a bug here can never lock the box out.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';
import { createRequire } from 'node:module';
import { exec, execFile } from 'node:child_process';
import yazl from 'yazl';
import { startRun, subscribe, respondAsk, askRun, stopRun, listRuns, getRun } from './runs.js';
import { limitsSnapshot } from './claude.js';   // last usage-window the engine saw
import { shipEngineUpdate, shipStatus, lastWatchdogOutcome } from './engine-ship.js';
import { listSkills, matchSkillCommand } from './skills.js';
import { attachTerminal, terminalTargets, terminalSessionInfo } from './terminal.js';
import { WORKSPACES_ROOT, ROOT_REAL, resolveInUserRoot, listProjectsFor, createProjectFor, createFolderIn, userHome, resolveBrowse, listDir, saveUpload, saveUploadInto, searchFiles, planZip } from './sandbox.js';
import { listSessions, getSession, setSessionTitle, setSessionFlags, deleteSession } from './history.js';
import { readContext, contextSnapshot, forgetContext, rewindPoints, rewind, fork } from './context.js';
import { mcpStatus, reloadEngineParts, pluginCatalogue, installPlugin, uninstallPlugin } from './plugins.js';
import { exportAnswer } from './export.js';
import { listModels } from './models.js';
import { listSites, SITE_GROUPS } from './sites.js';
import { appById, appLoginContext, appForOrigin } from './apps.js';
import { changePassword, setEnvVar } from './credentials.js';
import { getWorkspace, setWorkspace } from './settings.js';
import { spendSummary } from './spend.js';
import { listCommands } from './commands.js';
import * as notepad from './notepad.js';
import { read as readStore, update as updateStore } from './store.js';
import {
  listTasks, createTask, editTask, deleteTask,
  cancelTask, acceptTask, rejectTask, runNow, initRunner,
  opsMeta, opsStatus, taskPatch, onOpsChange,
} from './operations.js';
import { engineStatus, whatsNew, updateLog, applyUpdate, DEV_REPO } from './engine.js';
// `subscribe` is already taken by runs.js above, so the push ones are aliased —
// the two subscription ideas (SSE run streams vs Web Push devices) must not blur.
import { pushStatus, subscribe as pushSubscribe, unsubscribe as pushUnsubscribe } from './push.js';
import { powerCommand, platformLabel, resetTempEnv } from './platform.js';
import { capabilities, unavailableSummary } from './capabilities.js';
import {
  issueSession, sessionCookie, clearedCookie, SESSION_COOKIE, sessionPayload,
  registrationOptions, verifyRegistration, authenticationOptions, verifyAuthentication,
  webauthnEnrolled, listCredentials, resetWebauthn, removeCredential,
} from './auth.js';
import {
  registerUser, loginUser, findById, findByEmail, ownerUser, bootstrapNeeded,
  userCount, publicUser, profileView, updateUserProfile, changeUserPin,
  updateUserAvatar, removeUserAvatar, canPowerOff, setPowerOff, userSessionVersion,
  membersView, removeUser, createInvite, pendingInvites, revokeInvite, inviteIsValid,
  updateUserDefaults,
} from './users.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3002);
// Loopback by DEFAULT. This process runs shell commands and edits files as
// whoever started it, so a wide bind is a security decision, not a convenience:
// an unconfigured box on 0.0.0.0 is an open shell to everything on the network.
// Set HOST explicitly to go wider — and see preflight() at the bottom, which
// refuses to open an exposed socket that nothing authenticates.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const REPO_ROOT = path.resolve(__dirname, '..');       // the checkout this process was started from
const HOME_DIR = process.env.HOME || os.homedir();

// --- Boot-time environment hygiene ---
// PM2 captured the environment of the Claude Code session that first started this
// app — it is baked into ~/.pm2/dump.pm2 — so the process carries CLAUDECODE=1,
// CLAUDE_CODE_SESSION_ID, CLAUDE_EFFORT and TMPDIR=/tmp/claude-<uid> from a session
// that ended months ago, and EVERY child inherits it. That is what broke member
// turns once before: the agent CLI booted wearing another session's identity and
// wrote its temp files into a doubly-nested claude dir. claude.js (scrubbedEnv),
// terminal.js and engine.js each scrub their own copy of the env; this clears the
// leak at its source, before anything can spawn. Same list as those three — if you
// add a name there, add it here too.
for (const key of [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_EFFORT', 'TMPPREFIX', 'TMP', 'TEMP',
]) delete process.env[key];
// Restore a real temp dir on whichever variable this OS reads — see platform.js.
resetTempEnv(process.env);

const app = express();
app.use(express.json({ limit: '1mb' }));

// Baseline security headers on everything this server sends. `nosniff` stops a
// text/plain answer being sniffed into script; a same-origin referrer keeps
// conversation URLs off other sites; and the frame policy is SAMEORIGIN, never
// DENY, because grid.html embeds the app in iframes on this very origin (?embed=1)
// — DENY would blank the split view.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// --- Auth gate: signed session cookie (carries the user id) OR HTTP Basic (the
// lifeline fallback, which maps to the owner). `authPass` is mutable so a
// password change takes effect immediately. Basic auth is NEVER removed, so a bug
// in the account flow can't lock the box out.
const AUTH_USER = process.env.AUTH_USER;
let authPass = process.env.AUTH_PASS;
const BASIC_SUB = '__basic__'; // session sub used by the Basic-auth lifeline → owner

function safeEqual(a = '', b = '') {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    // A malformed percent-escape ("%zz") makes decodeURIComponent THROW, and this
    // runs on every single request — one junk cookie left by any app on this
    // hostname used to 500 the whole server. Ignore the unreadable copy and keep
    // scanning: a browser can legitimately send two cookies of the same name (a
    // host-only one and a domain one), and the good one must still win.
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { /* unreadable — try the next */ }
  }
  return null;
}
function basicOk(req) {
  if (!AUTH_USER || !authPass) return false;
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  // Split on the FIRST colon only — a password containing ':' must survive.
  const decoded = Buffer.from(encoded, 'base64').toString();
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), AUTH_USER) && safeEqual(decoded.slice(i + 1), authPass);
}

// A synthetic owner identity for the Basic-auth lifeline when no account exists
// yet (fresh box) — keeps the operator in and root-scoped until they register.
function syntheticOwner() {
  return { id: null, firstName: 'Owner', lastName: '', name: 'Owner', email: '', role: 'owner', homeRel: '', initials: 'A', status: 'active', _synthetic: true };
}

// Resolve the caller's identity: session cookie (by user id) first, else the
// Basic-auth lifeline (→ owner). Returns a public user record or null.
function currentUser(req) {
  const p = sessionPayload(readCookie(req, SESSION_COOKIE));
  const sub = p ? p.sub : null;
  if (sub === BASIC_SUB) { const o = ownerUser(); return o ? publicUser(o) : syntheticOwner(); }
  if (sub) {
    const u = findById(sub);
    // The cookie's session version must match the account's current one. A PIN
    // change bumps the account version, so any cookie minted before it stops
    // authenticating — that's what actually logs stolen/old sessions out. On a
    // mismatch we fall through to the Basic-auth lifeline rather than 401 hard.
    if (u && (p.sv || 0) === (u.sv || 0)) return publicUser(u);
  }
  if (basicOk(req)) { const o = ownerUser(); return o ? publicUser(o) : syntheticOwner(); }
  return null;
}
function isAdminUser(u) { return !!u && (u.role === 'owner' || u.role === 'admin'); }
function authConfigured() { return (!!AUTH_USER && !!authPass) || userCount() > 0; }
function isSecure(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return String(proto).split(',')[0].trim() === 'https';
}
// RP ID / origin for WebAuthn + invite links, derived from the request host
// (works behind a TLS-terminating proxy like `tailscale serve` via X-Forwarded-*).
function rpInfo(req) {
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || '';
  return { rpId: hostHeader.split(':')[0], origin: (isSecure(req) ? 'https' : 'http') + '://' + hostHeader, secure: isSecure(req) };
}
function safeNext(next) {
  const n = typeof next === 'string' ? next : '';
  if (!n.startsWith('/') || n.startsWith('//')) return '/';
  if (n === '/login' || n.startsWith('/login?') || n.startsWith('/api/auth')) return '/';
  return n;
}

// Slide the session window: a valid session cookie more than a day old is
// re-issued on use, so an actively-used login effectively never expires. You're
// only re-prompted for the PIN after ~30 days of NOT opening the tool (the cookie
// TTL), or after an explicit logout / passcode change.
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
function maybeRenewSession(req, res) {
  const p = sessionPayload(readCookie(req, SESSION_COOKIE));
  if (!p) return; // authed via Basic (or not authed) — nothing to slide
  if (Date.now() - (p.iat || 0) < SESSION_RENEW_AFTER_MS) return;
  res.setHeader('Set-Cookie', sessionCookie(issueSession(p.sub, p.sv || 0), { secure: isSecure(req) }));
}

// Attach identity to every request (may be null), then gate.
app.use((req, res, next) => { req.user = currentUser(req); maybeRenewSession(req, res); next(); });

function requireAuth(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({ error: 'authentication required' });
}
function requireAdmin(req, res, next) {
  if (isAdminUser(req.user)) return next();
  return res.status(403).json({ error: 'admin access required' });
}
// The interactive terminal is owner-only (it hands out a real, unsandboxed shell).
// Admins are NOT enough here — only the single owner account. Mirrors the same
// check the /terminal WebSocket upgrade enforces in terminal.js.
function requireOwner(req, res, next) {
  if (req.user && req.user.role === 'owner') return next();
  return res.status(403).json({ error: 'owner access required' });
}
// Powering the whole box off is gated separately from admin: only the owner and
// accounts the owner has explicitly granted (see canPowerOff in users.js).
function requirePowerOff(req, res, next) {
  if (canPowerOff(req.user)) return next();
  return res.status(403).json({ error: 'not permitted to power off this machine' });
}

// Pre-auth allow-list: the unlock/register page, its assets, and the auth API.
const PUBLIC_EXACT = new Set([
  '/login', '/login.html', '/theme.js', '/manifest.webmanifest',
  // The unlock screen's own design system. plume.css owns the palette, the four
  // typefaces and every primitive login.html styles itself with, so gating it
  // rendered the FIRST thing anyone sees of PlumiChat as unstyled serif on white
  // — it 401'd for exactly the visitors it exists for.
  '/plume.css',
  // Every icon the manifest names. The manifest is public, so an installer that
  // could read it but not fetch what it points at was the same bug one level down.
  '/favicon-32.png', '/favicon-100.png', '/favicon-512.png', '/apple-touch-icon.png',
  '/maskable-512.png', '/icon.svg', '/favicon.ico',
  '/sw.js',   // the notification service worker re-fetches itself outside the page; serve it without an auth redirect
  // Single sign-on: a sister app has to be able to ask "is anyone signed in?" and be
  // told plainly no. Behind the gate these would 401/redirect, which the asking app
  // can't tell apart from being broken.
  '/api/sso/me', '/sso/logout',
]);
// /fonts/ is a prefix rather than seven more exact entries: plume.css @font-faces
// them by name, and a subset added later must not silently un-style the login page.
function isPublicPath(p) {
  return PUBLIC_EXACT.has(p) || p.startsWith('/api/auth/') || p.startsWith('/fonts/');
}

// Let configured sister apps call the SSO endpoints from the browser with
// the session cookie attached. Credentialed CORS forbids a wildcard origin, so the
// exact origin is echoed back and only after apps.js recognises it — same hostname
// as this request, on a port we publish. Vary: Origin keeps caches from serving one
// app the header meant for another.
function ssoCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (!origin) return true;                       // same-origin / server-to-server
  if (!appForOrigin(origin, req.headers['x-forwarded-host'] || req.headers.host)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  return true;
}
app.use('/api/sso', (req, res, next) => {
  if (!ssoCors(req, res)) return res.status(403).json({ error: 'origin not allowed' });
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    return res.sendStatus(204);
  }
  next();
});

app.use((req, res, next) => {
  // There is deliberately NO "nothing configured → let everyone in" branch here.
  // A fresh box is not open: it serves the pre-auth allow-list (the login page,
  // which shows owner setup while bootstrapNeeded() is true, and /api/auth/*)
  // and 401s the rest. That is what makes first boot safe to leave running.
  if (isPublicPath(req.path)) return next();   // login page + auth endpoints
  if (req.user) return next();                 // session cookie or Basic fallback
  // Unauthenticated: send page navigations to the login/register screen; 401 the rest.
  if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
    return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl || '/'));
  }
  return res.status(401).json({ error: 'authentication required' });
});

// --- API ---
const ok = (res, fn) => { try { res.json(fn()); } catch (err) { res.status(400).json({ error: err.message }); } };

app.get('/api/health', (_req, res) => res.json({ ok: true, root: WORKSPACES_ROOT }));

// What this machine can actually do. The client uses it to hide or explain a
// surface rather than offering a button that cannot work here — see
// server/capabilities.js. requireAuth because the answer names installed software
// and absolute paths, which is not something to hand an anonymous caller.
app.get('/api/capabilities', requireAuth, async (_req, res) => {
  try { res.json(await capabilities()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Run a fixed argv and resolve its outcome. NEVER rejects and never goes through a
// shell: a missing binary or a non-zero exit is data ("couldn't check"), not a 500.
// Every caller below builds argv as a literal array — no request value is ever
// interpolated into a command line, which is what keeps the git/npm calls safe.
function sh(cmd, args, { cwd, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => resolve({
      ok: !err,
      out: String(stdout || '').trim(),
      err: String(stderr || '').trim() || (err ? String(err.message || '') : ''),
    }));
  });
}

// The native `claude` is called by ABSOLUTE path: PM2's PATH does not contain
// ~/.local/bin, so a bare `claude` is ENOENT (same gotcha engine.js documents).
const CLAUDE_BIN = path.join(HOME_DIR, '.local', 'bin', 'claude');
const nodeRequire = createRequire(import.meta.url);

// The SDK the RUNNING process resolved, not "whatever sits in ../node_modules" —
// node may have hoisted it. Mirrors engine.js's lookup; kept local so /api/version
// stays a cheap file read instead of dragging in engineStatus's network calls.
function installedSdkVersion() {
  try {
    const entry = nodeRequire.resolve('@anthropic-ai/claude-agent-sdk');
    return JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')).version || null;
  } catch { return null; }
}

// What this box is actually running — the answer to "is my phone looking at the
// build I just deployed, or a cached one?". app/commit describe THIS checkout;
// sdk and cli are the two Claude engines, which are separate installs that move
// independently (docs/ENGINE-UPDATES.md); node is the runtime under both. Every
// field is best-effort — a checkout with no .git, or a renamed binary, nulls one
// field rather than failing the call, because this gets read while diagnosing a
// half-broken deploy and must survive one. Readable by any signed-in account.
// Cached briefly so a polling UI can't spawn git and the CLI once a second.
const VERSION_TTL_MS = 30 * 1000;
let versionCache = { at: 0, value: null };
app.get('/api/version', requireAuth, async (_req, res) => {
  // The usage window is attached OUTSIDE the cache: the version fields are stable
  // for 30s but the limits are the one thing here that moves, and serving a stale
  // copy is part of why the chip looked wrong.
  if (versionCache.value && Date.now() - versionCache.at < VERSION_TTL_MS) {
    return res.json({ ...versionCache.value, limits: limitsSnapshot() });
  }
  let app_ = null;
  try { app_ = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version || null; } catch { /* no manifest */ }
  const [git, cli] = await Promise.all([
    sh('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 }),
    sh(fs.existsSync(CLAUDE_BIN) ? CLAUDE_BIN : 'claude', ['--version'], { timeout: 10000 }),
  ]);
  const value = {
    app: app_,
    commit: git.ok ? git.out : null,          // no .git / no git binary → null, never a throw
    sdk: installedSdkVersion(),
    cli: (cli.out.match(/(\d+\.\d+\.\d+)/) || [])[1] || null,   // "2.1.258 (Claude Code)"
    node: process.version,
  };
  versionCache = { at: Date.now(), value };
  res.json({ ...value, limits: limitsSnapshot() });
});

// The browser answers a parked permission/question prompt. Only the account
// that owns the prompted conversation (or an admin) may answer — otherwise a
// member could blind-approve the owner's permission prompts.
app.post('/api/respond', requireAuth, (req, res) => {
  const { id, response } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  const run = askRun(String(id));
  if (run && !isAdminUser(req.user) && run.userId && run.userId !== req.user.id) {
    return res.status(403).json({ error: 'not your conversation' });
  }
  if (!respondAsk(String(id), response)) {
    return res.status(404).json({ error: 'no such pending prompt (it may have expired)' });
  }
  res.json({ ok: true });
});

// Projects the CALLER can see: owner/admin → every top-level project at the root;
// a member → only the contents of their own home folder.
app.get('/api/projects', requireAuth, (req, res) => {
  res.json({ root: userHome(req.user), projects: listProjectsFor(req.user) });
});

// Create a new project folder in the caller's workspace (git-initialised so the
// Operations runner can use it). Returns { name, path, git }.
app.post('/api/projects', requireAuth, (req, res) => ok(res, () => createProjectFor(req.user, (req.body || {}).name)));

// First-run setup: point the workspace at code you already have.
//
// A "project" is just a directory under WORKSPACES_ROOT, so "use my existing repo"
// means moving that root — there is no separate registry to add a path to. The
// value is written to .env and takes effect on the next start, because
// WORKSPACES_ROOT is resolved once at import time in sandbox.js and is the anchor
// every containment check is measured against. Re-resolving it live would mean
// mutating the confinement root of a running server while turns are in flight,
// which is not a trade worth making for a setup convenience.
//
// requireOwner, not requireAdmin: this decides where every account's home lives.
app.post('/api/setup/workspace-root', requireOwner, (req, res) => {
  try {
    const raw = String((req.body || {}).path || '').trim();
    if (!raw) throw new Error('Choose a folder first');
    const abs = path.resolve(raw.replace(/^~(?=$|[\\/])/, HOME_DIR));
    let st;
    try { st = fs.statSync(abs); } catch { throw new Error('That folder does not exist: ' + abs); }
    if (!st.isDirectory()) throw new Error('That is a file, not a folder');
    try { fs.accessSync(abs, fs.constants.R_OK | fs.constants.X_OK); } catch {
      throw new Error('That folder cannot be opened (check permissions)');
    }
    setEnvVar('WORKSPACES_ROOT', abs);
    res.json({ ok: true, path: abs, restartRequired: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Browse the server's filesystem for the "pick a file from disk" feature.
// owner/admin can traverse the whole machine; a member is confined to their own
// home folder — enforced in sandbox.js, never trusting the client path. With no
// `path` we open at the caller's home (the workspace for owner/admin).
app.get('/api/files', requireAuth, (req, res) => {
  try {
    const start = req.query.path ? String(req.query.path) : userHome(req.user);
    res.json(listDir(req.user, start));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Find files/folders by name without hand-navigating the tree. Rooted at `path`
// (defaults to the caller's home), the search is scope-checked and bounded exactly
// like browsing — owner/admin reach the whole machine, a member only their home —
// so it can never leak paths outside the caller's area. Returns matches with a
// relative sub-path plus a `truncated` flag when the bound was hit.
app.get('/api/search', requireAuth, (req, res) => {
  try {
    const start = req.query.path ? String(req.query.path) : userHome(req.user);
    const q = String(req.query.q || '');
    if (!q.trim()) return res.json({ path: start, query: '', results: [], truncated: false, scanned: 0 });
    res.json(searchFiles(req.user, start, q));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Ext → Content-Type for single-file downloads. Anything not listed goes out as
// octet-stream which, with an attachment disposition, is a safe "just save it".
const DOWNLOAD_MIME = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.doc': 'application/msword', '.ppt': 'application/vnd.ms-powerpoint', '.xls': 'application/vnd.ms-excel',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
// Files up to this size are sent in one buffered write (like /api/export, which
// downloads reliably); anything bigger streams so we never hold it all in memory.
const MAX_BUFFERED_DOWNLOAD = 48 * 1024 * 1024;

// Force ONE file to download. We deliberately avoid res.download()/`send` here: it
// advertises Accept-Ranges and answers Range/conditional probes with 206/304, and the
// Tailscale HTTPS proxy in front of PlumiChat can leave the browser hanging on that
// partial response — the file lands on the Mac as a half-written `.crdownload` that
// never finalizes. Instead we emit a single clean 200 with an exact Content-Length
// and no range support (the same shape as /api/export, which downloads fine): small
// files as one buffered write, large ones streamed. The filename* carries the real
// (maybe CJK) name; the ascii copy is the legacy fallback.
function sendDownload(res, abs, name) {
  let size;
  try { size = fs.statSync(abs).size; } catch { return res.status(404).end(); }
  const mime = DOWNLOAD_MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim() || 'download';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);

  if (size <= MAX_BUFFERED_DOWNLOAD) {
    fs.promises.readFile(abs)
      .then((buf) => res.end(buf))
      .catch(() => { if (!res.headersSent) res.status(404).end(); else res.destroy(); });
    return;
  }
  const stream = fs.createReadStream(abs);
  stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
  stream.pipe(res);
}

// Stream server file(s)/folder(s) DOWN to the caller's device (Mac/phone). Paths
// come as one or many `path` values — via the query string (GET, used for a single
// file/folder) or a form body (POST, used for big multi-selections so a long list
// can't blow past the URL/header size limit). Same scope rule as browsing
// (resolveBrowse re-checks containment on EVERY path — the client is never trusted),
// so a member can only pull things from inside their own home. A single file streams
// as-is; a single folder, or any multi-selection, streams as a .zip built on the
// fly. The session cookie rides the request, so it's authed like any other route.
function handleDownload(req, res) {
  const raw = (req.body && req.body.path != null) ? req.body.path : req.query.path;
  const list = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
  if (!list.length) return res.status(400).json({ error: 'path is required' });

  // Validate + classify every requested path against the caller's scope first.
  let items;
  try {
    items = list.slice(0, 100).map((p) => {
      const abs = resolveBrowse(req.user, String(p));
      const st = fs.statSync(abs);
      if (!st.isFile() && !st.isDirectory()) throw new Error('not a file or folder');
      return { abs, isDir: st.isDirectory(), name: path.basename(abs) };
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // One plain file → clean single-200 download (see sendDownload for why not
  // res.download): a range/conditional response can strand the file as a
  // never-finished `.crdownload` behind the HTTPS proxy.
  if (items.length === 1 && !items[0].isDir) {
    return sendDownload(res, items[0].abs, items[0].name);
  }

  // A folder, or several items → zip on the fly. Name it after the lone folder
  // when there's exactly one, else a generic bundle.
  const zipName = (items.length === 1 ? items[0].name : 'plumi-files') + '.zip';
  streamZip(res, items, zipName);
}
app.get('/api/download', requireAuth, handleDownload);
app.post('/api/download', requireAuth, express.urlencoded({ extended: false, limit: '256kb' }), handleDownload);

// Serve a single image INLINE for the file-browser's thumbnail grid. Same scope
// rule as browsing (resolveBrowse re-checks containment on every path, so a member
// only reaches inside their own home). Raster images only — never SVG, which can
// carry inline script — plus a size cap and a hard lockdown (nosniff + a strict
// CSP sandbox) so the bytes can ONLY ever render as an image, never as an active
// document, even if the URL is opened directly.
const INLINE_IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.avif': 'image/avif', '.ico': 'image/x-icon',
};
const THUMB_MAX_BYTES = 12 * 1024 * 1024;
app.get('/api/thumb', requireAuth, (req, res) => {
  const raw = req.query.path;
  if (!raw) return res.status(400).end();
  let abs, st;
  try { abs = resolveBrowse(req.user, String(raw)); st = fs.statSync(abs); }
  catch { return res.status(404).end(); }
  if (!st.isFile()) return res.status(404).end();
  const mime = INLINE_IMAGE_MIME[path.extname(abs).toLowerCase()];
  if (!mime) return res.status(415).end();
  if (st.size > THUMB_MAX_BYTES) return res.status(413).end();
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=60');
  fs.createReadStream(abs)
    .on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); })
    .pipe(res);
});

// Build and stream a .zip of the given (already scope-validated) items. planZip
// resolves every entry up-front WITHOUT following symlinks — that prevents archive
// loops and stops a confined member from escaping their home via a symlink inside
// it — rooting each top-level pick at its basename (de-duplicated on clash).
function streamZip(res, items, zipName) {
  const { files, dirs } = planZip(items);
  const zip = new yazl.ZipFile();
  res.attachment(zipName); // Content-Disposition: attachment + application/zip
  zip.outputStream.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
  res.on('close', () => { try { zip.outputStream.destroy(); } catch { /* gone */ } });
  zip.outputStream.pipe(res);
  for (const name of dirs) zip.addEmptyDirectory(name);
  for (const f of files) zip.addFile(f.abs, f.name);
  zip.end();
}

// Accept a device upload (phone/computer file or picture) as a raw binary body.
// Content-type is application/octet-stream, so the global 1mb JSON parser ignores
// it and this route's own 30mb limit applies. We save it inside the CALLER'S home
// (sandbox.saveUpload contains the path) and return the absolute path, which the
// client attaches like a disk-picked file. /api/chat then re-checks that path, so
// a member can't reach outside their folder even with a hand-crafted request.
app.post('/api/upload', requireAuth, express.raw({ type: 'application/octet-stream', limit: '30mb' }), (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'empty upload' });
    }
    const name = req.query.name ? String(req.query.name) : 'file';
    const abs = saveUpload(req.user, name, req.body);
    res.json({ name: path.basename(abs), path: abs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Upload a device file INTO the folder the picker is showing (not the fixed
// `.uploads` drop /api/upload uses). Raw octet-stream body, ONE file per request —
// the client loops for multi-file / folder uploads, passing each file's relative
// path as ?rel so a whole tree is rebuilt under ?dir. saveUploadInto re-checks the
// destination with resolveBrowse on every call, so a member can only ever write
// inside their own home. 0-byte files are allowed (a folder may contain them); a
// name clash is suffixed, never overwritten. Cap is 100 MB/file (buffered in memory).
app.post('/api/upload-to', requireAuth, express.raw({ type: 'application/octet-stream', limit: '100mb' }), (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'empty upload' });
    const dir = req.query.dir ? String(req.query.dir) : '';
    if (!dir) return res.status(400).json({ error: 'dir is required' });
    const rel = req.query.rel ? String(req.query.rel) : (req.query.name ? String(req.query.name) : 'file');
    const abs = saveUploadInto(req.user, dir, rel, req.body);
    res.json({ name: path.basename(abs), path: abs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Make a new folder inside the folder the file picker is showing (right-click, or
// long-press on a phone, the listing's empty space). Same scope rule as browsing —
// createFolderIn re-checks the destination with resolveBrowse, so a member can only
// ever create one inside their own home. Returns { name, path }.
app.post('/api/mkdir', requireAuth, (req, res) => ok(res, () => createFolderIn(req.user, (req.body || {}).dir, (req.body || {}).name)));

// Live model list for the account (from Anthropic /v1/models via the Claude
// subscription token), so the picker auto-updates as new models are granted.
app.get('/api/models', requireAuth, async (_req, res) => {
  try { const r = await listModels(); res.json({ models: r.models, live: !!r.live }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Every skill installed on the box — { id, name, description } discovered live
// from ~/.claude/skills (see skills.js). Feeds both the composer's "what PlumiChat
// can make" sheet and the "/" command picker, so the UI lists exactly what the
// agent can actually use and picks up new skills automatically.
app.get('/api/skills', requireAuth, (_req, res) => { res.json({ skills: listSkills() }); });

// The slash-command palette's real list (audit F2). The client has asked for this
// since the palette shipped and shrugged at the 404 ever since; the palette has
// been running on 19 hand-typed commands while the CLI offers about 65.
//
// Everyone gets this, not just the owner — it is the composer's own picker. The
// cwd is resolved against the CALLER's root, so a member sees their own
// project-local commands and never another account's. `project` is optional: the
// list barely varies by project, and the client asks before it has one.
app.get('/api/commands', requireAuth, async (req, res) => {
  let cwd;
  try {
    // No segments = the caller's own root, the same call /api/chat uses to build
    // a member's confinement (userBrowseRoot exists but nothing imports it).
    cwd = resolveInUserRoot(req.user, ...(req.query.project ? [String(req.query.project)] : []));
  } catch (err) { return res.status(400).json({ error: err.message }); }
  try { res.json({ commands: await listCommands(cwd) }); }
  catch (err) {
    // A palette that cannot be enriched is not an error worth a red banner: the
    // client already falls back to skills + its bundled set.
    console.error(`[commands] could not read the command list: ${err.message}`);
    res.status(503).json({ error: 'command list unavailable' });
  }
});

// Owner-only: the "open the terminal in…" picker choices (HOME + each project folder),
// the design-system path for the Design sync button, and `live` = the running session
// (or null) so another device can see and re-attach to it. { targets, designSyncCwd, live }.
app.get('/api/terminal/targets', requireOwner, (_req, res) => {
  const live = terminalSessionInfo();
  res.json({
    ...terminalTargets(),
    live,
    // Additive: since the shell runs under tmux, a session can SURVIVE a server
    // restart with nobody attached — `live.live` is false but the work is still
    // there. Hoisted to the top level so the client can offer "Re-attach" without
    // having to know the shape of `live`.
    resumable: !!(live && live.resumable),
    tmux: !!(live && live.tmux),
  });
});

// Owner-only: every website this box is hosting right now — name, address, favicon —
// discovered live from what's listening + PM2 + tailscale serve (see server/sites.js),
// so a newly started project shows up on its own. Feeds the drawer's "Sites" list.
// ?refresh=1 skips the short scan cache. Owner-only because it enumerates the box's
// internals; members never see it.
app.get('/api/sites', requireOwner, async (req, res) => {
  try { res.json({ sites: await listSites({ refresh: req.query.refresh === '1' }), groups: SITE_GROUPS }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Notepad: a per-user synced scratchpad (text clips + small file drops) that
// syncs across the caller's own devices. Live sync is SSE (same transport as chat
// streaming): every device with the panel open holds a /api/notepad/stream
// connection, and any mutation broadcasts the fresh list to that user's set. The
// subscriber map is in-memory, which is fine on this single-process server (it
// mirrors how auth challenges are held). See server/notepad.js for storage.
const notepadClients = new Map(); // userKey -> Set<res>
function notepadSubscribe(key, res) {
  let set = notepadClients.get(key);
  if (!set) notepadClients.set(key, (set = new Set()));
  set.add(res);
  return () => { set.delete(res); if (!set.size) notepadClients.delete(key); };
}
function notepadBroadcast(user) {
  const set = notepadClients.get(notepad.keyOf(user));
  if (!set || !set.size) return;
  const frame = 'data: ' + JSON.stringify({ type: 'clips', clips: notepad.listClips(user) }) + '\n\n';
  for (const res of set) { try { res.write(frame); } catch { /* dead connection — its own close handler cleans up */ } }
}

app.get('/api/notepad', requireAuth, (req, res) => ok(res, () => ({ clips: notepad.listClips(req.user) })));
app.post('/api/notepad', requireAuth, (req, res) => ok(res, () => {
  const clip = notepad.addText(req.user, (req.body || {}).text); notepadBroadcast(req.user); return clip;
}));
app.patch('/api/notepad/:id', requireAuth, (req, res) => ok(res, () => {
  const clip = notepad.editText(req.user, req.params.id, (req.body || {}).text); notepadBroadcast(req.user); return clip;
}));
app.delete('/api/notepad/:id', requireAuth, (req, res) => ok(res, () => {
  const r = notepad.remove(req.user, req.params.id); notepadBroadcast(req.user); return r;
}));
app.post('/api/notepad/clear', requireAuth, (req, res) => ok(res, () => {
  const r = notepad.clearAll(req.user); notepadBroadcast(req.user); return r;
}));

// File drop: raw octet-stream body (kept clear of the global JSON parser), same
// 30 MB cap as /api/upload. Stored per-user under data/notepad-files, never in a
// project folder — these are cross-device transfers, not workspace files.
app.post('/api/notepad/file', requireAuth, express.raw({ type: 'application/octet-stream', limit: '30mb' }), (req, res) => ok(res, () => {
  const clip = notepad.addFile(req.user, req.query.name ? String(req.query.name) : 'file', req.body); notepadBroadcast(req.user); return clip;
}));
// Download a dropped file to this device. notepad.fileFor scopes the lookup to the
// caller, so an id from another account resolves to nothing (404) — no path is
// ever taken from the client.
app.get('/api/notepad/file/:id', requireAuth, (req, res) => {
  let f;
  try { f = notepad.fileFor(req.user, req.params.id); }
  catch { return res.status(404).json({ error: 'file not found' }); }
  res.download(f.storedPath, f.name, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});
// Live push. Sends an immediate snapshot so a freshly-opened panel is in sync at
// once, then streams updates until the device navigates away.
app.get('/api/notepad/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // don't let any buffering proxy sit on the stream
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  res.write('data: ' + JSON.stringify({ type: 'clips', clips: notepad.listClips(req.user) }) + '\n\n');
  const unsub = notepadSubscribe(notepad.keyOf(req.user), res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 25000);
  ping.unref?.();
  req.on('close', () => { clearInterval(ping); unsub(); });
});

// --- Web Push: "ping me when it's done", for a phone that is locked ---
// Per-user (requireAuth), NOT owner-only: a member's turn finishing matters to the
// member. Subscriptions are keyed by account inside push.js, so one account can
// neither read nor delete another's devices. The key route doubles as the
// availability probe — with no VAPID keys configured it answers available:false
// with the reason, which is the client's cue to hide the toggle instead of offering
// a button that cannot work.
app.get('/api/push/key', requireAuth, (req, res) => ok(res, () => pushStatus(req.user)));
// Register (or refresh) one browser. Accepts the raw PushSubscription JSON the
// service worker produces, or the same wrapped in { subscription } — the client
// shouldn't have to care which, and re-subscribing the same endpoint replaces it
// rather than doubling the notifications.
app.post('/api/push/subscribe', requireAuth, (req, res) => ok(res, () => {
  const body = req.body || {};
  return pushSubscribe(req.user, body.subscription || body);
}));
// Drop this device (notifications turned off, or the browser rotated its endpoint).
// Idempotent: unsubscribing something already gone answers { removed: false }.
app.post('/api/push/unsubscribe', requireAuth, (req, res) => ok(res, () => {
  const body = req.body || {};
  const sub = body.subscription || {};
  return pushUnsubscribe(req.user, String(body.endpoint || sub.endpoint || ''));
}));

// Conversation history, scoped to the caller's home.
app.get('/api/sessions', requireAuth, async (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: 'project is required' });
  try { res.json({ sessions: await listSessions(project, req.user) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/session', requireAuth, async (req, res) => {
  const { project, id } = req.query;
  if (!project || !id) return res.status(400).json({ error: 'project and id are required' });
  // getSession is ASYNC now (it streams the SDK's JSONL instead of reading it whole,
  // and returns timestamps, cost and thinking alongside the text). Without the await
  // this serialised a Promise — every reopened conversation came back empty.
  try { res.json({ messages: await getSession(project, id, req.user) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.patch('/api/sessions/:id', requireAuth, (req, res) => {
  const project = (req.body || {}).project || req.query.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  // Block renaming another account's conversation (setSessionTitle also re-checks
  // that the log lives in the caller's own project dir).
  if (!mayTouchRun(req, req.params.id)) return res.status(403).json({ error: 'not your conversation' });
  try { res.json(setSessionTitle(String(project), req.params.id, (req.body || {}).title, req.user)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Set a conversation's pin / archive flags. Scoped like rename.
app.patch('/api/sessions/:id/flags', requireAuth, (req, res) => {
  const body = req.body || {};
  const project = body.project || req.query.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  if (!mayTouchRun(req, req.params.id)) return res.status(403).json({ error: 'not your conversation' });
  const flags = {};
  if ('pinned' in body) flags.pinned = !!body.pinned;
  if ('archived' in body) flags.archived = !!body.archived;
  try { res.json(setSessionFlags(String(project), req.params.id, flags, req.user)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Permanently delete a conversation (its SDK session log + title override).
app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const project = req.query.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  // Refuse while a turn is still writing to this conversation's log; the user
  // can stop it first. Also blocks touching another account's active run.
  const run = getRun(String(id));
  if (run && run.status === 'running') {
    return res.status(409).json({ error: 'This conversation is still running — stop it first.' });
  }
  if (!mayTouchRun(req, id)) return res.status(403).json({ error: 'not your conversation' });
  try { const out = deleteSession(project, id, req.user); forgetContext(id); res.json(out); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// --- Context, rewind and fork (audit F4) ------------------------------------
// The SDK exposes these on a live Query; PlumiChat runs one process per turn, so
// server/context.js reaches them through a control-only query that resumes the
// transcript and never sends a prompt. See the header there for why that is not
// a workaround for the missing persistent process but simply the cheaper path.

// The context ring. Two deliberately different costs:
//   no flag    — hand back the snapshot already in memory (or null). Free, and the
//                only thing a page reload should ever ask for: opening five
//                conversations must not start five CLIs.
//   ?refresh=1 — actually read the session (~1s CLI spawn, no tokens).
// `stale` says which one you got, so the ring never presents an old figure as live.
app.get('/api/context', requireAuth, async (req, res) => {
  const { project, id, refresh } = req.query;
  if (!project || !id) return res.status(400).json({ error: 'project and id are required' });
  if (!mayTouchRun(req, id)) return res.status(403).json({ error: 'not your conversation' });
  const cached = contextSnapshot(String(id));
  if (!refresh) return res.json({ context: cached, stale: true });
  try { res.json({ context: await readContext(String(project), String(id), req.user), stale: false }); }
  catch (err) {
    // A conversation whose context can't be read is not an error worth blocking the
    // UI with — fall back to whatever was cached and let the client label it.
    if (cached) return res.json({ context: cached, stale: true, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

// The user messages a rewind can target, with the SDK's own uuids.
app.get('/api/sessions/:id/rewind-points', requireAuth, async (req, res) => {
  const project = req.query.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  if (!mayTouchRun(req, req.params.id)) return res.status(403).json({ error: 'not your conversation' });
  try { res.json({ points: await rewindPoints(String(project), req.params.id, req.user) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Preview (dryRun, the default) or perform a file rewind. Refused while a turn is
// running: restoring files under a live agent would fight its own edits.
app.post('/api/sessions/:id/rewind', requireAuth, async (req, res) => {
  const body = req.body || {};
  const project = body.project || req.query.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  if (!mayTouchRun(req, req.params.id)) return res.status(403).json({ error: 'not your conversation' });
  const run = getRun(String(req.params.id));
  if (run && run.status === 'running') {
    return res.status(409).json({ error: 'This conversation is still running — stop it first.' });
  }
  try {
    res.json(await rewind(String(project), req.params.id, req.user, body.messageId, { dryRun: body.dryRun !== false }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Branch a conversation into a new one. The source is copied, never moved, so the
// original stays exactly where it was in the drawer.
app.post('/api/sessions/:id/fork', requireAuth, async (req, res) => {
  const body = req.body || {};
  const project = body.project || req.query.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  if (!mayTouchRun(req, req.params.id)) return res.status(403).json({ error: 'not your conversation' });
  try {
    res.json(await fork(String(project), req.params.id, req.user, {
      upToMessageId: body.upToMessageId, title: body.title,
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// --- Split-view profiles: named board arrangements (layout + which conversation
// sits in each slot), saved PER ACCOUNT so they follow the user across devices.
// The client owns the list shape; the server just validates, caps, and persists.
const GRID_LAYOUTS = new Set(['2h', '2v', '3t', '3b', '3c', '4']);
const gridKey = (u) => String((u && u.id) || '__owner__');
function sanitizeGridProfiles(list) {
  if (!Array.isArray(list)) throw new Error('profiles must be an array');
  if (list.length > 12) throw new Error('too many profiles (max 12)');
  return list.map((p, i) => {
    if (!p || typeof p !== 'object') throw new Error('bad profile');
    const layout = String(p.layout || '');
    if (!GRID_LAYOUTS.has(layout)) throw new Error('unknown layout');
    const slots = (Array.isArray(p.slots) ? p.slots : []).slice(0, 6).map((s) => ({
      project: String((s && s.project) || '').slice(0, 160),
      conv: String((s && s.conv) || '').slice(0, 160),
    }));
    return {
      id: String(p.id || '').slice(0, 40) || crypto.randomUUID().slice(0, 8),
      name: String(p.name || '').trim().slice(0, 60) || `Profile ${i + 1}`,
      layout,
      slots,
    };
  });
}
app.get('/api/grid/profiles', requireAuth, (req, res) => ok(res, () => {
  const all = readStore('grid-profiles', {});
  return { profiles: all[gridKey(req.user)] || [] };
}));
app.put('/api/grid/profiles', requireAuth, (req, res) => ok(res, () => {
  const profiles = sanitizeGridProfiles((req.body || {}).profiles);
  updateStore('grid-profiles', (all) => { all[gridKey(req.user)] = profiles; }, {});
  return { profiles };
}));

// Pipe a run's events to an SSE response. A client disconnect only UNSUBSCRIBES;
// it never aborts the run (a turn survives a refresh). Self-closes on 'done'.
function streamRun(res, key) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders?.();
  let closed = false;
  // Heartbeat: long silent tool runs would otherwise leave the stream idle for
  // minutes, and proxies (tailscale serve) may drop a connection that looks dead.
  const ping = setInterval(() => {
    if (closed) return;
    try { res.write(':ping\n\n'); } catch { /* socket gone */ }
  }, 25000);
  const send = (event) => {
    if (closed) return;
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* socket gone */ }
    if (event.type === 'done') { closed = true; clearInterval(ping); try { res.end(); } catch { /* already gone */ } }
  };
  const unsub = subscribe(key, send);
  if (!unsub) { send({ type: 'error', message: 'no active run for this conversation' }); send({ type: 'done' }); return; }
  res.on('close', () => { closed = true; clearInterval(ping); unsub(); });
}

// A run belongs to the caller (or the caller is admin). Guards attach/stop so a
// member can't follow or kill another account's conversation.
function mayTouchRun(req, key) {
  const run = getRun(String(key));
  if (!run) return true; // unknown key → let streamRun emit the friendly 'no active run'
  if (isAdminUser(req.user)) return true;
  return !run.userId || run.userId === (req.user && req.user.id);
}

// Start a turn (detached run) and stream it.
app.post('/api/chat', requireAuth, (req, res) => {
  const { project, prompt, sessionId, model, effort, fastMode, context1m, permissionMode, attachments } = req.body || {};
  const hasAtts = Array.isArray(attachments) && attachments.length > 0;
  if (!project || (!prompt && !hasAtts)) {
    return res.status(400).json({ error: 'project and a prompt (or attachment) are required' });
  }
  let cwd;
  try {
    cwd = resolveInUserRoot(req.user, project);
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch (err) {
    return res.status(400).json({ error: `invalid project: ${err.message}` });
  }

  // Terminal-style skill picker: a leading "/<skill-id>" explicitly selects a
  // skill. The browser shows the raw "/pptx …" in the sent bubble; here we turn
  // it into a plain instruction the model will honor (and that reads fine when
  // the conversation is replayed from the SDK log), stripping the slash token.
  // A "/word" that isn't an installed skill is left as ordinary text.
  const picked = matchSkillCommand(prompt || '');
  let finalPrompt = picked
    ? `Use the "${picked.id}" skill.${picked.rest ? ' ' + picked.rest : ''}`
    : (prompt || '');

  // Disk files AND folders the user attached (path-reference delivery): each must
  // pass the SAME scope check as browsing, so a member can't smuggle a path
  // outside their home by hand-crafting the request. We hand Claude the absolute
  // paths and let its own tools open files / explore folders on demand. Folders
  // make it possible to work across more than one project in a single chat.
  if (hasAtts) {
    const files = [], dirs = [];
    try {
      for (const a of attachments.slice(0, 25)) {
        const abs = resolveBrowse(req.user, String(a));
        const st = fs.statSync(abs);
        if (st.isDirectory()) dirs.push(abs);
        else if (st.isFile()) files.push(abs);
        else throw new Error('not a file or folder');
      }
    } catch (err) {
      return res.status(400).json({ error: `invalid attachment: ${err.message}` });
    }
    const blocks = [];
    if (files.length) {
      // Open each with the tool that fits its type: the document skills (which use
      // python-pptx / openpyxl / pdfplumber / etc.) can actually parse binary
      // Office and PDF files, whereas the Read tool only handles text/code — so
      // don't steer the agent at Read for an .xlsx/.docx/.pptx/.pdf.
      const lead = 'The user attached these file(s) from disk' +
        (finalPrompt ? ' for this message' : '') +
        '. Open each with whatever tool fits its type — your document skills ' +
        '(pptx / docx / xlsx / pdf) for Office and PDF files, your Read tool for text or code:';
      blocks.push(lead + '\n' + files.map((p) => '- ' + p).join('\n'));
    }
    if (dirs.length) {
      blocks.push(
        'The user attached these folder(s) from disk. Explore them as needed with your LS, Glob, Grep and Read tools — each may be a separate project:\n' +
        dirs.map((p) => '- ' + p).join('\n'));
    }
    const head = blocks.join('\n\n');
    finalPrompt = head + (finalPrompt ? '\n\n' + finalPrompt : '');
  }

  // Members are hard-confined to their home (and lose Bash); admins are not.
  const confineHome = isAdminUser(req.user) ? null : resolveInUserRoot(req.user);
  // Model-switch policy: unless the workspace allows it, a member's requested
  // model is ignored and the turn runs on the server default (claude.js picks it
  // when model is falsy). Admins/owner always choose freely.
  let effModel = model;
  if (!isAdminUser(req.user) && getWorkspace().allowMemberSwitch === false) effModel = undefined;
  // Approval-mode ("restriction mode") selector: only the owner/admins may relax
  // it. acceptEdits/bypass make the SDK skip canUseTool for auto-approved tools —
  // and canUseTool is exactly what confines a member to their own home — so a
  // member's turn is ALWAYS forced back to 'default' no matter what they request.
  const effMode = isAdminUser(req.user) ? permissionMode : 'default';
  let run;
  try {
    run = startRun({ project, cwd, prompt: finalPrompt, sessionId, model: effModel, effort, fastMode, context1m, permissionMode: effMode, confineHome, userId: req.user.id });
  } catch (err) {
    // startRun throws three things, and they mean different things to a client:
    // the duplicate-conversation guard ("a turn is already running here") stays a
    // 409, while the H6 resource caps are a temporary "the box is full" → 429, so
    // the UI can offer "try again in a moment" instead of "you did something wrong".
    // Matched on the message because runs.js throws plain Errors — keep these two
    // prefixes in step with the throws in startRun().
    // …and a spent workspace budget is a third thing again: not "you did something
    // wrong" and not "try again in a moment", but "blocked until someone changes a
    // setting". 403 says that; 429 would invite a pointless retry.
    if (/^The workspace budget/.test(err.message || '')) {
      return res.status(403).json({ error: err.message });
    }
    const capped = /^(You already have|The box is busy with)/.test(err.message || '');
    return res.status(capped ? 429 : 409).json({ error: err.message });
  }
  streamRun(res, run.key);
});

app.get('/api/chat/attach', requireAuth, (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'key is required' });
  if (!mayTouchRun(req, key)) return res.status(403).json({ error: 'not your conversation' });
  streamRun(res, String(key));
});

// Which of the caller's turns are alive — lets the UI reattach after a refresh.
// listRuns() now also returns turns that ENDED in the last ten minutes, with their
// status/reason/endedAt, so a phone that was asleep when a turn finished collects
// the ending instead of showing a half-written answer forever (audit H2).
app.get('/api/runs', requireAuth, (req, res) => {
  const admin = isAdminUser(req.user);
  res.json({ runs: listRuns().filter((r) => admin || !r.userId || r.userId === req.user.id) });
});

app.post('/api/chat/stop', requireAuth, (req, res) => {
  const { key, reason } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key is required' });
  if (!mayTouchRun(req, key)) return res.status(403).json({ error: 'not your conversation' });
  if (!stopRun(String(key), reason)) return res.status(404).json({ error: 'no running turn for this conversation' });
  res.json({ ok: true });
});

// Save arbitrary content to a file inside one of the caller's projects (sandboxed).
app.post('/api/save', requireAuth, (req, res) => {
  const { project, filename, content } = req.body || {};
  if (!project || !filename || content == null) {
    return res.status(400).json({ error: 'project, filename and content are required' });
  }
  try {
    const target = resolveInUserRoot(req.user, project, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    res.json({ ok: true, path: path.relative(userHome(req.user), target) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Convert an answer's markdown into a downloadable file and stream it back as an
// attachment (so the device saves rather than navigates). Word/PowerPoint go through
// pandoc; Excel is built from the answer's own tables; PDF is rendered by headless
// Chromium. Clients that CAN print do their own PDF instead — the device's fonts beat
// the box's for Traditional Chinese — so PDF only reaches here from the iOS home-screen
// web app, which has no print UI at all.
app.post('/api/export', requireAuth, async (req, res) => {
  const { format, markdown, filename } = req.body || {};
  try {
    // A safe download name: drop control chars and slashes, cap the length. The
    // ascii copy is the legacy fallback; filename* carries the real (maybe CJK) name.
    const raw = String(filename == null ? '' : filename)
      .replace(/[\u0000-\u001f/\\]+/g, ' ').trim().slice(0, 80) || 'plumi-answer';
    const ascii = raw.replace(/[^\x20-\x7e]/g, '').replace(/"/g, '').trim() || 'plumi-answer';
    const { buffer, mime, ext } = await exportAnswer(format, markdown, raw);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition',
      `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(raw + '.' + ext)}`);
    res.send(buffer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Settings ---
app.get('/api/settings/profile', requireAuth, (req, res) => ok(res, () => profileView(req.user)));
app.put('/api/settings/profile', requireAuth, (req, res) => ok(res, () => {
  if (!req.user.id) throw new Error('register your account first');
  return updateUserProfile(req.user.id, req.body || {});
}));
app.put('/api/settings/avatar', requireAuth, (req, res) => ok(res, () => {
  if (!req.user.id) throw new Error('register your account first');
  return updateUserAvatar(req.user.id, (req.body || {}).data);
}));
app.delete('/api/settings/avatar', requireAuth, (req, res) => ok(res, () => {
  if (!req.user.id) throw new Error('register your account first');
  return removeUserAvatar(req.user.id);
}));
// Model / effort / approval defaults, per ACCOUNT rather than per browser, so one
// choice holds on the phone, the Mac, and inside a split-view pane. Not admin
// gated: everyone gets their own. updateUserDefaults clamps a member's approval
// mode to 'default' the same way /api/chat does, so this cannot widen anyone's
// permissions — it only remembers a preference the turn would have honoured.
app.put('/api/settings/defaults', requireAuth, (req, res) => ok(res, () => {
  if (!req.user.id) throw new Error('register your account first');
  return updateUserDefaults(req.user.id, req.body || {});
}));
app.get('/api/settings/workspace', requireAuth, (_req, res) => ok(res, () => getWorkspace()));
// This month's metered usage, against the workspace budget. Per-user figures are
// admin-shaped data and ride on /api/members instead; this is just the total.
app.get('/api/spend', requireAuth, (_req, res) => ok(res, () => spendSummary()));
app.put('/api/settings/workspace', requireAdmin, (req, res) => ok(res, () => setWorkspace(req.body || {})));

// Change the Basic-auth lifeline password. OWNER-only (audit H5): this rotates the
// recovery credential for the whole box — the way back in when accounts break — and
// an invited admin is a guest here, not a key-holder.
app.post('/api/settings/password', requireOwner, (req, res) => ok(res, () =>
  changePassword(req.body || {}, { currentPass: authPass, apply: (next) => { authPass = next; } })));

// Restart the app process via PM2 (admin only) — lets the operator redeploy from
// a phone. Respond FIRST, then trigger the restart a beat later so this response
// flushes before the process is replaced; the client polls /api/health to detect
// the new process coming back online.
const PM2_APP_NAME = process.env.PM2_APP_NAME || 'plumi';
app.post('/api/system/restart', requirePowerOff, (req, res) => {
  res.json({ ok: true, app: PM2_APP_NAME });
  setTimeout(() => {
    exec('pm2 restart ' + PM2_APP_NAME, (err, _stdout, stderr) => {
      if (err) console.error('pm2 restart failed:', stderr || err.message);
    });
  }, 350);
});

// Cleanly power the whole Windows PC off (owner or an owner-granted account) so
// the operator can then cut the smart plug without a hard crash. We invoke the
// real Windows shutdown from WSL. A short countdown (`/t`, which also implies
// `/f`) guarantees the box actually goes down instead of stalling on a blocking
// app, while still being a proper OS shutdown — not a power cut. The countdown
// leaves a window to abort from the UI. No user input goes into the command.
const SHUTDOWN_DELAY_SECS = 6;

// Powering the machine off is the one control whose command differs on every OS
// AND needs privileges everywhere, so platform.js returns the argv to try and this
// reports the failure honestly rather than pretending. execFile (argv, no shell)
// means nothing user-supplied can reach a command line — there is no user input
// here at all, and that stays true by construction.
function powerRoute(action, label) {
  return (req, res) => {
    const cmd = powerCommand(action, SHUTDOWN_DELAY_SECS);
    if (!cmd) {
      return res.status(501).json({ error: `No supported way to ${label} on ${platformLabel()}` });
    }
    execFile(cmd.cmd, cmd.args, (err, stdout, stderr) => {
      const out = ((stderr || '') + (stdout || '')).trim();
      if (action === 'cancel') {
        // Exits non-zero when nothing is pending — that is "already clear", not a failure.
        if (err && !/no.*shutdown|1116|not.*scheduled/i.test(out)) {
          return res.status(400).json({ error: out || err.message || 'could not cancel' });
        }
        return res.json({ ok: true });
      }
      if (err) {
        console.error(`${label} failed:`, out || err.message);
        return res.status(500).json({ error: out || err.message || `could not schedule ${label}` });
      }
      res.json({ ok: true, delay: SHUTDOWN_DELAY_SECS });
    });
  };
}

// A scheduled countdown returns immediately, so — unlike the PM2 restart, which
// replaces this very process — we can wait for the exit code and only report
// success once the OS has actually accepted it. The countdown is the abort window.
app.post('/api/system/shutdown', requirePowerOff, powerRoute('shutdown', 'shut down'));
// Same idea, but reboot instead of powering off. If the machine is on a smart plug,
// that plug must stay ON for a reboot or it will never come back.
app.post('/api/system/reboot', requirePowerOff, powerRoute('reboot', 'reboot'));
// Abort a pending shutdown or reboot while the countdown is still running (Cancel).
app.post('/api/system/shutdown/abort', requirePowerOff, powerRoute('cancel', 'cancel'));

// Members + invites (admin manages; everyone can read the roster).
app.get('/api/members', requireAuth, (req, res) => ok(res, () => ({ members: membersView(req.user.id) })));
app.delete('/api/members/:id', requireAdmin, (req, res) => ok(res, () => removeUser(req.user, req.params.id)));
// Grant/revoke a member's power-off access (setPowerOff enforces owner-only).
app.put('/api/members/:id/poweroff', requireAuth, (req, res) => ok(res, () => setPowerOff(req.user, req.params.id, !!(req.body || {}).allowed)));

// Pending invites, expired ones already dropped by users.js. Entries carry
// `expiresAt` so the panel can say "expires in 3 days" instead of implying forever.
app.get('/api/invites', requireAdmin, (req, res) => ok(res, () => ({ invites: pendingInvites(req.user) })));
// Body: { role, ttlDays? }. The role match is case-insensitive server-side (the UI
// sends the display label 'Admin'), and ttlDays rides through untouched — users.js
// clamps it and falls back to the box default.
app.post('/api/invites', requireAdmin, (req, res) => ok(res, () => {
  const inv = createInvite(req.user, req.body || {});
  const { origin } = rpInfo(req);
  return {
    token: inv.token, role: inv.role, expiresAt: inv.expiresAt || null,
    url: origin + '/login?invite=' + encodeURIComponent(inv.token),
  };
}));
// Revoke a link before anyone spends it. requireAdmin admits the owner too (the
// owner IS an admin here and in users.js), so the owner can always clean up.
app.delete('/api/invites/:token', requireAdmin, (req, res) => ok(res, () => revokeInvite(req.user, req.params.token)));


// --- Operations (OWNER-only) ---
// These were requireAdmin, which was far too wide (audit H5): the runner executes
// autonomous agents against ANY root project, edits the real working tree, and
// ships with a commit + push under this box's git identity. An invited admin is a
// guest on this machine — they must not be able to spend the owner's rate limit,
// rewrite the owner's code, or push to the owner's GitHub. Members never had it and
// still don't: the runner isn't per-user sandboxed.
app.get('/api/ops/tasks', requireOwner, (_req, res) => ok(res, () => ({ tasks: listTasks() })));
app.post('/api/ops/tasks', requireOwner, (req, res) => ok(res, () => createTask(req.body || {})));
app.patch('/api/ops/tasks/:id', requireOwner, (req, res) => ok(res, () => editTask(req.params.id, req.body || {})));
app.delete('/api/ops/tasks/:id', requireOwner, (req, res) => ok(res, () => deleteTask(req.params.id)));
app.post('/api/ops/tasks/:id/cancel', requireOwner, (req, res) => ok(res, () => cancelTask(req.params.id)));
// Also the RETRY button: runNow now restarts an error/cancelled/apply_failed task,
// and throws a specific explanation for the ones whose changes already reached the
// working tree. ok() turns that throw into a 400 carrying the message verbatim,
// which is exactly what the operator needs to read.
app.post('/api/ops/tasks/:id/run', requireOwner, (req, res) => ok(res, () => runNow(req.params.id)));
app.post('/api/ops/tasks/:id/reject', requireOwner, (req, res) => ok(res, () => rejectTask(req.params.id)));
app.post('/api/ops/tasks/:id/accept', requireOwner, async (req, res) => {
  try { res.json(await acceptTask(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// The board's own vocabulary — categories, the status groups, the retry set, the
// project picker, the fix-attempt cap — so the client stops keeping a hard-coded
// copy that silently drifts from the runner's.
// The board, pushed instead of polled (audit §4.3). It used to re-fetch every task
// — logs and all — every 2.5 seconds for as long as the page was open, which on a
// phone is a request every 2.5 seconds forever. operations.js now announces every
// write to the task store, so a connected board hears about a status change within
// a blink and stays silent the rest of the time.
//
// The client still keeps a slow poll as a fallback: SSE is the fast path, not the
// only one, and a board that silently stopped updating would be worse than one
// that updates slowly.
const opsClients = new Set();
function opsBroadcast() {
  if (!opsClients.size) return;
  let frame;
  try { frame = 'data: ' + JSON.stringify({ type: 'tasks', tasks: listTasks() }) + '\n\n'; }
  catch { return; }   // an unserialisable board is not worth killing the stream over
  for (const res of opsClients) { try { res.write(frame); } catch { /* its close handler cleans up */ } }
}
onOpsChange(opsBroadcast);

app.get('/api/ops/stream', requireOwner, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // don't let any buffering proxy sit on the stream
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  try { res.write('data: ' + JSON.stringify({ type: 'tasks', tasks: listTasks() }) + '\n\n'); } catch { /* ignore */ }
  opsClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 25000);
  ping.unref?.();
  req.on('close', () => { clearInterval(ping); opsClients.delete(res); });
});

app.get('/api/ops/meta', requireOwner, (_req, res) => ok(res, () => opsMeta()));
// Is the runner busy, and with what? Cheap enough to poll, and it's the signal a
// sleep/deploy controller needs before it touches anything.
app.get('/api/ops/status', requireOwner, (_req, res) => ok(res, () => opsStatus()));
// The captured diff for the human gate: see the change BEFORE approving it. 404
// rather than 400 when it's absent — "there is no patch here" is a missing thing,
// and taskPatch's message already explains which of the reasons it is.
app.get('/api/ops/tasks/:id/patch', requireOwner, (req, res) => {
  try { res.json(taskPatch(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

// --- Engine updates (OWNER-only) ---
// PlumiChat updating the Claude engine it runs on, from the phone. OWNER-only for the
// same reason Operations is: this stages a real `npm install`, spawns a canary CLI
// on a 5.9 GB box, and the CLI target repoints ~/.local/bin/claude under any live
// terminal session — an invited admin is a guest here, not a key-holder. Every
// safety rail lives in server/engine.js (never the live clone, never a commit,
// never pm2); these handlers only expose it. See docs/ENGINE-UPDATES.md.

// What am I on, what is published, how far behind. `?refresh=1` forces past the
// 30-minute cache (npm dist-tags + the two changelogs are network calls), so the
// plain call stays cheap enough for the panel to open with.
// --- Plugins and MCP (audit F6) ---------------------------------------------
// Owner-only, and not merely for tidiness: installing a plugin runs code from a
// third-party marketplace on this box under the owner's account.

// Which MCP servers this project's engine has, and what state they are in. Takes
// a few seconds by design — servers connect in the background and the answer is
// only true once they have stopped saying 'pending' (see plugins.js).
app.get('/api/mcp', requireOwner, async (req, res) => {
  const project = req.query.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  try { res.json(await mcpStatus(String(project))); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Pick up what changed on disk (a newly installed plugin, an authorised server).
app.post('/api/mcp/reload', requireOwner, async (req, res) => {
  const project = (req.body || {}).project || req.query.project;
  if (!project) return res.status(400).json({ error: 'project is required' });
  try { res.json(await reloadEngineParts(String(project))); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Installed + available plugins. Cached for half an hour: `--available` fetches
// from every configured marketplace, which is a network call.
app.get('/api/plugins', requireOwner, async (req, res) => {
  try { res.json(await pluginCatalogue({ refresh: !!req.query.refresh })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/plugins/install', requireOwner, async (req, res) => {
  try { res.json(await installPlugin((req.body || {}).id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/plugins/uninstall', requireOwner, async (req, res) => {
  try { res.json(await uninstallPlugin((req.body || {}).id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/engine/status', requireOwner, async (req, res) => {
  try { res.json(await engineStatus({ refresh: req.query.refresh === '1' })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// "What's new since your version", per engine, parsed from the cached changelogs.
// `?sdk=` / `?cli=` override the since-versions so the panel can show a chosen range.
app.get('/api/engine/whats-new', requireOwner, async (req, res) => {
  try {
    res.json(await whatsNew({
      sinceSdk: req.query.sdk ? String(req.query.sdk) : undefined,
      sinceCli: req.query.cli ? String(req.query.cli) : undefined,
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The last N attempts, successful or not. When turns start failing three days
// later, "what did I change to the engine, and when" is the first question.
app.get('/api/engine/log', requireOwner, (req, res) =>
  ok(res, () => ({ updates: updateLog(Number(req.query.limit) || 20) })));

// A staged update takes minutes — a ~215 MB download, then a real canary turn in a
// child process — which is far longer than a phone will hold a request open. So the
// POST starts the job DETACHED and returns immediately, and the client polls
// /api/engine/update/status for the verdict. One at a time: engine.js refuses a
// second concurrently, but the record here has to stay honest too.
let engineJob = null;   // { id, startedAt, finishedAt, running, target, version, dryRun, result, error }

// Start an update. `dryRun` DEFAULTS TO TRUE and only a literal `dryRun: false` in
// the body performs a real one: the safe call proves the new version installs and
// answers, without moving a file the app loads, so a mistyped or replayed request
// can never bump anything. Nothing here restarts anything — a green real run leaves
// the DEV repo's package.json bumped and the human ship flow (commit → push → pull →
// restart) still to do, exactly as CLAUDE.md describes.
app.post('/api/engine/update', requireOwner, (req, res) => {
  const body = req.body || {};
  if (engineJob && engineJob.running) {
    return res.status(409).json({ error: 'an engine update is already running', update: engineJob });
  }
  const job = {
    id: crypto.randomUUID().slice(0, 8),
    startedAt: Date.now(), finishedAt: null, running: true,
    target: String(body.target || 'sdk'),
    version: body.version ? String(body.version) : null,
    dryRun: body.dryRun !== false,
    prune: body.prune === true,
    result: null, error: null,
  };
  engineJob = job;
  // Deliberately not awaited: this promise outlives the request. engine.js validates
  // target/version itself and returns { ok:false, error } rather than throwing, so a
  // bad request surfaces on the job record instead of on a socket that is long gone.
  applyUpdate({
    target: job.target,
    version: job.version || undefined,
    dryRun: job.dryRun,
    prune: job.prune,
    // runs.js is the authority on "is a turn in flight". The canary spawns another
    // ~340 MB CLI, so staging must not start next to a live turn.
    isBusy: () => listRuns().some((r) => r.status === 'running'),
  }).then(
    (r) => { job.result = r; },
    (err) => { job.error = String((err && err.message) || err); },
  ).finally(() => { job.running = false; job.finishedAt = Date.now(); });
  res.status(202).json({ ok: true, update: job });
});

// Poll the detached job. The last job is kept after it finishes, so a phone that
// slept through the update still collects the verdict instead of losing it.
app.get('/api/engine/update/status', requireOwner, (_req, res) => {
  res.json({ running: !!(engineJob && engineJob.running), update: engineJob });
});

// --- Deploy (OWNER-only) ---
// The two-copy deploy from CLAUDE.md, as buttons. This box runs the code twice: the
// dev working copy (where the work happens) and the separately-served clone the
// phone is actually talking to. Shipping is commit+push in dev → pull in live →
// restart. These two routes own the middle step and nothing else: they READ both
// HEADs, they fast-forward the live clone, and — only when the lockfile moved and no
// turn is running — they `npm ci` there. They never commit, never push, and NEVER restart PM2
// — the session asking for the deploy is streaming through that very process, so a
// restart from in here would kill the request mid-flight. `restartRequired` comes
// back instead and the user taps the existing side-menu control (/api/system/restart)
// after the reply has landed. OWNER-only: this moves the code the whole box runs.
// The separately-served clone of a two-copy deploy. Empty unless configured, which
// is what makes the Deploy surface report itself unavailable instead of guessing.
const LIVE_CLONE = process.env.PLUMI_LIVE_CLONE ? path.resolve(process.env.PLUMI_LIVE_CLONE) : '';
// Same npm-through-node trick engine.js documents: PM2 captured a minimal PATH and
// npm's `#!/usr/bin/env node` shebang dies with ENOENT there. process.execPath is
// always the node this process is running on.
const NPM_CLI = path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const GIT_MS = 15 * 1000;
const PULL_MS = 3 * 60 * 1000;
const NPM_CI_MS = 10 * 60 * 1000;

// One read of a checkout: HEAD, its short form, the branch, and where its upstream
// currently points. All four are plain reads and NOTHING here fetches, so `upstream`
// is only as fresh as that clone's last fetch — the honest "is there something to
// deploy" signal is dev HEAD vs live HEAD, because the ship flow pushes from dev.
async function repoHead(dir) {
  const [head, short, branch, up] = await Promise.all([
    sh('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: GIT_MS }),
    sh('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { timeout: GIT_MS }),
    sh('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: GIT_MS }),
    sh('git', ['-C', dir, 'rev-parse', '@{u}'], { timeout: GIT_MS }),
  ]);
  return {
    path: dir,
    head: head.ok ? head.out : null,       // not a checkout / no git → null, never a throw
    short: short.ok ? short.out : null,
    branch: branch.ok ? branch.out : null,
    upstream: up.ok ? up.out : null,       // null when the branch tracks nothing
  };
}

// Read-only: is the live clone on the commit the DEV copy is on, and is it behind
// its own upstream? Cheap enough for the settings page to open with.
//
// `dev` is engine.js's explicit DEV_REPO (the running checkout, or PLUMI_DEV_REPO), never
// REPO_ROOT: this file ships to the live clone and runs FROM it, so "the checkout
// this process started from" IS the live clone there — comparing it with itself
// reported "in sync" forever and left the Pull button disabled on the one server
// where it matters. `runningFrom` says which copy answered, for the UI.
// One tap: stage, canary, commit, push, pull, install, restart. Owner-only and
// refused while any turn is running, because the install deletes node_modules
// and every turn spawns its CLI from in there. The response comes back BEFORE
// the restart, and a detached watchdog restores the previous modules if the
// server does not answer again — see server/engine-ship.js for why that has to
// live outside this process.
app.post('/api/engine/ship', requireOwner, async (req, res) => {
  const body = req.body || {};
  const r = await shipEngineUpdate({
    target: body.target || 'sdk',
    version: body.version,
    isBusy: () => listRuns().some((run) => run.status === 'running'),
  });
  res.status(r.ok ? 202 : 409).json(r);
});

// Readable after the restart: the job record is persisted, so the phone can ask
// how it went of a process that never saw it happen. `watchdog` is what the
// rollback left behind, if it ran at all.
app.get('/api/engine/ship/status', requireOwner, (_req, res) => {
  res.json({ ...shipStatus(), watchdog: lastWatchdogOutcome() });
});

// Deploy only means anything in a TWO-COPY install: a tree you edit plus a separate
// clone that is actually served. A single-copy install (the normal case) has no
// second tree to fast-forward, so these answer 501 and the UI hides the row —
// see server/capabilities.js and js/capabilities.js.
function requireTwoCopyDeploy(_req, res, next) {
  if (!LIVE_CLONE) {
    return res.status(501).json({
      error: 'No separate live clone is configured. Set PLUMI_LIVE_CLONE only if you serve a different checkout from the one you edit.',
    });
  }
  next();
}

app.get('/api/deploy/status', requireOwner, requireTwoCopyDeploy, async (_req, res) => {
  const [live, dev] = await Promise.all([repoHead(LIVE_CLONE), repoHead(DEV_REPO)]);
  res.json({
    live, dev, runningFrom: REPO_ROOT,
    // "Deployed" means the live clone is sitting on the same commit as the dev copy.
    // (A dev commit that has not been PUSHED yet also reads as "behind" — the pull
    // then finds nothing, and the sheet says to push first.)
    inSync: !!(live.head && dev.head && live.head === dev.head),
    behindUpstream: !!(live.head && live.upstream && live.head !== live.upstream),
  });
});

// Fast-forward the live clone. One at a time — two taps must not run two pulls into
// the same working tree.
let pulling = false;
app.post('/api/deploy/pull', requireOwner, requireTwoCopyDeploy, async (_req, res) => {
  if (pulling) return res.status(409).json({ error: 'a deploy is already running' });
  pulling = true;
  try {
    const before = await sh('git', ['-C', LIVE_CLONE, 'rev-parse', 'HEAD'], { timeout: GIT_MS });
    if (!before.ok) return res.status(400).json({ error: 'live clone unreadable: ' + before.err });
    // --ff-only: this is a deploy, never a merge. If the live clone has drifted (an
    // emergency install made straight into it, say) the pull refuses loudly instead
    // of inventing a merge commit in a tree nobody is watching.
    const pull = await sh('git', ['-C', LIVE_CLONE, 'pull', '--ff-only'], { timeout: PULL_MS });
    const after = await sh('git', ['-C', LIVE_CLONE, 'rev-parse', 'HEAD'], { timeout: GIT_MS });
    if (!pull.ok) {
      return res.status(400).json({ error: (pull.err || 'git pull failed').slice(-1500), head: after.ok ? after.out : null });
    }
    const moved = !!(after.ok && after.out !== before.out);

    // Dependencies, and only when the lockfile actually moved between those two
    // commits. Both shas come from git itself, never from the request.
    let deps = { ran: false, reason: moved ? 'package-lock.json unchanged' : 'nothing was pulled' };
    if (moved) {
      const changed = await sh('git', ['-C', LIVE_CLONE, 'diff', '--name-only', before.out, after.out], { timeout: GIT_MS });
      if (changed.ok && changed.out.split('\n').some((f) => f.trim() === 'package-lock.json')) {
        if (listRuns().some((r) => r.status === 'running')) {
          // `npm ci` DELETES node_modules before reinstalling, and every chat turn
          // spawns its CLI binary from in there — doing that under a live turn breaks
          // it, including the turn that asked for the deploy. Report it instead; the
          // operator re-taps Deploy once the box is idle.
          deps = { ran: false, required: true, reason: 'a chat turn is running — run the deploy again when the box is idle' };
        } else {
          const ci = await sh(process.execPath, [NPM_CLI, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
            { cwd: LIVE_CLONE, timeout: NPM_CI_MS });
          deps = { ran: true, ok: ci.ok, error: ci.ok ? null : (ci.err || '').slice(-1500) };
        }
      }
    }

    // Restart guidance — the one thing the UI reads to decide whether to offer the
    // Restart step. `npm ci` REMOVES node_modules before it reinstalls, so a failed
    // or interrupted run leaves a live clone that cannot boot; and a lockfile change
    // whose install was skipped can mean server code importing a package that is
    // not there yet. A restart into either state fails at import time, PM2 backs
    // off, and the remote lifeline is gone. So restartRequired is true ONLY when the
    // tree is known-complete, and `warning` spells out what to do first otherwise.
    const depsBroken = !!(deps.ran && !deps.ok);
    const depsPending = !!(deps.required && !deps.ran);
    let warning = null;
    if (depsBroken) {
      warning = 'npm ci FAILED in the live clone, so its node_modules may be incomplete. '
        + 'Do NOT restart the server until `npm ci` succeeds there (over SSH): a restart '
        + 'now could fail to boot and take the remote lifeline with it.';
    } else if (depsPending) {
      warning = 'package-lock.json changed but the dependencies were not installed because a '
        + 'chat turn is running. Do NOT restart yet — run Deploy again once the box is idle '
        + 'so `npm ci` can complete first.';
    }

    res.json({
      ok: true, moved, from: before.out, to: after.ok ? after.out : null,
      output: (pull.out || '').slice(-2000), deps, warning,
      // public/* is live on a browser reload, but any server/*.js change needs the
      // process replaced — and only the user does that, from the side menu, after
      // this reply has flushed. False when nothing moved: saying "restart" then
      // would be a lie. Also false while `warning` is set (see above).
      restartRequired: moved && !depsBroken && !depsPending,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    pulling = false;
  }
});

// --- Auth: login / register screen + session cookies ---

// One login screen, wearing whichever app sent you. The skin is inlined into the
// <head> rather than applied by script on load, so the page paints in the app's own
// colours immediately instead of flashing PlumiChat's blue first.
function appSkin(ctx) {
  const vars = (o) => Object.keys(o).map((k) => '--' + k + ':' + o[k] + ';').join('');
  const b = ctx.brand || {};
  return '<style id="app-skin">:root{' + vars(ctx.theme.dark) + '}'
    + 'html[data-theme="light"]{' + vars(ctx.theme.light) + '}'
    + '.brand{letter-spacing:' + (b.letterSpacing || '0.2em') + ';font-weight:' + (b.weight || 650)
    + ';font-size:' + (b.size || '14px') + ';}'
    + (b.dot === false ? '.brand .dot{display:none}' : '')
    + '</style>'
    + '<script>window.__SSO_APP=' + JSON.stringify(ctx).replace(/</g, '\\u003c') + ';</script>';
}

app.get('/login', async (req, res, next) => {
  const ctx = appLoginContext(req.query.app, req.headers['x-forwarded-host'] || req.headers.host, isSecure(req));
  // Already signed in: go where they were headed. Coming from an app, that's the
  // app — bouncing them into PlumiChat instead would strand them.
  if (req.user) return res.redirect(302, ctx ? ctx.returnUrl : safeNext(req.query.next));
  if (!ctx) return res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  try {
    const html = await fs.promises.readFile(path.join(PUBLIC_DIR, 'login.html'), 'utf8');
    res.type('html').set('Cache-Control', 'no-store')
      .send(html.replace('</head>', appSkin(ctx) + '</head>'));
  } catch (err) { next(err); }
});

// Who is signed in, for a sister app that can't read the cookie itself. Public on
// purpose: an honest "nobody" is the useful answer. Reveals nothing without a valid
// cookie, and never hands back anything an app could sign a session with.
app.get('/api/sso/me', (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const app_ = appForOrigin(req.headers.origin, host) || appById(req.query.app);
  const base = (isSecure(req) ? 'https' : 'http') + '://' + host;
  const login = base + '/login' + (app_ ? '?app=' + encodeURIComponent(app_.id) : '');
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false, loginUrl: login, logoutUrl: null });
  const u = req.user;
  res.json({
    signedIn: true,
    user: {
      id: u.id, name: u.name, firstName: u.firstName || '', email: u.email || '',
      initials: u.initials || 'U', role: u.role, avatar: u.avatar || null,
    },
    loginUrl: login,
    logoutUrl: base + '/sso/logout' + (app_ ? '?app=' + encodeURIComponent(app_.id) : ''),
  });
});

// Sign out from inside a sister app: drop the session, then hand the browser back to
// the app, which will re-ask and find nobody. Only registry apps are redirect targets.
app.get('/sso/logout', (req, res) => {
  const ctx = appLoginContext(req.query.app, req.headers['x-forwarded-host'] || req.headers.host, isSecure(req));
  res.setHeader('Set-Cookie', clearedCookie());
  res.redirect(302, ctx ? ctx.returnUrl : '/login');
});

// Drives the login UI: first-run setup vs login vs invite-register, plus context.
app.get('/api/auth/status', (req, res) => {
  const { rpId, secure } = rpInfo(req);
  const inviteTok = req.query.invite ? String(req.query.invite) : '';
  res.json({
    app: appLoginContext(req.query.app, req.headers['x-forwarded-host'] || req.headers.host, secure),
    bootstrap: bootstrapNeeded(),                 // no accounts yet → owner setup
    authed: !!req.user,
    user: req.user ? { name: req.user.name, initials: req.user.initials, role: req.user.role } : null,
    inviteValid: inviteTok ? inviteIsValid(inviteTok) : false,
    webauthnAvailable: webauthnEnrolled(),        // any passkeys exist (usernameless prompt)
    basicAvailable: !!(AUTH_USER && authPass),
    secure, rpId,
  });
});

// Create an account (first one = owner; later ones need a valid invite), log in.
app.post('/api/auth/register', async (req, res) => {
  try {
    const u = await registerUser(req.body || {});
    res.setHeader('Set-Cookie', sessionCookie(issueSession(u.id, u.sv || 0), { secure: isSecure(req) }));
    res.json({ ok: true, user: { name: u.name, initials: u.initials, role: u.role } });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Log in with email + 6-digit PIN. A PIN is a small keyspace, so throttle:
// 5 straight failures per email lock that email out for 60s (in-memory).
const loginFails = new Map(); // emailKey -> { count, until }
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCKOUT_MS = 60 * 1000;
app.post('/api/auth/login', async (req, res) => {
  const emailKey = String((req.body || {}).email || '').trim().toLowerCase();
  const rec = loginFails.get(emailKey);
  if (rec && rec.until > Date.now()) {
    return res.status(429).json({ error: 'too many attempts — wait a minute and try again' });
  }
  try {
    const u = await loginUser(req.body || {});
    loginFails.delete(emailKey);
    res.setHeader('Set-Cookie', sessionCookie(issueSession(u.id, u.sv || 0), { secure: isSecure(req) }));
    res.json({ ok: true, user: { name: u.name, initials: u.initials, role: u.role } });
  } catch (err) {
    const r = loginFails.get(emailKey) || { count: 0, until: 0 };
    r.count += 1;
    if (r.count >= LOGIN_MAX_FAILS) { r.count = 0; r.until = Date.now() + LOGIN_LOCKOUT_MS; }
    loginFails.set(emailKey, r);
    res.status(401).json({ error: err.message });
  }
});

// Change your own PIN (must be unlocked; re-checks the current PIN).
app.post('/api/auth/pin/change', requireAuth, async (req, res) => {
  try {
    if (!req.user.id) throw new Error('register your account first');
    const r = await changeUserPin(req.user.id, req.body || {});
    // The change bumped the account's session version, invalidating every cookie
    // minted before it — including this device's. Re-issue this caller a fresh
    // cookie at the new version so THEY stay signed in; other devices are logged out.
    res.setHeader('Set-Cookie', sessionCookie(issueSession(req.user.id, r.sv), { secure: isSecure(req) }));
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearedCookie());
  res.json({ ok: true });
});

// Explicit Basic-auth fallback: fires the native prompt, then upgrades to an
// owner session (the lifeline).
app.get('/api/auth/basic', (req, res) => {
  if (basicOk(req)) {
    const ctx = appLoginContext(req.query.app, req.headers['x-forwarded-host'] || req.headers.host, isSecure(req));
    res.setHeader('Set-Cookie', sessionCookie(issueSession(BASIC_SUB), { secure: isSecure(req) }));
    return res.redirect(302, ctx ? ctx.returnUrl : safeNext(req.query.next));
  }
  res.set('WWW-Authenticate', 'Basic realm="PlumiChat"');
  return res.status(401).send('Authentication required');
});

// WebAuthn — enrollment is gated behind an authed session and bound to that
// account; authentication (unlock) resolves the account from the passkey itself.
app.post('/api/auth/webauthn/register/options', requireAuth, (req, res) => {
  if (!req.user.id) return res.status(400).json({ error: 'register your account first' });
  res.json(registrationOptions({ rpId: rpInfo(req).rpId, rpName: 'PlumiChat', user: req.user }));
});
app.post('/api/auth/webauthn/register/verify', requireAuth, (req, res) => {
  try {
    if (!req.user.id) throw new Error('register your account first');
    const { rpId, origin } = rpInfo(req);
    res.json(verifyRegistration(req.body || {}, { rpId, origin, userId: req.user.id }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/auth/webauthn/auth/options', (req, res) => {
  const email = (req.body || {}).email;
  const u = email ? findByEmail(email) : null;
  const userId = u ? u.id : undefined; // omit → usernameless over all resident keys
  if (!webauthnEnrolled(userId)) return res.status(400).json({ error: 'no passkey enrolled' });
  res.json(authenticationOptions({ rpId: rpInfo(req).rpId, userId }));
});
app.post('/api/auth/webauthn/auth/verify', (req, res) => {
  try {
    const r = verifyAuthentication(req.body || {}, { rpId: rpInfo(req).rpId });
    if (!r.userId || !findById(r.userId)) return res.status(401).json({ error: 'this passkey is not linked to an account' });
    res.setHeader('Set-Cookie', sessionCookie(issueSession(r.userId, userSessionVersion(r.userId)), { secure: isSecure(req) }));
    res.json({ ok: true });
  } catch (err) { res.status(401).json({ error: err.message }); }
});
app.get('/api/auth/webauthn/credentials', requireAuth, (req, res) => {
  res.json({ credentials: listCredentials(req.user.id).map((c) => ({ id: c.id, createdAt: c.createdAt })) });
});
app.post('/api/auth/webauthn/reset', requireAuth, (req, res) => res.json(resetWebauthn(req.user.id)));
app.delete('/api/auth/webauthn/credentials/:id', requireAuth, (req, res) => {
  try { res.json(removeCredential(req.user.id, req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// --- Static UI ---
// 'no-cache' = browsers may keep a copy but MUST revalidate before using it
// (cheap 304s on the tailnet). Without it they cache heuristically — after the
// files sit unchanged for weeks, phones/desktops decide "fresh for days" and
// serve stale app.js/style.css without ever asking, so deployed features never
// show up (bit us twice on 2026-07-03).
// --- Cache-busting that maintains itself ---
// Every asset URL in the HTML carries a ?v= stamp, and for months that stamp was
// a hand-typed date. Change a module without remembering to bump it and the URL
// is byte-identical to yesterday's, so a browser that has decided to cache
// heuristically — an iOS home-screen app especially — keeps serving the old file
// through a reload, a hard refresh and a deploy. That is not hypothetical: it is
// how a shipped usage fix stayed invisible on the phone while the server was
// serving the corrected file to anyone who asked.
//
// So the stamp is derived instead of typed: the newest mtime anywhere under
// public/. Any frontend change moves it, nothing else does, and no one has to
// remember anything. Re-checked at most every 10s so this costs a few stats.
const ASSET_TAG_TTL_MS = 10 * 1000;
let assetTag = { at: 0, value: null };
function assetVersion() {
  if (assetTag.value && Date.now() - assetTag.at < ASSET_TAG_TTL_MS) return assetTag.value;
  let newest = 0;
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      try { const m = fs.statSync(full).mtimeMs; if (m > newest) newest = m; } catch { /* raced */ }
    }
  };
  walk(PUBLIC_DIR);
  assetTag = { at: Date.now(), value: Math.round(newest).toString(36) };
  return assetTag.value;
}

// The HTML documents get the stamp rewritten on the way out. They are sent
// no-store — they are tiny, and they are the only thing that must never be stale,
// because everything else is addressed through the URLs they contain.
const STAMPED_HTML = ['/', '/index.html', '/settings.html', '/operations.html', '/grid.html'];
app.get(STAMPED_HTML, (req, res, next) => {
  const file = req.path === '/' ? 'index.html' : req.path.slice(1);
  fs.promises.readFile(path.join(PUBLIC_DIR, file), 'utf8')
    .then((html) => {
      res.type('html').set('Cache-Control', 'no-store')
        .send(html.replace(/([?&]v=)[0-9a-zA-Z]+/g, '$1' + assetVersion()));
    })
    .catch(next);   // missing file → fall through to static, which 404s properly
});

app.use(express.static(PUBLIC_DIR, {
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); },
}));

// Keep the lifeline up. This box is a personal always-on server reached over the
// tailnet; a single unhandled throw/rejection from a detached run, a broken SSE
// socket, or a background task must NOT take the whole process down (which would
// drop every conversation and the ops runner). Log loudly and stay alive — PM2 is
// the backstop for anything genuinely fatal, not a stray async error.
process.on('uncaughtException', (err) => { console.error('[uncaughtException]', err); });
process.on('unhandledRejection', (reason) => { console.error('[unhandledRejection]', reason); });

// --- Boot preflight ---------------------------------------------------------
// One rule, checked before the socket opens: an EXPOSED bind requires that
// something already authenticates a request. Loopback needs nothing, because
// only this machine can reach it.
//
// The window this closes is the bootstrap one. Before the owner account exists
// there is nobody to sign in as, so on 0.0.0.0 the gate above would be serving
// its login page to the whole network with a live chat API behind it — and a
// chat turn here runs shell commands as the user who started this process.
// Setting AUTH_USER/AUTH_PASS covers that window: the Basic lifeline answers
// first, and the owner registers behind it.
//
// A reverse proxy is unaffected. Proxied setups bind loopback and let the proxy
// hold the port, which is the arrangement this default already encourages.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
const EXPOSED = !LOOPBACK_HOSTS.has(String(HOST).trim().toLowerCase());

function refuseToStart() {
  const who = (() => { try { return os.userInfo().username; } catch { return 'this user'; } })();
  console.error('');
  console.error('  PlumiChat refused to start.');
  console.error('');
  console.error(`  HOST is ${HOST}, so this server would accept connections from the`);
  console.error('  network — but nothing here authenticates one yet. A chat turn runs');
  console.error(`  shell commands as ${who}, so that is a remote shell, not a chat app.`);
  console.error('');
  console.error('  Pick one:');
  console.error('    - Unset HOST (or set 127.0.0.1) and open it from this machine.');
  console.error('    - Set AUTH_USER and AUTH_PASS in .env, then start again. They');
  console.error('      guard the window before the owner account exists.');
  console.error('');
  console.error('  docs/SECURITY.md explains the model in full.');
  console.error('');
  process.exit(1);
}

function banner() {
  const url = `http://${EXPOSED ? HOST : 'localhost'}:${PORT}`;
  const accounts = userCount();
  const auth = accounts > 0
    ? `${accounts} account${accounts === 1 ? '' : 's'}` + (AUTH_USER && authPass ? ' + Basic lifeline' : '')
    : (AUTH_USER && authPass ? 'Basic lifeline only - open the URL to create the owner account' : 'NOT SET UP - open the URL to create the owner account');
  const rows = [
    ['URL', url],
    ['Reachable', EXPOSED ? `anything that can route to ${HOST}` : 'this machine only'],
    ['Sign-in', auth],
    ['Workspace', WORKSPACES_ROOT],
    ['Platform', platformLabel()],
  ];
  console.log('');
  console.log('  PlumiChat');
  for (const [k, v] of rows) console.log(`  ${(k + '          ').slice(0, 11)} ${v}`);
  // Only the OFF features are printed. A list of everything that works is noise;
  // a list of what does not is the thing an operator needs on a new machine.
  unavailableSummary().then((off) => {
    if (!off.length) return;
    console.log('');
    console.log('  Not available here (everything else is on):');
    for (const { name, reason } of off) console.log(`    - ${name}: ${reason}`);
    console.log('');
  }).catch(() => {});
  console.log('');
}

if (EXPOSED && !authConfigured()) refuseToStart();

const server = app.listen(PORT, HOST, () => {
  banner();
  try { initRunner(); } catch (err) { console.error('runner init failed:', err); }
});

// Owner-only interactive terminal (WebSocket at /terminal). Gated to the owner
// account inside the upgrade handler — see server/terminal.js.
try { attachTerminal(server, { currentUser }); } catch (err) { console.error('terminal init failed:', err); }

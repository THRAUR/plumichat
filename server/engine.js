// Engine updates — PlumiChat updating its OWN Claude engine, from the phone.
//
// Two engines run on this box and they are separate installs of the same thing:
//   * the CHAT engine  — `@anthropic-ai/claude-agent-sdk` in node_modules, which
//     bundles its own CLI binary; this is what every chat turn spawns.
//   * the TERMINAL CLI — the natively installed `claude` under
//     ~/.local/share/claude/versions, symlinked from ~/.local/bin/claude; this is
//     what the owner terminal (and `/design-sync`) drives.
// Both have `autoUpdates:false`, so today they only move when a human types the
// commands. This module is the read side (what am I on, what's out, what changed)
// plus a STAGED, verified update that a human taps once.
//
// SAFETY MODEL — read this before changing anything here:
//   1. Nothing in this file may ever run pm2, restart a process, or `git push`.
//      The session asking for the update is streaming THROUGH the live server; a
//      restart from in here kills the very turn that requested it.
//   2. Nothing may ever install into the LIVE clone (the served copy).
//      An `npm install` there swaps the SDK under a running process — the live
//      server would keep the old module in memory and the next turn would spawn a
//      half-written binary. Installs happen ONLY in a throwaway staging dir.
//   3. The one thing a successful update writes into a real repo is the vetted
//      package.json + package-lock.json pair, and only into the DEV copy on
//      the working copy. This module runs from BOTH copies (it ships to the live clone), so
//      the dev path is resolved explicitly and every write is checked against the
//      live clone first — see assertNotLive(). Do not replace that with a
//      "relative to this file" path; on the live box that IS the live clone.
// Shipping stays the human's job: commit → push → pull → restart, exactly as
// CLAUDE.md describes. This module only gets the bump ready and proves it works.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resetTempEnv } from './platform.js';
import { read, update, DATA_DIR } from './store.js';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || os.homedir();

const SDK_PKG = '@anthropic-ai/claude-agent-sdk';
const CLI_PKG = '@anthropic-ai/claude-code';

// The three trees this module knows about, each resolved ONCE and explicitly:
//   RUNNING_ROOT — the checkout this process was started from (dev or live).
//   DEV_REPO     — the working copy you edit, the only tree we may write into.
//   LIVE_CLONE   — the PM2-served clone, which we must never write into at all.
// Overridable by env so the isolated test server (DATA_DIR+PORT) can point them
// somewhere harmless without editing code.
const RUNNING_ROOT = path.resolve(SERVER_DIR, '..');
// Exported: index.js's deploy status compares the live clone against THIS path.
// It must never compare against "the checkout this process runs from" — on the
// live box that is the live clone itself, and a tree is always in sync with itself.
// Defaults to the checkout this process runs from, which is correct for the single
// -copy install almost everyone has. Only a two-copy deploy (a working tree plus a
// separate served clone) needs to set it.
export const DEV_REPO = path.resolve(process.env.PLUMI_DEV_REPO || RUNNING_ROOT);
// The separately-served clone, for two-copy deploys. EMPTY by default: with no
// second clone there is nothing to fast-forward, and the Deploy surface reports
// itself unavailable rather than inventing a path.
const LIVE_CLONE = process.env.PLUMI_LIVE_CLONE ? path.resolve(process.env.PLUMI_LIVE_CLONE) : '';
// Scratch install target. Deliberately a sibling of the live clone, never inside
// it, so a stray `rm -rf` of staging can't reach the server that is serving us.
const STAGING_DIR = path.resolve(
  process.env.PLUMI_ENGINE_STAGING || path.join(os.tmpdir(), 'plumichat-engine-staging')
);

// Native CLI install layout (verified on this box): `versions/` holds one plain
// executable per version and ~/.local/bin/claude is a symlink to the active one.
const CLI_VERSIONS_DIR = path.join(HOME, '.local', 'share', 'claude', 'versions');
const CLI_BIN = path.join(HOME, '.local', 'bin', 'claude');

// npm is invoked as `node <npm-cli.js>` rather than as `npm`, because PM2 captured
// a minimal PATH and npm's shebang is `#!/usr/bin/env node` — spawning `npm`
// directly dies with ENOENT there. process.execPath is always the node we run on.
const NPM_CLI = path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');

const CHANGELOG_URLS = {
  cli: 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md',
  sdk: 'https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md',
};

const STATUS_TTL_MS = 30 * 60 * 1000;   // npm dist-tags move ~daily; twice an hour is plenty
const CHANGELOG_TTL_MS = 30 * 60 * 1000;
const NPM_VIEW_MS = 60 * 1000;          // `npm view` is a network call and can be slow
const NPM_INSTALL_MS = Number(process.env.PLUMI_ENGINE_NPM_MS || 10 * 60 * 1000); // the SDK ships a ~215 MB binary
const CANARY_MS = 120 * 1000;
const FETCH_MS = 30 * 1000;             // the claude-code changelog is ~600 KB
const CHANGELOG_MAX_SECTIONS = 40;      // a phone needs a readable list, not the full history
const CHANGELOG_MAX_BYTES = 60 * 1024;
const CHANGELOG_SCAN_BYTES = 256 * 1024; // both changelogs are newest-first; never parse the whole 600 KB
const UPDATES_STORE = 'engine-updates';
const UPDATES_KEEP = 50;

// The Options keys claude.js actually passes to query(). If an upgrade removes one
// of these, THAT is the breakage signal for this app — a renamed option fails
// silently (the CLI just ignores it) and the symptom shows up as "the model picker
// stopped working" three days later. Keep this list in sync with runPrompt's
// `options` object in server/claude.js.
const PLUMI_OPTION_KEYS = [
  'cwd', 'model', 'systemPrompt', 'permissionMode', 'includePartialMessages',
  'stderr', 'canUseTool', 'env', 'skills', 'effort', 'settings', 'betas',
  'sandbox', 'resume', 'abortController',
];

/* ------------------------------ safety rails ------------------------------ */

// True when `p` is `root` or lives underneath it. Used for the live-clone guard,
// so it must be path-based (not string-prefix) — '/home/plumi/plumi-remote-x'
// must NOT count as inside '/home/plumi/plumi-remote'.
function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// THE guard. Every filesystem write in this module goes through it first. A throw
// here is correct behaviour, not a bug: refusing to write beats corrupting the
// only remote access to this machine.
function assertNotLive(target) {
  const abs = path.resolve(target);
  // No live clone configured -> there is nothing to be inside of, so the guard
  // passes. This case MUST be handled explicitly: path.relative('', abs) resolves
  // '' to process.cwd(), so an empty LIVE_CLONE would otherwise mean "refuse every
  // write inside the current directory" — which is the whole dev repo.
  if (!LIVE_CLONE) return abs;
  if (isInside(LIVE_CLONE, abs)) {
    throw new Error('refused: ' + abs + ' is inside the live server clone (' + LIVE_CLONE + ')');
  }
  return abs;
}

/* -------------------------------- plumbing -------------------------------- */

// Run a command and resolve its outcome. NEVER rejects: every caller here treats a
// missing tool / non-zero exit as data ("couldn't check"), not as an exception.
// Exported alongside claudeBin() so server/plugins.js shells out the same way:
// execFile, never a shell, always a normalised {ok, code, stdout, stderr}.
export function run(cmd, args, { cwd, timeout = 30 * 1000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout, env: env || process.env, maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        // execFile reports a numeric exit code, or a string errno ('ENOENT') when
        // the binary itself is missing — normalise so callers can just check .ok.
        code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
        errno: err && typeof err.code === 'string' ? err.code : null,
        timedOut: !!(err && err.killed),
        stdout: String(stdout || ''),
        stderr: String(stderr || '') || (err ? String(err.message || '') : ''),
      });
    });
  });
}

// npm through the resolved CLI script (see NPM_CLI). Quiet flags keep the output
// parseable and stop npm printing a funding/audit essay into our log.
function npm(args, opts) {
  return run(process.execPath, [NPM_CLI, ...args, '--no-audit', '--no-fund', '--loglevel=error'], opts);
}

async function fetchText(url, ms = FETCH_MS) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'follow' });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; } // offline / DNS / timeout — the disk cache takes over
}

// Numeric semver compare, prerelease tags ignored (neither changelog uses them).
// Returns >0 when a is newer than b.
function cmpVer(a, b) {
  const pa = String(a || '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const isVersion = (v) => /^\d+\.\d+\.\d+([\w.+-]*)$/.test(String(v || ''));

/* --------------------------- installed versions --------------------------- */

// The SDK the RUNNING server resolved — not "whatever is in ../node_modules",
// because node may have hoisted it. require.resolve follows the same lookup the
// live process did; the repo-local path is the fallback for an odd layout.
function sdkPackageJsonPath() {
  try {
    const entry = createRequire(import.meta.url).resolve(SDK_PKG);
    return path.join(path.dirname(entry), 'package.json');
  } catch {
    return path.join(RUNNING_ROOT, 'node_modules', ...SDK_PKG.split('/'), 'package.json');
  }
}

function installedSdk() {
  try {
    const j = JSON.parse(fs.readFileSync(sdkPackageJsonPath(), 'utf8'));
    return { version: j.version || null, claudeCodeVersion: j.claudeCodeVersion || null };
  } catch { return { version: null, claudeCodeVersion: null }; }
}

// Where the native CLI actually is. PM2's PATH does not contain ~/.local/bin, so a
// bare `claude` is ENOENT under the server — always resolve the symlink first.
// Exported for server/plugins.js, which shells out to `claude plugin`.
export function claudeBin() { return fs.existsSync(CLI_BIN) ? CLI_BIN : 'claude'; }

// `claude --version` prints "2.1.258 (Claude Code)".
async function installedCli() {
  const bin = claudeBin();
  const r = await run(bin, ['--version'], { timeout: 20 * 1000 });
  const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

async function distTags(pkg) {
  const r = await npm(['view', pkg, 'dist-tags', '--json'], { timeout: NPM_VIEW_MS });
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/* -------------------------------- changelogs ------------------------------- */

// Changelogs are cached on DISK (not just in memory) so the panel still tells the
// owner what changed when the box is offline or GitHub is unreachable — which is
// exactly when they are most likely to be poking at the engine.
const changelogFile = (which) => path.join(DATA_DIR, 'engine-changelog-' + which + '.md');

async function changelogText(which, { refresh = false } = {}) {
  const file = changelogFile(which);
  let cachedAt = 0;
  try { cachedAt = fs.statSync(file).mtimeMs; } catch { /* no cache yet */ }
  const fresh = cachedAt && Date.now() - cachedAt < CHANGELOG_TTL_MS;
  if (fresh && !refresh) {
    try { return { text: fs.readFileSync(file, 'utf8'), cachedAt, stale: false }; } catch { /* fall through */ }
  }
  const text = await fetchText(CHANGELOG_URLS[which]);
  if (text) {
    // DATA_DIR is ours (data/ is gitignored), but keep the write best-effort: a
    // read-only disk must degrade to "no cache", never to a failed status call.
    try { fs.writeFileSync(file, text); } catch { /* best effort */ }
    return { text, cachedAt: Date.now(), stale: false };
  }
  try { return { text: fs.readFileSync(file, 'utf8'), cachedAt, stale: true }; } catch { /* none */ }
  return { text: null, cachedAt: 0, stale: true };
}

// Both changelogs are "## <version>" headings followed by "- " bullets, newest
// first. We only scan the head of the file: the CLI changelog is ~600 KB of
// history and everything we can show fits in the first few pages.
function parseChangelog(md) {
  const head = String(md || '').slice(0, CHANGELOG_SCAN_BYTES);
  const out = [];
  let cur = null;
  for (const raw of head.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const h = line.match(/^##\s+v?(\d+\.\d+\.\d+[\w.+-]*)\s*$/);
    if (h) { cur = { version: h[1], notes: [] }; out.push(cur); continue; }
    if (!cur) continue;
    const b = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (b) cur.notes.push(b[1]);
  }
  return out;
}

// Sections strictly newer than `since`, capped two ways: a section count (so the
// list stays scrollable on a phone) and a total byte budget (so one release with
// 200 bullets can't blow up the response).
function sectionsSince(sections, since) {
  const out = [];
  let bytes = 0;
  for (const s of sections) {
    if (out.length >= CHANGELOG_MAX_SECTIONS) break;
    // `continue`, not `break`: the files are newest-first today, but a changelog
    // with one out-of-order heading must not silently truncate the whole list.
    if (since && cmpVer(s.version, since) <= 0) continue;
    const notes = [];
    for (const n of s.notes) {
      bytes += n.length + 1;
      if (bytes > CHANGELOG_MAX_BYTES) break;
      notes.push(n);
    }
    out.push({ version: s.version, notes });
    if (bytes > CHANGELOG_MAX_BYTES) break;
  }
  return out;
}

/* ------------------------------ engineStatus ------------------------------ */

let statusCache = { at: 0, value: null };

// What am I running, what is published, and how far behind am I? Every field is
// best-effort: a missing npm, a dead network or a renamed binary degrades single
// fields to null instead of failing the panel.
export async function engineStatus({ refresh = false } = {}) {
  if (!refresh && statusCache.value && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.value;
  }

  const sdkPkg = installedSdk();
  const [cliInstalled, sdkTags, cliTags, sdkLog, cliLog] = await Promise.all([
    installedCli(),
    distTags(SDK_PKG),
    distTags(CLI_PKG),
    changelogText('sdk', { refresh }),
    changelogText('cli', { refresh }),
  ]);

  const sdkSections = parseChangelog(sdkLog.text);
  const cliSections = parseChangelog(cliLog.text);
  // "behind" counts published releases between us and HEAD of the changelog, which
  // is more honest than a version delta: 0.3.240 -> 0.3.258 is 18 releases, not 18
  // of anything else. null means we could not read a changelog at all.
  const behind = (sections, installed) =>
    (sections.length && installed ? sections.filter((s) => cmpVer(s.version, installed) > 0).length : null);

  const sdk = {
    installed: sdkPkg.version,
    latest: (sdkTags && sdkTags.latest) || null,
    behind: behind(sdkSections, sdkPkg.version),
    // The CLI build this SDK bundles — the actual chat engine, which is NOT the
    // same install as the terminal's `claude` below even when the numbers match.
    bundledCli: sdkPkg.claudeCodeVersion,
    changelog: { cachedAt: sdkLog.cachedAt || null, stale: !!sdkLog.stale },
  };
  const cli = {
    installed: cliInstalled,
    latest: (cliTags && cliTags.latest) || null,
    stable: (cliTags && cliTags.stable) || null,
    behind: behind(cliSections, cliInstalled),
    changelog: { cachedAt: cliLog.cachedAt || null, stale: !!cliLog.stale },
  };

  const newer = (installed, latest) => !!(installed && latest && cmpVer(latest, installed) > 0);
  const value = {
    sdk,
    cli,
    node: process.version,
    checkedAt: Date.now(),
    updateAvailable: newer(sdk.installed, sdk.latest) || newer(cli.installed, cli.latest),
    // Where an update would (and would not) go, so the UI can say it out loud
    // rather than the owner having to trust an invisible rule.
    paths: { devRepo: DEV_REPO, staging: STAGING_DIR, liveClone: LIVE_CLONE, runningFrom: RUNNING_ROOT },
  };
  statusCache = { at: Date.now(), value };
  return value;
}

// "What's new since your version", for both engines. Defaults to the installed
// versions so the caller can just call whatsNew().
export async function whatsNew({ sinceSdk, sinceCli } = {}) {
  const [sdkLog, cliLog] = await Promise.all([changelogText('sdk'), changelogText('cli')]);
  const fromSdk = sinceSdk || installedSdk().version;
  const fromCli = sinceCli || await installedCli();
  return {
    sdk: sectionsSince(parseChangelog(sdkLog.text), fromSdk),
    cli: sectionsSince(parseChangelog(cliLog.text), fromCli),
    since: { sdk: fromSdk || null, cli: fromCli || null },
    cachedAt: { sdk: sdkLog.cachedAt || null, cli: cliLog.cachedAt || null },
    stale: { sdk: !!sdkLog.stale, cli: !!cliLog.stale },
  };
}

/* ------------------------------- update log ------------------------------- */

// Every attempt is persisted, successful or not: when a turn starts failing three
// days later, "what did I change to the engine and when" is the first question.
function logAttempt(entry) {
  const rec = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), ...entry };
  try {
    update(UPDATES_STORE, (all) => {
      const list = Array.isArray(all) ? all : [];
      list.unshift(rec);
      if (list.length > UPDATES_KEEP) list.length = UPDATES_KEEP;
      return list;
    }, []);
  } catch { /* the store is a convenience here; never fail an update over it */ }
  return rec;
}

export function updateLog(limit = 20) {
  const list = read(UPDATES_STORE, []);
  return (Array.isArray(list) ? list : []).slice(0, Math.max(1, Math.min(UPDATES_KEEP, limit)));
}

/* --------------------------------- busy ---------------------------------- */

// Never restage the engine while a turn is in flight: `npm install` in staging is
// harmless on its own, but the canary spawns another ~340 MB CLI on a 5.9 GB box,
// and the CLI target repoints ~/.local/bin/claude under any interactive session.
// runs.js is the authority; we ask it as gently as possible so this module keeps
// working whether or not the export exists yet.
async function turnsActive(isBusy) {
  if (typeof isBusy === 'function') {
    try { return !!(await isBusy()); } catch { return false; }
  }
  try {
    const runs = await import('./runs.js');
    if (typeof runs.anyRunActive === 'function') return !!runs.anyRunActive();
    // Fallback on the export that has always existed, so a missing anyRunActive
    // still gets us a truthful answer instead of a blind "not busy".
    if (typeof runs.listRuns === 'function') {
      return (runs.listRuns() || []).some((r) => r && r.status === 'running');
    }
  } catch { /* runs.js unavailable (isolated test server) — fall through */ }
  return false;
}

/* --------------------------- staging + the canary -------------------------- */

// Copy the dev repo's manifest pair into staging and install the requested SDK
// version THERE. Staging carries the real package.json so npm resolves the same
// dependency graph PlumiChat will ship — the resulting lockfile is the artifact we
// hand back to the dev tree in step 5.
//
// --ignore-scripts is deliberate: node-pty would try to compile in staging (slow,
// and irrelevant — the canary only needs the SDK). The SDK itself has no install
// scripts; its CLI binary arrives as a platform-matched optionalDependency.
async function stageSdk(version, notes) {
  assertNotLive(STAGING_DIR);
  await fsp.mkdir(STAGING_DIR, { recursive: true });

  const src = fs.existsSync(path.join(DEV_REPO, 'package.json')) ? DEV_REPO : RUNNING_ROOT;
  for (const f of ['package.json', 'package-lock.json']) {
    try { await fsp.copyFile(path.join(src, f), assertNotLive(path.join(STAGING_DIR, f))); }
    catch { /* no lockfile is survivable; npm will make one */ }
  }
  notes.push('staged from ' + src);

  const spec = SDK_PKG + '@' + version;
  const r = await npm(['install', '--ignore-scripts', spec], { cwd: STAGING_DIR, timeout: NPM_INSTALL_MS });
  if (!r.ok) {
    return { ok: false, step: 'stage', error: (r.stderr || r.stdout || 'npm install failed').slice(-2000) };
  }
  // Trust the installed tree, not the requested spec: a range or a dist-tag would
  // otherwise be reported back as if it were a concrete version.
  let staged = null;
  try {
    staged = JSON.parse(fs.readFileSync(
      path.join(STAGING_DIR, 'node_modules', ...SDK_PKG.split('/'), 'package.json'), 'utf8'
    )).version;
  } catch { /* reported as unknown below */ }
  return { ok: true, step: 'stage', staged };
}

// The canary runs in a CHILD process, not in ours. That is the whole point: a new
// SDK version that throws on import, hangs, or leaks memory must not be able to
// destabilise the live server that is streaming this very request — and an ES
// module, once imported, can never be unloaded again.
const CANARY_MARK = '<<<PlumiChat-ENGINE-CANARY>>>';
const CANARY_SRC = `// generated by server/engine.js — safe to delete
import { query } from '${SDK_PKG}';
const out = { ok: false, text: '', sawResult: false, error: null };
try {
  const q = query({
    prompt: 'Reply with the single word OK',
    options: { model: 'haiku', persistSession: false, maxTurns: 1, settingSources: [] },
  });
  for await (const m of q) {
    if (m.type === 'assistant') {
      for (const b of (m.message && m.message.content) || []) if (b.type === 'text') out.text += b.text;
    }
    if (m.type === 'result') { out.sawResult = true; break; }
  }
  out.ok = /\\bOK\\b/i.test(out.text);
} catch (e) { out.error = String((e && e.message) || e); }
process.stdout.write('\\n${CANARY_MARK}' + JSON.stringify(out) + '\\n');
`;

// PlumiChat's own secrets must not ride along into the canary's CLI subprocess, and
// the parent Claude session's markers must not either (same reasoning as
// scrubbedEnv() in server/claude.js — a doubly-nested TMPDIR breaks the CLI).
// Duplicated rather than imported because claude.js does not export it; if that
// changes, delete this and import the real one.
const SECRET_ENV = ['AUTH_USER', 'AUTH_PASS', 'SESSION_SECRET', 'OPS_SIGNALS', 'VAPID_PRIVATE_KEY'];
const INHERITED_CLAUDE_ENV = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_EFFORT', 'TMPPREFIX', 'TMP', 'TEMP',
];
function scrubbedEnv() {
  const env = { ...process.env };
  for (const k of SECRET_ENV) delete env[k];
  for (const k of INHERITED_CLAUDE_ENV) delete env[k];
  resetTempEnv(env);
  return env;
}

async function runCanary() {
  const script = assertNotLive(path.join(STAGING_DIR, 'plumi-engine-canary.mjs'));
  try { await fsp.writeFile(script, CANARY_SRC); }
  catch (e) { return { ok: false, error: 'could not write canary: ' + (e.message || e) }; }

  const r = await run(process.execPath, [script], {
    cwd: STAGING_DIR, timeout: CANARY_MS, env: scrubbedEnv(),
  });
  try { await fsp.unlink(script); } catch { /* leave it; it is inert */ }

  const cut = r.stdout.lastIndexOf(CANARY_MARK);
  if (cut < 0) {
    return {
      ok: false,
      error: r.timedOut ? 'canary timed out after ' + Math.round(CANARY_MS / 1000) + 's'
        : (r.stderr || r.stdout || 'canary produced no result').slice(-1500),
    };
  }
  try {
    const parsed = JSON.parse(r.stdout.slice(cut + CANARY_MARK.length).trim());
    return { ok: !!parsed.ok, reply: (parsed.text || '').trim().slice(0, 200), error: parsed.error || null };
  } catch (e) {
    return { ok: false, error: 'unparseable canary output: ' + (e.message || e) };
  }
}

/* --------------------------- Options surface diff -------------------------- */

// Pull the top-level key names out of `export declare type Options = { … }` in a
// sdk.d.ts. Members of the type sit at exactly four spaces; anything nested (the
// `env?: { [k]: … }` body, for instance) is indented deeper and is correctly
// skipped by the four-space anchor. The file is CRLF, hence the \r tolerance.
function optionKeys(dtsText) {
  const lines = String(dtsText || '').split('\n');
  const start = lines.findIndex((l) => l.replace(/\r$/, '').trim() === 'export declare type Options = {');
  if (start < 0) return null;
  const keys = new Set();
  for (let i = start + 1; i < lines.length; i++) {
    const s = lines[i].replace(/\r$/, '');
    if (/^\};?\s*$/.test(s)) break;
    const m = s.match(/^ {4}([A-Za-z_$][\w$]*)\??\s*:/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

function readDts(root) {
  try {
    return fs.readFileSync(path.join(root, 'node_modules', ...SDK_PKG.split('/'), 'sdk.d.ts'), 'utf8');
  } catch { return null; }
}

// Compare the staged SDK's Options surface with the one we run today. Two answers
// matter and they are NOT the same thing:
//   lost     — a key PlumiChat passes that the new version dropped → real breakage.
//   alreadyMissing — a key PlumiChat passes that TODAY's version already ignores →
//                    a pre-existing bug in claude.js, not something the upgrade did.
// (That distinction is not academic: 0.3.258 has no top-level `fastMode` option —
// it is a Settings field, which is why claude.js now passes fast mode through
// `settings` instead. `settings` is therefore the key this diff must protect.)
function diffOptions(stagedRoot) {
  const nextText = readDts(stagedRoot);
  const nextKeys = optionKeys(nextText);
  if (!nextKeys) return { ok: null, reason: 'could not read the staged sdk.d.ts Options type' };
  const curKeys = optionKeys(readDts(RUNNING_ROOT)) || new Set();

  const lost = [], alreadyMissing = [];
  for (const k of PLUMI_OPTION_KEYS) {
    if (nextKeys.has(k)) continue;
    (curKeys.has(k) ? lost : alreadyMissing).push(k);
  }
  const added = curKeys.size ? [...nextKeys].filter((k) => !curKeys.has(k)) : [];
  const removed = curKeys.size ? [...curKeys].filter((k) => !nextKeys.has(k)) : [];
  return {
    ok: lost.length === 0,
    lost, alreadyMissing,
    // "What did I gain" — the changelog says it in prose, this says it in keys.
    added: added.slice(0, 40),
    removed: removed.slice(0, 40),
    counts: { next: nextKeys.size, current: curKeys.size },
  };
}

/* ------------------------------- CLI target ------------------------------- */

function versionsOnDisk() {
  let running = null;
  try { running = path.basename(fs.realpathSync(CLI_BIN)); } catch { /* no symlink */ }
  let entries = [];
  try {
    entries = fs.readdirSync(CLI_VERSIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() || e.isSymbolicLink())
      .map((e) => {
        let size = 0;
        try { size = fs.statSync(path.join(CLI_VERSIONS_DIR, e.name)).size; } catch { /* skip */ }
        return { version: e.name, size, running: e.name === running };
      });
  } catch { entries = []; }
  entries.sort((a, b) => cmpVer(b.version, a.version));
  return { running, entries };
}

// Install a native CLI version and (only when explicitly asked) reclaim the disk
// the old ones hold — 852 MB of stale versions was in the audit. The running
// version is never a deletion candidate, and neither is the one we just put in.
async function applyCliUpdate(version, { dryRun, prune }) {
  const bin = claudeBin();
  const before = await installedCli();
  const disk = versionsOnDisk();
  const keep = new Set([disk.running, before, version].filter(Boolean));
  const prunable = disk.entries.filter((e) => !keep.has(e.version));
  const reclaimable = prunable.reduce((n, e) => n + e.size, 0);

  if (dryRun) {
    return {
      ok: true, dryRun: true, before, target: version || null,
      prunable: prunable.map((e) => ({ version: e.version, size: e.size })), reclaimable,
      note: 'dry run — nothing installed, nothing deleted',
    };
  }

  if (!version) return { ok: false, error: 'no CLI version given' };

  // Already there? Don't reinstall — but still honour an explicit prune, which is
  // the one reason to run this at all when the version is current.
  let after = before;
  const skipped = before === version;
  if (!skipped) {
    // `claude install <version>` is the native installer: it drops the new binary
    // in ~/.local/share/claude/versions and repoints ~/.local/bin/claude. It
    // touches neither node_modules nor PM2.
    const r = await run(bin, ['install', version], { timeout: NPM_INSTALL_MS, env: scrubbedEnv() });
    after = await installedCli();
    if (!r.ok && after !== version) {
      return { ok: false, before, after, error: (r.stderr || r.stdout || 'claude install failed').slice(-1500) };
    }
    if (after !== version) {
      return { ok: false, before, after, error: 'installer reported success but `claude --version` is still ' + after };
    }
  }

  const pruned = [];
  if (prune) {
    // Recompute AFTER the install so the freshly installed (now running) version
    // is excluded by the same rule rather than by luck.
    const disk2 = versionsOnDisk();
    for (const e of disk2.entries) {
      if (e.running || e.version === after) continue;
      try { fs.unlinkSync(path.join(CLI_VERSIONS_DIR, e.version)); pruned.push({ version: e.version, size: e.size }); }
      catch { /* leave it; disk is a nicety, not correctness */ }
    }
  }
  const prunedBytes = pruned.reduce((n, e) => n + e.size, 0);
  return {
    ok: true, before, after, skipped,
    prunable: prunable.map((e) => ({ version: e.version, size: e.size })),
    reclaimable, pruned,
    note: (skipped ? 'terminal CLI was already ' + after : 'terminal CLI updated to ' + after)
      + (prune ? '; reclaimed ' + prunedBytes + ' bytes'
        : reclaimable ? ' — pass prune:true to reclaim ' + reclaimable + ' bytes' : ''),
  };
}

/* -------------------------------- applyUpdate ------------------------------ */

// One tap at a time. Two concurrent `npm install`s into the same staging dir would
// interleave and produce a lockfile that matches neither request.
let applying = false;

// Staged, verified engine update.
//   step 1  refuse while a chat turn is running
//   step 2  stage the install in ~/plumi-engine-staging (never live, never dev)
//   step 3  canary: a real scripted turn on the staged SDK + an Options-surface diff
//   step 4  verdict (dryRun stops here)
//   step 5  copy the vetted package.json + package-lock.json into the DEV repo
// It never commits, never pushes, never restarts anything. Activating the bump is
// still the documented human flow: commit → push → pull → restart.
export async function applyUpdate({ target = 'sdk', version, dryRun = true, prune = false, isBusy } = {}) {
  if (!['sdk', 'cli', 'both'].includes(target)) {
    return { ok: false, error: 'unknown target "' + target + '" (expected sdk, cli or both)' };
  }
  if (version != null && !isVersion(version)) {
    return { ok: false, error: 'invalid version "' + version + '"' };
  }
  // The two engines are versioned independently (SDK 0.3.x vs CLI 2.1.x), so one
  // explicit version cannot mean both. Refuse rather than quietly apply a Claude
  // Code version number to the SDK.
  if (version && target === 'both') {
    return { ok: false, error: 'target "both" cannot take an explicit version — the SDK and the CLI are versioned separately; omit it to take latest of each, or update them one at a time' };
  }
  if (applying) return { ok: false, error: 'an engine update is already running' };

  applying = true;
  const notes = [];
  const started = Date.now();
  try {
    if (await turnsActive(isBusy)) {
      const res = { ok: false, blocked: 'busy', error: 'A chat turn is running — wait for it to finish, then try again.' };
      logAttempt({ target, version: version || null, dryRun: !!dryRun, ok: false, error: res.error });
      return res;
    }

    const status = await engineStatus({ refresh: true });
    const verdict = { target, dryRun: !!dryRun, startedAt: started, notes };

    /* ---- SDK ---- */
    if (target === 'sdk' || target === 'both') {
      const want = version || status.sdk.latest;
      if (!want) {
        verdict.sdk = { ok: false, error: 'no target version (npm is unreachable and none was given)' };
      } else if (status.sdk.installed && cmpVer(want, status.sdk.installed) === 0 && !dryRun) {
        verdict.sdk = { ok: true, skipped: true, note: 'already on ' + want };
      } else {
        const staged = await stageSdk(want, notes);
        if (!staged.ok) {
          verdict.sdk = staged;
        } else {
          const canary = await runCanary();
          const options = diffOptions(STAGING_DIR);
          verdict.sdk = {
            ok: canary.ok && options.ok !== false,
            from: status.sdk.installed, to: staged.staged || want,
            canary, options,
          };
          if (!canary.ok) verdict.sdk.error = 'canary failed: ' + (canary.error || 'no OK in the reply');
          else if (options.ok === false) verdict.sdk.error = 'the new SDK drops Options PlumiChat passes: ' + options.lost.join(', ');
        }
      }
    }

    /* ---- terminal CLI ---- */
    if (target === 'cli' || target === 'both') {
      verdict.cli = await applyCliUpdate(version || status.cli.latest, { dryRun, prune });
    }

    const sdkOk = !verdict.sdk || verdict.sdk.ok;
    const cliOk = !verdict.cli || verdict.cli.ok;
    verdict.ok = sdkOk && cliOk;

    // step 4 — a dry run stops here, having proved the thing works without moving
    // a single file the app actually loads.
    if (dryRun) {
      const res = {
        ok: verdict.ok, dryRun: true, verdict,
        note: verdict.ok
          ? 'dry run passed — nothing was changed; run again with dryRun:false to write the version bump into the dev repo'
          : 'dry run failed — nothing was changed',
      };
      logAttempt({ target, version: version || null, dryRun: true, ok: verdict.ok, verdict: slimVerdict(verdict) });
      return res;
    }

    // step 5 — the ONLY write into a real repo, and only into the dev copy.
    let note = verdict.cli && verdict.cli.ok ? (verdict.cli.note || 'terminal CLI updated in place')
      : (verdict.sdk && verdict.sdk.skipped) ? verdict.sdk.note
        : 'nothing was changed';
    if (verdict.sdk && verdict.sdk.ok && !verdict.sdk.skipped) {
      const copied = await promoteToDevRepo(notes);
      verdict.promote = copied;
      if (!copied.ok) verdict.ok = false;
      note = copied.ok
        ? 'package.json updated in the dev repo — commit, push, pull and restart to activate'
        : 'canary passed but the dev repo was not updated: ' + copied.error;
    }

    const res = { ok: verdict.ok, verdict, note };
    logAttempt({ target, version: version || null, dryRun: false, ok: verdict.ok, note, verdict: slimVerdict(verdict) });
    return res;
  } catch (err) {
    // Includes assertNotLive() throwing, which is a refusal we want in the log.
    const msg = String((err && err.message) || err);
    logAttempt({ target, version: version || null, dryRun: !!dryRun, ok: false, error: msg });
    return { ok: false, error: msg };
  } finally {
    applying = false;
    statusCache = { at: 0, value: null }; // versions may have moved — recheck next call
  }
}

// Hand the vetted manifest pair to the DEV working tree. Nothing else is copied:
// node_modules stays exactly as it is in both real checkouts, so no running
// process has its engine swapped underneath it.
async function promoteToDevRepo(notes) {
  if (path.resolve(DEV_REPO) === LIVE_CLONE || isInside(LIVE_CLONE, DEV_REPO)) {
    return { ok: false, error: 'the configured dev repo IS the live clone — refusing to write' };
  }
  if (!fs.existsSync(path.join(DEV_REPO, 'package.json'))) {
    return { ok: false, error: 'dev repo not found at ' + DEV_REPO };
  }
  const written = [];
  for (const f of ['package.json', 'package-lock.json']) {
    const from = path.join(STAGING_DIR, f);
    if (!fs.existsSync(from)) continue;
    const to = assertNotLive(path.join(DEV_REPO, f));
    try { await fsp.copyFile(from, to); written.push(f); }
    catch (e) { return { ok: false, error: 'copying ' + f + ': ' + (e.message || e), written }; }
  }
  if (!written.length) return { ok: false, error: 'staging produced no manifest to copy' };
  notes.push('wrote ' + written.join(' + ') + ' into ' + DEV_REPO);
  return { ok: true, repo: DEV_REPO, written };
}

// The store keeps 50 attempts; a full verdict carries the whole changelog-sized
// Options diff, so persist the shape a human actually reads back.
function slimVerdict(v) {
  const out = { target: v.target, dryRun: v.dryRun, ok: v.ok };
  if (v.sdk) {
    out.sdk = {
      ok: v.sdk.ok, from: v.sdk.from || null, to: v.sdk.to || null,
      skipped: !!v.sdk.skipped, error: v.sdk.error || null,
      canaryReply: (v.sdk.canary && v.sdk.canary.reply) || null,
      lostOptions: (v.sdk.options && v.sdk.options.lost) || [],
    };
  }
  if (v.cli) out.cli = { ok: v.cli.ok, before: v.cli.before || null, after: v.cli.after || null, error: v.cli.error || null };
  if (v.promote) out.promote = v.promote;
  return out;
}

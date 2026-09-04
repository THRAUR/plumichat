// One-tap engine update: stage → canary → commit → push → pull → install → restart.
//
// server/engine.js deliberately STOPS after writing the vetted package.json into
// the dev repo, because the last three steps are the dangerous ones. This module
// is the rest of the walk, and exists because doing it by hand is five commands
// on a phone. Everything here is about making the dangerous part survivable.
//
// THE HAZARD, precisely: `npm ci` deletes node_modules before it reinstalls, and
// every chat turn spawns its ~215 MB CLI binary from in there. If the install
// fails, or the box loses power mid-install, the live clone cannot boot. Restart
// into that and PM2 backs off, the port goes dark, and the owner — who reaches
// this machine only through that port — has no way back in short of physical
// access. That is the single failure this file is built to prevent.
//
// THE DEFENCE, in three layers:
//   1. node_modules is RENAMED aside, never deleted. A rename on the same
//      filesystem is atomic and instant, so the known-good tree is always one
//      rename away right up until we prove the new one works.
//   2. The new tree is proven BEFORE any restart: the SDK must resolve and its
//      bundled CLI must answer --version, both in a child process so a broken
//      install cannot take this one down.
//   3. A DETACHED watchdog outlives the restart. Nothing inside this process can
//      roll anything back once PM2 replaces it, so the rollback has to be
//      somewhere else, already running, before the restart is issued.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { DEV_REPO, applyUpdate } from './engine.js';
import { read, update, DATA_DIR } from './store.js';

const HOME = process.env.HOME || os.homedir();
// Empty unless a two-copy deploy is configured — see engine.js.
const LIVE_CLONE = process.env.PLUMI_LIVE_CLONE ? path.resolve(process.env.PLUMI_LIVE_CLONE) : '';
const NPM_CLI = path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const PM2_APP = process.env.PM2_APP_NAME || 'plumi';
const PORT = Number(process.env.PORT || 3002);

const GIT_MS = 20 * 1000;
const PUSH_MS = 3 * 60 * 1000;
const NPM_CI_MS = 15 * 60 * 1000;
const VERIFY_MS = 90 * 1000;
const STORE = 'engine-ship';          // the running/last job, readable after a restart

// Empty LIVE_CLONE would make these RELATIVE paths ('node_modules'), i.e. whatever
// the current directory happens to be. Keep them empty instead, and shipEnabled()
// below is what every entry point checks first.
const MODULES = LIVE_CLONE ? path.join(LIVE_CLONE, 'node_modules') : '';
const MODULES_BAK = LIVE_CLONE ? path.join(LIVE_CLONE, 'node_modules.previous') : '';

// Two-copy deploy configured? Everything in this module is a no-op without it.
export function shipEnabled() { return !!LIVE_CLONE; }
const WATCHDOG = path.join(DATA_DIR, 'engine-watchdog.mjs');

let shipping = false;

/* ------------------------------- job record ------------------------------- */
// Persisted, not in-memory: the whole point is that the interesting part happens
// across a restart, so the phone must be able to ask "how did that go?" of a
// process that did not witness it.
function setJob(patch) {
  return update(STORE, (cur) => {
    const job = { ...(cur.job || {}), ...patch };
    job.steps = job.steps || [];
    return { job };
  }, { job: null }).job;
}
function pushStep(name, ok, detail) {
  return update(STORE, (cur) => {
    const job = cur.job || { steps: [] };
    job.steps = (job.steps || []).concat([{ name, ok, detail: detail || null, at: Date.now() }]);
    return { job };
  }, { job: null }).job;
}
export function shipStatus() {
  const job = read(STORE, { job: null }).job || null;
  return { running: shipping, job };
}

/* --------------------------------- helpers -------------------------------- */
// Node puts the useful line FIRST ("Package subpath './package.json' is not
// defined by exports") and the stack after it, so a tail-only slice throws away
// the reason and keeps the noise. Keep both ends.
function why(text, max = 600) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.floor(max * 0.6)) + ' … ' + t.slice(-Math.floor(max * 0.4));
}

function sh(cmd, args, { cwd, timeout = GIT_MS, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, env: env || process.env, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: String(stderr || (err && err.message) || '').trim(),
      }));
  });
}

// Any HTTP answer at all proves the process booted and Express is serving. A 401
// counts: we deliberately do NOT authenticate here, so the watchdog never needs
// credentials on disk. Only "connection refused" means the server is down.
async function serverAnswers(ms = 3000) {
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/health', { signal: AbortSignal.timeout(ms) });
    return r.status > 0;
  } catch { return false; }
}

/* ------------------------------ the watchdog ------------------------------ */
// Written to disk and spawned DETACHED just before the restart. It cannot import
// anything from this repo: the tree it is guarding is the one that might be
// broken, so it depends on nothing but node itself.
const WATCHDOG_SRC = `
// Autogenerated by server/engine-ship.js. Restores the previous node_modules if
// the server does not come back after an engine update. Deliberately dependency-free.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
const [, , port, modules, backup, app, flagFile] = process.argv;
const answers = async () => {
  try { const r = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(3000) }); return r.status > 0; }
  catch { return false; }
};
const note = (o) => { try { fs.writeFileSync(flagFile, JSON.stringify(o)); } catch {} };
const run = (cmd, args) => new Promise((r) => execFile(cmd, args, { timeout: 120000 }, (e) => r(!e)));
(async () => {
  // Give PM2 time to tear the old process down before we start believing silence.
  await new Promise((r) => setTimeout(r, 8000));
  const deadline = Date.now() + ${VERIFY_MS};
  while (Date.now() < deadline) {
    if (await answers()) {
      // Healthy. Drop the backup — 400+ MB of superseded binaries — and get out.
      try { fs.rmSync(backup, { recursive: true, force: true }); } catch {}
      note({ outcome: 'healthy', at: Date.now() });
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  // Never came back. Put the known-good modules back and restart into them.
  try { fs.rmSync(modules, { recursive: true, force: true }); } catch {}
  try { fs.renameSync(backup, modules); } catch (e) { note({ outcome: 'rollback-failed', error: String(e && e.message), at: Date.now() }); process.exit(1); }
  await run('pm2', ['restart', app]);
  note({ outcome: 'rolled-back', at: Date.now() });
  process.exit(0);
})();
`;

function armWatchdog(flagFile) {
  fs.mkdirSync(path.dirname(WATCHDOG), { recursive: true });
  fs.writeFileSync(WATCHDOG, WATCHDOG_SRC, 'utf8');
  const child = spawn(process.execPath, [WATCHDOG, String(PORT), MODULES, MODULES_BAK, PM2_APP, flagFile], {
    detached: true, stdio: 'ignore', cwd: os.tmpdir(),
  });
  child.unref();   // survives this process being replaced by PM2
  return child.pid;
}

// What the watchdog left behind, if anything — read on the next boot so the panel
// can say "it rolled back" instead of the update simply seeming to vanish.
export function lastWatchdogOutcome() {
  const f = path.join(DATA_DIR, 'engine-watchdog-result.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

/* --------------------------------- the ship -------------------------------- */
// `isBusy()` must answer "is a chat turn running right now". Checked twice: once
// up front so the user is told immediately, and again immediately before the
// destructive step, because staging and the canary take minutes and a turn can
// start inside that window.
export async function shipEngineUpdate({ target = 'sdk', version, isBusy } = {}) {
  if (shipping) return { ok: false, error: 'an engine update is already running' };
  const busy = () => { try { return !!(isBusy && isBusy()); } catch { return false; } };
  if (busy()) return { ok: false, error: 'a chat turn is running — try again when the box is idle' };

  shipping = true;
  const flagFile = path.join(DATA_DIR, 'engine-watchdog-result.json');
  try { fs.rmSync(flagFile, { force: true }); } catch { /* first run */ }
  setJob({ startedAt: Date.now(), target, version: version || 'latest', steps: [], done: false, ok: null, error: null });

  try {
    // 1 — stage, canary, and write the vetted manifest into the dev repo. This is
    //     engine.js's whole existing flow; no reason to reimplement it.
    const applied = await applyUpdate({ target, version, dryRun: false, isBusy });
    if (!applied || applied.ok === false) {
      pushStep('canary', false, (applied && applied.error) || 'the staged canary did not pass');
      return finish(false, (applied && applied.error) || 'the staged canary did not pass');
    }
    pushStep('canary', true, 'staged install ran a real turn and the SDK option surface still matches');

    // 2 — commit + push from the dev repo. Nothing else is committed: only the two
    //     manifest files the promote step wrote.
    const add = await sh('git', ['-C', DEV_REPO, 'add', '--', 'package.json', 'package-lock.json'], { timeout: GIT_MS });
    if (!add.ok) return finish(false, 'git add failed: ' + add.err);
    const staged = await sh('git', ['-C', DEV_REPO, 'diff', '--cached', '--name-only'], { timeout: GIT_MS });
    if (!staged.out) {
      // Nothing to COMMIT is not the same as nothing to DO: the manifest may
      // already carry this version (a caret range covers a patch bump, or an
      // earlier attempt promoted and committed it) while the live clone still
      // has the old one installed. Fall through and let the installed-vs-pinned
      // check below decide.
      pushStep('commit', true, 'manifest already carries this version — nothing new to commit');
    } else {
      const subject2 = 'Engine: ' + target + ' → ' + (applied.version || version || 'latest');
      const body2 = 'Staged in a scratch clone, canary turn passed, sdk.d.ts option surface unchanged.\nShipped from PlumiChat by one tap.';
      const commit = await sh('git', ['-C', DEV_REPO, 'commit', '-m', subject2, '-m', body2, '--', 'package.json', 'package-lock.json'], { timeout: GIT_MS });
      if (!commit.ok) return finish(false, 'commit blocked (hook or git error): ' + why(commit.err));
      pushStep('commit', true, subject2);

      const push = await sh('git', ['-C', DEV_REPO, 'push', 'origin', 'HEAD'], { timeout: PUSH_MS });
      if (!push.ok) return finish(false, 'push failed: ' + why(push.err) + ' (the commit is local; push it by hand)');
      pushStep('push', true, 'pushed to origin');
    }

    // 3 — bring the live clone up to it.
    const pull = await sh('git', ['-C', LIVE_CLONE, 'pull', '--ff-only'], { timeout: PUSH_MS });
    if (!pull.ok) return finish(false, 'live pull failed: ' + pull.err);
    pushStep('pull', true, 'live clone fast-forwarded');

    // 4 — is there actually anything to install? Compare what the live lockfile
    //     pins against what is installed there right now. This is the check that
    //     replaced "did git have something to commit", which said no while the
    //     live clone was genuinely a version behind.
    const pinned = livePinnedSdk();
    const installedNow = liveInstalledSdk();
    if (pinned && installedNow && pinned === installedNow) {
      pushStep('install', true, 'already running ' + installedNow + ' — nothing to install');
      return finish(true, null, { note: 'the live server is already running ' + installedNow, upToDate: true });
    }
    pushStep('plan', true, 'live has ' + (installedNow || 'unknown') + ', lockfile pins ' + (pinned || 'unknown'));

    // 5 — the destructive step. Re-check idleness first: staging and the canary
    //     took minutes, and a turn started since would be killed by the install.
    if (busy()) return finish(false, 'a chat turn started while the update was staging — nothing was installed; try again when idle');

    if (!fs.existsSync(MODULES)) return finish(false, 'live node_modules is missing — refusing to touch it');
    try { fs.rmSync(MODULES_BAK, { recursive: true, force: true }); } catch { /* none yet */ }
    // Rename, never delete: this is the rollback, and it is one atomic operation.
    fs.renameSync(MODULES, MODULES_BAK);
    pushStep('backup', true, 'previous node_modules set aside');

    const ci = await sh(process.execPath, [NPM_CLI, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd: LIVE_CLONE, timeout: NPM_CI_MS });
    if (!ci.ok) {
      restoreModules();
      return finish(false, 'npm ci failed, previous modules restored, nothing was restarted: ' + why(ci.err));
    }
    pushStep('install', true, 'npm ci completed');

    // 5 — prove the new tree before betting the server on it. Both checks run in a
    //     child process so a broken install cannot crash this one.
    const proof = await verifyInstalled();
    if (!proof.ok) {
      restoreModules();
      return finish(false, 'the new install did not verify (' + proof.error + '); previous modules restored, nothing was restarted');
    }
    pushStep('verify', true, 'SDK resolves and its CLI answers --version');

    // 6 — arm the rollback, then restart. Order matters: once PM2 replaces this
    //     process nothing here runs again, so the watchdog must already be alive.
    const pid = armWatchdog(flagFile);
    pushStep('watchdog', true, 'rollback armed (pid ' + pid + ')');
    finish(true, null, { restarting: true });

    setTimeout(() => {
      execFile('pm2', ['restart', PM2_APP], { timeout: 60000 }, (err) => {
        if (err) console.error('[engine-ship] pm2 restart failed:', err.message);
      });
    }, 1200);   // let the HTTP response flush first

    return { ok: true, restarting: true, job: shipStatus().job };
  } catch (err) {
    return finish(false, (err && err.message) || String(err));
  } finally {
    shipping = false;
  }
}

// What `npm ci` in the live clone WILL install, and what is installed there now.
// These two, not a git diff, are what decide whether there is work to do: with a
// caret range a new patch release changes no manifest line, and a promote that
// was already committed leaves nothing to commit while the live tree is still
// running the old version. That is exactly how a real update reported "nothing
// to ship" while the live clone sat a version behind.
function livePinnedSdk() {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(LIVE_CLONE, 'package-lock.json'), 'utf8'));
    const key = Object.keys(lock.packages || {}).find((k) => k.endsWith('@anthropic-ai/claude-agent-sdk'));
    return key ? (lock.packages[key].version || null) : null;
  } catch { return null; }
}
function liveInstalledSdk() {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(LIVE_CLONE, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version || null;
  } catch { return null; }
}

function restoreModules() {
  try { fs.rmSync(MODULES, { recursive: true, force: true }); } catch { /* may not exist */ }
  try { fs.renameSync(MODULES_BAK, MODULES); pushStep('rollback', true, 'previous node_modules restored'); }
  catch (e) { pushStep('rollback', false, 'could not restore node_modules: ' + (e && e.message)); }
}

// Prove the new tree before betting the server on it. Run OUT OF PROCESS: importing
// a half-installed ESM tree into this process is exactly the crash we are avoiding.
//
// What we check and why: the SDK must actually IMPORT and still expose `query`,
// because that is the single call every chat turn makes — a package that resolves
// but throws on load would pass a resolution-only check and then break every turn.
// The version is read straight off disk rather than through the package: the SDK's
// `exports` map has no "./package.json" entry, so requiring that subpath fails with
// ERR_PACKAGE_PATH_NOT_EXPORTED on a perfectly healthy install. (It did, on the
// first real run of this feature — the rollback caught it, which is the point.)
async function verifyInstalled() {
  const probe = [
    'import { createRequire } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    'import fs from "node:fs";',
    'import path from "node:path";',
    'const root = process.argv[1];',
    'const req = createRequire(path.join(root, "x.js"));',
    'const entry = req.resolve("@anthropic-ai/claude-agent-sdk");',
    'const mod = await import(pathToFileURL(entry).href);',
    'if (typeof mod.query !== "function") throw new Error("the SDK loaded but exports no query()");',
    'const pkg = path.join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");',
    'process.stdout.write(JSON.parse(fs.readFileSync(pkg, "utf8")).version || "unknown");',
  ].join('\n');
  const res = await sh(process.execPath, ['--input-type=module', '-e', probe, LIVE_CLONE], { cwd: LIVE_CLONE, timeout: 90 * 1000 });
  if (!res.ok || !res.out) return { ok: false, error: 'the SDK did not load: ' + why(res.err || 'no version reported') };

  // The bundled CLI is what a turn actually spawns, so a tree whose binary will not
  // execute is broken even though the JS imported fine.
  const bin = path.join(LIVE_CLONE, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude');
  if (fs.existsSync(bin)) {
    const ver = await sh(bin, ['--version'], { timeout: 90 * 1000 });
    if (!ver.ok) return { ok: false, error: 'the bundled CLI did not run: ' + why(ver.err) };
    return { ok: true, sdk: res.out, cli: ver.out };
  }
  return { ok: true, sdk: res.out, cli: null };   // platform package absent is not fatal
}

function finish(ok, error, extra) {
  const job = setJob({ done: true, ok, error: error || null, finishedAt: Date.now(), ...(extra || {}) });
  return { ok, error: error || null, job };
}

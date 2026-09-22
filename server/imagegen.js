// server/imagegen.js — making a picture, as one tool the agent can call.
//
// The generator is stable-diffusion.cpp, which ships as two binaries, and this
// module uses both:
//
//   sd-cli     loads its weights, writes one file and exits. The floor: it needs
//              nothing, so it is what runs when anything else is unavailable.
//   sd-server  keeps the weights loaded and answers over HTTP on loopback.
//
// The CLI was the whole design at first, on the reasoning that a box with a few
// gigabytes of RAM to spare cannot afford a daemon holding a model hostage. Then it
// was measured: of 44 seconds, 31 were re-reading 6.4 GB of weights that had not
// changed since the last picture. Warm, the same picture takes 17. So the resident
// server is used when it can be reached, with an idle timer that unloads it — the
// weights are a cache, not a tenancy, and an unattended box gives the card back.
//
// Three properties are load-bearing and easy to break:
//
// 1. THE MODEL NEVER NAMES A PATH. Not the output file, not a model file, not a
//    directory. Everything on disk is derived here from the account that started
//    the turn — exactly the rule memory.js follows, and for exactly the same
//    reason: an SDK MCP tool runs inside the server process, OUTSIDE the bubblewrap
//    sandbox that confines a member's Bash. The sandbox is not protecting this code;
//    this code is the confinement.
//
// 2. THE CHILD MAY NOT BE ABLE TO SEE THE DESTINATION. Under WSL the CUDA build is
//    a Windows program (upstream ships no Linux CUDA binary), and a Windows program
//    cannot usefully write into ext4 — only through a \\wsl.localhost path that is
//    slow and that some programs refuse. So the CLI always writes to scratch on its
//    own side and this module moves the result. See runViaCli().
//
// 3. THE RESIDENT SERVER IS PROBED, NEVER ASSUMED. Reaching a Windows-side listener
//    from WSL works here because this box runs `networkingMode=mirrored`; on a box
//    without it, that connection simply never answers. So the engine is started,
//    health-checked, and on any failure the reason is recorded once and every
//    picture falls back to the CLI. Slower is a degraded feature; broken is not.
//
// Off unless PLUMI_IMAGE_DIR points at an install. A box without one loses the tool
// and nothing else, and says why at startup (capabilities.js).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { imageGenSource, winPath, findNvidiaSmi } from './platform.js';
import { userHome, ensureDir } from './sandbox.js';
import { findById } from './users.js';

const SERVER_NAME = 'plumichat-image';

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const TIMEOUT_MS = num(process.env.PLUMI_IMAGE_TIMEOUT_MS, 300000);
const QUEUE_WAIT_MS = num(process.env.PLUMI_IMAGE_QUEUE_MS, 180000);
const MIN_VRAM_MB = num(process.env.PLUMI_IMAGE_MIN_VRAM_MB, 4500);
const KEEP_DAYS = num(process.env.PLUMI_IMAGE_KEEP_DAYS, 30);
const KEEP_MB = num(process.env.PLUMI_IMAGE_KEEP_MB, 2048);

// The resident engine. Loopback only — it has no authentication of its own, so the
// one thing that must never happen is it listening anywhere else.
const ENGINE_PORT = num(process.env.PLUMI_IMAGE_PORT, 1234);
// Long enough to survive a coffee, short enough that an unattended machine is not
// still holding 4 GB of VRAM overnight.
const IDLE_MS = num(process.env.PLUMI_IMAGE_IDLE_MS, 900000);
// Cold start reads gigabytes off disk; a slow disk can take minutes and that is not
// a failure.
const BOOT_MS = num(process.env.PLUMI_IMAGE_BOOT_MS, 240000);
// auto = use the resident server if it can be reached, otherwise the CLI.
const ENGINE_MODE = String(process.env.PLUMI_IMAGE_ENGINE || 'auto').toLowerCase();

// Measured, and the reason this is not PNG: the same 1216x832 picture is 2034 KB as
// a PNG and 120-190 KB as a webp at quality 92, with no difference anyone has been
// able to point at. Over a phone link on the other side of the world that is the
// difference between a picture that appears and one that crawls in. PlumiChat has no
// image library and cannot re-encode anything itself, so the small file has to come
// out of the generator already small.
const FORMATS = { webp: '.webp', png: '.png', jpeg: '.jpg' };
const FORMAT = FORMATS[String(process.env.PLUMI_IMAGE_FORMAT || 'webp').toLowerCase()] ? String(process.env.PLUMI_IMAGE_FORMAT || 'webp').toLowerCase() : 'webp';
const QUALITY = Math.min(100, Math.max(50, num(process.env.PLUMI_IMAGE_QUALITY, 92)));

// Where a generated picture lands, inside the account's own home. The dot prefix is
// the same trick `.users` uses: listProjectsFor() skips dotted entries, so a gallery
// folder does not turn up in the project picker pretending to be a project — while
// staying fully browsable, downloadable and thumbnail-able, because resolveBrowse
// contains an account to its home and this is inside it.
const GALLERY = '.plumi-images';

// zod and the SDK's tool helpers, both optional in the way that matters: without
// them the tool is simply not offered and the capability row says so. Not in
// package.json for the reason memory.js records — the SDK already pulls zod in as a
// peer, and a second copy at another version is exactly what must not happen.
let z = null;
let sdkTools = null;
try { ({ z } = await import('zod')); } catch { z = null; }
try {
  const m = await import('@anthropic-ai/claude-agent-sdk');
  if (typeof m.createSdkMcpServer === 'function' && typeof m.tool === 'function') sdkTools = m;
} catch { sdkTools = null; }

/* --------------------------------- presets -------------------------------- */

// What a model needs on the command line, as data. `args` is passed to the binary
// VERBATIM, and that is deliberate rather than lazy: the flag naming the text
// encoder changes with the model family (--llm for Qwen-family encoders, --t5xxl
// and --clip_l for the Stable Diffusion lineage), so a named field per flag is
// precisely what would force a code change to add the second model. Everything the
// server needs to clamp or report — steps, guidance, sizes — stays a named field.
const BUILTIN = {
  default: 'z-image-turbo',
  models: {
    'z-image-turbo': {
      label: 'Z-Image Turbo',
      args: [
        '--diffusion-model', 'models/z_image_turbo-Q4_K.gguf',
        '--llm', 'models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        '--vae', 'models/ae.safetensors',
        '--diffusion-fa',
        // Measured on an 8 GB card: without this the VAE asks for ~7.3 GB while the
        // diffusion model still holds the rest, fails, and sd.cpp retries it tiled
        // anyway. Asking for tiles up front costs nothing visible and turns a run
        // that logs two errors into one that logs none.
        '--vae-tiling',
      ],
      steps: 8,
      // A distilled model. Guidance above ~1 does not sharpen it, it destroys it.
      cfgScale: 1.0,
      sizes: { square: [1024, 1024], portrait: [832, 1216], landscape: [1216, 832] },
      requires: [
        'models/z_image_turbo-Q4_K.gguf',
        'models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        'models/ae.safetensors',
      ],
    },
  },
};

// Every pixel the card has to hold at once. 1216x832 is a little over a megapixel;
// the ceiling is here so a preset added by hand cannot quietly ask for 4K and turn
// a working install into one that only ever reports out-of-memory.
const MAX_PIXELS = 1400 * 1400;

function readPresets(root) {
  const f = path.join(root, 'presets.json');
  if (!fs.existsSync(f)) return { cfg: BUILTIN, from: 'built-in' };
  try {
    return { cfg: JSON.parse(fs.readFileSync(f, 'utf8')), from: 'presets.json' };
  } catch (err) {
    return { cfg: null, err: `presets.json could not be read (${err.message})` };
  }
}

// A path from the config, resolved inside the install and nowhere else. The same
// containment habit as the rest of the server: a `../../etc` in a config file is a
// mistake worth refusing rather than following.
function inRoot(root, rel) {
  const abs = path.resolve(root, String(rel || ''));
  const r = path.relative(root, abs);
  return !r || r.startsWith('..') || path.isAbsolute(r) ? null : abs;
}

/* ---------------------------------- status -------------------------------- */

// Probed once. Re-reading a config on every turn buys nothing: adding a model means
// putting several gigabytes on disk, which is not something anyone does without
// restarting afterwards.
let status = null;

export function imagegenStatus() {
  if (status) return status;
  status = probe();
  return status;
}

function off(reason) { return { ok: false, reason, detail: '', presets: [] }; }

function probe() {
  const src = imageGenSource();
  if (!src) {
    return off(process.env.PLUMI_IMAGE_DIR
      ? `PLUMI_IMAGE_DIR is set to ${process.env.PLUMI_IMAGE_DIR} but no stable-diffusion.cpp binary is there (looked for sd-cli.exe, sd.exe, sd-cli and sd, in bin/ and in the folder itself).`
      : 'PLUMI_IMAGE_DIR is not set, so there is no local image generator. Install stable-diffusion.cpp with a model, then point PLUMI_IMAGE_DIR at that folder.');
  }
  if (!z || !sdkTools) {
    return off('The Claude Agent SDK tool helpers or zod could not be loaded, so the image tool cannot be offered. Reinstall dependencies.');
  }

  // Scratch: where the child writes before the file is moved into the account's
  // gallery. It has to be somewhere the child itself can address, which under WSL
  // means a Windows drive — hence the check rather than an assumption.
  const scratch = process.env.PLUMI_IMAGE_SCRATCH || path.join(src.root, 'out');
  const scratchForChild = src.kind === 'windows' ? winPath(scratch) : scratch;
  if (!scratchForChild) {
    return off(`The scratch folder ${scratch} is not on a Windows drive, and a Windows sd.exe cannot write anywhere else. Put the install under /mnt/<drive>/ or set PLUMI_IMAGE_SCRATCH to a folder that is.`);
  }
  try { ensureDir(scratch); } catch (err) { return off(`The scratch folder ${scratch} could not be created (${err.message}).`); }

  const { cfg, err } = readPresets(src.root);
  if (!cfg) return off(err);

  // A preset that cannot work is DROPPED with a reason, never fatal: one missing
  // model must not take the others down with it.
  const presets = [];
  const dropped = [];
  for (const [id, m] of Object.entries(cfg.models || {})) {
    const why = checkPreset(src.root, m);
    if (why) { dropped.push(`${id}: ${why}`); continue; }
    presets.push({ id, ...m });
  }
  if (!presets.length) {
    return off(dropped.length
      ? `No usable image model. ${dropped[0]}`
      : 'The image generator is installed but presets.json names no models.');
  }

  const first = cfg.default && presets.find((p) => p.id === cfg.default);
  if (first) presets.sort((a, b) => (a.id === first.id ? -1 : b.id === first.id ? 1 : 0));

  const canWarm = !!src.server && ENGINE_MODE !== 'cli';
  return {
    ok: true,
    reason: '',
    detail: `${path.basename(src.cmd)}${canWarm ? ' + resident engine' : ''} + ${presets.length} model${presets.length > 1 ? 's' : ''} (${presets.map((p) => p.label || p.id).join(', ')})`,
    src, scratch, scratchForChild, presets,
    dropped,
  };
}

function checkPreset(root, m) {
  if (!m || !Array.isArray(m.args) || !m.args.length) return 'no args';
  for (const rel of m.requires || []) {
    const abs = inRoot(root, rel);
    if (!abs) return `${rel} resolves outside the install folder`;
    if (!fs.existsSync(abs)) return `${rel} is missing`;
  }
  const sizes = m.sizes || {};
  if (!sizes.square) return 'no square size';
  for (const [name, wh] of Object.entries(sizes)) {
    if (!Array.isArray(wh) || wh.length !== 2) return `size ${name} is not [width, height]`;
    const [w, h] = wh.map(Number);
    if (!(w > 0 && h > 0) || w % 16 || h % 16) return `size ${name} must be positive multiples of 16`;
    if (w * h > MAX_PIXELS) return `size ${name} is larger than this server allows`;
  }
  return null;
}

/* ------------------------------ one at a time ----------------------------- */

// One GPU, so one job. A plain promise chain rather than a library, with the link
// released in a `finally` — a job that throws must not wedge every later one.
//
// Waiting is bounded in both directions. A third caller is refused outright instead
// of stacking, and a caller that has waited past QUEUE_WAIT_MS gives up: a turn
// frozen for ten minutes behind someone else's queue is worse for the person
// reading it than a refusal their assistant can explain.
let chain = Promise.resolve();
let waiting = 0;
const MAX_WAITING = 2;

async function withGpu(fn) {
  if (waiting >= MAX_WAITING) throw new Error('busy');
  waiting += 1;
  const prev = chain;
  let release;
  chain = new Promise((r) => { release = r; });
  try {
    let timer;
    const gate = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('queue')), QUEUE_WAIT_MS); });
    try { await Promise.race([prev, gate]); } finally { clearTimeout(timer); }
    return await fn();
  } finally {
    waiting -= 1;
    // Resolved WITH `prev`, not bare. On the normal path prev has already settled,
    // so this releases immediately. On the gave-up-waiting path it matters: the job
    // ahead is still on the card, and handing the next caller an already-resolved
    // promise would let two of them run at once — which is the one thing this
    // function exists to prevent. A promise resolved with a promise adopts it.
    release(prev);
  }
}

/* --------------------------------- the card ------------------------------- */

// Free VRAM, in MB, or null when there is no way to ask. Cached for a moment
// because two calls a second apart would tell the same story and each costs a
// subprocess — the same reasoning (and the same two seconds) as PlumiRecord's
// memory reading.
//
// This is the right number to guard on, not system RAM: under WSL the generator
// runs as a Windows process, so /proc/meminfo describes a machine it is not using.
let vramAt = 0;
let vramMb = null;
function freeVramMb() {
  if (Date.now() - vramAt < 2000) return vramMb;
  vramAt = Date.now();
  const smi = findNvidiaSmi();
  if (!smi) return (vramMb = null);
  try {
    const out = execFileSync(smi, ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 2500 });
    const n = parseInt(String(out).split(/\r?\n/)[0], 10);
    return (vramMb = Number.isFinite(n) ? n : null);
  } catch { return (vramMb = null); }
}
// Refuse a model LOAD onto a card that has no room for it, with the number in the
// message. Only the two paths that load weights call this — a spawn of the resident
// engine, and a CLI run; adopting an engine that is already up loads nothing.
function assertVramForLoad() {
  const free = freeVramMb();
  if (free !== null && free < MIN_VRAM_MB) throw new Error(`vram:${free}`);
}


/* -------------------------------- generating ------------------------------ */

const SHAPES = ['square', 'portrait', 'landscape'];

function slug(s, max = 40) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'image';
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Config args, verbatim, with relative model paths resolved here rather than by the
// child's working directory — a Windows binary needs Windows paths for its weights
// too. Shared by both backends so they can never disagree about which model is
// loaded.
function resolveArgs(st, preset) {
  const args = [];
  for (let i = 0; i < preset.args.length; i += 1) {
    const a = preset.args[i];
    const next = preset.args[i + 1];
    if (typeof a === 'string' && a.startsWith('-') && typeof next === 'string' && !next.startsWith('-')) {
      const abs = inRoot(st.src.root, next);
      const asFile = abs && fs.existsSync(abs);
      args.push(a, asFile ? (st.src.kind === 'windows' ? winPath(abs) || abs : abs) : next);
      i += 1;
    } else args.push(a);
  }
  return args;
}

/* -------------------------------- the engine ------------------------------ */

// At most one resident child, and it is a cache: anything that goes wrong with it
// costs speed, never the picture. `engineFault` is the sentence explaining why the
// slow path is in use, and it is reported rather than thrown.
let engine = null;
let engineFault = '';
let engineNoted = false;
let idleTimer = null;
let bootLock = null;

const engineUrl = (p) => `http://127.0.0.1:${ENGINE_PORT}${p}`;

async function ask(p, init, ms = 10000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetch(engineUrl(p), { ...(init || null), signal: ac.signal }); }
  finally { clearTimeout(timer); }
}

async function engineAnswers(ms = 2500) {
  try { return (await ask('/sdcpp/v1/capabilities', {}, ms)).ok; } catch { return false; }
}

// Every use of the engine — a picture, or a page of the upstream WebUI — pushes the
// unload back. The weights are worth holding while someone is working and worth
// dropping the moment they stop.
function touchEngine() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!IDLE_MS || !engine) return;
  idleTimer = setTimeout(() => { stopEngine('idle'); }, IDLE_MS);
  idleTimer.unref?.();
}

async function stopEngine() {
  const rec = engine;
  engine = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!rec || rec.gone || !rec.child) return;
  // SIGKILL on the WSL-side interop child takes the Windows process with it —
  // verified by watching the card drop straight back to its idle 449 MiB.
  try { rec.child.kill('SIGKILL'); } catch { /* already gone */ }
  await new Promise((r) => {
    if (rec.gone) return r();
    rec.child.once('exit', r);
    setTimeout(r, 5000);
  });
}

function lastLine(s) {
  return String(s || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]?.slice(0, 200) || 'no output';
}

async function bootEngine(st, preset) {
  // Something already listening is almost always our own child, orphaned by a
  // restart while it was warm — there is no shutdown endpoint to reclaim it with.
  // Adopting it is right when there is only one model to be confused about, and
  // wrong the moment there are two, because nothing in its API says which one it
  // loaded and a silently wrong model is worse than a slow one.
  if (await engineAnswers()) {
    if (st.presets.length === 1) {
      engine = { child: null, presetId: preset.id, gone: false, adopted: true };
      touchEngine();
      return engine;
    }
    engineFault = `something is already listening on 127.0.0.1:${ENGINE_PORT} and there is more than one model installed, so it is not safe to assume which one it holds. Set PLUMI_IMAGE_PORT to a free port.`;
    return null;
  }

  // About to load 6.4 GB of weights onto the card: this is one of the two moments
  // the floor is for. It throws, so ensureEngine()'s caller sees the real reason
  // rather than a mute fall back to a CLI run that would fail the same way.
  assertVramForLoad();

  let child;
  try {
    child = spawn(st.src.server, resolveArgs(st, preset).concat([
      '--listen-ip', '127.0.0.1', '--listen-port', String(ENGINE_PORT),
    ]), {
      // Pinned to the binary's own folder for the same reason the CLI is: a Windows
      // program handed a \\wsl.localhost working folder may refuse to start, and the
      // CUDA DLLs sit beside the executable.
      cwd: path.dirname(st.src.server),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    engineFault = `the resident engine could not be started (${err.message})`;
    return null;
  }

  const rec = { child, presetId: preset.id, gone: false, tail: '' };
  const keep = (b) => { rec.tail = (rec.tail + String(b)).slice(-4000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('error', keep);
  child.on('exit', () => { rec.gone = true; if (engine === rec) engine = null; });
  engine = rec;

  const until = Date.now() + BOOT_MS;
  while (Date.now() < until) {
    if (rec.gone) {
      engineFault = `the resident engine exited while loading — ${lastLine(rec.tail)}`;
      engine = null;
      return null;
    }
    if (await engineAnswers()) { touchEngine(); return rec; }
    await sleep(700);
  }
  // The common cause is a WSL without mirrored networking, where a Windows-side
  // 127.0.0.1 listener is simply not reachable from here. Say so, because it is a
  // one-line fix for whoever reads it.
  engineFault = `the resident engine did not answer on 127.0.0.1:${ENGINE_PORT} within ${Math.round(BOOT_MS / 1000)}s. Under WSL this needs networkingMode=mirrored in .wslconfig; without it pictures still work, one model load at a time.`;
  await stopEngine();
  return null;
}

// Null means "use the CLI". Callers must treat that as normal.
export async function ensureEngine(preset) {
  const st = imagegenStatus();
  if (!st.ok || ENGINE_MODE === 'cli' || !st.src.server) return null;
  const want = preset || st.presets[0];

  while (bootLock) { try { await bootLock; } catch { /* the fault is recorded */ } }
  if (engine && !engine.gone && engine.presetId === want.id) { touchEngine(); return engine; }

  bootLock = (async () => {
    if (engine) await stopEngine();
    return bootEngine(st, want);
  })();
  try {
    const got = await bootLock;
    if (!got && engineFault && !engineNoted) {
      engineNoted = true;
      console.log(`[image] running one model load per picture: ${engineFault}`);
    }
    return got;
  } finally { bootLock = null; }
}

// The upstream WebUI lives inside the resident binary, so the studio exists exactly
// when that binary does. Reported separately from imageGen: an install with only the
// CLI still makes pictures, it just has no page of knobs to open.
export function imagegenStudio() {
  const st = imagegenStatus();
  if (!st.ok) return { ok: false, reason: st.reason };
  if (ENGINE_MODE === 'cli') return { ok: false, reason: 'PLUMI_IMAGE_ENGINE is set to cli, so the resident engine — and the studio page it serves — is turned off.' };
  if (!st.src.server) return { ok: false, reason: `No sd-server binary in ${st.src.root}. It ships in the same release as the CLI and is what serves the studio page; without it pictures still work, one model load at a time.` };
  return { ok: true, reason: '', detail: path.basename(st.src.server) };
}

export function engineState() {
  return {
    warm: !!(engine && !engine.gone),
    model: engine && !engine.gone ? engine.presetId : '',
    port: ENGINE_PORT,
    fault: engineFault,
    mode: ENGINE_MODE,
  };
}

// Best effort only: a process killed outright cannot run this, which is exactly why
// bootEngine() knows how to adopt a listener it did not start.
process.on('exit', () => { try { engine?.child?.kill('SIGKILL'); } catch { /* going away anyway */ } });

// 'exit' alone is not enough, and the gap is not theoretical: SIGTERM is what a
// process manager sends to restart this server, and its default action terminates
// without ever running an 'exit' listener — so every restart left a warm engine
// holding ~4.4 GB of the card with nothing alive to time it out. Re-raising is what
// keeps this from becoming a shutdown handler: once() has already removed the
// listener by the time the body runs, so the second delivery finds the default
// disposition and the process dies exactly as it would have, same signal, same code.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    try { engine?.child?.kill('SIGKILL'); } catch { /* already gone */ }
    process.kill(process.pid, sig);
  });
}

/* ------------------------------- the backends ----------------------------- */

const runChild = (cmd, args, opts) => new Promise((resolve) => {
  execFile(cmd, args, opts, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

// The resident path. Returns the finished picture's bytes; the job is asynchronous
// on the engine's side, so this polls and reports progress as it goes.
async function runViaServer(o) {
  const body = {
    prompt: o.prompt,
    negative_prompt: o.negative || '',
    width: o.width,
    height: o.height,
    seed: o.seed,
    batch_count: 1,
    output_format: o.format,
    output_compression: o.quality,
    sample_params: { sample_steps: o.steps, guidance: { txt_cfg: o.cfg } },
  };
  // Measured, not guessed: this POST usually answers 202 in milliseconds, but the
  // FIRST one after a long idle took over 20s and was aborted — the engine had been
  // warm for so long that Windows had paged out the 2.5 GB of weights it keeps in
  // RAM, and it cannot answer until they are back. A 20s ceiling turned that into a
  // dead engine and a 45s CLI fall-back, which is the exact wait this whole path
  // exists to remove. TIMEOUT_MS bounds the picture as a whole, so nothing is
  // unbounded; only a genuinely wedged engine reaches it.
  const r = await ask('/sdcpp/v1/img_gen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, TIMEOUT_MS);
  if (!r.ok) throw new Error(`the engine refused the job (HTTP ${r.status})`);
  const queued = await r.json();
  if (!queued || !queued.id) throw new Error('the engine queued nothing');

  const until = Date.now() + TIMEOUT_MS;
  let job = null;
  while (Date.now() < until) {
    await sleep(600);
    // Same reason as the enqueue above, smaller: a poll landing mid-VAE on a busy
    // card can sit for a while, and killing a picture that is nearly finished to
    // start it again from scratch is the worst possible trade.
    const jr = await ask(`/sdcpp/v1/jobs/${encodeURIComponent(queued.id)}`, {}, 60000);
    if (!jr.ok) throw new Error(`the engine lost track of the job (HTTP ${jr.status})`);
    job = await jr.json();
    if (typeof o.onProgress === 'function') o.onProgress(job);
    if (job.status === 'completed') break;
    if (job.status === 'failed' || job.status === 'cancelled') throw new Error(String(job.error || job.status));
  }
  if (!job || job.status !== 'completed') throw new Error('timeout');

  const b64 = job.result?.images?.[0]?.b64_json;
  if (!b64) throw new Error('the engine finished but returned no picture');
  return Buffer.from(b64, 'base64');
}

// The one-shot path, unchanged in substance: the child writes to scratch on its own
// side of the filesystem because a Windows program cannot usefully write into ext4.
async function runViaCli(st, o) {
  const scratchFile = path.join(st.scratch, `${o.jobId}${FORMATS[o.format]}`);
  const scratchForChild = st.src.kind === 'windows' ? winPath(scratchFile) : scratchFile;

  // The other load: sd-cli reads every weight file on every run.
  assertVramForLoad();

  const args = resolveArgs(st, o.preset);
  args.push('-p', o.prompt);
  if (o.negative) args.push('-n', o.negative);
  args.push('-W', String(o.width), '-H', String(o.height));
  args.push('--steps', String(o.steps));
  args.push('--cfg-scale', String(o.cfg));
  args.push('--compression-quality', String(o.quality));
  args.push('-s', String(o.seed));
  args.push('-o', scratchForChild);

  const { err, stderr, stdout } = await runChild(st.src.cmd, args, {
    cwd: path.dirname(st.src.cmd),
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 1 << 20,
    windowsHide: true,
  });

  // Verified on WSL: SIGKILL on the interop child does take the Windows process
  // with it, so there is no orphaned sd.exe sitting on the card afterwards.
  if (err && (err.killed || err.signal)) { safeUnlink(scratchFile); throw new Error('timeout'); }

  if (!fs.existsSync(scratchFile)) {
    // A clean exit with no file is the signature of a path the child could not
    // write — name it, because that is the one thing the log will not show.
    const tail = (stderr || stdout).trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
    throw new Error(`the generator finished but wrote nothing to ${scratchForChild}${tail ? ` — ${tail}` : ''}`);
  }
  try { return fs.readFileSync(scratchFile); } finally { safeUnlink(scratchFile); }
}

const clamp = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : dflt);

// Pick a backend, make one picture, and land it in the account's gallery. The file
// is written HERE, from bytes, whichever backend produced them — one naming rule and
// one place that touches the destination.
async function runOnce({ st, preset, prompt, negative, shape, seed, outDir, name, steps, cfg, format, onProgress }) {
  const [width, height] = preset.sizes[shape] || preset.sizes.square;
  const jobId = crypto.randomBytes(6).toString('hex');
  const fmt = FORMATS[format] ? format : FORMAT;
  const o = {
    jobId, preset, prompt, negative, width, height, seed, onProgress,
    steps: clamp(steps, 1, 60, preset.steps || 8),
    cfg: clamp(cfg, 0, 20, preset.cfgScale ?? 1),
    format: fmt,
    quality: QUALITY,
  };

  const started = Date.now();

  // No free-VRAM check here on purpose. The floor guards a model LOAD, and from up
  // here you cannot tell whether one is about to happen: asked before ensureEngine()
  // it is self-defeating twice over. A warm engine holds ~4.4 GB of the card, so free
  // space reads as 3.6 GB and every picture after the first is refused on the grounds
  // that something is using the GPU — that something being itself. Worse, an engine
  // left listening by a previous server is adoptable and needs no load at all, but
  // the refusal lands before bootEngine() ever gets to adopt it, so a box that was
  // ready to draw in one second reports that its card is full. assertVramForLoad()
  // is called by the two places that actually load weights instead.
  const eng = await ensureEngine(preset);
  let buf;
  // Which backend actually drew it, not which one we hoped would: a job that fell
  // back reported warm=true and made the panel promise "about 20s" for a 45s wait.
  let warm = !!eng;
  if (eng) {
    try { buf = await runViaServer(o); touchEngine(); }
    catch (err) {
      // A resident engine that broke mid-job is not a reason to lose the picture.
      if (String(err.message) === 'timeout') throw err;
      await stopEngine();
      engineFault = `the resident engine failed mid-picture (${err.message})`;
      warm = false;
      buf = await runViaCli(st, o);
    }
  } else {
    buf = await runViaCli(st, o);
  }

  ensureDir(outDir);
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(outDir, `${stamp}-${slug(name || prompt)}-${jobId.slice(0, 6)}${FORMATS[o.format]}`);
  fs.writeFileSync(file, buf);
  return {
    file, width, height, seed, bytes: buf.length,
    steps: o.steps, cfg: o.cfg, format: o.format,
    warm,
    secs: Math.round((Date.now() - started) / 1000),
  };
}

function safeUnlink(p) { try { fs.unlinkSync(p); } catch { /* already gone, or never made */ } }

// Any format this module can be configured to write. Retention has to recognise a
// picture made under a setting that has since been changed, or a gallery quietly
// stops being swept the day someone switches to PNG.
const PICTURE_RE = /\.(webp|png|jpg|jpeg)$/i;

/* -------------------------------- retention ------------------------------- */

// Run after a successful generation, on that one account's gallery. Best effort
// throughout: a sweep that fails must never turn into a picture that failed.
function sweep(dir) {
  let rows;
  try {
    rows = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && PICTURE_RE.test(e.name))
      .map((e) => {
        const full = path.join(dir, e.name);
        try { const s = fs.statSync(full); return { full, mtime: s.mtimeMs, size: s.size }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtime - b.mtime);
  } catch { return; }

  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let total = rows.reduce((n, r) => n + r.size, 0);
  const cap = KEEP_MB * 1048576;
  for (const r of rows) {
    const tooOld = r.mtime < cutoff;
    const tooMuch = total > cap;
    if (!tooOld && !tooMuch) break;
    safeUnlink(r.full);
    total -= r.size;
  }
}

// A killed job leaves a part-written file behind on the generator's side.
function sweepScratch(dir) {
  const cutoff = Date.now() - 3600000;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!PICTURE_RE.test(name)) continue;
      const full = path.join(dir, name);
      try { if (fs.statSync(full).mtimeMs < cutoff) safeUnlink(full); } catch { /* raced */ }
    }
  } catch { /* scratch vanished; probe() remakes it next restart */ }
}

/* ---------------------------------- tools --------------------------------- */

const text = (s, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) });

// Why both lines, and why built here rather than described to the model: the
// markdown image is what renders in the bubble (/api/thumb streams it inline, and
// re-checks containment on the way out), while <!--plumi:file--> is what produces
// the Download box and the entry in this chat's file tray. A path holding a space
// or a bracket breaks markdown link syntax silently, so the src is encoded; the
// flag's attribute is read as-is by exports.js and must not be.
function handover(file, prompt, seed, meta, title) {
  const alt = String(prompt).replace(/[[\]()\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  // The Download box wants a short label, so the model's own two or three words are
  // better than the first clause of a paragraph-long prompt. Quotes would close the
  // attribute early, so they cannot survive into it.
  const name = (String(title || '').replace(/["\r\n]/g, ' ').trim() || alt.split(/[,.]/)[0]).slice(0, 40) || 'Image';
  return [
    `Image generated — ${meta}, seed ${seed}.`,
    'End your reply with these two lines, exactly as written, and say nothing about them:',
    '',
    `![${alt}](/api/thumb?path=${encodeURIComponent(file)})`,
    '',
    `<!--plumi:file path="${file}" name="${name}"-->`,
    '',
    `Reuse seed ${seed} to change one thing and keep the rest of the picture.`,
  ].join('\n');
}

function imageServer(outDir) {
  const st = imagegenStatus();
  if (!st.ok || !sdkTools || !z) return null;
  const { createSdkMcpServer, tool } = sdkTools;
  const ids = st.presets.map((p) => p.id);

  const schema = {
    prompt: z.string().min(3).max(1500)
      .describe('A full visual description: subject, setting, composition, lighting, style, mood. The generator has no memory of the conversation and sees only this.'),
    negative_prompt: z.string().max(400).optional()
      .describe('What to keep out. Leave empty unless an earlier attempt went wrong.'),
    shape: z.enum(SHAPES).optional().describe('Aspect of the picture. Default square.'),
    seed: z.number().int().min(0).max(2147483647).optional()
      .describe('Reuse a seed from an earlier result to vary one thing and keep the rest. Omit for a new picture.'),
    name: z.string().max(60).optional().describe('Two or three words for the file name, e.g. "harbour sunset".'),
  };
  // Only offered when there is a choice to make — and built from the config, which
  // is what lets a second model become selectable without touching this file.
  if (ids.length > 1) {
    schema.model = z.enum(ids).optional()
      .describe(st.presets.map((p) => `${p.id} — ${p.hint || p.label || ''}`).join('; '));
  }

  return createSdkMcpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    // Loaded up front for the reason memory.js measured: deferred, the model spends
    // a ToolSearch round trip before it can draw anything. The description is kept
    // short because it is re-sent on every turn of every account.
    alwaysLoad: true,
    tools: [
      tool('generate_image',
        'Generate a picture from a description, locally on this machine and at no cost. Use it whenever someone wants an image, illustration, cover or concept art. One picture per call, under a minute each.',
        schema,
        async (input) => {
          const preset = st.presets.find((p) => p.id === input.model) || st.presets[0];
          const shape = SHAPES.includes(input.shape) ? input.shape : 'square';
          const seed = Number.isInteger(input.seed) ? input.seed : crypto.randomInt(0, 2147483647);
          try {
            const r = await withGpu(async () => {
              return runOnce({
                st, preset, shape, seed, outDir,
                prompt: String(input.prompt).slice(0, 1500),
                negative: input.negative_prompt ? String(input.negative_prompt).slice(0, 400) : '',
                name: input.name,
              });
            });
            try { sweep(outDir); sweepScratch(st.scratch); } catch { /* housekeeping only */ }
            return text(handover(r.file, input.prompt, seed,
              `${preset.label || preset.id}, ${r.width}x${r.height}, ${r.secs}s`, input.name));
          } catch (err) {
            return text(explain(err), true);
          }
        }),
    ],
  });
}

// One plain sentence per failure. Never a stack trace and never the argv: the model
// reads this out to someone on a phone.
function explain(err) {
  const m = String(err?.message || err);
  if (m === 'busy') return 'This machine has one graphics card and it already has two pictures queued. Try again in a minute.';
  if (m === 'queue') return 'Another picture was still being generated after several minutes, so this one was not started. Try again shortly.';
  if (m === 'timeout') return 'The picture took too long and was stopped. A simpler prompt or a smaller shape usually works.';
  if (m.startsWith('vram:')) return `The graphics card only has ${m.slice(5)} MB free right now — something else is using it. Try again shortly.`;
  return `The picture could not be generated: ${m}`;
}

/* ------------------------------ jobs for the UI --------------------------- */

// The panel cannot hold a request open for twenty seconds on a phone whose screen
// may lock halfway through, so a picture is started, handed an id, and polled.
//
// The id is the only handle, and a job belongs to the account that started it: a
// stranger's id reads as "no such job", not as a refusal. That is the same rule the
// gallery folder follows and for the same reason — these handlers run in the server
// process, outside the sandbox, so they are the confinement rather than something
// the sandbox protects.
const jobs = new Map();
const JOB_KEEP_MS = 600000;

function pruneJobs() {
  const cutoff = Date.now() - JOB_KEEP_MS;
  for (const [id, j] of jobs) if (j.endedAt && j.endedAt < cutoff) jobs.delete(id);
}

// What a caller is allowed to see. Never the absolute path on its own: `src` is the
// one route that will serve it, and it is built here so no caller has to know how.
function publicJob(j) {
  return {
    id: j.id,
    state: j.state,
    error: j.error,
    prompt: j.prompt,
    seed: j.seed,
    shape: j.shape,
    model: j.model,
    label: j.label,
    steps: j.steps,
    queuePosition: j.queuePosition,
    elapsed: Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000),
    width: j.width,
    height: j.height,
    bytes: j.bytes,
    secs: j.secs,
    warm: j.warm,
    src: j.file ? `/api/thumb?path=${encodeURIComponent(j.file)}` : '',
    path: j.file,
  };
}

export function imagePresets() {
  const st = imagegenStatus();
  if (!st.ok) return { ok: false, reason: st.reason, models: [] };
  return {
    ok: true,
    reason: '',
    engine: engineState(),
    format: FORMAT,
    models: st.presets.map((p) => ({
      id: p.id,
      label: p.label || p.id,
      hint: p.hint || '',
      steps: p.steps || 8,
      cfgScale: p.cfgScale ?? 1,
      shapes: Object.keys(p.sizes || {}),
      sizes: p.sizes || {},
    })),
  };
}

export function startImageJob(user, input) {
  const st = imagegenStatus();
  if (!st.ok) throw new Error(st.reason);

  const prompt = String(input?.prompt || '').trim().slice(0, 1500);
  if (prompt.length < 3) throw new Error('Describe the picture you want in a few words.');

  const preset = st.presets.find((p) => p.id === input?.model) || st.presets[0];
  const shape = SHAPES.includes(input?.shape) && preset.sizes[input.shape] ? input.shape : 'square';
  const seed = Number.isInteger(input?.seed) && input.seed >= 0 && input.seed <= 2147483647
    ? input.seed
    : crypto.randomInt(0, 2147483647);
  const outDir = path.join(userHome(user || null), GALLERY);

  pruneJobs();
  const id = crypto.randomBytes(9).toString('hex');
  const job = {
    id,
    owner: (user && user.id) || '',
    state: 'queued',
    error: '',
    prompt,
    seed,
    shape,
    model: preset.id,
    label: preset.label || preset.id,
    steps: clamp(input?.steps, 1, 60, preset.steps || 8),
    queuePosition: null,
    startedAt: Date.now(),
    endedAt: 0,
    file: '', width: 0, height: 0, bytes: 0, secs: 0, warm: false,
  };
  jobs.set(id, job);

  // Deliberately not awaited: the caller gets the id straight back and polls.
  (async () => {
    try {
      const r = await withGpu(async () => {
        job.state = 'running';
        return runOnce({
          st, preset, shape, seed, outDir, prompt,
          negative: input?.negative_prompt ? String(input.negative_prompt).slice(0, 400) : '',
          name: input?.name,
          steps: job.steps,
          cfg: input?.cfg,
          format: input?.format,
          onProgress: (j) => { job.queuePosition = Number.isFinite(j?.queue_position) ? j.queue_position : null; },
        });
      });
      Object.assign(job, {
        state: 'done',
        file: r.file, width: r.width, height: r.height,
        bytes: r.bytes, secs: r.secs, warm: r.warm,
      });
      try { sweep(outDir); sweepScratch(st.scratch); } catch { /* housekeeping only */ }
    } catch (err) {
      job.state = 'failed';
      job.error = explain(err);
    } finally {
      job.endedAt = Date.now();
    }
  })();

  return publicJob(job);
}

export function readImageJob(user, id) {
  const j = jobs.get(String(id || ''));
  if (!j || j.owner !== ((user && user.id) || '')) return null;
  return publicJob(j);
}

// The account's own recent pictures, newest first. Reads the folder rather than a
// list kept in memory, so a restart does not lose the gallery and a file deleted in
// the file browser disappears from it.
export function imageGallery(user, limit = 24) {
  const dir = path.join(userHome(user || null), GALLERY);
  let rows;
  try {
    rows = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && PICTURE_RE.test(e.name))
      .map((e) => {
        const full = path.join(dir, e.name);
        try { const s = fs.statSync(full); return { full, name: e.name, at: s.mtimeMs, size: s.size }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.min(100, Math.max(1, limit)));
  } catch { return []; }
  return rows.map((r) => ({
    name: r.name,
    at: new Date(r.at).toISOString(),
    bytes: r.size,
    path: r.full,
    src: `/api/thumb?path=${encodeURIComponent(r.full)}`,
  }));
}

/* --------------------------------- per turn ------------------------------- */

// What runs.js hands to runPrompt, or null when this turn gets no image tool.
// Decided from the ACCOUNT, never from the request, because the account is what
// decides where the file is allowed to land. The Operations runner calls runPrompt
// directly and so never gets it — an autonomous run has no one to show a picture to.
export function turnImage(userId) {
  if (!imagegenStatus().ok) return null;
  const rec = userId ? findById(userId) : null;
  // No account at all is the Basic-auth lifeline with nobody registered; that turn
  // is the owner's, and userHome() resolves it to the workspaces root.
  const outDir = path.join(userHome(rec || null), GALLERY);
  const server = imageServer(outDir);
  return server ? { mcpServers: { [SERVER_NAME]: server } } : null;
}

export function imagegenToolName() { return `mcp__${SERVER_NAME}__generate_image`; }

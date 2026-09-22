// server/capabilities.js — what can this particular machine actually do?
//
// PlumiChat's optional surfaces (the terminal, document export, Web Push, Sites,
// Operations, engine updates, single sign-on) each depend on something that may
// simply not be installed. The old shape assumed one specific box and every one of
// them was hard-wired on, so on any other machine they failed at the moment of use
// — an export that 500s, a Sites panel that lists nothing, a member turn that dies
// inside the SDK.
//
// This module answers ONE question per feature, at boot and on demand: is it
// available, and if not, what exactly is missing? The UI reads it from
// GET /api/capabilities and can then hide or explain a surface instead of offering
// a button that cannot work.
//
// Two rules for anything added here:
//   1. PROBE, never infer from the platform. "macOS therefore no pandoc" is wrong.
//   2. A missing capability is a SENTENCE, not a boolean. `reason` is shown to a
//      human who has to go install something, so name the thing and the fix.

import fs from 'node:fs';
import path from 'node:path';
import {
  IS_WINDOWS, IS_WSL, IS_MAC, platformLabel, which, findTmux, findPandoc, findChrome,
  sandboxKind, listeningPortsCommand, powerCommand, hasGit, hasPm2, hasTailscale,
  findNvidiaSmi, wifiSource, procRoot,
} from './platform.js';
import { ssoConfigured } from './apps.js';
import { memoryConfigured, memoryBackend } from './memory.js';
import { imagegenStatus, imagegenStudio } from './imagegen.js';
import { cpuTempSource, cpuTempReason } from './machine.js';

const yes = (detail) => ({ available: true, reason: '', detail: detail || '' });
const no = (reason) => ({ available: false, reason, detail: '' });

// node-pty is an OPTIONAL dependency: it needs a native build, which is the most
// likely thing to fail on a fresh Windows install. Failing to load it must cost you
// the terminal panel and nothing else, so it is probed by attempting the import.
let ptyOk = null;
export async function probePty() {
  if (ptyOk !== null) return ptyOk;
  try { await import('node-pty'); ptyOk = true; } catch { ptyOk = false; }
  return ptyOk;
}

export async function capabilities() {
  const pandoc = findPandoc();
  const chrome = findChrome();
  const sandbox = sandboxKind();
  const tmux = findTmux();
  const pty = await probePty();
  const ports = listeningPortsCommand();
  const git = hasGit();
  const claudeCli = which('claude');
  const wifi = wifiSource();
  const tempSource = await cpuTempSource();
  const imageGen = imagegenStatus();
  const imageStudio = imagegenStudio();

  return {
    platform: { label: platformLabel(), wsl: IS_WSL, node: process.version },

    // --- core: if this is not available the app has no purpose ---------------
    chat: yes('Agent SDK (bundled)'),

    // --- the owner terminal --------------------------------------------------
    terminal: pty
      ? yes(tmux ? 'PTY + tmux' : 'PTY only')
      : no('node-pty failed to build or load. It is an optional dependency; reinstall with build tools available to get the terminal panel.'),
    terminalPersistence: tmux
      ? yes(tmux)
      : no(IS_WINDOWS
        ? 'tmux does not exist on Windows, so a terminal session ends when the server restarts.'
        : 'tmux is not installed, so a terminal session ends when the server restarts.'),

    // --- multi-user ----------------------------------------------------------
    // The single most important row here. No sandbox means no safe member account,
    // and the app must say so rather than degrade quietly.
    members: sandbox
      ? yes(sandbox)
      : no(`No OS sandbox on ${platformLabel()}, so member accounts cannot be confined. Run owner-only, or host on Linux (bubblewrap) or macOS (seatbelt).`),

    // --- document export -----------------------------------------------------
    exportXlsx: yes('built in'),
    exportDocx: pandoc ? yes(pandoc) : no('pandoc is not installed.'),
    exportPptx: pandoc ? yes(pandoc) : no('pandoc is not installed.'),
    exportPdf: pandoc && chrome
      ? yes(`${pandoc} + ${chrome}`)
      : no(!pandoc ? 'pandoc is not installed.' : 'No Chrome/Chromium found. Install one, or set CHROME_BIN.'),

    // --- notifications -------------------------------------------------------
    push: (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
      ? yes('VAPID configured')
      : no('No VAPID keypair yet. It is generated and written to .env the first time push is enabled.'),

    // --- optional owner surfaces, all off until configured -------------------
    sites: ports
      ? yes(`${ports.cmd} + ${[hasPm2() && 'pm2', hasTailscale() && 'tailscale'].filter(Boolean).join(' + ') || 'no labellers'}`)
      : no(`No way to list listening sockets on ${platformLabel()} (needs ss, lsof or netstat).`),
    operations: git
      ? yes('git worktrees')
      : no('git is not installed; Operations runs each task in a throwaway worktree.'),
    operationsNative: claudeCli
      ? yes(claudeCli)
      : no('The native `claude` CLI is not on PATH. The default in-process runner does not need it.'),
    engineUpdates: git && which('npm')
      ? yes('staged canary')
      : no('Needs git and npm on PATH.'),
    deploy: deployCapability(git),
    sso: ssoConfigured()
      ? yes('apps.config.json')
      : no('No sister apps configured. Copy apps.config.example.json to enable single sign-on.'),
    // Configured, not probed: whether the server answers right now is a live
    // question, asked by GET /api/memory each time Settings opens.
    memory: memoryConfigured()
      ? yes(`Supermemory on ${memoryBackend()}`)
      : no('No memory server configured. Set PLUMI_MEMORY_URL (and PLUMI_MEMORY_KEY) to a Supermemory server to remember across conversations — see docs/INSTALL.md.'),
    // Making pictures locally (server/imagegen.js): a stable-diffusion.cpp binary
    // and at least one model whose files are all present. Opt-in, so OFF on every
    // box that has not set PLUMI_IMAGE_DIR — several gigabytes of weights is not
    // something to assume.
    imageGen: imageGen.ok ? yes(imageGen.detail) : no(imageGen.reason),
    // The generator's own web page, proxied at /sdui behind requireOwner. Needs the
    // resident binary specifically, so it can be unavailable on an install whose
    // pictures work perfectly well.
    imageStudio: imageStudio.ok ? yes(imageStudio.detail) : no(imageStudio.reason),

    // --- the machine card (top of the side menu) ------------------------------
    // The card itself needs nothing: CPU, RAM and disks read everywhere. These are
    // the parts of it that can be missing, and the card leaves each one out.
    machineGpu: findNvidiaSmi()
      ? yes('nvidia-smi')
      : no('No nvidia-smi on this machine, so the card shows no GPU. It reads NVIDIA cards, through the tool their driver installs.'),
    machineCpuTemp: tempSource
      ? yes(tempSource)
      : no('No CPU temperature. ' + cpuTempReason() + (IS_WSL || IS_WINDOWS ? ' See docs/INSTALL.md.' : '')),
    machineWifi: wifi
      ? yes(wifi.kind === 'netsh' ? 'netsh wlan' : 'kernel wireless stats')
      : no(IS_MAC
        ? 'macOS only shows Wi-Fi signal to privileged tools, so the link grade leaves the Wi-Fi part out.'
        : `No way to read Wi-Fi signal on ${platformLabel()}, so the link grade leaves the Wi-Fi part out.`),
    machineNetSpeed: procRoot()
      ? yes('kernel counters')
      : no(`Network speed comes from the kernel counters in /proc, which ${platformLabel()} does not have.`),

    // --- machine controls ----------------------------------------------------
    powerControls: powerCommand('shutdown')
      ? yes(IS_WSL ? 'Windows host via shutdown.exe' : 'OS shutdown')
      : no(`No supported shutdown command on ${platformLabel()}.`),
    processRestart: hasPm2() && process.env.PM2_APP_NAME
      ? yes(`pm2 restart ${process.env.PM2_APP_NAME}`)
      : no('Needs pm2 and PM2_APP_NAME. Without it, restart the server yourself.'),
  };
}

// The two-copy deploy: a working tree plus a separately-served clone. Entirely
// opt-in — most installs are one copy and this stays off.
function deployCapability(git) {
  const live = process.env.PLUMI_LIVE_CLONE;
  if (!live) return no('Single-copy install. Set PLUMI_LIVE_CLONE only if you serve a separate clone from the one you edit.');
  if (!git) return no('git is not installed.');
  if (!fs.existsSync(path.join(live, '.git'))) return no(`PLUMI_LIVE_CLONE is set to ${live}, which is not a git checkout.`);
  return yes(live);
}

// One-line-per-feature summary for the boot banner. Only the OFF ones are worth
// printing: a list of everything that works is noise, a list of what does not is
// the thing an operator needs.
export async function unavailableSummary() {
  const caps = await capabilities();
  const out = [];
  for (const [name, v] of Object.entries(caps)) {
    if (name === 'platform' || !v || typeof v !== 'object' || v.available !== false) continue;
    out.push({ name, reason: v.reason });
  }
  return out;
}

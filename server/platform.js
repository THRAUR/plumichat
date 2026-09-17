// server/platform.js — the one module that knows which operating system this is.
//
// Everything else asks THIS file instead of testing process.platform inline. That
// is the whole point: the OS-specific knowledge is ~200 lines in one place, so
// porting is a diff you can read, and a feature that cannot work somewhere reports
// itself unavailable instead of throwing ENOENT halfway through a request.
//
// The rule for anything added here: NEVER guess a capability from the platform
// alone. Probe for the actual binary. A Mac without pandoc and a Linux box without
// pandoc are the same situation, and both must degrade the same way.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

// WSL is Linux that can reach a Windows host, and the difference matters exactly
// once: powering the machine off means powering off WINDOWS, not the distro.
export const IS_WSL = IS_LINUX && (() => {
  if (process.env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; }
})();

export const HOME = os.homedir();

export function platformLabel() {
  if (IS_WSL) return 'WSL (' + (process.env.WSL_DISTRO_NAME || 'linux') + ')';
  if (IS_WINDOWS) return 'Windows';
  if (IS_MAC) return 'macOS';
  return 'Linux';
}

/* ------------------------------- finding tools ---------------------------- */

const isExec = (p) => { try { fs.accessSync(p, IS_WINDOWS ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

// A PATH scan rather than shelling out to which/where: no subprocess, no shell, and
// it behaves the same on all three platforms. On Windows a bare name has no
// extension, so every PATHEXT suffix is tried — `pandoc` must find `pandoc.exe`.
export function which(bin) {
  if (!bin) return null;
  if (bin.includes('/') || bin.includes('\\')) return isExec(bin) ? bin : null;
  const exts = IS_WINDOWS
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const cand = path.join(dir, bin + ext);
      if (isExec(cand)) return cand;
    }
  }
  return null;
}

// Try an explicit list of absolute paths first (packages install to known places),
// then fall back to PATH. Returns the first that exists, or null.
function firstOf(candidates, fallbackName) {
  for (const c of candidates) { if (c && isExec(c)) return c; }
  return fallbackName ? which(fallbackName) : null;
}

/* ---------------------------------- shell --------------------------------- */

// The interactive shell the terminal panel spawns.
//
// `-l` (login shell) is deliberate on Unix: it sources the user's profile, which is
// what puts nvm/pyenv/homebrew on PATH. It is NOT a Windows concept, and passing it
// to PowerShell makes it try to open a file called `-l`.
export function defaultShell() {
  if (IS_WINDOWS) {
    const pwsh = which('pwsh') || which('powershell');
    if (pwsh) return { bin: pwsh, args: ['-NoLogo'], login: false };
    return { bin: process.env.COMSPEC || 'cmd.exe', args: [], login: false };
  }
  const bin = process.env.SHELL || (IS_MAC ? '/bin/zsh' : '/bin/bash');
  return { bin, args: ['-l'], login: true };
}

// tmux gives the terminal its restart-survival. Absent (always, on Windows) the
// terminal still works — it just becomes an ordinary PTY that dies with the process.
export function findTmux() {
  if (IS_WINDOWS) return null;
  return firstOf([
    '/usr/bin/tmux', '/usr/local/bin/tmux', '/opt/homebrew/bin/tmux',
    path.join(HOME, '.local', 'bin', 'tmux'),
  ], 'tmux');
}

// `env -u VAR` is how the terminal scrubs inherited markers from a tmux session.
// No Windows equivalent, and none is needed: tmux is absent there anyway.
export function findEnvBin() {
  if (IS_WINDOWS) return null;
  return firstOf(['/usr/bin/env', '/bin/env'], 'env');
}

/* ------------------------------ document export --------------------------- */

export function findPandoc() {
  return firstOf([
    process.env.PANDOC_BIN,
    '/usr/bin/pandoc', '/usr/local/bin/pandoc', '/opt/homebrew/bin/pandoc',
    IS_WINDOWS ? 'C:\\Program Files\\Pandoc\\pandoc.exe' : null,
  ].filter(Boolean), 'pandoc');
}

// Chromium is not a dependency, so find whatever this machine already has. Checked
// in rough order of "most likely to be a real, current install".
export function findChrome() {
  const fixed = [process.env.CHROME_BIN];
  if (IS_WINDOWS) {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    fixed.push(
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    );
  } else if (IS_MAC) {
    fixed.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/opt/homebrew/bin/chromium',
    );
  } else {
    fixed.push(
      '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/snap/bin/chromium',
    );
  }
  const hit = firstOf(fixed.filter(Boolean), IS_WINDOWS ? 'chrome' : 'chromium');
  if (hit) return hit;

  // Playwright keeps versioned copies; take the newest so an update does not pin us
  // to a stale one. The per-platform subdirectory name is Playwright's, not ours.
  const root = path.join(HOME, IS_MAC ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  const leaf = IS_WINDOWS ? ['chrome-win', 'chrome.exe']
    : IS_MAC ? ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']
      : ['chrome-linux64', 'chrome'];
  let best = -1, found = null;
  try {
    for (const dir of fs.readdirSync(root)) {
      const m = /^chromium(?:_headless_shell)?-(\d+)$/.exec(dir);
      if (!m || Number(m[1]) <= best) continue;
      const cand = path.join(root, dir, ...leaf);
      if (isExec(cand)) { best = Number(m[1]); found = cand; }
    }
  } catch { /* no playwright cache */ }
  return found;
}

/* --------------------------------- sandbox -------------------------------- */

// Which OS sandbox the agent SDK can confine a member's Bash inside. This is the
// mechanism member confinement RESTS on, so "null" is not a cosmetic downgrade:
// callers must refuse to run a member turn rather than run one unconfined.
export function sandboxKind() {
  if (IS_LINUX) return which('bwrap') ? 'bubblewrap' : null;
  if (IS_MAC) return isExec('/usr/bin/sandbox-exec') ? 'seatbelt' : null;
  return null; // Windows: no supported sandbox
}

/* ----------------------------- listening sockets -------------------------- */

// Ground truth for "what is this machine serving?", used by the Sites panel.
// Returns argv (never a shell string) plus which parser the output needs.
export function listeningPortsCommand() {
  if (IS_LINUX) {
    if (which('ss')) return { cmd: 'ss', args: ['-ltnpH'], format: 'ss' };
    if (which('netstat')) return { cmd: 'netstat', args: ['-ltnp'], format: 'netstat-linux' };
    return null;
  }
  if (IS_MAC) {
    if (which('lsof')) return { cmd: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN'], format: 'lsof' };
    return null;
  }
  if (IS_WINDOWS) {
    const netstat = which('netstat');
    if (netstat) return { cmd: netstat, args: ['-ano', '-p', 'TCP'], format: 'netstat-win' };
    return null;
  }
  return null;
}

/* -------------------------------- power ----------------------------------- */

// Shutting the machine down needs privileges everywhere, so this returns the argv
// to TRY and callers surface the failure. Null means "no supported way here".
//
// WSL is the interesting case: the Linux distro is not the machine. Powering off
// means reaching the Windows host through its own shutdown.exe.
export function powerCommand(action, delaySecs = 6) {
  const winShutdown = IS_WSL
    ? '/mnt/c/Windows/System32/shutdown.exe'
    : 'shutdown.exe';
  if (IS_WSL || IS_WINDOWS) {
    const bin = IS_WSL ? (isExec(winShutdown) ? winShutdown : null) : which('shutdown');
    if (!bin) return null;
    if (action === 'shutdown') return { cmd: bin, args: ['/s', '/t', String(delaySecs)] };
    if (action === 'reboot') return { cmd: bin, args: ['/r', '/t', String(delaySecs)] };
    if (action === 'cancel') return { cmd: bin, args: ['/a'] };
    return null;
  }
  if (IS_MAC) {
    const bin = which('shutdown');
    if (!bin) return null;
    // macOS `shutdown` takes minutes (+N) or `now`; a 6s delay is not expressible,
    // so the nearest honest thing is +1 minute.
    if (action === 'shutdown') return { cmd: bin, args: ['-h', '+1'] };
    if (action === 'reboot') return { cmd: bin, args: ['-r', '+1'] };
    if (action === 'cancel') return { cmd: bin, args: ['-c'] };
    return null;
  }
  // Linux: systemd first (works without a password under a polkit rule), then the
  // classic shutdown binary.
  const sysctl = which('systemctl');
  if (sysctl) {
    if (action === 'shutdown') return { cmd: sysctl, args: ['poweroff'] };
    if (action === 'reboot') return { cmd: sysctl, args: ['reboot'] };
    if (action === 'cancel') return { cmd: sysctl, args: ['cancel-shutdown'] };
  }
  const bin = which('shutdown');
  if (!bin) return null;
  if (action === 'shutdown') return { cmd: bin, args: ['-h', '+1'] };
  if (action === 'reboot') return { cmd: bin, args: ['-r', '+1'] };
  if (action === 'cancel') return { cmd: bin, args: ['-c'] };
  return null;
}

/* --------------------------- hardware readings ---------------------------- */

// Where the machine card (server/machine.js) gets each figure without a privileged
// helper. These answer "where to look", never "is it working right now": every
// reading is best-effort, and one that fails hides its figure rather than erroring.

// nvidia-smi ships with the NVIDIA driver, but not always on PATH: WSL mounts the
// Windows driver's copy under /usr/lib/wsl/lib, and older Windows drivers put it in
// an NVSMI folder of their own.
export function findNvidiaSmi() {
  return firstOf([
    IS_WSL && '/usr/lib/wsl/lib/nvidia-smi',
    IS_WINDOWS && 'C:\\Windows\\System32\\nvidia-smi.exe',
    IS_WINDOWS && 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
  ], 'nvidia-smi');
}

// Where the Wi-Fi signal comes from. On WSL the Wi-Fi belongs to Windows (the VM
// only sees a mirrored adapter), so it is Windows' `netsh wlan`, started from C:\
// because a Windows program handed a \\wsl.localhost working folder may refuse it.
// Linux drivers publish /proc/net/wireless. macOS keeps the signal for privileged
// tools, so it has no source.
export function wifiSource() {
  if (IS_WSL) {
    const netsh = '/mnt/c/Windows/System32/netsh.exe';
    return isExec(netsh) ? { kind: 'netsh', cmd: netsh, cwd: '/mnt/c' } : null;
  }
  if (IS_WINDOWS) {
    const netsh = which('netsh');
    return netsh ? { kind: 'netsh', cmd: netsh } : null;
  }
  if (IS_LINUX && fs.existsSync('/proc/net/wireless')) return { kind: 'proc', file: '/proc/net/wireless' };
  return null;
}

// A CPU temperature the kernel shows without privileges: a hwmon driver that IS the
// CPU package, else a CPU thermal zone. There is none on WSL (Hyper-V hides the
// sensor from the VM), and macOS and Windows only show it to privileged tools.
export function cpuSensorFile() {
  if (!IS_LINUX) return null;
  const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
  const hw = '/sys/class/hwmon';
  for (const h of list(hw)) {
    const dir = path.join(hw, h);
    if (!/^(coretemp|k10temp|zenpower|cpu_thermal|soc_thermal)$/.test(read(path.join(dir, 'name')))) continue;
    const inputs = list(dir).filter((f) => /^temp\d+_input$/.test(f))
      .sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10));
    if (!inputs.length) continue;
    const pkg = inputs.find((f) => /package|tctl|tdie/i.test(read(path.join(dir, f.replace('_input', '_label')))));
    return path.join(dir, pkg || inputs[0]);
  }
  const tz = '/sys/class/thermal';
  for (const z of list(tz).filter((d) => d.startsWith('thermal_zone'))) {
    if (/^(x86_pkg_temp|cpu[-_]thermal|soc[-_]thermal)$/.test(read(path.join(tz, z, 'type')))) return path.join(tz, z, 'temp');
  }
  return null;
}

// Where Windows' CPU temperature can be asked for without admin rights: from
// LibreHardwareMonitor, which runs elevated and serves its readings locally. WSL
// reaches Windows' localhost only with mirrored networking; a NAT-mode install sets
// PLUMI_SENSORS_URL to the host's address instead.
export function sensorsUrlDefault() {
  return IS_WINDOWS || IS_WSL ? 'http://127.0.0.1:8085/data.json' : '';
}

// The kernel counters behind swap, the default route and network speed. Linux only.
export function procRoot() {
  return IS_LINUX && fs.existsSync('/proc/net/dev') ? '/proc' : null;
}

// macOS counts only never-touched pages as free, so os.freemem() reads a healthy Mac
// as nearly full. vm_stat has the page counts that make "used" honest.
export function memoryStatsCommand() {
  return IS_MAC && isExec('/usr/bin/vm_stat') ? { cmd: '/usr/bin/vm_stat', args: [] } : null;
}

// Windows has no load average: os.loadavg() answers [0, 0, 0] there.
export function hasLoadAverage() { return !IS_WINDOWS; }

/* ------------------------------ misc helpers ------------------------------ */

// The server can inherit a TMPDIR from whatever launched it — a parent Claude Code
// session leaves one pointing at its own scratch dir, which disappears when that
// session ends. os.tmpdir() honours it, so check it is really writable first.
export function tmpRoot() {
  const dir = os.tmpdir();
  try { fs.accessSync(dir, fs.constants.W_OK); return dir; } catch { return IS_WINDOWS ? 'C:\\Windows\\Temp' : '/tmp'; }
}

// Point an environment at a REAL temp directory, using the variable the platform
// actually reads. Call this AFTER scrubbing an inherited TMPDIR/TMP/TEMP: os.tmpdir()
// consults those same variables, so once they are gone it returns the OS default
// rather than the dead /tmp/claude-<uid> a parent session left behind.
//
// The Windows branch is not cosmetic. TMP and TEMP *are* Windows' temp variables,
// so a scrub that deletes them and then sets only TMPDIR leaves every child process
// with no usable temp configuration at all.
export function resetTempEnv(env) {
  const dir = tmpRoot();
  if (IS_WINDOWS) { env.TMP = dir; env.TEMP = dir; }
  else env.TMPDIR = dir;
  return env;
}

export function hasPm2() { return !!which('pm2'); }
export function hasGit() { return !!which('git'); }
export function hasTailscale() { return !!which('tailscale'); }

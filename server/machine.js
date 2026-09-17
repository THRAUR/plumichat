// server/machine.js — how the box this server runs on is doing, for the owner's
// side menu: CPU / GPU / RAM load and temperatures, network speed, free disk, and a
// grade for the box's OWN internet link. (Not the phone's link to the box: that one
// is felt on the phone already, and a server on another continent would read "slow"
// on the best day there is.)
//
// Three cadences, because the figures cost very different amounts:
//   - every 3 s, always on once someone has asked: CPU, RAM, swap and the network
//     counters. In-process reads of the kernel's own counters, no child process
//     (vm_stat on macOS is the one exception) — and keeping them running is what
//     lets the card open on two minutes of graph instead of an empty one.
//   - only while the card is on someone's screen (a request in the last 30 s): the
//     GPU (spawns nvidia-smi, ~60 ms), the CPU temperature (a localhost HTTP call on
//     a Windows host) and the Wi-Fi reading (spawns netsh, ~0.5 s under WSL).
//   - the internet probe: every 10 s while watched, every 30 s otherwise, so the
//     grade already has loss figures behind it the moment the card opens. It is two
//     TCP handshakes per target and nothing else — no payload.
// Nothing starts until the first GET /api/machine, and everything stops after an
// hour nobody has looked, so a server whose owner never opens the card samples
// nothing at all.
//
// Where each figure comes from is server/platform.js's business; what can be
// missing, and why, is in server/capabilities.js (the machine* rows).
import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA_DIR } from './store.js';
import { WORKSPACES_ROOT } from './sandbox.js';
import {
  IS_WINDOWS, IS_MAC, IS_WSL, findNvidiaSmi, wifiSource, cpuSensorFile,
  sensorsUrlDefault, procRoot, memoryStatsCommand, hasLoadAverage,
} from './platform.js';

const FAST_MS = 3000;
const SLOW_MS = 6000;
const LINK_WATCHED_MS = 10000;
const LINK_IDLE_MS = 30000;
const DISK_MS = 60000;
const WATCH_MS = 30000;
const STOP_AFTER_MS = 60 * 60 * 1000;
const SENSORS_RETRY_MS = 60000;
const HISTORY = 40;            // two minutes at FAST_MS
const LINK_KEEP = 30;          // results kept per target: 60 across the two defaults
const LINK_JUDGE_LOSS = 10;    // below this many results, one lost handshake is noise
// …and below this many answers, one slow handshake is. The very first round runs
// while nvidia-smi and netsh are starting too, and read as 8 ms of "jitter" on a
// line that measures 1-4 ms.
const LINK_JUDGE_JITTER = 4;
const PROBE_MS = 2000;
const CHILD_MS = 2500;
const GPU_FAILS_TO_HIDE = 3;   // one slow nvidia-smi must not make the GPU tile blink

/* --------------------------------- sources -------------------------------- */

const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

const NVIDIA_SMI = findNvidiaSmi();
const WIFI = wifiSource();
const PROC = procRoot();
const VM_STAT = memoryStatsCommand();
// Looked up once: sensor drivers do not come and go under a running server.
const SENSOR_FILE = cpuSensorFile();

export const SENSORS_URL = (() => {
  const v = String(process.env.PLUMI_SENSORS_URL || '').trim();
  if (v.toLowerCase() === 'off') return '';
  return v || sensorsUrlDefault();
})();

// host:port pairs, IPs so no DNS lookup is timed. "off" turns the probe off.
const TARGETS = (() => {
  const raw = String(process.env.PLUMI_NET_TARGETS || '1.1.1.1:443,8.8.8.8:443').trim();
  if (raw.toLowerCase() === 'off') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(s);
    return m ? { host: m[1], port: Number(m[2] || 443), key: s } : null;
  }).filter(Boolean);
})();

/* ------------------------------ fixed facts ------------------------------- */

// "Intel(R) Core(TM) i5-9600KF CPU @ 3.70GHz" -> "Intel Core i5-9600KF".
export function tidyModel(s) {
  return String(s || '')
    .replace(/\((R|TM)\)/gi, '')
    .replace(/\s+CPU\s+@.*$/i, '')
    .replace(/\s+@\s.*$/, '')
    .replace(/\s+\d+-Core Processor$/i, '')
    .replace(/\s+Processor$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
const MODEL = tidyModel((os.cpus()[0] || {}).model);

// Where the box is, from its own clock: "Europe/Paris" -> "Paris, France". The
// country comes from the tz database's zone table where the OS ships one; without
// it the city alone is still a useful answer.
const PLACE = (() => {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* no Intl zone data */ }
  const custom = String(process.env.PLUMI_MACHINE_NAME || '').trim();
  if (custom) return { label: custom, tz };
  if (!tz.includes('/') || tz.startsWith('Etc/')) return { label: '', tz };
  const city = tz.slice(tz.lastIndexOf('/') + 1).replace(/_/g, ' ');
  let country = '';
  const code = zoneCountry(tz);
  if (code) { try { country = new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || ''; } catch { /* old ICU */ } }
  return { label: country ? `${city}, ${country}` : city, tz };
})();
function zoneCountry(tz) {
  for (const f of ['/usr/share/zoneinfo/zone.tab', '/usr/share/zoneinfo/zone1970.tab']) {
    for (const line of readText(f).split('\n')) {
      const cols = line.split('\t');
      if (cols[2] === tz) return cols[0].split(',')[0];
    }
  }
  return '';
}

/* --------------------------------- state ---------------------------------- */

let timer = null;
let lastAsk = 0;

let cpuPrev = null, cpu = null, mem = null;
let macUsed = null, macAt = 0, macBusy = false;
let netIface = null, netPrev = null, netRate = null;
let gpus = [], gpuAt = 0, gpuBusy = false, gpuFails = 0;
let temp = null, watts = null, tempAt = 0, tempBusy = false, sensorsNextTry = 0, sensorsSeenAt = 0;
let wifi, wifiAt = 0, wifiBusy = false;          // undefined = not known (yet)
const linkResults = new Map();                   // target key -> [ms | null]
let lastRound = [], linkAt = 0, linkBusy = false;
let disks = [], diskAt = 0, diskBusy = false;
const hist = { t: [], cpu: [], ram: [], gpu: [], rx: [], tx: [], ms: [] };

/* ------------------------------ fast readings ----------------------------- */

const pct = (x) => Math.max(0, Math.min(100, Math.round(x * 100)));

function sampleCpu() {
  const now = os.cpus().map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
  if (cpuPrev && cpuPrev.length === now.length) {
    let idle = 0, total = 0;
    const cores = now.map((c, i) => {
      const di = c.idle - cpuPrev[i].idle, dt = c.total - cpuPrev[i].total;
      idle += di; total += dt;
      return dt > 0 ? pct(1 - di / dt) : 0;
    });
    cpu = { pct: total > 0 ? pct(1 - idle / total) : 0, cores };
  }
  cpuPrev = now;
}

// vm_stat, as Activity Monitor counts "Memory Used": app memory (anonymous pages
// that are not purgeable), wired, and what the compressor occupies. Older macOS
// has no anonymous-page line; free + inactive + speculative is the fallback.
export function parseVmStat(out) {
  const text = String(out || '');
  const page = Number((/page size of (\d+) bytes/.exec(text) || [])[1]) || 4096;
  const pages = (label) => {
    const m = new RegExp('^' + label + ':\\s+(\\d+)', 'mi').exec(text);
    return m ? Number(m[1]) : null;
  };
  const anon = pages('Anonymous pages'), purgeable = pages('Pages purgeable');
  const wired = pages('Pages wired down'), compressor = pages('Pages occupied by compressor');
  if (anon != null && wired != null) {
    return { used: (anon - (purgeable || 0) + wired + (compressor || 0)) * page };
  }
  const free = pages('Pages free'), inactive = pages('Pages inactive'), spec = pages('Pages speculative');
  if (free == null) return null;
  return { available: (free + (inactive || 0) + (spec || 0)) * page };
}

function readVmStat() {
  if (!VM_STAT || macBusy) return;
  macBusy = true;
  execFile(VM_STAT.cmd, VM_STAT.args, { timeout: CHILD_MS, maxBuffer: 64 * 1024 }, (err, out) => {
    macBusy = false;
    const r = err ? null : parseVmStat(out);
    const total = os.totalmem();
    macUsed = r ? Math.max(0, Math.min(total, r.used != null ? r.used : total - r.available)) : null;
    macAt = Date.now();
  });
}

function sampleMem() {
  // os.freemem() is MemAvailable on Linux and the available physical memory on
  // Windows — what can still be handed out. macOS is the odd one out (see above).
  const total = os.totalmem();
  const used = macUsed != null && Date.now() - macAt < FAST_MS * 3 ? macUsed : total - os.freemem();
  mem = { used, total, swapUsed: null, swapTotal: null };
  if (VM_STAT) readVmStat();
  if (!PROC) return;
  const info = readText(PROC + '/meminfo');
  const kb = (k) => { const m = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(info); return m ? Number(m[1]) * 1024 : null; };
  const st = kb('SwapTotal'), sf = kb('SwapFree');
  if (st != null && sf != null) { mem.swapTotal = st; mem.swapUsed = st - sf; }
}

// The interface the default route leaves by — the one carrying internet traffic.
function defaultIface() {
  if (!PROC) return null;
  let best = null;
  for (const line of readText(PROC + '/net/route').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || f[1] !== '00000000' || f[7] !== '00000000') continue;
    const metric = Number(f[6]) || 0;
    if (!best || metric < best.metric) best = { iface: f[0], metric };
  }
  return best ? best.iface : null;
}

function sampleNet(now) {
  const iface = defaultIface();
  if (iface !== netIface) { netIface = iface; netPrev = null; netRate = null; }
  if (!iface) return;
  let cur = null;
  for (const line of readText(PROC + '/net/dev').split('\n').slice(2)) {
    const i = line.indexOf(':');
    if (i < 0 || line.slice(0, i).trim() !== iface) continue;
    const f = line.slice(i + 1).trim().split(/\s+/).map(Number);
    cur = { rx: f[0], tx: f[8], at: now };
  }
  if (!cur) return;
  if (netPrev) {
    const dt = (cur.at - netPrev.at) / 1000;
    const rx = cur.rx - netPrev.rx, tx = cur.tx - netPrev.tx;
    // A counter that went backwards was reset (interface bounced) — skip one beat.
    netRate = dt > 0 && rx >= 0 && tx >= 0 ? { rx: Math.round(rx / dt), tx: Math.round(tx / dt) } : null;
  }
  netPrev = cur;
}

/* ------------------------------ slow readings ----------------------------- */

const GPU_FIELDS = 'name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed';
const num = (s) => { const n = parseFloat(String(s == null ? '' : s).replace(',', '.')); return Number.isFinite(n) ? n : null; };

// One CSV line per GPU. Unsupported fields read "[N/A]" / "[Not Supported]" -> null.
// Parsed from the right, so a comma inside a card's name cannot shift the numbers.
export function parseNvidiaSmi(out) {
  const MIB = 1024 * 1024;
  return String(out || '').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const f = line.split(',');
    if (f.length < 8) return null;
    const v = f.slice(-7).map(num);
    return {
      name: f.slice(0, -7).join(',').trim(),
      pct: v[0],
      memUsed: v[1] == null ? null : v[1] * MIB,
      memTotal: v[2] == null ? null : v[2] * MIB,
      temp: v[3],
      watts: v[4],
      wattsMax: v[5],
      fan: v[6],
    };
  }).filter(Boolean);
}

function readGpu() {
  if (!NVIDIA_SMI || gpuBusy) return;
  gpuBusy = true;
  execFile(NVIDIA_SMI, ['--query-gpu=' + GPU_FIELDS, '--format=csv,noheader,nounits'],
    { timeout: CHILD_MS, maxBuffer: 64 * 1024, windowsHide: true },
    (err, out) => {
      gpuBusy = false;
      gpuAt = Date.now();
      const list = err ? [] : parseNvidiaSmi(out);
      if (list.length) { gpus = list; gpuFails = 0; }
      else if (++gpuFails >= GPU_FAILS_TO_HIDE) gpus = [];
    });
}

// LibreHardwareMonitor's /data.json: a tree of {Text, Value, Children}. Newer builds
// tag sensors with SensorId ("/intelcpu/0/temperature/0") and Type; older ones only
// say where they sit (a CPU node with a cpu.png icon, a "Temperatures" group).
// Values are display strings in the PC's own locale: "52.0 °C", "52,0 °C", "35.2 W".
export function parseLhm(root) {
  const temps = [], powers = [];
  (function walk(node, inCpu, group) {
    if (!node || typeof node !== 'object') return;
    const text = String(node.Text || '');
    const sid = String(node.SensorId || '');
    const cpuHere = inCpu
      || /^\/(intelcpu|amdcpu)\//i.test(String(node.HardwareId || ''))
      || /(^|\/)cpu\.png$/i.test(String(node.ImageURL || ''));
    const kids = Array.isArray(node.Children) ? node.Children : [];
    if (kids.length) { for (const k of kids) walk(k, cpuHere, text); return; }
    if (!cpuHere && !/^\/(intelcpu|amdcpu)\//i.test(sid)) return;
    const shown = String(node.Value || '');
    const value = num(shown);
    if (value == null) return;
    const type = String(node.Type || '')
      || (/\/temperature\//i.test(sid) || /^temperatures$/i.test(group) || /°C\s*$/.test(shown) ? 'Temperature'
        : /\/power\//i.test(sid) || /^powers$/i.test(group) || /\sW\s*$/.test(shown) ? 'Power' : '');
    // "Distance to TjMax" is a temperature-typed sensor that is not a temperature.
    if (type === 'Temperature' && !/distance/i.test(text) && value > 0 && value < 150) temps.push({ text, value });
    else if (type === 'Power' && value >= 0) powers.push({ text, value });
  })(root, false, '');

  const pick = (list, prefer) => {
    for (const re of prefer) { const hit = list.find((s) => re.test(s.text)); if (hit) return hit.value; }
    return null;
  };
  let t = pick(temps, [/^(cpu )?package$/i, /tctl\/tdie/i, /^tdie$/i, /^tctl$/i, /^core max$/i, /^core average$/i]);
  if (t == null && temps.length) t = Math.max(...temps.map((s) => s.value));
  let w = pick(powers, [/^(cpu )?package$/i, /^package power$/i]);
  if (w == null && powers.length) w = powers[0].value;
  return {
    temp: t == null ? null : Math.round(t * 10) / 10,
    watts: w == null ? null : Math.round(w * 10) / 10,
  };
}

// Whether the last question got an answer at all, with or without a CPU reading.
// Set only once a question settles, so the reason does not flicker while one is
// out.
let sensorsHeard = false;
async function askSensors() {
  try {
    const r = await fetch(SENSORS_URL, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const got = parseLhm(await r.json());
    sensorsHeard = true;
    return got;
  } catch (e) {
    sensorsHeard = false;
    throw e;
  }
}

async function readTemp() {
  if (tempBusy) return;
  tempBusy = true;
  try {
    if (SENSOR_FILE) {
      const v = Number(readText(SENSOR_FILE)) / 1000;
      temp = Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : null;
      watts = null;
      return;
    }
    if (!SENSORS_URL || Date.now() < sensorsNextTry) { temp = null; watts = null; return; }
    const got = await askSensors();
    temp = got.temp; watts = got.watts;
    // It answered but shows no CPU (a different app on the port, or a build that
    // lost its driver) — ask again later rather than every six seconds.
    if (temp == null) sensorsNextTry = Date.now() + SENSORS_RETRY_MS;
    else sensorsSeenAt = Date.now();
  } catch {
    temp = null; watts = null;
    sensorsNextTry = Date.now() + SENSORS_RETRY_MS;
  } finally {
    tempBusy = false;
    tempAt = Date.now();
  }
}

// For the capability row: is a CPU temperature source really there? Asked once a
// minute at most; a reading the card took recently already answers it.
let sensorsProbe = { at: 0, ok: false };
export async function cpuTempSource() {
  if (SENSOR_FILE) return 'kernel sensor';
  if (!SENSORS_URL) return '';
  if (Date.now() - sensorsSeenAt < SENSORS_RETRY_MS) return 'LibreHardwareMonitor';
  if (Date.now() - sensorsProbe.at > SENSORS_RETRY_MS) {
    let ok = false;
    try { ok = (await askSensors()).temp != null; } catch { ok = false; }
    sensorsProbe = { at: Date.now(), ok };
  }
  return sensorsProbe.ok ? 'LibreHardwareMonitor' : '';
}

// Why there is no CPU temperature, in words the owner can act on. Shared by the
// card and the capability row.
export function cpuTempReason() {
  if (SENSOR_FILE) return 'The CPU sensor gave no reading.';
  if (/^off$/i.test(String(process.env.PLUMI_SENSORS_URL || '').trim())) return 'Turned off with PLUMI_SENSORS_URL=off.';
  // It answers, so it runs and its web server is on: what is missing is the driver
  // behind the CPU readings. Current builds read them through PawnIO and offer to
  // install it when they start, a prompt that is easy to cancel.
  if (SENSORS_URL && sensorsHeard) {
    return 'LibreHardwareMonitor answers but lists no CPU temperature, which usually means its PawnIO driver is missing. Restart it and click OK when it offers to install PawnIO.';
  }
  if (SENSORS_URL && process.env.PLUMI_SENSORS_URL) {
    return 'No answer from LibreHardwareMonitor at PLUMI_SENSORS_URL. Is it running, with Options → Remote Web Server on?';
  }
  if (IS_WSL || IS_WINDOWS) {
    return 'Windows only shows it to administrators. Run LibreHardwareMonitor on the PC (it asks for admin rights), let it install PawnIO, and turn on Options → Remote Web Server → Run.';
  }
  if (IS_MAC) return 'macOS only shows it to privileged tools.';
  return 'No CPU sensor in /sys/class/hwmon. Installing lm-sensors and loading the coretemp (Intel) or k10temp (AMD) module usually adds one.';
}

// `netsh wlan show interfaces`: one block per adapter, "    Label : value" lines.
// The labels are in Windows' display language, so what is read language-blind is
// the shape of the values: an adapter is a block holding a MAC address, and a
// CONNECTED one is the block holding a "NN%" value — the signal. The rest is read
// from the English labels when they are there.
// Returns the connected adapter, or null when no Wi-Fi connection is up.
export function parseNetsh(out) {
  const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
  for (const block of String(out || '').replace(/\r/g, '').split(/\n[ \t]*\n/)) {
    const fields = [];
    for (const line of block.split('\n')) {
      const m = /^\s+([^:]+?)\s+:\s?(.*)$/.exec(line);
      if (m) fields.push([m[1].trim(), m[2].trim()]);
    }
    const macs = fields.filter(([, v]) => MAC.test(v));
    const sig = fields.find(([, v]) => /^\d{1,3}\s?%$/.test(v));
    if (!macs.length || !sig) continue;
    const get = (re) => { const f = fields.find(([k]) => re.test(k)); return f ? f[1] : ''; };
    return {
      signal: Math.min(100, parseInt(sig[1], 10)),
      ssid: get(/^SSID$/i) || null,
      band: get(/^Band$/i) || null,
      radio: get(/^Radio type$/i) || null,
      channel: num(get(/Channel$/i)),
      rxMbps: num(get(/^Receive rate/i)),
      txMbps: num(get(/^Transmit rate/i)),
      mac: (get(/^Physical address$/i) || macs[0][1]).toLowerCase().replace(/-/g, ':'),
    };
  }
  return null;
}

// /proc/net/wireless, for a Wi-Fi card Linux drives itself:
//   wlan0: 0000   54.  -56.  -256   0 0 0 0 0   0
// The level is dBm on every modern driver; -50 dBm and better is full signal.
export function parseProcWireless(text, iface) {
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i < 0 || line.slice(0, i).trim() !== iface) continue;
    const f = line.slice(i + 1).trim().split(/\s+/).map((s) => parseFloat(s));
    const quality = f[1], level = f[2];
    if (Number.isFinite(level) && level < 0) return { signal: Math.max(0, Math.min(100, Math.round(2 * (level + 100)))) };
    if (Number.isFinite(quality)) return { signal: Math.max(0, Math.min(100, Math.round((quality / 70) * 100))) };
  }
  return null;
}

function readWifi() {
  if (wifiBusy || !WIFI) return;
  if (WIFI.kind === 'proc') {
    // Only a card the default route actually uses; a spare adapter is not the link.
    const iface = netIface;
    const w = iface && fs.existsSync(`/sys/class/net/${iface}/wireless`) ? parseProcWireless(readText(WIFI.file), iface) : null;
    wifi = w ? { ...w, ssid: null, band: null, radio: null, channel: null, rxMbps: null, txMbps: null, mac: null } : null;
    wifiAt = Date.now();
    return;
  }
  wifiBusy = true;
  // latin1: the console code page is not UTF-8, and only ASCII is relied on here.
  execFile(WIFI.cmd, ['wlan', 'show', 'interfaces'],
    { timeout: CHILD_MS, maxBuffer: 256 * 1024, encoding: 'latin1', windowsHide: true, cwd: WIFI.cwd },
    (err, out) => {
      wifiBusy = false;
      wifiAt = Date.now();
      // A refusal (Windows 11 can demand location permission for Wi-Fi details) is
      // "don't know", not "no Wi-Fi" — it must not turn into a confident "Ethernet".
      wifi = err ? undefined : parseNetsh(out);
    });
}

// Ethernet or Wi-Fi, for the interface the internet traffic actually takes.
function linkKind() {
  const iface = netIface;
  if (!WIFI) return null;
  if (WIFI.kind === 'proc') {
    if (!iface) return null;
    return fs.existsSync(`/sys/class/net/${iface}/wireless`) ? 'wifi'
      : fs.existsSync(`/sys/class/net/${iface}/device`) ? 'wired' : null;
  }
  if (wifi === undefined) return null;
  if (!wifi) return 'wired';
  // WSL's mirrored networking gives the Linux interface the Windows adapter's own
  // MAC, so the route can be matched to the adapter. NAT mode shows a Hyper-V MAC
  // (00:15:5d…) instead — and native Windows shows no route here at all — and then
  // an up Wi-Fi connection is the best guess there is.
  const mac = iface ? readText(`/sys/class/net/${iface}/address`).trim().toLowerCase() : '';
  if (mac && !mac.startsWith('00:15:5d') && wifi.mac) return mac === wifi.mac ? 'wifi' : 'wired';
  return 'wifi';
}

/* ------------------------------ internet probe ---------------------------- */

// Time a TCP handshake. A refusal still proves the path works, so it counts as a
// reply; a timeout or an unreachable network is a loss.
function handshake(host, port) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const elapsed = () => Number(process.hrtime.bigint() - t0) / 1e6;
    let settled = false;
    const sock = net.connect({ host, port });
    const finish = (ms) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ms == null ? null : Math.round(ms * 10) / 10);
    };
    sock.setTimeout(PROBE_MS, () => finish(null));
    sock.on('connect', () => finish(elapsed()));
    sock.on('error', (e) => finish(e && e.code === 'ECONNREFUSED' ? elapsed() : null));
  });
}

async function probeLink() {
  if (linkBusy || !TARGETS.length) return;
  linkBusy = true;
  try {
    const round = await Promise.all(TARGETS.map(async (t) => {
      const got = [];
      // Two in a row, not in parallel: parallel handshakes would share the same
      // moment of congestion and hide the jitter this is here to measure.
      for (let i = 0; i < 2; i++) got.push(await handshake(t.host, t.port));
      const list = linkResults.get(t.key) || [];
      list.push(...got);
      if (list.length > LINK_KEEP) list.splice(0, list.length - LINK_KEEP);
      linkResults.set(t.key, list);
      return got;
    }));
    lastRound = round.flat();
  } finally {
    linkBusy = false;
    linkAt = Date.now();
  }
}

function median(list) {
  const s = [...list].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Each target judged on its own — mixing them would read the gap between two
// providers as jitter — and the internet is as good as its best-answering target:
// one provider being blocked or far away is not the connection being bad.
function linkFigures() {
  let best = null;
  for (const list of linkResults.values()) {
    const ok = list.filter((v) => v != null);
    if (!ok.length) continue;
    const recent = ok.slice(-10);
    let jitter = 0;
    for (let i = 1; i < recent.length; i++) jitter += Math.abs(recent[i] - recent[i - 1]);
    const fig = {
      ms: median(recent),
      jitter: recent.length >= LINK_JUDGE_JITTER ? jitter / (recent.length - 1) : null,
      loss: list.length >= LINK_JUDGE_LOSS ? ((list.length - ok.length) / list.length) * 100 : null,
    };
    if (!best || fig.ms < best.ms) best = fig;
  }
  return best;
}

// Fixed limits, and the worst part decides: a perfect ping over a failing Wi-Fi
// signal is not an excellent connection.
export const GRADES = ['excellent', 'good', 'average', 'mediocre', 'bad'];
const LIMITS = {
  ms: [20, 50, 100, 200],        // below
  jitter: [5, 15, 30, 60],       // below
  loss: [0, 2, 5, 15],           // at most, percent
  signal: [80, 65, 50, 35],      // at least, percent
};
function step(v, lims, fits) {
  if (v == null) return 0;
  for (let i = 0; i < lims.length; i++) if (fits(v, lims[i])) return i;
  return lims.length;
}
export function gradeLink({ offline, ms, jitter, loss, signal } = {}) {
  if (offline) return 'offline';
  if (ms == null) return null;
  return GRADES[Math.max(
    step(ms, LIMITS.ms, (v, l) => v < l),
    step(jitter, LIMITS.jitter, (v, l) => v < l),
    step(loss, LIMITS.loss, (v, l) => v <= l),
    step(signal, LIMITS.signal, (v, l) => v >= l),
  )];
}

function linkView() {
  const fig = linkFigures();
  const offline = lastRound.length > 0 && lastRound.every((v) => v == null);
  const kind = linkKind();
  const w = kind === 'wifi' && wifi ? wifi : null;
  const round = (v) => (v == null ? null : v < 10 ? Math.round(v * 10) / 10 : Math.round(v));
  return {
    grade: TARGETS.length ? gradeLink({ offline, ms: fig && fig.ms, jitter: fig && fig.jitter, loss: fig && fig.loss, signal: w && w.signal }) : null,
    kind,
    ms: fig ? round(fig.ms) : null,
    jitter: fig ? round(fig.jitter) : null,
    loss: fig && fig.loss != null ? Math.round(fig.loss * 10) / 10 : null,
    wifi: w ? { signal: w.signal, ssid: w.ssid, band: w.band, radio: w.radio, rxMbps: w.rxMbps, txMbps: w.txMbps } : null,
  };
}

/* ---------------------------------- disks --------------------------------- */

async function diskLabel(dir, dev) {
  const m = /^\/mnt\/([a-z])(?:\/|$)/i.exec(dir) || /^([a-z]):[\\/]/i.exec(dir);
  if (m) return m[1].toUpperCase() + ': drive';
  // Climb to the mount point: the last ancestor still on the same device.
  let cur = path.resolve(dir);
  while (cur !== path.dirname(cur)) {
    try { if ((await fs.promises.stat(path.dirname(cur))).dev !== dev) break; } catch { break; }
    cur = path.dirname(cur);
  }
  return cur === path.parse(cur).root ? (IS_WSL ? 'Linux disk' : 'System disk') : cur;
}

// The disks that matter to this server: where its data lives, where the projects
// live, and under WSL the C: drive — the Linux disk is an image file on the Windows
// side, so C:'s free space is the real ceiling however roomy the Linux disk says it
// is (that image normally lives on C:).
async function readDisks() {
  if (diskBusy) return;
  diskBusy = true;
  try {
    const dirs = [DATA_DIR, WORKSPACES_ROOT];
    if (IS_WSL) dirs.push('/mnt/c');
    const seen = new Set();
    const out = [];
    for (const dir of dirs) {
      try {
        const st = await fs.promises.stat(dir);
        if (seen.has(st.dev)) continue;
        seen.add(st.dev);
        const s = await fs.promises.statfs(dir);
        out.push({ label: await diskLabel(dir, st.dev), free: s.bavail * s.bsize, total: s.blocks * s.bsize });
      } catch { /* a folder that is not there is not a disk to show */ }
    }
    disks = out;
  } finally {
    diskBusy = false;
    diskAt = Date.now();
  }
}

/* --------------------------------- runner --------------------------------- */

function push(key, v) {
  const a = hist[key];
  a.push(v);
  if (a.length > HISTORY) a.splice(0, a.length - HISTORY);
}

function record(now) {
  const link = linkFigures();
  push('t', now);
  push('cpu', cpu ? cpu.pct : null);
  push('ram', mem && mem.total ? pct(mem.used / mem.total) : null);
  // Only while the GPU is actually being read: a gap says "not measured", where a
  // repeated old value would claim the card sat still.
  push('gpu', gpus.length && now - gpuAt < SLOW_MS * 2 ? gpus[0].pct : null);
  push('rx', netRate ? netRate.rx : null);
  push('tx', netRate ? netRate.tx : null);
  push('ms', link && now - linkAt < LINK_IDLE_MS + FAST_MS * 2 ? Math.round(link.ms * 10) / 10 : null);
}

function kickWatched() {
  readGpu();
  readTemp();
  readWifi();
}

function tick() {
  const now = Date.now();
  if (now - lastAsk > STOP_AFTER_MS) return stop();
  sampleCpu();
  sampleMem();
  sampleNet(now);
  const watched = now - lastAsk < WATCH_MS;
  if (watched) {
    if (now - gpuAt >= SLOW_MS) readGpu();
    if (now - tempAt >= SLOW_MS) readTemp();
    if (now - wifiAt >= LINK_WATCHED_MS) readWifi();
  }
  if (now - linkAt >= (watched ? LINK_WATCHED_MS : LINK_IDLE_MS)) probeLink();
  if (now - diskAt >= DISK_MS) readDisks();
  record(now);
}

function start() {
  // CPU and network are differences between two readings: take the first now.
  const now = Date.now();
  sampleCpu();
  sampleMem();
  sampleNet(now);
  timer = setInterval(tick, FAST_MS);
  timer.unref?.();
  // One early beat, so the card's second look (a second after its first) already
  // has a CPU figure instead of a dash.
  setTimeout(() => { if (timer) tick(); }, 900).unref?.();
  kickWatched();
  probeLink();
  readDisks();
}

function stop() {
  clearInterval(timer);
  timer = null;
  cpuPrev = null; cpu = null;
  netPrev = null; netRate = null;
  for (const k of Object.keys(hist)) hist[k].length = 0;
  linkResults.clear();
  lastRound = [];
}

// What GET /api/machine answers. Always immediate: it reports what the sampler
// holds, and asking is what keeps the costlier probes running.
export function machineSnapshot() {
  const now = Date.now();
  const wasWatched = now - lastAsk < WATCH_MS;
  lastAsk = now;
  if (!timer) start();
  else if (!wasWatched) kickWatched();

  const off = {};
  if (temp == null) off.cpuTemp = cpuTempReason();
  if (!NVIDIA_SMI) off.gpu = 'No nvidia-smi on this machine.';
  else if (!gpus.length && gpuFails >= GPU_FAILS_TO_HIDE) off.gpu = 'nvidia-smi is not answering.';

  return {
    at: now,
    place: PLACE,
    cpu: {
      pct: cpu ? cpu.pct : null,
      cores: cpu ? cpu.cores : [],
      model: MODEL,
      threads: os.cpus().length,
      load: hasLoadAverage() ? os.loadavg().map((v) => Math.round(v * 100) / 100) : null,
      temp,
      watts,
    },
    gpus,
    mem,
    disks,
    net: netRate,
    link: linkView(),
    history: hist,
    off,
  };
}

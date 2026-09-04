// Sites — every website this box is hosting right now, discovered live so the list
// maintains itself: start a new project on a new port and it simply appears.
//
// Three sources, joined on the LOCAL port:
//   1. `ss -ltnp`               — what is actually listening (ground truth) + owning pids
//   2. `pm2 jlist`              — pid -> friendly app name (and its project folder)
//   3. `tailscale serve --json` — local port -> the public https URL a phone can
//      actually reach. This matters: raw 100.x.y.z:PORT is firewalled on this box,
//      only tailscale-served ports get through (see the always-on sites notes).
//
// Each candidate is then probed over plain HTTP on 127.0.0.1. The probe doubles as
// the filter — proxies, ssh and databases never answer with HTML — and lifts the
// page's <title> and favicon so each row reads like a bookmark, not a port number.
// Owner-only by construction: the route in index.js gates it, and nothing here is
// ever exposed to members.
//
// Rows are then grouped by what the site IS rather than by port number, inferred
// from how it was started (see classify) so the grouping maintains itself too.
import { exec, execFile } from 'node:child_process';
import { listeningPortsCommand } from './platform.js';
import { readFile } from 'node:fs/promises';

const TTL_MS = 30 * 1000;          // re-scan at most twice a minute; ?refresh=1 forces
// Generous, because a cold Next.js page served off a slow disk needs
// seconds on its first render — at 2.5s those sites silently vanished from the list.
// Probes run in parallel, so this is the worst case for the whole scan, not per site.
const PROBE_MS = 6000;
const ICON_MS = 3000;              // the page already answered; its icon should be quick
const ICON_MAX = 96 * 1024;        // favicons are tiny; anything bigger isn't one
const SKIP_PORTS = new Set([22, 53]); // sshd / resolved — listening, never websites
// Tried in order when the page gives no <link rel="icon"> — or gives no page at all
// because it wants a login first. All three are conventional, not app-specific.
const ICON_FALLBACKS = ['/favicon.ico', '/favicon.png', '/apple-touch-icon.png'];

let cache = { at: 0, sites: [] };

/* ------------------------------- discovery -------------------------------- */

// Run a shell command and resolve its stdout, or '' if the tool is missing/fails.
// Every source here is best-effort: losing pm2 or tailscale degrades the labels,
// it must never break the list.
function sh(cmd, timeout = 4000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '')));
  });
}

// Same contract, but argv instead of a shell string — used for the port scan, whose
// command and arguments come from platform.js and differ per OS.
function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '')));
  });
}

// Can this platform enumerate listening sockets at all? Surfaced by the capability
// probe so the UI can explain the gap instead of showing an empty panel.
export function sitesSupported() { return !!listeningPortsCommand(); }

// Local ports with something listening on a wildcard/loopback address, plus the
// pids holding them. Interface-bound listeners (the tailnet IP, the WSL gateway)
// are skipped on purpose — those are tailscaled's own front doors, which we learn
// about properly from the serve map below.
// Address filter shared by every parser: only wildcard/loopback listeners count.
// Interface-bound listeners (a tailnet IP, the WSL gateway) are skipped on purpose
// — those are a tunnel's own front doors, which the serve map below describes
// properly.
const LOCAL_ADDRS = new Set(['0.0.0.0', '127.0.0.1', '::', '[::]', '::1', '[::1]', '*']);

function addPort(byPort, port, pids) {
  if (!port || SKIP_PORTS.has(port)) return;
  const prev = byPort.get(port) || { port, pids: [] };
  byPort.set(port, { port, pids: [...new Set([...prev.pids, ...pids.filter(Boolean)])] });
}

// Four parsers because there is no portable way to ask "what is listening?".
// platform.js picks the tool; each branch below only has to read that tool's shape.
const PORT_PARSERS = {
  // ss -ltnpH:  LISTEN 0 511 127.0.0.1:3002 0.0.0.0:* users:(("node",pid=123,fd=21))
  ss(out, byPort) {
    for (const line of out.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 5 || f[0] !== 'LISTEN') continue;
      const local = f[3];
      const cut = local.lastIndexOf(':');
      if (cut < 0) continue;
      if (!LOCAL_ADDRS.has(local.slice(0, cut).replace(/%\w+$/, ''))) continue;
      addPort(byPort, Number(local.slice(cut + 1)), [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])));
    }
  },
  // netstat -ltnp (Linux):  tcp 0 0 127.0.0.1:3002 0.0.0.0:* LISTEN 123/node
  'netstat-linux'(out, byPort) {
    for (const line of out.split('\n')) {
      if (!/\bLISTEN\b/.test(line)) continue;
      const f = line.trim().split(/\s+/);
      const local = f[3] || '';
      const cut = local.lastIndexOf(':');
      if (cut < 0) continue;
      if (!LOCAL_ADDRS.has(local.slice(0, cut))) continue;
      const pid = /(\d+)\//.exec(f[6] || '');
      addPort(byPort, Number(local.slice(cut + 1)), [pid ? Number(pid[1]) : 0]);
    }
  },
  // lsof -nP -iTCP -sTCP:LISTEN (macOS):  node 123 me 21u IPv4 ... TCP 127.0.0.1:3002 (LISTEN)
  lsof(out, byPort) {
    for (const line of out.split('\n')) {
      if (!/\(LISTEN\)/.test(line)) continue;
      const f = line.trim().split(/\s+/);
      const addr = f[8] || '';
      const cut = addr.lastIndexOf(':');
      if (cut < 0) continue;
      const host = addr.slice(0, cut);
      if (!LOCAL_ADDRS.has(host) && host !== '*') continue;
      addPort(byPort, Number(addr.slice(cut + 1)), [Number(f[1])]);
    }
  },
  // netstat -ano -p TCP (Windows):  TCP  127.0.0.1:3002  0.0.0.0:0  LISTENING  123
  'netstat-win'(out, byPort) {
    for (const line of out.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 5 || !/^LISTENING$/i.test(f[3])) continue;
      const local = f[1] || '';
      const cut = local.lastIndexOf(':');
      if (cut < 0) continue;
      if (!LOCAL_ADDRS.has(local.slice(0, cut))) continue;
      addPort(byPort, Number(local.slice(cut + 1)), [Number(f[4])]);
    }
  },
};

// Local ports with something listening, plus the pids holding them. Returns an
// empty map when the platform has no usable tool — the Sites panel then reports
// itself unavailable rather than showing an empty list that looks like "nothing
// is running here".
async function listeningPorts() {
  const spec = listeningPortsCommand();
  const byPort = new Map();
  if (!spec) return byPort;
  const out = await run(spec.cmd, spec.args);
  (PORT_PARSERS[spec.format] || PORT_PARSERS.ss)(out, byPort);
  return byPort;
}

// pid -> { app, cwd, cmd } for everything PM2 supervises, so a discovered port can be
// labelled with the name you know it by even before we have a page title.
async function pm2ByPid() {
  const out = await sh('pm2 jlist');
  const map = new Map();
  try {
    for (const p of JSON.parse(out.slice(out.indexOf('[')))) {
      const pid = Number(p && p.pid);
      const env = p.pm2_env || {};
      if (pid) map.set(pid, { app: p.name, cwd: env.pm_cwd || '', cmd: [env.pm_exec_path, env.args].filter(Boolean).join(' ') });
    }
  } catch { /* pm2 absent or mid-restart — labels just fall back to the page title */ }
  return map;
}

// How a process was launched, walking one step up the tree: a dev server usually
// hides behind a wrapper (`npm run dev` -> vite), and Next.js goes further by
// rewriting its own process title to "next-server", erasing the dev/start flag
// that tells the two apart. The parent still carries it.
async function cmdline(pid) {
  const read = async (p) => {
    try { return (await readFile('/proc/' + p + '/cmdline', 'utf8')).replace(/\0/g, ' ').trim(); }
    catch { return ''; }
  };
  let ppid = 0;
  try {
    const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
    ppid = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1]) || 0;
  } catch { /* process already gone — its own cmdline is all we get */ }
  const [self, parent] = await Promise.all([read(pid), ppid > 1 ? read(ppid) : '']);
  return self + ' ' + parent;
}

// local port -> the public https URL tailscale publishes it at (443 stays bare).
async function servedPorts() {
  const out = await sh('tailscale serve status --json');
  const map = new Map();
  try {
    const web = (JSON.parse(out.slice(out.indexOf('{'))) || {}).Web || {};
    for (const [hostPort, cfg] of Object.entries(web)) {
      const cut = hostPort.lastIndexOf(':');
      const host = hostPort.slice(0, cut);
      const port = hostPort.slice(cut + 1);
      const origin = 'https://' + host + (port === '443' ? '' : ':' + port);
      for (const [mount, handler] of Object.entries((cfg && cfg.Handlers) || {})) {
        const target = handler && handler.Proxy;
        if (!target) continue;
        const local = Number(new URL(target).port);
        if (local) map.set(local, origin + (mount === '/' ? '' : mount));
      }
    }
  } catch { /* tailscale down or not serving — sites still list on their local URL */ }
  return map;
}

/* --------------------------------- probe ---------------------------------- */

// Ask a local port whether it's a website, and if so what it calls itself. Anything
// that isn't HTML (proxy handshakes, JSON APIs, a bare socket) drops out here.
// A protected site answering 401/403 still counts — it's a site, it just wants a login.
async function probe(port) {
  const base = 'http://127.0.0.1:' + port + '/';
  let res;
  try {
    res = await fetch(base, { redirect: 'follow', signal: AbortSignal.timeout(PROBE_MS), headers: { 'user-agent': 'PlumiChat-sites' } });
  } catch { return null; }
  const type = res.headers.get('content-type') || '';
  const html = /text\/html/i.test(type);
  if (!html && !(res.status === 401 || res.status === 403)) return null;
  let title = '', iconHref = '';
  if (html) {
    const body = await readCapped(res, 256 * 1024);
    title = pickTitle(body);
    iconHref = pickIcon(body);
  }
  return { title, icon: await fetchIcon(res.url || base, iconHref) };
}

// Read at most `max` bytes of a response — a streaming endpoint must not be able to
// feed us forever just because it happens to be text/html.
async function readCapped(res, max) {
  if (!res.body) return '';
  const dec = new TextDecoder();
  let text = '';
  for await (const chunk of res.body) {
    text += dec.decode(chunk, { stream: true });
    if (text.length >= max) break;
  }
  return text;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

function pickTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return '';
  const full = m[1]
    .replace(/&(#\d+|\w+);/g, (all, e) => (ENTITIES[e] || (e[0] === '#' ? String.fromCharCode(+e.slice(1)) : all)))
    .replace(/\s+/g, ' ')
    .trim();
  // Titles carry taglines ("Jaws Co., Ltd. — Precision Interconnect · Since 1975");
  // a sidebar row wants just the site's name, so keep the part before the first
  // separator the way a browser bookmark would.
  const head = full.split(/\s+[|·–—]\s+|\s+-\s+/)[0].trim();
  return (head.length >= 3 ? head : full).slice(0, 40);
}

// The best <link rel="…icon"> in the head, preferring a plain icon over the big
// apple-touch one. Returns the raw href; resolution happens against the final URL.
function pickIcon(html) {
  const head = html.slice(0, 64 * 1024);
  let best = '', bestRank = 99;
  for (const tag of head.match(/<link\b[^>]*>/gi) || []) {
    const rel = (/\brel\s*=\s*["']?([^"'>]+)/i.exec(tag) || [])[1] || '';
    if (!/\bicon\b/i.test(rel)) continue;
    const href = (/\bhref\s*=\s*["']([^"']+)/i.exec(tag) || [])[1];
    if (!href) continue;
    const rank = /apple-touch/i.test(rel) ? 2 : /shortcut/i.test(rel) ? 1 : 0;
    if (rank < bestRank) { best = href; bestRank = rank; }
  }
  return best;
}

// Fetch the favicon over the same local origin and inline it as a data URL, so the
// browser never has to reach the site itself to draw the row (a site can be up but
// unreachable from the phone, and the list should still look right).
async function fetchIcon(baseUrl, href) {
  for (const candidate of [href, ...ICON_FALLBACKS].filter(Boolean)) {
    let url;
    try { url = new URL(candidate, baseUrl); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(ICON_MS) });
      if (!r.ok) continue;
      const type = (r.headers.get('content-type') || '').split(';')[0].trim();
      if (type && !/^image\//i.test(type)) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > ICON_MAX) continue;
      return 'data:' + (type || 'image/x-icon') + ';base64,' + buf.toString('base64');
    } catch { /* try the next candidate */ }
  }
  return null;
}

/* -------------------------------- grouping --------------------------------- */

// The order rows appear in the sidebar. `site` first because a finished project is
// what you actually want to open; PlumiChat's own row is informative but you're already
// looking at it, and unsupervised scratch servers belong at the bottom.
export const SITE_GROUPS = [
  { id: 'site', label: 'Project sites' },
  { id: 'dev', label: 'In development' },
  { id: 'box', label: 'This box' },
  { id: 'other', label: 'Also running' },
];
const GROUP_ORDER = new Map(SITE_GROUPS.map((g, i) => [g.id, i]));

// A dev server rebuilds on every keystroke and dies with the shell that started it.
// Worth calling out separately: those rows are the ones that go dark on a reboot.
const DEV_CMD = /\b(vite|nodemon|webpack-dev-server|rsbuild|turbo)\b|\b(next|nuxt|astro|remix|ng|rspack|expo|vinxi)\s+(dev|serve|start:dev)\b|\brun\s+dev\b|--watch\b/i;
// Checked before DEV_CMD, because the same binary serves a finished build under a
// different subcommand: `vite preview` is production, bare `vite` is the dev server.
const PROD_CMD = /\b(vite|next|nuxt|astro|vinxi|serve)\s+(preview|start)\b/i;
// Ad-hoc file servers — a one-liner in a temp folder, not a project.
const SCRATCH_CMD = /\bhttp\.server\b|\bhttp-server\b|\bSimpleHTTPServer\b/i;

// What kind of thing is listening here? Everything below is read off how the process
// was actually launched, so a new project sorts itself the day it starts.
function classify({ port, cmd, owner, ownPort, ownDir }) {
  if (port === ownPort) return 'box';
  if (ownDir && owner && owner.cwd && owner.cwd.startsWith(ownDir)) return 'box';
  if (SCRATCH_CMD.test(cmd)) return 'other';
  if (!PROD_CMD.test(cmd) && DEV_CMD.test(cmd)) return 'dev';
  // Supervised by PM2 means someone meant it to stay up — that's a project site,
  // not a process that happens to be running.
  if (owner) return 'site';
  return 'other';
}

/* --------------------------------- assemble -------------------------------- */

export async function listSites({ refresh = false } = {}) {
  if (!refresh && cache.at && Date.now() - cache.at < TTL_MS) return cache.sites;

  const [listening, pm2, served] = await Promise.all([listeningPorts(), pm2ByPid(), servedPorts()]);
  const ports = new Set([...listening.keys(), ...served.keys()]);
  const ownPort = Number(process.env.PORT) || 3002;
  const ownDir = process.cwd();

  const found = await Promise.all([...ports].map(async (port) => {
    const page = await probe(port);
    if (!page) return null;
    const pids = (listening.get(port) || { pids: [] }).pids;
    const owner = pids.map((pid) => pm2.get(pid)).find(Boolean);
    const url = served.get(port) || null;
    // Answering with HTML isn't quite enough to be a website worth listing: local
    // tooling opens throwaway HTTP ports too. A real site is published, supervised,
    // or at minimum names itself with a title or a favicon.
    if (!url && !owner && !page.title && !page.icon) return null;
    const cmd = (owner && owner.cmd ? owner.cmd + ' ' : '') + (pids.length ? await cmdline(pids[0]) : '');
    return {
      port,
      name: page.title || (owner && owner.app) || 'localhost:' + port,
      app: (owner && owner.app) || null,
      url: url || 'http://localhost:' + port,
      // Published through tailscale = reachable from the phone; otherwise the row is
      // honest that it only opens from a browser on the box itself.
      published: !!url,
      // Supervised by PM2 = it comes back by itself after a reboot or a crash.
      managed: !!owner,
      group: classify({ port, cmd, owner, ownPort, ownDir }),
      icon: page.icon,
    };
  }));

  const sites = found.filter(Boolean).sort((a, b) =>
    (GROUP_ORDER.get(a.group) - GROUP_ORDER.get(b.group)) ||
    (Number(b.published) - Number(a.published)) ||
    a.name.localeCompare(b.name));
  cache = { at: Date.now(), sites };
  return sites;
}

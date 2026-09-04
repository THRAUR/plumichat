// What extends the engine: MCP servers and Claude Code plugins (audit F6).
// Owner-only, because installing a plugin runs third-party code on this box.
//
// Two different sources, deliberately:
//   - MCP status comes from the SDK, through the same control-only query the
//     context ring uses (server/context.js). No prompt is ever sent and — verified
//     — no session file is written, so asking never leaves a stray conversation.
//   - The plugin catalogue and every mutation come from the native `claude plugin`
//     CLI, which is the only thing that can reach a marketplace. The SDK can list
//     what is loaded; it cannot install.
import { withSessionControl } from './context.js';
import { claudeBin, run } from './engine.js';
import { resolveInRoot } from './sandbox.js';
import { scrubbedEnv } from './claude.js';

// MCP servers connect in the background after the CLI boots: at +1.2s the list is
// still empty, at +2.6s some are 'pending', by +5.6s they have settled (measured
// against the five claude.ai connectors on this box). Polling until nothing is
// pending is the difference between a page that says "no servers" and one that is
// true — but it is bounded, because a genuinely stuck server would poll forever.
const MCP_SETTLE_MS = 9000;
const MCP_POLL_MS = 900;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function mcpStatus(projectName) {
  const cwd = resolveInRoot(projectName);
  const servers = await withSessionControl(cwd, null, async (q) => {
    const deadline = Date.now() + MCP_SETTLE_MS;
    let last = [];
    for (;;) {
      last = (await q.mcpServerStatus()) || [];
      const settling = last.length === 0 || last.some((s) => s && s.status === 'pending');
      if (!settling || Date.now() >= deadline) return last;
      await wait(MCP_POLL_MS);
    }
  });
  return {
    servers: servers.map((s) => ({
      name: String(s.name || ''),
      status: String(s.status || 'pending'),
      scope: s.scope ? String(s.scope) : null,
      transport: (s.config && s.config.type) ? String(s.config.type) : null,
      // The URL matters for an HTTP/SSE server — it is the one field that says
      // where your tool calls are actually going.
      url: (s.config && (s.config.url || s.config.command)) ? String(s.config.url || s.config.command) : null,
      version: (s.serverInfo && s.serverInfo.version) ? String(s.serverInfo.version) : null,
      error: s.error ? String(s.error).slice(0, 400) : null,
      tools: (s.tools || []).map((t) => String(t.name || '')).filter(Boolean),
    })),
    at: Date.now(),
  };
}

// A newly authorised or reconfigured server, plus the counts the engine now sees.
// reloadPlugins() is the SDK's own "pick up what changed on disk" control, and it
// reports plugins, agents, commands and MCP servers in one answer.
export async function reloadEngineParts(projectName) {
  const cwd = resolveInRoot(projectName);
  const r = await withSessionControl(cwd, null, (q) => q.reloadPlugins());
  return {
    commands: (r.commands || []).length,
    agents: (r.agents || []).length,
    plugins: (r.plugins || []).map((p) => ({
      name: String(p.name || ''),
      version: p.version ? String(p.version) : null,
      source: p.source ? String(p.source) : null,
    })),
    mcpServers: (r.mcpServers || []).length,
    errors: Number(r.error_count) || 0,
  };
}

// --- The catalogue ----------------------------------------------------------

// `claude plugin list --available --json` fetches from every configured
// marketplace, so it is a network call measured in seconds. Cache it: the
// catalogue changes on the order of days, and a phone opening the sheet should
// not wait for GitHub every time.
const CATALOGUE_TTL_MS = 30 * 60 * 1000;
let catalogue = null;

const CLI_TIMEOUT_MS = 120 * 1000;
function cli(args, timeout = CLI_TIMEOUT_MS) {
  // scrubbedEnv, not process.env: the CLI must not inherit PlumiChat's own secrets,
  // and PM2's captured CLAUDE_CODE_* leak is exactly what broke member turns once.
  return run(claudeBin(), ['plugin', ...args], { timeout, env: scrubbedEnv() });
}

function parseJSON(text) {
  // The CLI prints a plain sentence when there is nothing to report ("No plugins
  // installed…"), so a parse failure is a legitimate empty answer, not a crash.
  try { return JSON.parse(text); } catch { return null; }
}

export async function pluginCatalogue({ refresh = false } = {}) {
  if (!refresh && catalogue && Date.now() - catalogue.at < CATALOGUE_TTL_MS) return catalogue;
  const r = await cli(['list', '--available', '--json']);
  if (!r.ok && !r.stdout.trim()) {
    throw new Error(r.errno === 'ENOENT'
      ? 'The Claude CLI is not installed on this box.'
      : (r.stderr.trim().split('\n')[0] || 'Could not read the plugin catalogue'));
  }
  const d = parseJSON(r.stdout) || {};
  const installed = (Array.isArray(d.installed) ? d.installed : []).map(shapePlugin);
  const have = new Set(installed.map((p) => p.id || p.name));
  const available = (Array.isArray(d.available) ? d.available : [])
    .map(shapePlugin)
    .filter((p) => !have.has(p.id) && !have.has(p.name))
    // Most-installed first: on a phone, the top of a 40-entry list is the list.
    .sort((a, b) => (b.installs || 0) - (a.installs || 0));
  catalogue = { installed, available, at: Date.now() };
  return catalogue;
}

function shapePlugin(p) {
  const src = p && p.source;
  return {
    id: String((p && (p.pluginId || p.id)) || ''),
    name: String((p && p.name) || ''),
    description: String((p && p.description) || '').slice(0, 600),
    marketplace: String((p && p.marketplaceName) || ''),
    version: (p && p.version) ? String(p.version) : null,
    enabled: p && typeof p.enabled === 'boolean' ? p.enabled : null,
    installs: Number(p && p.installCount) || 0,
    // Where the code comes from. Shown before an install is confirmed, because
    // `--yes` accepts a marketplace-declared install command — third-party code
    // running on this box under the owner's account.
    //
    // `source` is either a STRING path inside the marketplace repo
    // ("./plugins/frontend-design") or an object carrying an external git/http
    // url. Only the second is worth naming: for the first, the marketplace IS the
    // origin and `marketplace` above already says so.
    origin: (src && typeof src === 'object' && (src.url || src.repo)) ? String(src.url || src.repo) : '',
  };
}

// A plugin id is `name@marketplace`; a bare name is also valid. Anything else is
// refused rather than handed to a subprocess — even though execFile takes an argv
// array and never a shell, an id is user input reaching a command line.
const SAFE_ID = /^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/;
function checkId(id) {
  const v = String(id || '').trim();
  if (!SAFE_ID.test(v)) throw new Error('That does not look like a plugin id');
  return v;
}

function outcome(r, verb) {
  if (!r.ok) {
    const why = (r.stderr.trim() || r.stdout.trim() || '').split('\n').filter(Boolean).slice(-1)[0];
    throw new Error(why ? why.slice(0, 300) : `Could not ${verb} that plugin`);
  }
  catalogue = null; // the installed list just changed
  return { ok: true, output: (r.stdout.trim() || r.stderr.trim() || '').slice(-600) };
}

export async function installPlugin(id) {
  // -y accepts the marketplace-declared install command. The UI names the origin
  // and takes a second, explicit tap before this is ever called.
  return outcome(await cli(['install', checkId(id), '-y']), 'install');
}
export async function uninstallPlugin(id) {
  return outcome(await cli(['uninstall', checkId(id)]), 'uninstall');
}
// No setPluginEnabled() here on purpose. `claude plugin enable/disable` exists, but
// with nothing installed on this box the catalogue reports `enabled: null` for
// every row, so there is no verified way to SHOW which state a plugin is in — and
// a control that cannot show you what it just did is worse than no control. It is
// five lines to add back the day something is installed and the field is real.

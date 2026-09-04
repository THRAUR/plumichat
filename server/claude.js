// Thin wrapper over the Claude Agent SDK. Runs scoped to a single project dir
// in 'default' permission mode: the SDK auto-allows genuinely safe ops (file
// reads, `echo`, `ls`, …) while permission-worthy ops (Write / Edit / unsafe
// Bash / MCP writes / …) and the AskUserQuestion tool are routed to the human
// via the `askUser` callback. Live token streaming via includePartialMessages.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { PLUMI_SYSTEM_PROMPT } from './system-prompt.js';
import { WORKSPACES_ROOT } from './sandbox.js';
import { sandboxKind, resetTempEnv } from './platform.js';
import { skillIds } from './skills.js';
import { getWorkspace } from './settings.js';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// The model a turn runs on when the caller picked none: the workspace default the
// owner set in Settings, then the env override, then the plain 'sonnet' alias (the
// CLI resolves it to the current Sonnet, so there's no dated id to go stale).
// The stored default must be a real model ID — an older build wrote a DISPLAY name
// there ("Sonnet 4.6"), which the CLI would reject, so ignore anything with
// whitespace in it rather than break every turn on a legacy settings file.
// The account's most recent usage-window snapshot. Module scope on purpose: the
// SDK reports it only during a turn, but the chip has to say something between
// turns and on a cold page load, so the last known value must outlive the run
// that saw it. /api/version serves this to a client with no live stream yet.
let lastLimits = null;
export function limitsSnapshot() { return lastLimits; }

function defaultModel() {
  let ws = '';
  try { ws = String(getWorkspace().defaultModel || '').trim(); } catch { /* store unreadable */ }
  if (ws && !/\s/.test(ws)) return ws;
  return process.env.CLAUDE_MODEL || 'sonnet';
}

// How long a turn may go COMPLETELY silent after its first `result` while
// background work is still pending (see the H1 loop below), and the absolute
// ceiling on that wait. Two timers in one: the idle timer is rearmed by every
// message, so a task that heartbeats forever without ever finishing would keep a
// conversation open indefinitely — the ceiling is what makes termination certain.
const BACKGROUND_WAIT_MS = Math.max(10_000, Number(process.env.PLUMI_BACKGROUND_WAIT_MS) || 15 * 60 * 1000);
const BACKGROUND_MAX_MS = Math.max(BACKGROUND_WAIT_MS, Number(process.env.PLUMI_BACKGROUND_MAX_MS) || 60 * 60 * 1000);

// thinking_tokens fires many times a second; tool_progress heartbeats every few
// seconds per tool. Both are pure progress chrome, so they're throttled before
// they reach the SSE stream (and, through it, the run's replay buffer).
const THINK_TOKENS_MS = 750;
const TOOL_PROGRESS_MS = 1000;

// Keep a task row's free text short: these are status chips, not content. The SDK
// caps descriptions at 1000 chars and a task summary can be much longer.
const TASK_TEXT_MAX = 300;
const clip = (v) => { const t = String(v == null ? '' : v); return t.length > TASK_TEXT_MAX ? t.slice(0, TASK_TEXT_MAX) + '…' : t; };
// Approval modes the caller may request per turn (the "restriction mode" selector):
//   default          — prompt the human for permission-worthy tools (safest)
//   acceptEdits      — auto-approve file writes/edits; still prompt for the rest
//   bypassPermissions— never prompt (the agent runs unattended)
// 'plan' is intentionally excluded: it needs an ExitPlanMode approval loop this
// chat UI doesn't drive, so it would strand the turn. Anything unknown falls back
// to 'default'. NOTE: the HTTP layer clamps members to 'default' regardless —
// acceptEdits/bypass skip canUseTool, which is what confines a member to their home.
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions']);

// Document-generation toolchain, injected into every turn's environment (below) so
// the agent's bare `python` resolves to the venv carrying python-pptx / python-docx
// / openpyxl / reportlab / pypdf / pdfplumber / markitdown, and bare `node` can
// `require()` the globally-installed pptxgenjs / docx-js that the pptx & docx Skills
// use to build from scratch. NODE_PATH is derived from the running server's own
// node binary, so it tracks nvm version bumps automatically (no hard-coded version).
// Optional and UNSET by default: point it at a venv's bin/ to give the document
// Skills their toolchain. Nothing breaks without it — the agent just falls back to
// whatever `python` is already on PATH.
const DOC_VENV_BIN = process.env.PLUMI_DOC_VENV_BIN || '';
const NODE_GLOBAL_MODULES = path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules');

// PlumiChat's own secrets, stripped from every agent turn's environment so a Bash
// call can never `printenv` its way to the login credentials or cookie key.
// ANTHROPIC_API_KEY is deliberately NOT here — the SDK subprocess needs it.
// VAPID_PRIVATE_KEY signs Web Push; push.js already deletes it from process.env at
// import, but that only helps once push.js has been imported, so strip it here too
// (engine.js keeps the same list — the two must not drift).
const SECRET_ENV = ['AUTH_USER', 'AUTH_PASS', 'SESSION_SECRET', 'OPS_SIGNALS', 'VAPID_PRIVATE_KEY'];

// PlumiChat is usually LAUNCHED from inside a Claude Code session (that's how the
// owner operates the box), so our own process inherits that parent session's
// env: TMPDIR=/tmp/claude-<uid>, CLAUDECODE=1, CLAUDE_CODE_* markers, an effort,
// a session id, etc. Forwarding those into the SDK turns we spawn breaks them —
// the SDK derives its temp dir by appending its own `claude-<uid>` onto the
// already-Claude TMPDIR, double-nesting to /tmp/claude-<uid>/claude-<uid>. A
// member turn's sandbox `--settings` file is then written and read at mismatched
// paths, so the CLI dies with "Error processing settings: ENOENT …
// claude-settings-<hash>.json" on EVERY turn (owner turns pass no sandbox and so
// slip past it — which is why only member sessions go dark). Drop the inherited
// markers and pin TMPDIR back to the OS default so each turn gets a clean,
// single-level temp dir no matter how the server itself was started.
const INHERITED_CLAUDE_ENV = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_EFFORT', 'TMPPREFIX', 'TMP', 'TEMP',
];
export function scrubbedEnv() {
  const env = { ...process.env };
  for (const k of SECRET_ENV) delete env[k];
  for (const k of INHERITED_CLAUDE_ENV) delete env[k];
  resetTempEnv(env); // undo a parent Claude session's /tmp/claude-<uid> override
  return env;
}

// Read-only / no-side-effect tools we never bother the human about. In 'default'
// mode the SDK already auto-allows most of these without ever calling canUseTool;
// listing them is belt-and-suspenders so they can never surface a prompt.
const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'BashOutput',
  'WebFetch', 'WebSearch', 'TodoWrite', 'ExitPlanMode',
  // Skill just loads a skill's guidance into context; any side-effecting tool it
  // then runs (Bash / Write / Edit) is still independently checked below, so it's
  // safe to auto-allow and never prompt a member when a document skill activates.
  'Skill',
]);

// Turn the structured answer the browser sent back into a short natural-language
// line. We feed it to Claude as the AskUserQuestion tool result (see below).
function craftAnswer(payload) {
  if (!payload || !Array.isArray(payload.selections) || !payload.selections.length) {
    return 'The user dismissed the question without answering. Ask again or proceed using your best judgement.';
  }
  const parts = payload.selections.map((s) => {
    const chosen = Array.isArray(s.chosen) ? s.chosen.filter(Boolean).join(', ') : String(s.chosen || '');
    return `${JSON.stringify(s.header || 'Question')} → ${chosen || '(no answer)'}`;
  });
  return 'The user answered: ' + parts.join('; ') + '. Use these answers and continue.';
}

// Build the SDK canUseTool callback. `askUser(request)` returns a Promise that
// resolves once the human responds over the side channel; `allowAlways` is a
// per-conversation Set of tool names the user chose to stop being asked about.
function makeCanUseTool({ askUser, allowAlways }) {
  return async (toolName, input) => {
    // Claude is asking the human a question. There is no interactive backend in
    // headless mode (allowing the tool throws a ZodError requiring updatedInput),
    // so we present the question ourselves and feed the answer back as the tool
    // result via a deny message — Claude reads it as the answer (verified).
    if (toolName === 'AskUserQuestion') {
      const ans = await askUser({ kind: 'question', tool: toolName, input });
      return { behavior: 'deny', message: craftAnswer(ans) };
    }

    // Auto-allow safe tools and anything the user already blessed for this chat.
    // NOTE: an 'allow' result REQUIRES updatedInput to be a record in this SDK
    // version — echo the original input back unchanged (verified).
    if (SAFE_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input };
    if (allowAlways && allowAlways.has(toolName)) return { behavior: 'allow', updatedInput: input };

    // Everything else needs the human's say-so.
    const dec = await askUser({ kind: 'permission', tool: toolName, input });
    if (dec && dec.allow) {
      if (dec.always && allowAlways) allowAlways.add(toolName);
      return { behavior: 'allow', updatedInput: input };
    }
    return {
      behavior: 'deny',
      message: (dec && dec.message) ||
        `The user denied permission to use ${toolName}. Do not retry it; explain what you wanted to do and ask how they would like to proceed.`,
    };
  };
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Where this file lives (server/) and the app's secret file, computed once so the
// member sandbox can hide them from a member's shell without hard-coding paths.
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ENV = path.resolve(SERVER_DIR, '..', '.env');
const OS_HOME = os.homedir();

// Sandbox settings for a MEMBER turn. Member Bash runs inside an OS sandbox — a
// bubblewrap mount-namespace on Linux, seatbelt on macOS — where only `home` is
// writable, so a shell (the thing that powers the document Skills) is hard-confined
// to the member's own folder. Confinement is by MOUNT, not by chmod, which is why
// it holds even on filesystems that do not enforce Unix permissions (verified on a
// Windows-hosted /mnt drive under WSL). denyRead additionally hides high-value
// secrets from the shell.
//
// FAIL-CLOSED, and this is the load-bearing part: failIfUnavailable makes the turn
// ERROR when no sandbox exists rather than quietly running a member's shell
// unconfined. memberTurnsSupported() below lets callers refuse earlier, with a
// message a human can act on, instead of surfacing an SDK error.
// Can this machine confine a member at all? Windows has no supported sandbox, so
// the honest answer there is "owner-only install" — not "members, unconfined".
export function memberTurnsSupported() { return sandboxKind() !== null; }
export function sandboxMechanism() { return sandboxKind(); }

export function makeMemberSandbox(home) {
  return {
    enabled: true,
    failIfUnavailable: true,         // no bwrap → error out; never run a shell unconfined
    autoAllowBashIfSandboxed: true,  // the sandbox IS the boundary, so don't prompt per command
    allowUnsandboxedCommands: false, // never let a command run outside the sandbox
    filesystem: {
      allowWrite: [home],            // only the member's own folder is writable
      denyRead: [
        WORKSPACES_ROOT,                                    // the whole shared workspace — hides other members' and the owner's project CONTENTS (their own home stays readable via allowWrite above)
        APP_ENV,                                            // this app's own .env (API key, cookie secret, …)
        path.join(OS_HOME, '.ssh'),                         // ssh keys
        path.join(OS_HOME, '.claude', '.credentials.json'), // Claude credentials
      ],
    },
  };
}

// Member policy: hard-confined to the member's home directory. A write whose path
// resolves outside `home` is denied outright; a write INSIDE `home` is auto-approved
// — a member editing their own files is theirs to do, so we don't nag on every write.
// The containment check (not the prompt) IS the boundary: a member still cannot touch
// anything that isn't theirs. Bash runs only under the bubblewrap sandbox
// (makeMemberSandbox); unsandboxed it's denied, since a bare shell can escape via cd /
// absolute paths / redirection. Net effect: the safe, in-home work she actually asked
// for proceeds without prompts, while the real boundary stays fully intact.
export function makeMemberPolicy({ home, askUser, allowAlways, sandboxed }) {
  const within = (p) => {
    if (!p) return false;
    const abs = path.isAbsolute(p) ? p : path.resolve(home, p);
    const rel = path.relative(home, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const promptThenAllow = async (toolName, input) => {
    if (allowAlways && allowAlways.has(toolName)) return { behavior: 'allow', updatedInput: input };
    const dec = await askUser({ kind: 'permission', tool: toolName, input });
    if (dec && dec.allow) {
      if (dec.always && allowAlways) allowAlways.add(toolName);
      return { behavior: 'allow', updatedInput: input };
    }
    return {
      behavior: 'deny',
      message: (dec && dec.message) ||
        `The user denied permission to use ${toolName}. Do not retry it; explain what you wanted to do and ask how they would like to proceed.`,
    };
  };
  return async (toolName, input) => {
    if (toolName === 'AskUserQuestion') {
      const ans = await askUser({ kind: 'question', tool: toolName, input });
      return { behavior: 'deny', message: craftAnswer(ans) };
    }
    if (SAFE_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input };
    if (WRITE_TOOLS.has(toolName)) {
      const fp = input && (input.file_path || input.path || input.notebook_path);
      if (!within(fp)) {
        return { behavior: 'deny', message: 'Refused: "' + fp + '" is outside your workspace. You can only read or modify files inside your own folder.' };
      }
      // Inside their own confined home a member can only ever change their own
      // files, so this is theirs to do — auto-approve instead of prompting on every
      // write. The `within` containment check above, not a prompt, is the boundary.
      return { behavior: 'allow', updatedInput: input };
    }
    if (toolName === 'Bash') {
      // With the bubblewrap sandbox active (makeMemberSandbox), a shell is
      // hard-confined to the member's home, so we can safely allow it — this is
      // what lets the document Skills run code. Writes outside home are blocked by
      // the kernel; the SDK is set fail-closed (no unsandboxed commands), so an
      // 'allow' here can only ever run a sandboxed shell. Without the sandbox we
      // keep the original hard-deny (a bare shell can escape the per-user sandbox).
      if (sandboxed) return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: 'Shell commands are disabled for member accounts (a shell can escape the per-user sandbox). Ask me to create or edit files directly instead — I can do that inside your folder.' };
    }
    return promptThenAllow(toolName, input);
  };
}

// The model id the SDK stamps on a message IT generated rather than the API: an
// "API Error: 529 Overloaded…" line, a session-limit notice. Not a real model.
const SYNTHETIC_MODEL = '<synthetic>';

// Turn a raw SDK/CLI failure into a short, non-alarming line for the chat. The SDK
// collapses a subprocess crash into "exited with code N" and hides the real reason
// in stderr; we log the full detail server-side (see runPrompt's catch) and show the
// human something actionable instead. A transient upstream error (the API briefly
// overloaded/unreachable) is by far the most common cause here and is fully
// recoverable, so steer the user to simply retry rather than think PlumiChat is broken.
function friendlyError(raw, stderr) {
  const hay = `${raw}\n${stderr || ''}`;
  if (/overloaded|rate.?limit|\b429\b|\b5\d\d\b|\b529\b|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up|network error|fetch failed|timed? ?out/i.test(hay)) {
    return 'The AI service had a temporary error (it was briefly busy or unreachable). Tap Continue to retry — this usually clears within a minute.';
  }
  if (/exited with code|process exited|non-?zero exit/i.test(raw)) {
    return 'This turn ended unexpectedly before finishing. Tap Continue to try again — the technical details were saved to the server log.';
  }
  return raw;
}

// Why the CLI refused a fast-mode request, in words a human can act on. Fast mode
// is asked for through the settings layer (see runPrompt) and the CLI reports back
// on the init message whether it engaged; when it did not, the UI must say so
// rather than keep showing "· Fast" — a toggle that lies is worse than no toggle.
const FAST_MODE_WHY = {
  free: 'your plan does not include it',
  preference: 'it is switched off in this box\'s Claude settings',
  extra_usage_disabled: 'extra usage is turned off for this account',
  network_error: 'the service could not be reached to enable it',
  not_first_party: 'this login cannot use it',
  disabled_by_env: 'an environment variable on the box disables it',
  model_not_allowed: 'this model does not support it',
  sdk_opt_in_required: 'PlumiChat did not ask for it (report this — it is a bug)',
  pending: 'it had not finished starting up',
};
function fastModeWhy(reason, state) {
  if (state === 'cooldown') return 'it is cooling down after a rate limit';
  return FAST_MODE_WHY[reason] || 'the service did not say why';
}

// "15 minutes" / "45 seconds" for a duration in ms — used by the background-wait
// safety valve, whose deadlines are configurable, so the end reason has to name
// the deadline that actually applied instead of a hard-coded number.
function humanMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  // Whole hours read as hours ("1 hour", the default ceiling); anything else stays
  // in minutes rather than rounding 90 minutes down to "2 hours".
  if (m >= 60 && m % 60 === 0) { const h = m / 60; return `${h} hour${h === 1 ? '' : 's'}`; }
  return `${m} minute${m === 1 ? '' : 's'}`;
}

// Does this model id have a '[1m]' twin in the CLI's curated picker? Imported
// lazily on purpose: models.js imports scrubbedEnv from THIS module, so a static
// import back would make a cycle. Node caches the module, so every call after the
// first is a map lookup. Never throws — an unknown answer means "no 1M".
async function has1mVariant(id) {
  try {
    const m = await import('./models.js');
    return !!(await m.supports1m(id));
  } catch { return false; }
}

// Run a prompt against a project directory, emitting normalized events via
// onEvent(event). Callback form (not a generator): canUseTool is an async
// callback that must emit events too — which a generator body can't yield from.
//
// Resolves to null for an ordinary turn, or { stalled: true, reason } when the
// background-wait safety valve ended it — the caller needs that to report an
// honest end reason instead of a bare "Stopped" (see the valve below).
//
// `cwd` MUST already be validated as inside WORKSPACES_ROOT by the caller.
//
// Events:
//   { type: 'session', sessionId }      — once the session id is known
//   { type: 'text',    text }           — live token deltas (streamed)
//   { type: 'thinking', text }          — extended-thinking deltas (streamed)
//   { type: 'tool',    name, input }    — a tool the agent invoked
//   { type: 'ask', id, kind, tool, input } — emitted by askUser (see index.js)
//   { type: 'result',  sessionId }      — turn finished (text already streamed)
//   { type: 'notice',  phase, text }    — system notice (e.g. compaction)
//   { type: 'error',   message }
// Added for background-agent parity with the terminal (all additive — no existing
// event name or shape changed):
//   { type: 'waiting', tasks, text }    — a result landed but background work is still running
//   { type: 'task', phase, id, name, description, status, summary } — task lifecycle row
//   { type: 'limits', status, resetsAt, kind, overage }             — rate-limit window changed
//   { type: 'thinkingTokens', estimated }                           — throttled thinking-token estimate
export async function runPrompt({
  prompt, cwd, sessionId, model, effort, fastMode, context1m, permissionMode,
  onEvent, askUser, allowAlways, abortController, canUseTool, sandbox,
}) {
  // Capture the CLI subprocess's stderr. The SDK collapses a non-zero exit into a
  // generic "exited with code N" and discards the child's stderr — which is where
  // the ACTUAL reason lives (API overload, auth, model, …). Keep a bounded tail so a
  // failed turn can be diagnosed from the server log instead of being a total mystery.
  let stderrTail = '';
  const captureStderr = (d) => {
    stderrTail += d;
    if (stderrTail.length > 8192) stderrTail = stderrTail.slice(-8192);
  };

  const options = {
    cwd,
    model: model || defaultModel(),
    // PlumiChat's environment guide, appended to Claude Code's own system prompt so
    // the agent knows it answers in a mobile web chat with one-tap Download
    // (PDF/Word/PowerPoint/Excel) and shapes deliverables accordingly. The append
    // form keeps every default Claude Code capability intact. See
    // server/system-prompt.js — the single place to document new features.
    systemPrompt: { type: 'preset', preset: 'claude_code', append: PLUMI_SYSTEM_PROMPT },
    // The caller's chosen approval mode (default unless a trusted caller asked for
    // acceptEdits / bypassPermissions). In bypass/acceptEdits the SDK skips
    // canUseTool for the auto-approved tools, so the human simply isn't prompted.
    permissionMode: PERMISSION_MODES.has(permissionMode) ? permissionMode : 'default',
    includePartialMessages: true,
    // Snapshot every file before a tool modifies it, so a turn can be undone from
    // the phone (context.js `rewind`). Checkpoints are written by the process that
    // ran the turn — switching this on retroactively does nothing, which is why it
    // is unconditional here rather than a per-turn option: a rewind you can only
    // use if you remembered to arm it first is not a rewind.
    enableFileCheckpointing: true,
    // Route the child's stderr to our bounded buffer (see captureStderr above) so a
    // crash reports its real cause instead of a bare "exited with code N".
    stderr: captureStderr,
    // Callers (e.g. the autonomous Operations runner) may supply their own
    // policy to confine tools; otherwise route permission-worthy tools to the human.
    canUseTool: canUseTool || makeCanUseTool({ askUser, allowAlways }),
    // Every turn runs with the document toolchain on PATH (venv python) and
    // NODE_PATH (global pptxgenjs / docx-js). `skills` is discovered live from
    // ~/.claude/skills (see skills.js) rather than hardcoded, so every installed
    // skill — the four Anthropic document skills and anything else the owner has
    // dropped in — is enabled, and a new skill folder needs no code change here.
    // `skills` also auto-enables the Skill tool (allow-listed in SAFE_TOOLS so a
    // member is never prompted on activation). PlumiChat's own credentials must never
    // leak into the agent's environment — a turn (especially a member's) could just
    // `printenv AUTH_PASS`. Note that ANTHROPIC_API_KEY stays: the SDK needs it.
    env: {
      ...scrubbedEnv(),
      PATH: DOC_VENV_BIN ? `${DOC_VENV_BIN}${path.delimiter}${process.env.PATH || ''}` : (process.env.PATH || ''),
      NODE_PATH: NODE_GLOBAL_MODULES + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : ''),
    },
    skills: skillIds(),
  };
  if (effort && EFFORTS.has(effort)) options.effort = effort;
  // Fast mode. It is NOT a top-level Option — `fastMode` is a *Settings* field —
  // so the `options.fastMode = true` this used to set was dropped on the floor and
  // the composer's "· Fast" badge lied on every turn since the toggle shipped. The
  // channel the SDK actually honours is the `settings` option, which is loaded as
  // the flag-settings layer (the same layer --settings and applyFlagSettings write,
  // above user/project/local settings). Proven with the CLI's own report on the
  // system/init message:
  //   options.fastMode = true         → fast_mode_state 'off', reason 'sdk_opt_in_required'
  //   settings: { fastMode: true }    → fast_mode_state 'on'
  // Sent in BOTH directions so the toggle is authoritative: an OFF toggle has to
  // mean off even if a settings file on the box switched fast mode on globally.
  // Whether it actually engaged is checked on the init message below.
  options.settings = { fastMode: !!fastMode };
  // Member turns carry bubblewrap sandbox settings so their Bash is hard-confined
  // to their own home (see makeMemberSandbox). Owner/admin turns pass nothing.
  if (sandbox) options.sandbox = sandbox;
  // 1M token context window. On the 5.x models this is selected by a '[1m]' SUFFIX
  // on the model id ('claude-opus-5' -> 'claude-opus-5[1m]') — exactly how the CLI's
  // own picker exposes it. The old `betas: ['context-1m-…']` header only ever applied
  // to the Sonnet 4.x family and is a dead end everywhere else, so it survives only
  // for those ids. Never append the suffix to a model with no 1M twin: the CLI would
  // reject the id and the whole turn would fail.
  if (context1m && !/\[1m\]$/i.test(options.model)) {
    if (/sonnet-4/i.test(options.model)) options.betas = ['context-1m-2025-08-07'];
    else if (await has1mVariant(options.model)) options.model += '[1m]';
  }
  if (sessionId) options.resume = sessionId;
  if (abortController) options.abortController = abortController;

  const q = query({ prompt, options });
  let knownSession = sessionId || null;
  // Model provenance, two grades:
  //   'init' — the model the SDK *configured* the session with (an echo of our
  //            request; arrives instantly, good for the status bar).
  //   'api'  — `message.model` on the assistant message: the id Anthropic's API
  //            stamped on the response body itself. Serving-side metadata the
  //            model cannot misreport — THE proof of which model answered.
  let sentInit = false, sentApi = false;

  // --- Background-task bookkeeping (audit H1) -------------------------------
  // The SDK reports live background work two ways. `background_tasks_changed` is
  // a LEVEL signal carrying the full live set (replace semantics, self-healing);
  // task_started / task_notification are EDGE bookends. The SDK explicitly says
  // not to correlate ids across the two streams, so the level wins as soon as it
  // has ever been seen and the edges only cover the window before that.
  // `ambient` tasks (housekeeping watchers the CLI never surfaces as user work)
  // are excluded from both — one of them is by definition never going to finish,
  // and counting it would hold the turn open until the safety valve fired.
  let bgLevel = 0;            // tasks reported by the latest background_tasks_changed
  let bgLevelSeen = false;    // has a level message ever arrived in this process?
  const edgeOpen = new Set(); // task ids started but not yet notified (pre-level fallback)
  const ambientIds = new Set(); // ids to keep out of the UI tray (task_updated carries no flag)
  const pendingTasks = () => (bgLevelSeen ? bgLevel : edgeOpen.size);

  // Throttle state for the pure-progress streams (see the constants up top).
  let lastThinkTokens = 0, lastToolProgress = 0, limitsSig = '';

  // Safety valve for the "keep iterating after result" path below. Two deadlines,
  // whichever comes first: silence (idle) and an absolute ceiling from the first
  // result. Both are unref()'d so a pending timer can never hold the server open,
  // and the timer is cleared unconditionally in the finally block.
  // `stalled` doubles as the valve's verdict: null while healthy, otherwise the
  // honest end reason, which runPrompt hands back to runs.js so the turn can end
  // as "Ended: a background agent stopped responding after 15 minutes" instead of
  // the bare "Stopped" that reads as if the user had pressed Stop themselves.
  let waitTimer = null, waitUntil = 0, stalled = null;
  const clearWait = () => { if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; } };
  const armWait = () => {
    clearWait();
    const left = waitUntil - Date.now();
    // Which of the two deadlines is this timer? The ceiling, once what's left of
    // it is shorter than a full silence window; the idle timer until then. Decided
    // here rather than at fire time so the reason can never be mislabelled by a
    // few milliseconds of drift.
    const ceiling = left <= BACKGROUND_WAIT_MS;
    waitTimer = setTimeout(() => {
      // Nothing has arrived in a long time (or we've waited as long as we ever
      // will): a wedged background task must not hold the conversation open
      // forever. Say so, then abort — the catch below stays quiet on abort.
      stalled = {
        reason: ceiling
          ? `background work was still running after ${humanMs(BACKGROUND_MAX_MS)}`
          : `a background agent stopped responding after ${humanMs(BACKGROUND_WAIT_MS)}`,
      };
      onEvent({ type: 'notice', phase: 'done', text: `Ended: ${stalled.reason}.` });
      // abortController is the caller's stop handle and the path runs.js reads;
      // close() is the fallback for a caller that supplied none, so the iterator
      // still ends and the turn can never hang.
      try { if (abortController) abortController.abort(); else q.close?.(); } catch { /* already gone */ }
    }, Math.max(1000, Math.min(BACKGROUND_WAIT_MS, left)));
    waitTimer.unref?.();
  };

  try {
    for await (const message of q) {
      // ANY traffic means the CLI is still alive: drop the stall timer and let the
      // message handlers below re-arm it if we're still waiting on background work.
      clearWait();
      if (stalled) break; // the valve already fired; don't start another wait
      if (!knownSession && message && message.session_id) {
        knownSession = message.session_id;
        onEvent({ type: 'session', sessionId: knownSession });
      }

      // Ground truth: surface the ACTUAL model serving this turn. 'init' confirms
      // configuration immediately; the first assistant message upgrades it to
      // API-confirmed. `requested` rides along so the UI can flag a mismatch.
      if (!sentApi) {
        // Skip the synthetic marker: stamping it would put "<synthetic>" in the
        // model badge AND latch sentApi, so the real model never got reported for
        // the rest of the turn.
        if (message.type === 'assistant' && message.message && message.message.model
            && message.message.model !== SYNTHETIC_MODEL) {
          sentApi = true;
          onEvent({ type: 'model', model: message.message.model, source: 'api', requested: options.model });
        } else if (!sentInit && message.model) {
          sentInit = true;
          // `fast` rides along on the init grade only: it is the CLI's own verdict
          // on whether fast mode engaged for this session ('on' | 'cooldown' |
          // 'off'), which is the one thing that can confirm the toggle is real.
          onEvent({
            type: 'model', model: message.model, source: 'init', requested: options.model,
            fast: message.fast_mode_state || null,
          });
        }
      }

      if (message.type === 'stream_event') {
        // Live partial deltas. Two kinds interest us: the visible answer
        // (text_delta) and the model's extended-thinking stream (thinking_delta),
        // which effort levels high/xhigh/max produce. We surface thinking as its
        // own event so the UI can show it in a separate, collapsible block rather
        // than mixing reasoning into the answer. Redacted (encrypted) thinking
        // carries no text, so there's nothing to stream for it.
        const e = message.event;
        if (e && e.type === 'content_block_delta' && e.delta) {
          if (e.delta.type === 'text_delta' && e.delta.text) {
            onEvent({ type: 'text', text: e.delta.text });
          } else if (e.delta.type === 'thinking_delta' && e.delta.thinking) {
            onEvent({ type: 'thinking', text: e.delta.thinking });
          }
        }
      } else if (message.type === 'assistant') {
        // Text was already streamed via deltas; only surface tool calls here.
        // Skip AskUserQuestion: it's rendered as an interactive card via the
        // 'ask' event from canUseTool, so a tool row would be redundant.
        for (const block of message.message?.content ?? []) {
          if (block.type === 'tool_use' && block.name !== 'AskUserQuestion') {
            onEvent({ type: 'tool', name: block.name, input: block.input });
          }
        }
      } else if (message.type === 'result') {
        // A turn can end on an API error without ever throwing, so the catch
        // below never sees it: the SDK reports subtype 'success' with is_error
        // true and puts the error text in `result` ("API Error: 529 Overloaded…",
        // "You've hit your session limit…"); the error subtypes carry it in
        // `errors` instead. The assistant message that pairs with it is synthetic,
        // so its text never streamed as a delta and the assistant branch above
        // only forwards tool_use — which is why these turns ended SILENTLY: an
        // empty bubble, status 'done', nothing to tell a busy service from a
        // finished answer. Emit the real reason so runs.js ends the run as 'error'
        // and the client offers Continue.
        if (message.is_error) {
          const raw = String(message.result || (message.errors || []).join('; ') || '').trim()
            || 'The turn ended on an error before finishing.';
          console.error(`[claude] turn ended on an API error (session=${knownSession || 'new'}, status=${message.api_error_status ?? 'n/a'}): ${raw}`);
          onEvent({ type: 'error', message: friendlyError(raw, '') });
        }
        // The terminal message also carries this turn's token usage and (when the
        // SDK computes it) the dollar cost — surface both so the UI can badge the
        // response. Fields are defensive: shapes vary by SDK/transport.
        const usage = message.usage || null;
        onEvent({
          type: 'result',
          sessionId: knownSession,
          costUsd: (typeof message.total_cost_usd === 'number') ? message.total_cost_usd : null,
          durationMs: (typeof message.duration_ms === 'number') ? message.duration_ms : null,
          usage: usage ? {
            input: usage.input_tokens || 0,
            output: usage.output_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            cacheWrite: usage.cache_creation_input_tokens || 0,
          } : null,
        });
        // 'result' is the turn's terminal message, but it is NOT necessarily the
        // end of the work. Breaking here calls the generator's return(), which
        // closes the CLI's stdin — and that kills every background subagent,
        // monitor and scheduled wake-up the process owns, which is exactly why a
        // paused agent never picked itself back up the way it does in the terminal
        // (audit H1). Verified behaviour: keep iterating and the CLI delivers the
        // task_notification and AUTO-CONTINUES the conversation itself, ending in
        // a second result.
        //
        // So: finish only on a result with no background work left. Otherwise stay
        // on the line, tell the client we're waiting, and arm the safety valve.
        // (Supplying canUseTool puts the SDK in streaming-input mode, where the
        // iterator does not reliably self-close — so the break is still what ends
        // a normal turn; without it the `for await` would hang and 'done' would
        // never fire, leaving the UI stuck on "responding…".)
        // No q.getContextUsage() here, tempting as it looks. A turn is started with
        // a plain string prompt, which closes the child's stdin — so by the time
        // `result` lands the control channel is already gone and the call fails with
        // "Query closed before response received" (measured, both permission modes).
        // The context ring is fed instead by the `usage` above: the SDK's own
        // totalTokens is exactly input + cache_read + cache_creation of the last
        // request (verified against getContextUsage on the same session), so a
        // finished turn updates the ring for free and only the category breakdown
        // needs the out-of-band read in context.js.
        if (pendingTasks() === 0) break;
        if (!waitUntil) waitUntil = Date.now() + BACKGROUND_MAX_MS;
        onEvent({
          type: 'waiting',
          tasks: pendingTasks(),
          text: `Waiting on ${pendingTasks()} background agent${pendingTasks() === 1 ? '' : 's'}…`,
        });
        armWait();
      } else if (message.type === 'system') {
        // Surface auto-compaction as a lightweight notice — never as a chat
        // message. 'status:compacting' marks the start; 'compact_boundary' the end.
        if (message.subtype === 'init') {
          // The CLI reports here whether fast mode actually engaged. We only speak
          // up when the answer is no and the user asked for yes: the composer is
          // showing "· Fast", so silence would leave a badge claiming something
          // that isn't happening (a rate-limit cooldown, a model that can't do it,
          // extra usage switched off…).
          if (fastMode && message.fast_mode_state !== 'on') {
            onEvent({
              type: 'notice', phase: 'done',
              text: `Fast mode is off for this turn — ${fastModeWhy(message.fast_mode_disabled_reason, message.fast_mode_state)}.`,
            });
          }
        } else if (message.subtype === 'status' && message.status === 'compacting') {
          onEvent({ type: 'notice', phase: 'start', text: 'Compacting context…' });
        } else if (message.subtype === 'compact_boundary') {
          onEvent({ type: 'notice', phase: 'done', text: 'Context compacted' });
        } else if (message.subtype === 'api_retry') {
          // The CLI retries a retryable API failure (a 529 overload, a 5xx, a
          // dropped socket) itself, with growing backoff — the same thing the
          // terminal shows as a live retry counter. Ignoring it is why a turn
          // sitting out a several-minute backoff looked frozen in the browser:
          // no text, no tool, no notice, just "responding…" until it gave up.
          // Say what is happening; the wait is normal and usually ends in an
          // answer. error_status is null for connection errors with no response.
          const why = message.error_status ? ` (${message.error_status})` : '';
          onEvent({
            type: 'notice', phase: 'start',
            text: `The AI service is busy${why} — retrying, attempt ${message.attempt} of ${message.max_retries}…`,
          });
        } else if (message.subtype === 'background_tasks_changed') {
          // The level signal: the FULL live set after the change. Replace, don't
          // merge (that's the documented contract) and drop ambient housekeeping.
          bgLevel = (message.tasks || []).filter((t) => t && !t.ambient).length;
          bgLevelSeen = true;
        } else if (message.subtype === 'task_started') {
          if (message.ambient) ambientIds.add(message.task_id);
          else {
            edgeOpen.add(message.task_id);
            onEvent({
              type: 'task', phase: 'started', id: message.task_id,
              name: message.subagent_type || message.task_type || 'task',
              description: clip(message.description), status: 'running',
            });
          }
        } else if (message.subtype === 'task_progress') {
          if (!message.ambient) {
            onEvent({
              type: 'task', phase: 'progress', id: message.task_id,
              name: message.subagent_type || message.last_tool_name || '',
              description: clip(message.description), status: 'running',
              summary: clip(message.summary),
            });
          }
        } else if (message.subtype === 'task_updated') {
          const patch = message.patch || {};
          const ended = patch.status === 'completed' || patch.status === 'failed' || patch.status === 'killed';
          if (ended) edgeOpen.delete(message.task_id);
          if (!ambientIds.has(message.task_id)) {
            onEvent({
              type: 'task', phase: ended ? (patch.status === 'killed' ? 'stopped' : 'done') : 'progress',
              id: message.task_id, description: clip(patch.description),
              status: patch.status || 'running',
            });
          }
        } else if (message.subtype === 'task_notification') {
          edgeOpen.delete(message.task_id);
          if (message.ambient) ambientIds.add(message.task_id);
          else {
            onEvent({
              type: 'task', phase: message.status === 'stopped' ? 'stopped' : 'done',
              id: message.task_id, status: message.status || 'completed',
              summary: clip(message.summary),
            });
          }
        } else if (message.subtype === 'thinking_tokens') {
          // Fires many times a second — throttle hard, it's just a counter.
          const now = Date.now();
          if (now - lastThinkTokens >= THINK_TOKENS_MS) {
            lastThinkTokens = now;
            onEvent({ type: 'thinkingTokens', estimated: message.estimated_tokens || 0 });
          }
        }
      } else if (message.type === 'rate_limit_event') {
        // The account's usage window. Emitted on every change including no-op
        // repeats, so only forward it when something the UI shows actually moved.
        const info = message.rate_limit_info || {};
        const sig = `${info.status}|${info.resetsAt}|${info.rateLimitType}|${info.overageStatus}`;
        const snap = {
          status: info.status || '', resetsAt: info.resetsAt || null,
          kind: info.rateLimitType || '', overage: info.overageStatus || '',
        };
        lastLimits = { ...snap, at: Date.now() };   // remembered even when unchanged
        if (sig !== limitsSig) {
          limitsSig = sig;
          onEvent({ type: 'limits', ...snap });
        }
      } else if (message.type === 'tool_progress') {
        // Heartbeats for a long-running Bash/Agent call. These belong on the task
        // row the tray already shows, so fold them into a 'task' progress event
        // rather than inventing a channel; throttled because they tick steadily.
        const now = Date.now();
        if (now - lastToolProgress >= TOOL_PROGRESS_MS) {
          lastToolProgress = now;
          onEvent({
            type: 'task', phase: 'progress',
            id: message.task_id || message.tool_use_id,
            name: message.subagent_type || message.tool_name || '',
            description: `${Math.round(message.elapsed_time_seconds || 0)}s`,
            status: 'running',
          });
        }
      }

      // Once a result has landed with work still pending, the only clean exits
      // left are a LATER result (the break above) or the iterator ending. Keep
      // the valve armed for the whole of that window — not just while tasks are
      // pending — because a task set that empties without the CLI auto-continuing
      // would otherwise leave the `for await` blocked with no timer to save it.
      if (waitUntil) armWait();
    }
  } catch (err) {
    // A deliberate abort (client disconnected) isn't a real error — stay quiet.
    if (!(abortController && abortController.signal.aborted)) {
      const raw = err?.message || String(err);
      // Log the REAL reason (plus the child's stderr tail) so a failed turn is
      // debuggable from the server log — the SDK otherwise discards it. Then show
      // the human a short, actionable line instead of the raw "exited with code N".
      const tail = stderrTail.trim();
      console.error(`[claude] turn failed (session=${knownSession || 'new'}, cwd=${cwd}): ${raw}`);
      if (tail) console.error(`[claude] CLI stderr tail:\n${tail}`);
      onEvent({ type: 'error', message: friendlyError(raw, tail) });
    }
  } finally {
    // Unconditional: a live timer here would keep firing (and could abort a NEXT
    // turn's controller) long after this one is over.
    clearWait();
  }
  // How the turn ended, for the caller's end-reason line. Only the safety valve
  // has anything to report: everything else is either a normal finish, an error
  // already emitted as {type:'error'}, or the caller's own abort — all of which
  // runs.js can already name correctly on its own.
  return stalled ? { stalled: true, reason: stalled.reason } : null;
}

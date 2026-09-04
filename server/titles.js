// Conversation titles for the drawer, in precedence order:
//
//   1. the user's own rename            (history.js 'session-titles')
//   2. the SDK's own title              (customTitle from /rename, else the CLI's
//                                        auto summary — sdkTitle/sdkTitles below)
//   3. our generated Haiku title        ('session-auto-titles', generateTitle)
//   4. the first message, truncated     (history.js titleFromHead)
//
// Tier 2 is new and is tried BEFORE tier 3: Claude Code titles its own sessions
// and stores the result in the session log, so for anything the owner also
// touched from the terminal the right answer is already on disk — no API call, no
// token scraping, and a /rename done in the terminal shows up here. It just isn't
// there yet for a session PlumiChat only just created, which is why tier 3 stays.
//
// Tier 3's summary comes from ONE cheap Haiku call to the Anthropic Messages API,
// authenticated with the SAME Claude subscription (OAuth) token the Agent SDK
// uses — read fresh from ~/.claude/.credentials.json at call time, never stored
// or logged (see models.js). We deliberately call /v1/messages directly instead
// of going through the Agent SDK: the SDK would spin up a full agent session and
// write its own session log, which would then surface as a *phantom conversation*
// in the drawer. A plain HTTP request has no such side effect.
//
// Tier 3's titles live in their own store ('session-auto-titles'), separate from
// the user-set titles ('session-titles' in history.js), so the tiers above stay
// unambiguous: nothing here can ever overwrite a rename the user typed.
import { getSessionInfo, listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk';
import { read, update } from './store.js';
import { oauthToken, listModels } from './models.js';

const AUTO_TITLES = 'session-auto-titles';
const validId = (id) => /^[A-Za-z0-9._-]+$/.test(String(id || ''));

export function getAutoTitle(sessionId) {
  if (!validId(sessionId)) return '';
  return read(AUTO_TITLES, {})[sessionId] || '';
}
export function setAutoTitle(sessionId, title) {
  if (!validId(sessionId)) return '';
  const t = String(title || '').trim().slice(0, 80);
  update(AUTO_TITLES, (map) => { if (t) map[sessionId] = t; else delete map[sessionId]; return map; }, {});
  return t;
}
export function clearAutoTitle(sessionId) {
  if (!validId(sessionId)) return;
  update(AUTO_TITLES, (map) => { delete map[sessionId]; return map; }, {});
}

// SDKSessionInfo.summary is documented as "custom title, auto-generated summary,
// or first prompt" — so when it merely echoes firstPrompt the session has NOT been
// titled yet and we must fall through to tier 3/4 rather than pin the raw first
// message as though it were a title.
function titleOf(info) {
  if (!info) return '';
  const custom = String(info.customTitle || '').trim();
  if (custom) return custom.slice(0, 80);
  const summary = String(info.summary || '').trim();
  const first = String(info.firstPrompt || '').trim();
  if (!summary || summary === first) return '';
  return summary.slice(0, 80);
}

// Every SDK-known title for one project directory, as sessionId -> title. ONE
// call for a whole drawer listing (getSessionInfo would be one file read each).
// includeWorktrees is pinned off: it would pull in sessions belonging to OTHER
// directories of the same git repo, which would step straight outside the
// per-account scoping every other read in history.js relies on.
// Never throws — an empty map just means "no tier-2 titles available".
export async function sdkTitles(cwd) {
  const out = new Map();
  if (!cwd) return out;
  try {
    const list = await sdkListSessions({ dir: cwd, includeWorktrees: false });
    for (const info of list || []) {
      const t = titleOf(info);
      if (info && info.sessionId && t) out.set(info.sessionId, t);
    }
  } catch { /* SDK unavailable / no such project — fall through a tier */ }
  return out;
}

// The same lookup for a single session (one file read instead of the whole dir).
export async function sdkTitle(sessionId, cwd) {
  if (!validId(sessionId)) return '';
  try {
    return titleOf(await getSessionInfo(sessionId, cwd ? { dir: cwd } : undefined));
  } catch { return ''; }
}

// The OAuth subscription-token auth path requires every Messages request to
// identify as Claude Code: the FIRST system block must be exactly this string or
// the API rejects the call. Our titling instructions follow it as a second block.
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const TITLER_INSTRUCTIONS = [
  'For this turn ONLY, act as a title generator. Read the user request below and',
  'reply with a very short title that summarizes the task. Rules: 3-6 words, Title',
  'Case, no surrounding quotes, no trailing punctuation, no preamble or explanation',
  '— output ONLY the title itself. Examples: "Fix expired-session login bug",',
  '"Add CSV export to reports", "Debug failing CI pipeline".',
].join(' ');

// Pick a Haiku model id (cheapest + fastest), preferring the live list so it
// tracks new Haiku releases; falls back to an env override, then a known-good id.
async function haikuModel() {
  if (process.env.TITLE_MODEL) return process.env.TITLE_MODEL;
  try {
    const { models } = await listModels();
    const h = (models || []).find((m) => /haiku/i.test(m.id));
    if (h) return h.id;
  } catch { /* fall through to the constant */ }
  return 'claude-haiku-4-5-20251001';
}

// Tidy the model's output into a clean one-line label.
function clean(s) {
  let t = String(s || '').trim().split('\n')[0].trim();
  t = t.replace(/^["'`“‘«]+|["'`”’»]+$/g, '').trim(); // strip wrapping quotes
  t = t.replace(/[.…\s]+$/g, '').trim();                                        // trailing dots/space
  return t.slice(0, 60);
}

// Tier 3. Summarize a user request into a short title. Still worth having: it
// runs in parallel with the very first turn, so a brand-new conversation gets a
// real name in the drawer immediately, long before the CLI writes its own.
// Returns '' on ANY failure (no token, offline, API refusal, empty output) so
// callers transparently fall back to the first-message truncation. Never throws.
export async function generateTitle(prompt) {
  const text = String(prompt || '').trim();
  if (text.length < 2) return '';
  const tok = oauthToken();
  if (!tok) return '';
  try {
    const model = await haikuModel();
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + tok,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 24,
        temperature: 0,
        system: [
          { type: 'text', text: CLAUDE_CODE_IDENTITY },
          { type: 'text', text: TITLER_INSTRUCTIONS },
        ],
        messages: [{ role: 'user', content: 'User request:\n' + text.slice(0, 2000) }],
      }),
    });
    if (!r.ok) return '';
    const j = await r.json();
    const out = Array.isArray(j.content)
      ? j.content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ')
      : '';
    return clean(out);
  } catch {
    return '';
  }
}

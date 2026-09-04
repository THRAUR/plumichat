// Password change for the HTTP Basic-auth lifeline.
//
// Credentials live ONLY in .env (the project's hard rule). This module is the
// single writer of AUTH_PASS: it persists the new value to .env atomically
// (temp-file + rename, chmod 600 preserved) AND hands it back to the caller so
// the running process can update its in-memory value — the new password takes
// effect immediately, no restart required. Secret values are never logged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '.env');

// Node's `--env-file` parser (verified empirically):
//   - unquoted values are trimmed and truncated at the first '#'
//   - double-quoted values keep spaces/'#'/backslashes but DON'T un-escape, and
//     end at the first '"'
//   - single-quoted values are literal and end at the first "'"
// So: wrap in double quotes when the value has no '"'; otherwise single quotes;
// reject the rare value containing both (and any line break).
function envQuote(v) {
  if (/[\r\n]/.test(v)) throw new Error('password cannot contain line breaks');
  if (!v.includes('"')) return '"' + v + '"';
  if (!v.includes("'")) return "'" + v + "'";
  throw new Error('password cannot contain both single and double quotes');
}

export function setEnvVar(key, rawValue) {
  const quoted = envQuote(rawValue); // throws on un-persistable values
  let text = '';
  try { text = fs.readFileSync(ENV_PATH, 'utf8'); } catch { /* will create */ }
  const line = key + '=' + quoted;
  const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=.*$', 'm');
  if (re.test(text)) text = text.replace(re, line);
  else text = text + (text && !text.endsWith('\n') ? '\n' : '') + line + '\n';
  const tmp = ENV_PATH + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, ENV_PATH);
  try { fs.chmodSync(ENV_PATH, 0o600); } catch { /* best effort */ }
}

// Validate, persist, then apply live. `currentPass` is the running in-memory
// password; `apply(next)` lets the caller update it without a restart.
export function changePassword({ current, next, confirm } = {}, { currentPass, apply }) {
  if (!currentPass) throw new Error('password change is unavailable — no password is set');
  if (!current) throw new Error('enter your current password');
  if (current !== currentPass) throw new Error('current password is incorrect');
  const n = String(next == null ? '' : next);
  if (n.length < 8) throw new Error('new password must be at least 8 characters');
  if (n.length > 128) throw new Error('new password is too long');
  if (confirm != null && n !== String(confirm)) throw new Error('passwords do not match');
  if (n === currentPass) throw new Error('new password must be different from the current one');
  setEnvVar('AUTH_PASS', n); // persist first; if this throws, live pass is unchanged
  if (typeof apply === 'function') apply(n); // take effect now
  return { ok: true };
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The apps that share PlumiChat's accounts — the registry behind single sign-on.
//
// Every site on this box answers on ONE hostname and differs only by port, and
// cookies are not port-scoped, so PlumiChat's session cookie is already sent to each
// app. That is what makes sign-on shared with no tokens to pass around: an app asks
// PlumiChat who the caller is (/api/sso/me) and PlumiChat reads its own cookie.
//
// The apps therefore never receive SESSION_SECRET. They can ask who you are; they
// cannot mint a session, so a bug in a small app can't forge a PlumiChat login.
//
// KNOWN TRADE-OFF (audit 2026-09-02, accepted for now): cookies are scoped by
// host, not by port, so every sister app's server RECEIVES the raw PlumiChat session
// cookie on each request — including the owner's. It cannot forge one, but it can
// REPLAY it against PlumiChat and act as that user for the cookie's lifetime. So the
// blast radius of a compromised sister app is "full PlumiChat access", not "knows who
// you are". The fix, when an app needs less trust than that: have /api/sso/me mint
// a short-lived, app-scoped, audience-bound token that PlumiChat alone can verify, and
// stop letting apps present the session cookie itself. That is a protocol change
// across every app, which is why it is not done here.
//
// Ports live in that config, hostnames do NOT: the origin is rebuilt from whatever host the
// request arrived on, so this keeps working over the tailnet name, a plain IP, or
// localhost without edits. Only ports listed here are accepted as SSO origins, and
// only these entries can be redirect targets — an unknown ?app= is ignored rather
// than followed, so there is no open redirect.

// Each app also carries the skin its login screen wears. Same flow, same fields,
// same server — it just arrives dressed as the app you tapped, so signing in never
// feels like being thrown out of the app you were using.
//
// The registry is DATA, not code: it lives in apps.config.json so that adding a
// sister app never means editing this file. It is EMPTY by default — a fresh
// install has no sister apps, and an empty registry means every SSO check below
// simply answers "not one of ours", which is the safe answer.
//
// Shape (see apps.config.example.json for a filled-in one):
//   { "<id>": { "name": "...", "tagline": "...", "port": 8446,
//               "brand": { ... }, "theme": { "dark": {...}, "light": {...} } } }
const CONFIG_CANDIDATES = [
  process.env.PLUMI_APPS_CONFIG,
  path.join(DATA_DIR, 'apps.config.json'),
  path.join(REPO_ROOT, 'apps.config.json'),
].filter(Boolean);

function loadApps() {
  for (const file of CONFIG_CANDIDATES) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let parsed;
    // A malformed registry must not take the server down on boot, and it must not
    // silently degrade to "no apps" either — SSO would start answering "not ours"
    // to apps that ARE ours. Log loudly, then carry on with an empty registry.
    try { parsed = JSON.parse(raw); } catch (err) {
      console.error(`[apps] ${file} is not valid JSON — SSO disabled:`, err.message);
      return {};
    }
    const out = {};
    for (const [id, app] of Object.entries(parsed)) {
      if (id.startsWith('_') || !app || typeof app !== 'object') continue; // '_' keys are comments
      const port = Number(app.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(`[apps] "${id}" has no usable port — skipped`);
        continue;
      }
      out[id.toLowerCase()] = { ...app, id: id.toLowerCase(), port };
    }
    if (Object.keys(out).length) console.log(`[apps] ${Object.keys(out).length} sister app(s) from ${file}`);
    return out;
  }
  return {};
}

const APPS = loadApps();

// Is single sign-on configured at all? The capability probe reports this, so the
// UI can say "no sister apps" instead of showing a dead surface.
export function ssoConfigured() { return Object.keys(APPS).length > 0; }

export function appById(id) {
  const key = String(id == null ? '' : id).toLowerCase();
  return Object.prototype.hasOwnProperty.call(APPS, key) ? APPS[key] : null;
}

// Where an app lives, as seen from the same host this request arrived on. `hostHeader`
// may carry a port (PlumiChat's own) — drop it and use the app's.
function appOrigin(app, hostHeader, secure) {
  const hostname = String(hostHeader || '').split(':')[0];
  if (!hostname) return null;
  return (secure ? 'https' : 'http') + '://' + hostname + ':' + app.port;
}

// What the login screen needs: who it's dressing up as, and where to go afterwards.
export function appLoginContext(id, hostHeader, secure) {
  const app = appById(id);
  if (!app) return null;
  const origin = appOrigin(app, hostHeader, secure);
  if (!origin) return null;
  return { id: app.id, name: app.name, tagline: app.tagline, returnUrl: origin + '/', brand: app.brand, theme: app.theme };
}

// Is this browser Origin one of our apps? Same hostname as the request (so a
// look-alike host can't ask) plus a port we published. Returns the app or null.
export function appForOrigin(origin, hostHeader) {
  if (!origin || origin === 'null') return null;
  let u;
  try { u = new URL(origin); } catch { return null; }
  const hostname = String(hostHeader || '').split(':')[0];
  if (!hostname || u.hostname !== hostname) return null;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return Object.values(APPS).find((a) => String(a.port) === port) || null;
}

// Accounts — real per-person users, single-use invites, and the credential
// (email + 6-digit PIN) behind them. This is what turns PlumiChat from one
// machine-wide login into named accounts.
//
// Model:
//   - The PIN is each account's credential (their "password"); we store only its
//     salted scrypt hash on the user record — never the PIN, never in .env.
//   - The FIRST account created becomes the `owner` (bootstrap, no invite). Every
//     later account needs a valid single-use invite and becomes a `member`.
//   - owner/admin home = the workspace root (sees every project). Each member is
//     locked into a private home (<root>/.users/<id>) — enforced in sandbox.js.
//   - Email (lowercased) is the login lookup key and is unique across accounts.
import crypto from 'node:crypto';
import { spendByUser } from './spend.js';
import path from 'node:path';
import { read, update } from './store.js';
import { hashPin, verifyPin, PIN_RE, resetWebauthn } from './auth.js';
import { userHome, ensureDir, MEMBERS_DIRNAME } from './sandbox.js';

const USERS = 'users';
const INVITES = 'invites';

// Invites expire. A link is a bearer credential that mints an account on this
// box, and one pasted into a chat months ago must not still work; 7 days is long
// enough to hand someone a phone and short enough to forget safely.
const DEFAULT_INVITE_TTL_DAYS = 7;

const newId = () => crypto.randomBytes(5).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const now = () => new Date().toISOString();
const emailKey = (e) => String(e || '').trim().toLowerCase();

/* ------------------------------- helpers -------------------------------- */
// Strip C0 control characters, collapse whitespace, trim, and cap length —
// keeps letters/spaces/hyphens/apostrophes/accents so "Jean-Paul" and
// "Van Der Berg" survive intact. (Display code still escapes on render.)
function cleanName(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}
function initialsOf(first, last) {
  const a = (cleanName(first)[0] || '');
  const b = (cleanName(last)[0] || '');
  const out = (a + b) || (cleanName(first).slice(0, 2)) || 'U';
  return out.toUpperCase();
}
function roleLabel(role) {
  if (role === 'owner') return 'Owner · Workspace admin';
  if (role === 'admin') return 'Admin';
  return 'Member';
}
function isAdminRole(role) { return role === 'owner' || role === 'admin'; }

function validateNames(first, last) {
  if (!cleanName(first)) throw new Error('enter your first name');
  if (!cleanName(last)) throw new Error('enter your last name');
}
function validateEmail(email, { exceptId } = {}) {
  const e = String(email || '').trim();
  // Deliberately lenient (we can't verify deliverability): one @, a dot after it.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('enter a valid email address');
  const k = emailKey(e);
  const clash = listUsers().find((u) => u.emailKey === k && u.id !== exceptId);
  if (clash) throw new Error('an account with that email already exists');
  return e;
}

// Strip the secret (pinHash) before anything leaves this module.
export function publicUser(u) {
  if (!u) return null;
  const { pinHash, ...rest } = u;
  return rest;
}

/* -------------------------------- reads --------------------------------- */
export function listUsers() { return read(USERS, []); }
export function userCount() { return listUsers().length; }
export function bootstrapNeeded() { return userCount() === 0; }
export function findById(id) { return listUsers().find((u) => u.id === id) || null; }
export function findByEmail(email) { const k = emailKey(email); return listUsers().find((u) => u.emailKey === k) || null; }
export function ownerUser() { const us = listUsers(); return us.find((u) => u.role === 'owner') || us[0] || null; }
export function isAdmin(user) { return !!user && isAdminRole(user.role); }
// May this account power off the whole Windows box? The owner always can; anyone
// else only if the owner has explicitly granted it (per-account `canPowerOff`).
export function canPowerOff(user) { return !!user && (user.role === 'owner' || user.canPowerOff === true); }

/* ----------------------------- registration ----------------------------- */
// Create an account. The first account is the owner (no invite needed); later
// ones require a valid single-use invite and become members. Returns public user.
export async function registerUser({ invite, firstName, lastName, email, pin } = {}) {
  validateNames(firstName, lastName);
  const cleanEmail = validateEmail(email);
  if (!PIN_RE.test(String(pin || ''))) throw new Error('passcode must be exactly 6 digits');

  let role = 'owner';
  let inv = null;
  if (!bootstrapNeeded()) {
    inv = findInvite(invite);
    if (!inv || inv.used || inviteExpired(inv)) {
      throw new Error('this invite link is invalid, expired, or has already been used');
    }
    // Compare lowercased: older records (and any hand-edited invites.json) may
    // hold the UI's 'Admin' label rather than the internal role.
    role = String(inv.role || '').toLowerCase() === 'admin' ? 'admin' : 'member';
  }

  const id = newId();
  const first = cleanName(firstName);
  const last = cleanName(lastName);
  const user = {
    id,
    firstName: first,
    lastName: last,
    name: (first + ' ' + last).trim(),
    email: cleanEmail,
    emailKey: emailKey(cleanEmail),
    role,
    pinHash: await hashPin(pin),
    homeRel: role === 'member' ? `${MEMBERS_DIRNAME}/${id}` : '',
    initials: initialsOf(first, last),
    status: 'active',
    createdAt: now(),
  };

  // Create the account's home (and, for members, a starter project so the
  // picker isn't empty and they can begin immediately).
  try {
    const home = userHome(user);
    ensureDir(home);
    if (role === 'member') ensureDir(path.join(home, 'My First Project'));
  } catch (err) {
    throw new Error('could not create your workspace folder: ' + err.message);
  }

  update(USERS, (list) => { list.push(user); return list; }, []);
  if (inv) consumeInvite(inv.token, id); // burn the single-use invite
  return publicUser(user);
}

/* -------------------------------- login --------------------------------- */
// Look up by email and verify the PIN. Generic error avoids leaking which half
// was wrong (the link is shareable across a tailnet).
export async function loginUser({ email, pin } = {}) {
  const user = findByEmail(email);
  const okPin = user && await verifyPin(pin, user.pinHash);
  if (!user || !okPin) throw new Error('incorrect email or passcode');
  return publicUser(user);
}

/* ------------------------------ PIN change ------------------------------ */
export async function changeUserPin(userId, { current, next } = {}) {
  const rec = findById(userId);
  if (!rec) throw new Error('account not found');
  if (!await verifyPin(current, rec.pinHash)) throw new Error('current passcode is incorrect');
  if (!PIN_RE.test(String(next || ''))) throw new Error('new passcode must be exactly 6 digits');
  if (String(current) === String(next)) throw new Error('new passcode must be different');
  const h = await hashPin(next);
  // Bump the session version so every cookie issued under the OLD passcode stops
  // validating — a passcode change logs out all other devices. The caller's own
  // new cookie is re-issued at the new version by the route.
  update(USERS, (list) => {
    const u = list.find((x) => x.id === userId);
    if (u) { u.pinHash = h; u.sv = (u.sv || 0) + 1; }
    return list;
  }, []);
  return { ok: true, sv: (rec.sv || 0) + 1 };
}

// Current session version for an account (0 if never bumped). A session cookie
// carries the version it was minted at; a mismatch means it predates a passcode
// change and must be rejected. See server/auth.js + currentUser in index.js.
export function userSessionVersion(userId) {
  const u = findById(userId);
  return u ? (u.sv || 0) : 0;
}

/* ------------------------------- profile -------------------------------- */
// The Settings "Profile" view, scoped to one account.
export function profileView(user) {
  const u = findById(user && user.id) || user || {};
  return {
    id: u.id,
    firstName: u.firstName || '',
    lastName: u.lastName || '',
    name: u.name || 'You',
    email: u.email || '',
    role: roleLabel(u.role),
    initials: u.initials || 'U',
    avatar: u.avatar || null,
    isAdmin: isAdminRole(u.role),
    isOwner: u.role === 'owner',
    canPowerOff: u.role === 'owner' || !!u.canPowerOff,
    chatDefaults: chatDefaultsOf(u),
  };
}

/* ---------------------- per-account chat defaults ----------------------- */
// Model, effort and approval mode used to be remembered in localStorage, which
// made them per-DEVICE and per-browser: the same person got Opus on their Mac
// and whatever the phone last saw on the phone, and a split-view pane (a
// separate document) started from scratch again. They belong to the ACCOUNT, so
// one choice follows you onto every device and into every pane.
//
// '' means "no preference — fall back to the workspace/server default", which is
// the same convention settings.js uses for defaultModel.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERM_MODES = ['default', 'acceptEdits', 'bypassPermissions'];
// This stores the client's SELECTION KEY, not the raw engine id, because that is
// what identifies a choice in the picker: a model the server marks ctx1m gets a
// "1M context" twin whose key is `<id>#1m`, and the two share one engine id. So
// '#' is allowed here where settings.js's defaultModel — which really is an
// engine id — does not allow it. Still never a display label ('Sonnet 4.6').
const MODEL_ID_RE = /^[a-z0-9._#[\]-]+$/;

// A member's turn is forced to 'default' in /api/chat, because acceptEdits and
// bypass make the SDK skip canUseTool — which IS the confinement. Storing a
// relaxed default for one would be a promise the server will not keep, so it is
// clamped on the way in as well as at the turn.
//
// Reading is TOLERANT and writing is STRICT, deliberately. A stored value that
// is no longer recognised (a hand-edited file, a mode we stopped supporting)
// must read as the safe one rather than break the whole profile — but a WRITE
// carrying an unknown mode is a bug in the caller, and quietly resolving it to
// 'default' would silently wipe a setting the person had chosen. Reject it.
function readPerm(mode, user) {
  if (!PERM_MODES.includes(mode)) return 'default';
  return isAdminRole(user && user.role) ? mode : 'default';
}
export function chatDefaultsOf(user) {
  const d = (user && user.chatDefaults) || {};
  return {
    model: typeof d.model === 'string' ? d.model : '',
    effort: EFFORTS.includes(d.effort) ? d.effort : '',
    fastMode: !!d.fastMode,
    context1m: !!d.context1m,
    permissionMode: readPerm(d.permissionMode, user),
  };
}
export function updateUserDefaults(userId, patch = {}) {
  const rec = findById(userId);
  if (!rec) throw new Error('account not found');
  const cur = chatDefaultsOf(rec);
  const next = { ...cur };

  if (patch.model != null) {
    const m = String(patch.model).trim();
    if (m && (m.length > 80 || !MODEL_ID_RE.test(m))) throw new Error('not a model id');
    next.model = m;
  }
  if (patch.effort != null) {
    const e = String(patch.effort).trim();
    if (e && !EFFORTS.includes(e)) throw new Error('unknown effort level');
    next.effort = e;
  }
  if (patch.fastMode != null) next.fastMode = !!patch.fastMode;
  if (patch.context1m != null) next.context1m = !!patch.context1m;
  if (patch.permissionMode != null) {
    const pm = String(patch.permissionMode);
    if (!PERM_MODES.includes(pm)) throw new Error('unknown approval mode');
    next.permissionMode = readPerm(pm, rec);   // still clamped for a member
  }

  update(USERS, (list) => {
    const u = list.find((x) => x.id === userId);
    if (u) u.chatDefaults = next;
    return list;
  }, []);
  return chatDefaultsOf(findById(userId));
}

/* -------------------------------- avatar -------------------------------- */
// Avatars are stored inline as a small data URL on the user record (the client
// downscales to ~256px JPEG first, so this stays tiny — a few tens of KB).
export function updateUserAvatar(userId, dataUrl) {
  const rec = findById(userId);
  if (!rec) throw new Error('account not found');
  const s = String(dataUrl || '');
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) throw new Error('unsupported image format');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length < 32) throw new Error('image looks empty');
  if (bytes.length > 300 * 1024) throw new Error('image is too large — pick a smaller one');
  update(USERS, (list) => { const u = list.find((x) => x.id === userId); if (u) u.avatar = s; return list; }, []);
  return profileView(findById(userId));
}
export function removeUserAvatar(userId) {
  const rec = findById(userId);
  if (!rec) throw new Error('account not found');
  update(USERS, (list) => { const u = list.find((x) => x.id === userId); if (u) u.avatar = null; return list; }, []);
  return profileView(findById(userId));
}

export function updateUserProfile(userId, patch = {}) {
  const rec = findById(userId);
  if (!rec) throw new Error('account not found');
  const first = patch.firstName != null ? cleanName(patch.firstName) : rec.firstName;
  const last = patch.lastName != null ? cleanName(patch.lastName) : rec.lastName;
  if (patch.firstName != null && !first) throw new Error('first name cannot be empty');
  if (patch.lastName != null && !last) throw new Error('last name cannot be empty');
  let email = rec.email;
  if (patch.email != null && emailKey(patch.email) !== rec.emailKey) {
    email = validateEmail(patch.email, { exceptId: userId });
  }
  update(USERS, (list) => {
    const u = list.find((x) => x.id === userId);
    if (u) {
      u.firstName = first; u.lastName = last;
      u.name = (first + ' ' + last).trim() || u.name;
      u.email = email; u.emailKey = emailKey(email);
      u.initials = initialsOf(first, last);
    }
    return list;
  }, []);
  return profileView(findById(userId));
}

/* ------------------------------- members -------------------------------- */
// The Settings "Members" list — every account, mapped to the UI's shape. `you`
// marks the viewer's own row.
export function membersView(currentUserId) {
  // Real figures now (they were hard-coded zeros while nothing metered spend).
  // `cost` is the SDK's estimate of API-equivalent cost, not a bill — the label
  // that says so lives with the number in settings.html.
  const spend = spendByUser();
  return listUsers().map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role === 'member' ? 'Member' : (u.role === 'owner' ? 'Owner' : 'Admin'),
    status: u.status || 'active',
    initials: u.initials,
    avatar: u.avatar || null,
    you: u.id === currentUserId,
    canPowerOff: u.role === 'owner' ? true : !!u.canPowerOff,
    tokens: (spend[u.id] || {}).tokens || 0,
    cost: (spend[u.id] || {}).usd || 0,
    requests: (spend[u.id] || {}).turns || 0,
    createdAt: u.createdAt,
  }));
}

// Grant or revoke the "power off the whole PC" capability for one account.
// Owner-only — the owner alone decides who, besides themselves, may shut the
// machine down. The owner always has it implicitly, so it can't be toggled off.
export function setPowerOff(actor, id, allowed) {
  if (!actor || actor.role !== 'owner') throw new Error('only the owner can grant power-off access');
  const rec = findById(id);
  if (!rec) throw new Error('account not found');
  if (rec.role === 'owner') throw new Error('the owner always has power-off access');
  update(USERS, (list) => { const u = list.find((x) => x.id === id); if (u) u.canPowerOff = !!allowed; return list; }, []);
  return { ok: true, id, canPowerOff: !!allowed };
}

// Remove an account (admin only; never the owner, never yourself). The folder is
// intentionally LEFT on disk so a member's work is never destroyed by a click.
export function removeUser(actor, id) {
  if (!isAdmin(actor)) throw new Error('only an admin can remove members');
  const rec = findById(id);
  if (!rec) throw new Error('member not found');
  if (rec.role === 'owner') throw new Error('the owner account cannot be removed');
  if (actor.id === id) throw new Error('you cannot remove yourself');
  update(USERS, (list) => list.filter((x) => x.id !== id), []);
  // Their credentials must not outlive the account. A leftover passkey still
  // authenticates and resolves to a dangling id, and an unused invite they
  // created is a live door into the workspace signed by someone who no longer
  // exists. Spent invites stay: those are history, not doors.
  try { resetWebauthn(id); } catch { /* a store hiccup must not undo the removal */ }
  update(INVITES, (list) => list.filter((i) => !(i.createdBy === id && !i.used)), []);
  return { ok: true, keptFolder: rec.homeRel || null };
}

/* ------------------------------- invites -------------------------------- */
export function listInvites() { return read(INVITES, []); }
function findInvite(token) { if (!token) return null; return listInvites().find((i) => i.token === String(token)) || null; }

// How long a new invite lives. `ttlDays` (per-invite) beats PLUMI_INVITE_TTL_DAYS
// (per-box) beats 7. Clamped to a year so a fat-fingered value isn't "forever".
function inviteTtlDays(override) {
  const n = Number(override != null && override !== '' ? override : process.env.PLUMI_INVITE_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : DEFAULT_INVITE_TTL_DAYS;
}

// Single-use invite. Admin-only. Returns the raw token (the caller builds the URL).
export function createInvite(actor, { role = 'member', ttlDays } = {}) {
  if (!isAdmin(actor)) throw new Error('only an admin can create invites');
  // The Settings UI sends the display label ('Admin'), not the internal role, so
  // a case-sensitive compare silently downgraded every admin invite to a member.
  const wantsAdmin = String(role || '').trim().toLowerCase() === 'admin';
  const inv = {
    token: newToken(),
    role: wantsAdmin ? 'admin' : 'member',
    createdBy: actor.id,
    used: false,
    usedBy: null,
    createdAt: now(),
    expiresAt: new Date(Date.now() + inviteTtlDays(ttlDays) * 86400000).toISOString(),
    usedAt: null,
  };
  update(INVITES, (list) => { list.push(inv); return list; }, []);
  return inv;
}

// Invites minted before expiry existed carry no expiresAt. Treat those as
// unexpired rather than dead: revoking a link someone is mid-signup with would
// be a worse surprise than one extra legacy invite an admin can revoke by hand.
function inviteExpired(i) { return !!(i && i.expiresAt && Date.parse(i.expiresAt) <= Date.now()); }

// True if the token exists, hasn't been spent, and hasn't expired — drives the
// register screen.
export function inviteIsValid(token) {
  const i = findInvite(token);
  return !!(i && !i.used && !inviteExpired(i));
}

function consumeInvite(token, byUserId) {
  update(INVITES, (list) => {
    const i = list.find((x) => x.token === token);
    if (i && !i.used) { i.used = true; i.usedBy = byUserId; i.usedAt = now(); }
    return list;
  }, []);
}

export function revokeInvite(actor, token) {
  if (!isAdmin(actor)) throw new Error('only an admin can revoke invites');
  const i = findInvite(token);
  if (!i) throw new Error('invite not found');
  if (i.used) throw new Error('that invite was already used');
  update(INVITES, (list) => list.filter((x) => x.token !== token), []);
  return { ok: true };
}

// Pending invites, newest first — for the Settings members panel. Expired ones
// are omitted: "pending" has to mean "still hands out an account", and an expired
// link needs no revoking because inviteIsValid already refuses it.
// CONTRACT: entries are { token, role, createdAt, expiresAt }.
export function pendingInvites(actor) {
  if (!isAdmin(actor)) return [];
  return listInvites()
    .filter((i) => !i.used && !inviteExpired(i))
    .sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1))
    .map((i) => ({ token: i.token, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt || null }));
}

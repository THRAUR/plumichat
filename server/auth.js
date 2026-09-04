// PlumiChat auth — a 6-digit unlock PIN, signed stateless sessions, and
// account-bound WebAuthn passkeys. This layers on TOP of the existing HTTP
// Basic-auth lifeline (server/index.js still accepts Basic as a fallback), so a
// bug here can never lock the box out — the old password path keeps working.
//
// Secrets rule (project-wide): anything secret lives ONLY in .env. So the PIN is
// stored as a scrypt hash (AUTH_PIN_HASH) and the cookie-signing key as
// SESSION_SECRET, both written via credentials.js's atomic .env writer. The
// WebAuthn store holds only PUBLIC keys + counters, so it lives in the JSON store.
import crypto from 'node:crypto';
import { read, update } from './store.js';
import { setEnvVar } from './credentials.js';

/* ============================ session secret ============================ */
// Generated once and persisted to .env so signed cookies survive restarts.
function sessionSecret() {
  let s = process.env.SESSION_SECRET;
  if (!s) {
    s = crypto.randomBytes(32).toString('base64url');
    try { setEnvVar('SESSION_SECRET', s); } catch { /* read-only .env → in-memory only */ }
    process.env.SESSION_SECRET = s;
  }
  return s;
}

/* ================================= PIN ================================== */
// Per-account PIN crypto primitives. The PIN IS each user's credential (their
// "password"); the salted scrypt hash is stored on the user record in
// data/users.json — never in .env. The old single global .env PIN is retired now
// that accounts are real (see server/users.js).
export const PIN_RE = /^\d{6}$/;

// Hash a 6-digit PIN with a fresh random salt. Async: scrypt is deliberately
// CPU-heavy (that's the point), so we use the libuv-threadpool variant instead of
// scryptSync, which would block the single event loop for the whole hash. Rejects
// only on a crypto failure; throws synchronously if the PIN isn't 6 digits.
// Returns a Promise<string> ("scrypt$<salt>$<hash>").
export function hashPin(pin) {
  if (!PIN_RE.test(String(pin || ''))) throw new Error('passcode must be exactly 6 digits');
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), salt, 32, (err, dk) => {
      if (err) return reject(err);
      resolve('scrypt$' + salt.toString('base64') + '$' + dk.toString('base64'));
    });
  });
}

// Constant-time verify of a PIN against a stored scrypt hash. Async for the same
// reason as hashPin. Returns a Promise<boolean> and never rejects (any error →
// false), so callers can `await` it directly in an if-condition.
export function verifyPin(pin, stored) {
  if (!PIN_RE.test(String(pin || ''))) return Promise.resolve(false);
  const [scheme, saltB64, hashB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return Promise.resolve(false);
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  return new Promise((resolve) => {
    crypto.scrypt(String(pin), salt, expected.length, (err, dk) => {
      if (err) return resolve(false);
      resolve(dk.length === expected.length && crypto.timingSafeEqual(dk, expected));
    });
  });
}

/* =============================== sessions =============================== */
// Stateless: cookie value is base64url(payload).hmac. No server-side store, so
// it survives restarts as long as SESSION_SECRET is stable (it's in .env).
export const SESSION_COOKIE = 'plumi_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hmac(data) { return crypto.createHmac('sha256', sessionSecret()).update(data).digest('base64url'); }

// Issue a session bound to a user id (`sub`). Stateless: the id rides inside the
// signed payload, so the server learns *who* you are from the cookie alone.
export function issueSession(sub, sv) {
  const payload = Buffer.from(JSON.stringify({ sub: sub || null, sv: sv || 0, iat: Date.now(), exp: Date.now() + SESSION_TTL_MS }))
    .toString('base64url');
  return payload + '.' + hmac(payload);
}

// The longest cookie we will even look at. A real token is ~140 bytes (a small
// JSON payload plus a 43-char HMAC); browsers cap a whole cookie header near 4 KB
// anyway. Anything larger is not ours, so reject it BEFORE hashing — an HMAC over
// a megabyte of attacker-supplied text is free work on the single event loop that
// also streams every chat turn.
const MAX_SESSION_TOKEN = 4096;

// Verify signature + expiry; returns the decoded payload ({sub,iat,exp}) or null.
export function sessionPayload(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  if (token.length > MAX_SESSION_TOKEN) return null;
  const idx = token.indexOf('.');
  const payload = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expect = hmac(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof o.exp === 'number' && o.exp > Date.now()) return o;
    return null;
  } catch { return null; }
}

export function sessionCookie(token, { secure } = {}) {
  const parts = [
    SESSION_COOKIE + '=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax', // NOT Strict: the SSO redirect to a sister app is a cross-site
                    // navigation, and Strict would drop the cookie on arrival.
    'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
    'Priority=High', // survive Chrome's cookie eviction — losing this is a logout
  ];
  if (secure) parts.push('Secure'); // only over HTTPS — a Secure cookie isn't sent over plain HTTP
  return parts.join('; ');
}

export function clearedCookie() {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

/* ============================== WebAuthn =============================== */
// Per-account passkeys. We store only public material, tagged with the owning
// user id:  { id(base64url), userId, publicKeyJwk, signCount, createdAt }
// Real platform authenticators (Face ID / Touch ID / Windows Hello) all support
// ES256 (alg -7, P-256), so that's all we accept — keeps the verifier small.
//
// NOTE: WebAuthn only runs in a secure context (HTTPS) with a hostname RP ID
// (not a bare IP). Over plain-HTTP tailnet access the browser disables it; the
// server code below is host-aware and works as soon as HTTPS + a hostname are in
// place (e.g. a reverse proxy, or a `tailscale serve` HTTPS front end).
const WA_STORE = 'webauthn';

// Pass a userId to scope to that account; omit for all credentials (login lookup).
// Legacy records (pre-multi-user, no userId) are ignored when a userId is given.
export function listCredentials(userId) {
  const all = read(WA_STORE, []);
  return userId ? all.filter((c) => c.userId === userId) : all;
}
export function webauthnEnrolled(userId) { return listCredentials(userId).length > 0; }
export function resetWebauthn(userId) {
  if (userId) update(WA_STORE, (list) => list.filter((c) => c.userId !== userId), []);
  else update(WA_STORE, () => [], []);
  return { ok: true };
}
// Remove a single passkey, but only if it belongs to the caller.
export function removeCredential(userId, id) {
  let found = false;
  update(WA_STORE, (list) => list.filter((c) => {
    const drop = c.id === id && c.userId === userId;
    if (drop) found = true;
    return !drop;
  }), []);
  if (!found) throw new Error('passkey not found');
  return { ok: true };
}

// Short-lived challenges, in-memory (single-process server). Client echoes the
// `cid` back so we can match the exact challenge it signed.
const challenges = new Map();
function newChallenge() {
  const challenge = crypto.randomBytes(32).toString('base64url');
  const cid = crypto.randomBytes(12).toString('base64url');
  challenges.set(cid, { challenge, exp: Date.now() + 120000 });
  return { cid, challenge };
}
function takeChallenge(cid) {
  const c = challenges.get(cid);
  challenges.delete(cid);
  if (!c || c.exp < Date.now()) return null;
  return c.challenge;
}
// Opportunistic GC so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
}, 60000).unref?.();

export function registrationOptions({ rpId, rpName, user }) {
  const { cid, challenge } = newChallenge();
  const acct = user || { id: 'plumi', email: 'plumi', name: 'PlumiChat' };
  // The WebAuthn user handle must be stable per account so platform keychains
  // group/replace keys correctly — derive it from the account id.
  const handle = crypto.createHash('sha256').update(String(acct.id)).digest().toString('base64url');
  return {
    cid,
    publicKey: {
      challenge,
      rp: { id: rpId, name: rpName || 'PlumiChat' },
      user: { id: handle, name: acct.email || acct.name || 'user', displayName: acct.name || acct.email || 'PlumiChat' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60000,
      attestation: 'none',
      excludeCredentials: listCredentials(acct.id).map((c) => ({ type: 'public-key', id: c.id })),
    },
  };
}

export function verifyRegistration({ cid, clientDataJSON, attestationObject }, { rpId, origin, userId }) {
  const expected = takeChallenge(cid);
  if (!expected) throw new Error('challenge expired — try again');
  const clientData = JSON.parse(b64uField('clientDataJSON', clientDataJSON).toString());
  if (clientData.type !== 'webauthn.create') throw new Error('unexpected clientData type');
  if (clientData.challenge !== expected) throw new Error('challenge mismatch');
  if (!originAllowed(clientData.origin, rpId)) throw new Error('origin not allowed');

  const att = cborRead(b64uField('attestationObject', attestationObject), 0).value;
  // A crafted blob can decode to any CBOR type at all, so never assume the Map.
  if (!(att instanceof Map)) throw new Error('malformed attestation object');
  const authData = att.get('authData');
  if (!Buffer.isBuffer(authData)) throw new Error('malformed attestation object');
  const a = parseAuthData(authData);
  if (!rpIdHashOk(a.rpIdHash, rpId)) throw new Error('rpId hash mismatch');
  if (!(a.flags & 0x01)) throw new Error('user not present');
  if (!(a.flags & 0x04)) throw new Error('user verification required');
  if (!a.credentialId || !a.cosePublicKey) throw new Error('no attested credential data');

  const jwk = coseToJwk(a.cosePublicKey);
  const id = Buffer.from(a.credentialId).toString('base64url');
  update(WA_STORE, (list) => {
    if (!list.find((c) => c.id === id)) {
      list.push({ id, userId: userId || null, publicKeyJwk: jwk, signCount: a.signCount, createdAt: new Date().toISOString() });
    }
    return list;
  }, []);
  return { ok: true, id };
}

// Pass a userId to offer only that account's passkeys (after the email is known);
// omit it for a usernameless prompt over all enrolled resident keys.
export function authenticationOptions({ rpId, userId }) {
  const { cid, challenge } = newChallenge();
  return {
    cid,
    publicKey: {
      challenge,
      rpId,
      allowCredentials: listCredentials(userId).map((c) => ({ type: 'public-key', id: c.id })),
      userVerification: 'required',
      timeout: 60000,
    },
  };
}

export function verifyAuthentication({ cid, id, clientDataJSON, authenticatorData, signature }, { rpId }) {
  const expected = takeChallenge(cid);
  if (!expected) throw new Error('challenge expired — try again');
  const cred = listCredentials().find((c) => c.id === id);
  if (!cred) throw new Error('unrecognised passkey');
  // Decode once and reuse: the same bytes are both parsed as JSON and hashed
  // into the signed blob, and decoding twice would apply the size cap twice for
  // no reason (and risk the two copies drifting apart).
  const clientDataBuf = b64uField('clientDataJSON', clientDataJSON);
  const clientData = JSON.parse(clientDataBuf.toString());
  if (clientData.type !== 'webauthn.get') throw new Error('unexpected clientData type');
  if (clientData.challenge !== expected) throw new Error('challenge mismatch');
  if (!originAllowed(clientData.origin, rpId)) throw new Error('origin not allowed');

  const authData = b64uField('authenticatorData', authenticatorData);
  const a = parseAuthData(authData);
  if (!rpIdHashOk(a.rpIdHash, rpId)) throw new Error('rpId hash mismatch');
  if (!(a.flags & 0x01)) throw new Error('user not present');
  if (!(a.flags & 0x04)) throw new Error('user verification required');

  const clientHash = crypto.createHash('sha256').update(clientDataBuf).digest();
  const signed = Buffer.concat([authData, clientHash]);
  const pub = crypto.createPublicKey({ key: cred.publicKeyJwk, format: 'jwk' });
  const ok = crypto.verify('sha256', signed, pub, b64uField('signature', signature)); // ES256 → DER sig
  if (!ok) throw new Error('signature verification failed');

  // Clone detection: a non-zero counter must strictly increase.
  if (a.signCount !== 0 || cred.signCount !== 0) {
    if (a.signCount <= cred.signCount) throw new Error('passkey counter regressed (possible clone)');
  }
  update(WA_STORE, (list) => { const c = list.find((x) => x.id === id); if (c) c.signCount = a.signCount; return list; }, []);
  return { ok: true, userId: cred.userId || null };
}

/* --------- WebAuthn binary helpers (CBOR subset + COSE→JWK + authData) --------- */
// THREAT MODEL for everything below: these bytes arrive from a browser on the
// passkey routes, which any *authenticated* user can reach — and authenticated is
// not trusted (members are the whole reason confinement exists). Worse, this is
// the single-threaded event loop that also streams every chat turn, so an
// unbounded loop or allocation here is a machine-wide outage, not one bad request.
// Hence: every read is bounds-checked, every declared length is capped against
// what actually remains in the buffer, and recursion is capped.

// Generous ceilings on the base64url blobs the client posts. With
// attestation:'none' a real attestationObject is a few hundred bytes, so these
// are ~50× what any genuine authenticator sends — they can only ever reject an
// attack. Capping HERE means the CBOR reader's work is bounded before it starts.
const MAX_B64 = {
  clientDataJSON: 8 * 1024,
  attestationObject: 32 * 1024,
  authenticatorData: 8 * 1024,
  signature: 4 * 1024,
};

// Decode one named base64url field, refusing anything oversized or non-string.
function b64uField(field, value) {
  if (typeof value !== 'string' || !value) throw new Error('missing ' + field);
  if (value.length > (MAX_B64[field] || 4096)) throw new Error(field + ' is too large');
  return Buffer.from(value, 'base64url');
}

// Deepest nesting we will follow. Real attestation is 2–3 levels
// (map → authData → COSE map); 8 is slack, and it stops a byte string of nothing
// but 0x81 ("array of 1") from recursing us into a stack overflow.
const CBOR_MAX_DEPTH = 8;

// Assert `n` more bytes exist at `off`. Every read goes through this, so a
// truncated blob throws a clean Error instead of silently yielding `undefined`
// (which the old reader turned into count=NaN and a corrupt-but-accepted parse).
function cborNeed(buf, off, n) {
  if (!(off >= 0) || !(n >= 0) || off + n > buf.length) throw new Error('cbor: truncated input');
}

// Minimal CBOR reader: unsigned/negative ints, byte/text strings, arrays, maps.
// Sufficient for attestationObject + COSE keys. Returns { value, off }.
function cborRead(buf, off, depth = 0) {
  if (depth > CBOR_MAX_DEPTH) throw new Error('cbor: nesting too deep');
  cborNeed(buf, off, 1);
  const first = buf[off];
  const major = first >> 5;
  const minor = first & 0x1f;
  // Reject the major types we do not implement (6 = tag, 7 = simple/float)
  // BEFORE reading a length, so an unsupported header can never drive any work.
  if (major > 5) throw new Error('cbor: unsupported major type ' + major);

  let p = off + 1;
  let count = minor;
  if (minor === 24) { cborNeed(buf, p, 1); count = buf[p]; p += 1; }
  else if (minor === 25) { cborNeed(buf, p, 2); count = buf.readUInt16BE(p); p += 2; }
  else if (minor === 26) { cborNeed(buf, p, 4); count = buf.readUInt32BE(p); p += 4; }
  else if (minor === 27) { cborNeed(buf, p, 8); count = Number(buf.readBigUInt64BE(p)); p += 8; }
  else if (minor > 27) throw new Error('cbor: bad length'); // 28–30 reserved, 31 indefinite

  switch (major) {
    case 0: return { value: count, off: p };
    case 1: return { value: -1 - count, off: p };
    case 2: cborNeed(buf, p, count); return { value: buf.subarray(p, p + count), off: p + count };
    case 3: cborNeed(buf, p, count); return { value: buf.subarray(p, p + count).toString('utf8'), off: p + count };
    case 4: {
      // Every element costs at least one byte, so a count bigger than what
      // remains is a lie. This is the DoS fix: the old reader would happily
      // loop 2^32 times on a 4-byte header and wedge the whole server.
      if (count > buf.length - p) throw new Error('cbor: array longer than input');
      const arr = []; let q = p;
      for (let i = 0; i < count; i++) { const r = cborRead(buf, q, depth + 1); arr.push(r.value); q = r.off; }
      return { value: arr, off: q };
    }
    case 5: {
      // A map entry is a key AND a value, so it costs at least two bytes.
      if (count > (buf.length - p) / 2) throw new Error('cbor: map longer than input');
      const m = new Map(); let q = p;
      for (let i = 0; i < count; i++) { const k = cborRead(buf, q, depth + 1); const v = cborRead(buf, k.off, depth + 1); m.set(k.value, v.value); q = v.off; }
      return { value: m, off: q };
    }
    default: throw new Error('cbor: unsupported major type ' + major);
  }
}

// authData layout: rpIdHash(32) flags(1) signCount(4) [AAGUID(16) credIdLen(2)
// credId(credIdLen) COSEkey(rest)]. Bounds-checked for the same reason as the
// CBOR reader — credIdLen is attacker-chosen and used as a slice length.
function parseAuthData(buf) {
  if (!buf || buf.length < 37) throw new Error('authData too short');
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32];
  const signCount = buf.readUInt32BE(33);
  let credentialId = null;
  let cosePublicKey = null;
  if (flags & 0x40) { // AT — attested credential data present
    if (buf.length < 55) throw new Error('authData too short for attested credential data');
    const credIdLen = buf.readUInt16BE(53); // skip 16-byte AAGUID (37..53)
    // subarray() silently CLAMPS an over-long end, which would hand us a
    // credential id shorter than declared and leave the COSE key read pointing
    // past the buffer. Refuse instead of guessing.
    if (55 + credIdLen > buf.length) throw new Error('authData credential id overruns the buffer');
    credentialId = buf.subarray(55, 55 + credIdLen);
    cosePublicKey = cborRead(buf, 55 + credIdLen).value;
  }
  return { rpIdHash, flags, signCount, credentialId, cosePublicKey };
}

function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw new Error('malformed COSE key');
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty !== 2) throw new Error('unsupported key type (need EC2)');
  if (alg !== -7) throw new Error('unsupported algorithm (need ES256)');
  if (cose.get(-1) !== 1) throw new Error('unsupported curve (need P-256)');
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (!x || !y) throw new Error('malformed EC key');
  return { kty: 'EC', crv: 'P-256', x: Buffer.from(x).toString('base64url'), y: Buffer.from(y).toString('base64url') };
}

function rpIdHashOk(hash, rpId) {
  const expect = crypto.createHash('sha256').update(rpId).digest();
  return hash.length === expect.length && crypto.timingSafeEqual(hash, expect);
}

function originAllowed(clientOrigin, rpId) {
  try {
    const host = new URL(clientOrigin).hostname;
    return host === rpId || host.endsWith('.' + rpId);
  } catch { return false; }
}

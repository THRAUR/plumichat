// Web Push — notifications that reach a LOCKED phone.
//
// PlumiChat's "ping me when done" is today a page-generated Notification, which can
// only fire while the page is alive. On iOS the home-screen web app is suspended
// the moment the screen locks — exactly the case the feature exists for — so the
// ping never arrives. Real Web Push is delivered by Apple's/Google's push service
// to the SERVICE WORKER, which the OS wakes even when the app is closed.
//
// Implemented on node:crypto alone, deliberately: adding `web-push` would be a new
// runtime dependency in a repo with no build step, for ~200 lines of well-specified
// protocol. Two RFCs are involved and both are implemented in full below:
//
//   RFC 8291 (Message Encryption for Web Push) — end-to-end encryption of the
//     payload to the browser's own key pair, so the push service (Apple, Google)
//     relays ciphertext it cannot read. ECDH P-256 -> HKDF-SHA256 -> AES-128-GCM,
//     wrapped in the "aes128gcm" content coding of RFC 8188.
//   RFC 8292 (VAPID) — a per-request ES256 JWT that identifies THIS application
//     server to the push service, so nobody else who scrapes an endpoint URL can
//     push to our subscribers.
//
// Nothing here is debuggable from a phone, so every crypto step is commented with
// what it is and why it is in that exact order. Two rules if you touch it:
//   1. Byte order matters and failures are SILENT — a wrong HKDF info string still
//      produces a well-formed message that the browser simply discards.
//   2. The whole module is fail-soft: a broken or unconfigured crypto path reports
//      'unavailable' and sends nothing, rather than shipping malformed pushes that
//      would burn subscriptions. selfTest() below is what decides which it is.
import crypto from 'node:crypto';
import { read, update } from './store.js';
import { setEnvVar } from './credentials.js';
import { keyOf } from './notepad.js';

const STORE = 'push-subs';            // shape: { [userKey]: Sub[] }
const MAX_SUBS_PER_USER = 20;         // a phone, an iPad, a laptop… 20 is generous
const MAX_PAYLOAD = 3000;             // see RECORD_SIZE — the single-record budget
const RECORD_SIZE = 4096;             // aes128gcm record size; one record per message
const SEND_TIMEOUT_MS = 15 * 1000;
const SEND_CONCURRENCY = 4;           // be a polite client; a fan-out is a handful of endpoints
const DEFAULT_TTL = 3600;             // an hour: a "turn done" ping is stale after that
const JWT_LIFETIME_S = 12 * 3600;     // RFC 8292 caps this at 24h; 12 is the usual choice

// RFC 8292 wants a contact URI for the application server. Google/Mozilla accept
// anything well-formed; Apple has been known to reject a bogus one, so the owner
// should set VAPID_SUBJECT in .env to a real `mailto:` or `https:` URI. It is
// surfaced by pushStatus() so the settings page can say so out loud rather than
// leaving a 403 to be decoded from a log.
const SUBJECT = (() => {
  const s = String(process.env.VAPID_SUBJECT || '').trim();
  // RFC 8292 wants a real contact a push service can reach if your traffic causes
  // it a problem. Apple's service in particular may REJECT a bogus one, so this
  // fallback is a last resort, not a default to rely on — set VAPID_SUBJECT.
  return /^(mailto:|https:\/\/)/i.test(s) ? s : 'mailto:admin@localhost';
})();

/* ------------------------------ tiny helpers ------------------------------ */

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s == null ? '' : s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// HKDF (RFC 5869) in the only two shapes Web Push needs. Every expansion here is a
// single block (L <= 32), so the counter is always the literal 0x01 — no loop.
const hkdfExtract = (salt, ikm) => hmac(salt, ikm);
const hkdfExpand = (prk, info, len) => hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);
// info strings are NUL-terminated in both RFCs; get this wrong and the browser
// silently drops the message.
const info = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);

/* ------------------------------ VAPID keypair ----------------------------- */

// The private key is read out of the environment ONCE and then deleted from
// process.env. Agent turns inherit the server's environment (see scrubbedEnv() in
// claude.js), and a member's Bash can `printenv`; removing it here means a turn
// spawned after boot cannot see it at all, whether or not claude.js knows to strip
// it. Nothing else in the app reads these variables.
const bootEnvKeys = {
  pub: String(process.env.VAPID_PUBLIC_KEY || '').trim(),
  priv: String(process.env.VAPID_PRIVATE_KEY || '').trim(),
};
delete process.env.VAPID_PRIVATE_KEY;

// { publicKey:Buffer(65), privateKey:Buffer(32), signKey:KeyObject } once ready.
let keys = null;
let unavailable = null;   // a human-readable reason, once we know we cannot send
let checked = false;

// Build a node KeyObject that can produce ES256 signatures from the raw P-256
// scalar. JWK is the only import format that takes raw curve coordinates without
// hand-rolling DER, and node has supported it since 15.
function signKeyFrom(privateKey, publicKey) {
  return crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC', crv: 'P-256',
      d: b64u(privateKey),
      x: b64u(publicKey.subarray(1, 33)),   // uncompressed point: 0x04 || X(32) || Y(32)
      y: b64u(publicKey.subarray(33, 65)),
    },
  });
}

function generateKeypair() {
  const ec = crypto.createECDH('prime256v1');
  ec.generateKeys();
  // getPrivateKey() drops leading zero bytes, so a 1-in-256 key would come back
  // 31 bytes and every JWK import of it would fail. Left-pad to the curve size.
  const raw = ec.getPrivateKey();
  const privateKey = Buffer.alloc(32);
  raw.copy(privateKey, 32 - raw.length);
  return { privateKey, publicKey: ec.getPublicKey() };
}

function loadKeys() {
  const pub = unb64u(bootEnvKeys.pub);
  const priv = unb64u(bootEnvKeys.priv);
  if (pub.length === 65 && pub[0] === 0x04 && priv.length === 32) {
    return { publicKey: pub, privateKey: priv, generated: false };
  }
  // Refuse to mint a replacement when only ONE half is missing. A process started
  // WITHOUT --env-file still inherits VAPID_PUBLIC_KEY from its parent (PM2 passes
  // its environment down) but never sees the private half, because the block above
  // deletes it from process.env at import. Regenerating there looks like a clean
  // first run and silently rotates the pair, which invalidates every stored
  // subscription on every device — a failure nobody would trace back to a missing
  // flag. Only a genuinely empty pair is a first run; anything else is a
  // misconfiguration we report rather than "fix" destructively.
  if (bootEnvKeys.pub || bootEnvKeys.priv) {
    const half = bootEnvKeys.pub ? "VAPID_PRIVATE_KEY" : "VAPID_PUBLIC_KEY";
    throw new Error(
      "push: refusing to regenerate the VAPID pair — " + half + " is missing or " +
      "malformed. Start the server with --env-file=.env so both halves load, or " +
      "clear BOTH VAPID_ keys from .env to mint a new pair (that unsubscribes every device).");
  }
  // First run: mint one and persist it. setEnvVar is the
  // single .env writer (atomic temp-file + rename, mode 600) — the same path the
  // Basic-auth password change uses. The pair must survive a restart or every
  // stored subscription becomes undeliverable.
  const fresh = generateKeypair();
  setEnvVar('VAPID_PUBLIC_KEY', b64u(fresh.publicKey));
  setEnvVar('VAPID_PRIVATE_KEY', b64u(fresh.privateKey));
  // Make the public half visible to the running process too (the private half is
  // deliberately NOT put back into process.env — see bootEnvKeys above).
  process.env.VAPID_PUBLIC_KEY = b64u(fresh.publicKey);
  return { ...fresh, generated: true };
}

// The worked example from RFC 8291 §5, verbatim. This is the ONLY check that can
// catch a spec-compliant-looking mistake: a round-trip against our own decryptor
// would happily pass with the two public keys swapped in the HKDF info string, and
// the bug would only ever show as "notifications silently never arrive".
const RFC8291_VECTOR = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
      + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
      + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

// Prove the whole pipeline before we are ever asked to send. Two checks:
//   1. the RFC's known answer, byte for byte (spec conformance), and
//   2. a live round-trip with a throwaway subscription (the primitives actually
//      work on this node build).
// A failure here flips the module to 'unavailable' at boot, which is the whole
// point: not sending is recoverable, sending garbage burns real subscriptions.
function selfTest() {
  const known = encryptPayload(
    Buffer.from(RFC8291_VECTOR.plaintext, 'utf8'),
    unb64u(RFC8291_VECTOR.uaPublic),
    unb64u(RFC8291_VECTOR.authSecret),
    { asPrivate: unb64u(RFC8291_VECTOR.asPrivate), salt: unb64u(RFC8291_VECTOR.salt) },
  );
  if (b64u(known) !== RFC8291_VECTOR.body) {
    throw new Error('RFC 8291 §5 known-answer test failed — the aes128gcm output does not match the spec');
  }

  const ua = crypto.createECDH('prime256v1');
  const uaPublic = ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const probe = Buffer.from('plumi-push-selftest', 'utf8');

  const body = encryptPayload(probe, uaPublic, auth);

  // --- receiver side, mirroring RFC 8291 §3.4 from the browser's point of view ---
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);

  const shared = ua.computeSecret(asPublic);
  const prkKey = hkdfExtract(auth, shared);
  const ikm = hkdfExpand(prkKey, Buffer.concat([info('WebPush: info'), uaPublic, asPublic]), 32);
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, info('Content-Encoding: aes128gcm'), 16);
  const nonce = hkdfExpand(prk, info('Content-Encoding: nonce'), 12);

  const tag = record.subarray(record.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);

  // The last byte is RFC 8188's record delimiter, 0x02 for the final record.
  if (plain[plain.length - 1] !== 0x02) throw new Error('record delimiter is not 0x02');
  if (!plain.subarray(0, plain.length - 1).equals(probe)) throw new Error('round-trip plaintext mismatch');

  // And prove the VAPID signature path too — a JWT we cannot sign is just as fatal
  // as an encryption we cannot perform. Verify it with the public half so a broken
  // ieee-p1363 encoding cannot slip through as "well, it produced bytes".
  const jwt = vapidJwt('https://example.invalid');
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new Error('VAPID JWT did not sign');
  const verified = crypto.verify(
    'sha256', Buffer.from(parts[0] + '.' + parts[1], 'utf8'),
    { key: crypto.createPublicKey(keys.signKey), dsaEncoding: 'ieee-p1363' },
    unb64u(parts[2]),
  );
  if (!verified) throw new Error('VAPID JWT signature did not verify');
  jwtCache.clear(); // the probe token was minted for a bogus audience
}

// Lazy, once. Returns true when sending is possible. A failure is recorded, not
// thrown: callers are notification paths and must never take down a turn.
function ready() {
  if (checked) return !unavailable;
  checked = true;
  try {
    const k = loadKeys();
    keys = { publicKey: k.publicKey, privateKey: k.privateKey, signKey: signKeyFrom(k.privateKey, k.publicKey) };
    selfTest();
    if (k.generated) console.log('[push] generated a VAPID keypair and saved it to .env');
  } catch (err) {
    keys = null;
    unavailable = String((err && err.message) || err);
    console.error('[push] disabled — ' + unavailable);
  }
  return !unavailable;
}

/* --------------------------------- VAPID ---------------------------------- */

// One JWT per push-service origin, reused until it is close to expiry. Signing is
// cheap but a fan-out to several endpoints on the same service would otherwise
// re-sign the identical token every time.
const jwtCache = new Map();           // origin -> { token, exp }

function vapidJwt(origin) {
  const now = Math.floor(Date.now() / 1000);
  const hit = jwtCache.get(origin);
  if (hit && hit.exp - now > 300) return hit.token;

  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const exp = now + JWT_LIFETIME_S;
  const payload = b64u(JSON.stringify({ aud: origin, exp, sub: SUBJECT }));
  const signingInput = header + '.' + payload;
  // JWS ES256 wants the raw R||S pair (64 bytes). Node signs ECDSA as DER by
  // default, which every push service rejects — 'ieee-p1363' is the raw encoding.
  const sig = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: keys.signKey, dsaEncoding: 'ieee-p1363',
  });
  const token = signingInput + '.' + b64u(sig);
  if (jwtCache.size > 32) jwtCache.clear();
  jwtCache.set(origin, { token, exp });
  return token;
}

// RFC 8292 §3: the single "vapid" Authorization scheme carries both the token and
// the public key the service should verify it against.
function authHeader(endpoint) {
  const origin = new URL(endpoint).origin;
  return 'vapid t=' + vapidJwt(origin) + ', k=' + b64u(keys.publicKey);
}

/* ------------------------------- RFC 8291 --------------------------------- */

// Encrypt `payload` to one subscription. Returns the complete aes128gcm body that
// goes in the POST — header block included, exactly as RFC 8188 §2.1 lays it out.
//
// `fixed` pins the ephemeral keypair and salt, and exists ONLY so selfTest() can
// run the RFC 8291 §5 known-answer test. Production callers never pass it, and
// must not: reusing a sender key across messages would let the push service link
// them, and reusing a salt would reuse the AES-GCM nonce.
function encryptPayload(payload, uaPublic, authSecret, fixed) {
  if (payload.length + 17 > RECORD_SIZE) {
    // 16 bytes of GCM tag + 1 delimiter byte must fit inside one record.
    throw new Error('payload too large for a single aes128gcm record');
  }

  // Ephemeral (per-message) sender keypair. Fresh every time: reusing it would let
  // the push service link two messages to the same sender key.
  const as = crypto.createECDH('prime256v1');
  let asPublic;
  if (fixed) { as.setPrivateKey(fixed.asPrivate); asPublic = as.getPublicKey(); }
  else asPublic = as.generateKeys();
  const ecdhSecret = as.computeSecret(uaPublic);     // 32-byte X coordinate
  const salt = fixed ? fixed.salt : crypto.randomBytes(16);

  // 1. Extract with the SUBSCRIPTION'S auth secret as the HKDF salt. This is what
  //    binds the message to this subscriber and not merely to their public key.
  const prkKey = hkdfExtract(authSecret, ecdhSecret);

  // 2. Expand to the IKM for the content chain. The info string is
  //    "WebPush: info" || 0x00 || ua_public || as_public — RECEIVER'S key first,
  //    sender's second. Swap them and you get a message that looks perfectly valid
  //    and decrypts to nothing on the phone.
  const ikm = hkdfExpand(prkKey, Buffer.concat([info('WebPush: info'), uaPublic, asPublic]), 32);

  // 3. The RFC 8188 chain proper: re-extract with the random per-message salt, then
  //    expand once for the key and once for the nonce. Both info strings are fixed
  //    ASCII with the trailing NUL.
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, info('Content-Encoding: aes128gcm'), 16);
  const nonce = hkdfExpand(prk, info('Content-Encoding: nonce'), 12);

  // 4. One record. RFC 8188 pads every record with a delimiter byte: 0x01 means
  //    "another record follows", 0x02 means "this is the last one". We always send
  //    a single record, so it is always 0x02. No extra zero padding is added —
  //    padding only obscures the plaintext length, and these payloads are short,
  //    uniform notification JSON.
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),                              // GCM tag is appended, not separate
  ]);

  // 5. Header block: salt(16) || rs(4, big-endian) || idlen(1) || keyid(idlen).
  //    For Web Push the keyid IS our ephemeral public key — that is how the browser
  //    knows which key to run its half of the ECDH against (RFC 8291 §4).
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed]);
}

/* ------------------------------- storage ---------------------------------- */

// Same per-account keying as the notepad, imported rather than re-derived so the
// two can never drift: registered accounts key on their id, the Basic-auth owner
// fallback collapses to 'owner'.
function rawSubs(user) {
  const all = read(STORE, {});
  const list = all[keyOf(user)];
  return Array.isArray(list) ? list : [];
}

// What a client may see. `keys` (p256dh + auth) are the subscription's encryption
// secrets and never leave the server, even to their own owner — the browser
// already has them and nothing in the UI needs them.
const publicSub = (s) => ({
  endpoint: s.endpoint,
  host: hostOf(s.endpoint),
  ua: s.ua || '',
  createdAt: s.createdAt || null,
  lastSentAt: s.lastSentAt || null,
});

function hostOf(endpoint) {
  try { return new URL(endpoint).host; } catch { return ''; }
}

export function listSubs(user) { return rawSubs(user).map(publicSub); }

// Store (or refresh) one browser's subscription. Validation is strict on purpose:
// a malformed key would only fail later, at send time, as an unexplained silent
// non-delivery.
export function subscribe(user, sub) {
  const endpoint = String((sub && sub.endpoint) || '').trim();
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error('invalid push endpoint'); }
  if (parsed.protocol !== 'https:') throw new Error('push endpoints must be https');
  const p256dh = unb64u(sub && sub.keys && sub.keys.p256dh);
  const auth = unb64u(sub && sub.keys && sub.keys.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 0x04) throw new Error('invalid p256dh key');
  if (auth.length !== 16) throw new Error('invalid auth secret');

  const record = {
    endpoint,
    keys: { p256dh: b64u(p256dh), auth: b64u(auth) },
    ua: String((sub && sub.ua) || '').slice(0, 200),
    createdAt: Date.now(),
  };
  const key = keyOf(user);
  update(STORE, (all) => {
    const list = Array.isArray(all[key]) ? all[key] : [];
    // De-duplicate by endpoint: a browser re-subscribing (after a permission
    // reset, or a service-worker update) sends the SAME endpoint back, and two
    // copies would mean two notifications for one event.
    const kept = list.filter((s) => s && s.endpoint !== endpoint);
    kept.unshift(record);
    all[key] = kept.slice(0, MAX_SUBS_PER_USER);
    return all;
  }, {});
  return publicSub(record);
}

export function unsubscribe(user, endpoint) {
  const key = keyOf(user);
  let removed = false;
  update(STORE, (all) => {
    const list = Array.isArray(all[key]) ? all[key] : [];
    all[key] = list.filter((s) => (s && s.endpoint === endpoint ? ((removed = true), false) : true));
    return all;
  }, {});
  return { ok: true, removed };
}

// Drop a subscription the push service told us is gone (404/410). Called from the
// send path, so it must not throw.
function dropEndpoint(user, endpoint) {
  try { unsubscribe(user, endpoint); } catch { /* store write failed; next send retries */ }
}

function markSent(user, endpoint) {
  const key = keyOf(user);
  try {
    update(STORE, (all) => {
      const s = (all[key] || []).find((x) => x && x.endpoint === endpoint);
      if (s) s.lastSentAt = Date.now();
      return all;
    }, {});
  } catch { /* bookkeeping only */ }
}

/* --------------------------------- sending -------------------------------- */

// Bounded-concurrency map. Kept local (four lines) rather than pulled in, and low,
// because a push fan-out is a handful of endpoints and politeness beats speed.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
  });
  await Promise.all(workers);
  return out;
}

async function postOne(user, sub, body, { ttl, urgency, topic }) {
  try {
    // Built inside the try: authHeader() parses the endpoint and signs a JWT, and
    // a hand-edited store could hand us something unparseable. sendToUser must not
    // be able to throw at its caller — a failed notification is never worth
    // failing the turn that triggered it.
    const headers = {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
      Authorization: authHeader(sub.endpoint),
    };
    // Topic collapses an undelivered notification with the next one on the same
    // topic, so a locked phone gets "turn done" once, not eleven times. The header
    // is restricted to a short base64url token by RFC 8030 §5.4.
    if (topic) headers.Topic = topic;

    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers,
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 410) {
      // The canonical "this subscription is dead" answer: the browser was
      // uninstalled, or permission was revoked. Forget it or we retry forever.
      dropEndpoint(user, sub.endpoint);
      return { endpoint: sub.endpoint, host: hostOf(sub.endpoint), ok: false, status: res.status, dropped: true };
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { /* body optional */ }
      return {
        endpoint: sub.endpoint, host: hostOf(sub.endpoint), ok: false, status: res.status,
        retryAfter: res.headers.get('retry-after') || null, detail,
      };
    }
    markSent(user, sub.endpoint);
    return { endpoint: sub.endpoint, host: hostOf(sub.endpoint), ok: true, status: res.status };
  } catch (err) {
    return { endpoint: sub.endpoint, host: hostOf(sub.endpoint), ok: false, error: String((err && err.message) || err) };
  }
}

// Push one notification to every device a user has registered.
//
// NEVER throws: callers are "the turn finished" / "an approval is waiting" paths,
// and a push failure must never surface as a failed turn. The outcome comes back
// as a per-endpoint array so the settings page can show which device is unhappy.
export async function sendToUser(user, { title, body, tag, url, ttl, urgency } = {}) {
  if (!ready()) {
    return { ok: false, reason: 'unavailable', detail: unavailable, sent: 0, results: [] };
  }
  const subs = rawSubs(user);
  if (!subs.length) return { ok: true, reason: 'no-subscriptions', sent: 0, results: [] };

  // The service worker gets exactly this JSON; keep the shape stable. A push
  // payload has a hard ceiling (one aes128gcm record), so shrink rather than fail:
  // a truncated "…" notification is still the signal the user asked for, an
  // undelivered one is not. Halve the body until it fits — two or three rounds at
  // most, and the title/url survive so the notification stays tappable.
  const build = (b) => Buffer.from(JSON.stringify({
    title: String(title || 'PlumiChat').slice(0, 200),
    body: b,
    tag: tag ? String(tag).slice(0, 64) : undefined,
    url: url ? String(url).slice(0, 500) : undefined,
    at: Date.now(),
  }), 'utf8');
  let text = String(body || '');
  let payload = build(text);
  while (payload.length > MAX_PAYLOAD && text.length > 1) {
    text = text.slice(0, Math.floor(text.length / 2)).replace(/…$/, '') + '…';
    payload = build(text);
  }
  if (payload.length > MAX_PAYLOAD) payload = build('');

  const opts = {
    ttl: Number.isFinite(ttl) ? Math.max(0, Math.floor(ttl)) : DEFAULT_TTL,
    urgency: ['very-low', 'low', 'normal', 'high'].includes(urgency) ? urgency : 'normal',
    topic: /^[A-Za-z0-9_-]{1,32}$/.test(String(tag || '')) ? String(tag) : null,
  };

  const results = await mapLimit(subs, SEND_CONCURRENCY, async (sub) => {
    let sealed;
    try {
      // Encrypt PER SUBSCRIPTION — each device has its own key pair, so there is
      // no shared ciphertext to reuse across endpoints.
      sealed = encryptPayload(payload, unb64u(sub.keys && sub.keys.p256dh), unb64u(sub.keys && sub.keys.auth));
    } catch (err) {
      return { endpoint: sub.endpoint, host: hostOf(sub.endpoint), ok: false, error: 'encrypt: ' + ((err && err.message) || err) };
    }
    return postOne(user, sub, sealed, opts);
  });

  const sent = results.filter((r) => r && r.ok).length;
  return { ok: sent > 0, sent, results };
}

/* --------------------------------- status --------------------------------- */

// The applicationServerKey the browser needs for pushManager.subscribe(). Returns
// null when push is unavailable, which is the client's signal to hide the toggle
// rather than offer a button that cannot work.
export function publicKey() {
  if (!ready()) return null;
  return b64u(keys.publicKey);
}

// Everything the settings page needs to explain the current state, including WHY
// push is off when it is off.
export function pushStatus(user) {
  const available = ready();
  return {
    available,
    reason: available ? null : unavailable,
    publicKey: available ? b64u(keys.publicKey) : null,
    subject: SUBJECT,
    subscriptions: user ? listSubs(user) : undefined,
  };
}

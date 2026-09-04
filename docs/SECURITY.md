# Security model

Read this before you expose PlumiChat to anything.

## The one sentence that matters

**PlumiChat gives a language model a shell on the machine it runs on.** That is not
a side effect — it is the product. Every security decision below follows from it.

If someone can reach your instance and authenticate, they can read your files, run
commands, and use your Anthropic credentials. Treat access to PlumiChat exactly as
you would treat SSH access to the same machine.

## Defaults are deliberately closed

| Default | Why |
|---|---|
| Binds `127.0.0.1` | Only this machine can reach it. A wider bind is opt-in. |
| Refuses to start on a non-loopback address with no auth configured | The window before your owner account exists would otherwise be an unauthenticated remote shell. |
| A fresh install serves only the login/setup page; everything else 401s | There is no "unconfigured means open" mode. |
| Member turns refuse to run where no OS sandbox exists | Confinement is the sandbox. No sandbox, no member. |
| Two-copy deploy, sister-app SSO, error-digest signals: all off unless configured | An unconfigured feature reports itself unavailable rather than guessing. |

## How to expose it safely

In order of preference:

1. **Don't.** Run it on the machine you use it from. `localhost` is a secure
   context, so passkeys and the installable web app both work with zero setup.
2. **A private network overlay** — Tailscale, WireGuard, or similar. Keep
   `HOST=127.0.0.1` and let the overlay's own HTTPS front end reach it
   (`tailscale serve` does this well). Nothing touches the public internet, you get
   real TLS, and device identity is handled outside the app.
3. **A reverse proxy you control** (Caddy, nginx) terminating TLS, again with the
   app on loopback. Set `AUTH_USER`/`AUTH_PASS` as a second layer.
4. **Directly on `0.0.0.0`** — only on a network you trust completely, and only
   with `AUTH_USER`/`AUTH_PASS` set. The server enforces that second part.

**Do not port-forward this from a home router to the public internet.** There is no
rate limiting, no fail2ban, no WAF, and no bug bounty. It is a personal tool.

### HTTPS is not optional for real use

Two features silently need a *secure context* (HTTPS, or `localhost`):

- **WebAuthn passkeys** — Face ID / Touch ID unlock
- **Service workers** — the installable web app and Web Push notifications

Over plain HTTP to a LAN IP, both are unavailable. That is the browser's rule, not
PlumiChat's.

## Roles

| Role | Can |
|---|---|
| **Owner** | Everything. One per install, created first, no invite. Terminal, Operations, Sites, engine updates, machine power controls. |
| **Admin** | Sees the whole workspace, manages members. **No** terminal, **no** Operations, **no** power controls. |
| **Member** | Confined to a private home directory. Joins via a single-use expiring invite. |

Owner-only surfaces are owner-only because each one escapes containment: the
terminal hands out an unsandboxed shell, Operations runs autonomous agents against
any project, and engine updates install software.

## Member confinement, and its limits

Members are confined by **two independent, fail-closed layers**:

1. **The SDK `canUseTool` policy.** Every tool call whose path resolves outside the
   member's home is denied before it runs.
2. **An OS sandbox around Bash.** bubblewrap on Linux, seatbelt on macOS. Writes
   are confined by *mount*, not by file permissions — so it holds even on
   filesystems that do not enforce Unix permissions (a Windows-hosted drive under
   WSL, for example).

Two consequences worth stating plainly:

- **`acceptEdits` and `bypassPermissions` skip `canUseTool`.** That is why
  `/api/chat` clamps a member's permission mode to `default` **server-side**. Never
  relax that: the clamp is not a UI preference, it is half the confinement.
- **Windows has no supported sandbox.** `startRun` refuses member turns there
  rather than running them unconfined. Run Windows installs as owner-only.

### What confinement does NOT cover

Be honest with yourself about this list:

- A member can still **spend your Anthropic credits**.
- A member can still **read anything inside their own home**, including whatever
  you put there.
- Confinement is about the *filesystem*. A sandboxed shell may still make **network
  requests** unless you restrict that separately.
- The **owner is not confined at all**, by design. The terminal is a real shell.

## Secrets

- Secrets live only in `.env`, which is gitignored. Nothing else should hold them.
- Agent turns run with a **scrubbed environment** (`scrubbedEnv()` in
  `server/claude.js`): `AUTH_USER`, `AUTH_PASS`, `SESSION_SECRET`, `OPS_SIGNALS` and
  `VAPID_PRIVATE_KEY` are removed, so a prompt cannot `printenv` its way to them.
- `ANTHROPIC_API_KEY` is deliberately **kept** — the SDK subprocess needs it. An
  agent turn can therefore read your API key. There is no way around this while the
  agent runs as a child process; it is a reason to care who has an account.
- For members, the sandbox additionally `denyRead`s the app's own `.env`, your
  `~/.ssh`, and `~/.claude/.credentials.json`.

## Sister-app single sign-on

Off unless you create `apps.config.json`. Before you do, understand the trade-off:

Cookies are scoped by **host**, not by port. Every app you list therefore *receives*
the raw PlumiChat session cookie on each request. It cannot **forge** one — apps
never get `SESSION_SECRET`, they can only ask `/api/sso/me` who the caller is — but
it can **replay** the cookie against PlumiChat and act as that user for the cookie's
lifetime.

So the blast radius of a compromised sister app is *full PlumiChat access*, not
*knows who you are*. Only list apps you trust as much as PlumiChat itself.

The proper fix, if you ever need an app to be less trusted than that, is to have
`/api/sso/me` mint a short-lived, audience-bound token instead of letting apps see
the session cookie. That is a protocol change across every app, which is why it is
documented here rather than done.

## Sessions

- Signed, stateless cookies. `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS.
- 30-day TTL, slid on use — an actively used login effectively never expires.
- Each account carries a **session version**. Changing your PIN bumps it, which
  invalidates every cookie minted before the change. That is what actually logs a
  stolen session out.
- Passkeys are bound to the account and to the WebAuthn **relying-party id**, which
  is derived from the hostname. Changing the hostname invalidates enrolled passkeys.

## Reporting a vulnerability

This is a personal project with no security team and no SLA. Open a GitHub issue
for anything non-sensitive. For something you would rather not post publicly, use
GitHub's private vulnerability reporting on the repository.

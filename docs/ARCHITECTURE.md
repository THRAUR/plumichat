# Architecture

No build step. No framework. No bundler. No database. Node 22 with native ES
modules on the server, vanilla ES modules in the browser, and a set of flat files.

```
server/         ~12,200 lines   Express, the SDK wrapper, the run manager
public/         ~21,100 lines   the client, served as-is
```

This document covers the parts that are actually interesting — the decisions that
were not obvious, and the bugs that shaped them.

---

## A turn outlives its HTTP request

The single most important structural decision.

The naive shape is: `POST /api/chat` opens an SSE response, the turn runs inside the
handler, the response ends when the turn ends. It works right up until the client is
a phone. Lock the screen, switch apps, walk out of Wi-Fi range — the connection
drops, the handler unwinds, and the turn dies with it.

So `server/runs.js` owns a **run**: an object with its own lifecycle, created by the
request but not owned by it.

- The HTTP response is just a **subscriber**. It can disconnect and reconnect.
- Every event is buffered into a **transcript**, so a reattaching client replays
  what it missed rather than joining mid-sentence.
- Ended runs are **retained for ~10 minutes**, so a phone that was asleep when the
  turn finished can still collect the result.
- Concurrency caps are per-user and global, because each turn is a separate ~340 MB
  CLI process.
- Unanswered permission asks time out, so a forgotten approval cannot block a
  conversation forever.

`server/claude.js` owns the other half: building the SDK `query()` options for one
turn, translating SDK messages into the event stream, and applying the member
policy.

### Keeping a turn alive across background agents

The first version broke out of the SDK message loop on the first `result`. That
closed the CLI process — and took every background subagent with it. In the
terminal, a session that spawns background work resumes itself; here it silently
died the moment the main answer finished.

The fix is to keep iterating while background tasks are pending, bounded by an idle
deadline and an absolute ceiling. It is a small diff and it is the difference
between "chat UI" and "the terminal, with buttons".

---

## Reaching SDK APIs between turns

The context ring, Compact, Rewind files and Fork all need SDK methods that live on a
live `Query` object. Between turns there is no live query — the process that ran the
last turn has exited.

The trick in `server/context.js`: start a query whose **prompt is an async generator
that never yields**. The CLI boots, resumes the session transcript, and sits there
answering control requests without ever running a turn. About a second, and no
tokens.

Four things worth knowing if you touch it:

- **Ownership is checked before the session id reaches the SDK.** The SDK will
  resume any session id it can find, so a member must never be able to name someone
  else's.
- **File checkpointing is not retroactive.** Checkpoints are written by the process
  that ran the turn, so switching it on only helps from that turn forward. Rewind
  reports "no file checkpoint" for older turns rather than pretending.
- **You cannot call `getContextUsage()` at the end of a turn.** A turn is started
  with a *string* prompt, which closes the child's stdin — so the control channel is
  already gone by the time `result` arrives. The ring is fed from that turn's
  `usage` instead: `totalTokens` is exactly `input + cache_read + cache_creation` of
  the last request.
- Still genuinely blocked on a persistent per-conversation process: mid-turn
  interrupt, live model switching, and queued input. Those need a query *during* the
  turn.

---

## Two independent confinement layers

Member confinement is the security core, and it is deliberately not one mechanism.

1. **The SDK `canUseTool` policy** denies any tool call whose path resolves outside
   the member's home, before it runs.
2. **An OS sandbox around Bash** — bubblewrap on Linux, seatbelt on macOS —
   confining writes by *mount*, not by file permission. That distinction matters: it
   holds even on filesystems that do not enforce Unix permissions at all.

The sharp edge: `acceptEdits` and `bypassPermissions` **skip `canUseTool` entirely**.
So `/api/chat` clamps a member's permission mode to `default` server-side. The clamp
is not a UI preference — it is half of the confinement.

Both layers fail closed. Where no sandbox exists, `startRun` refuses the turn rather
than running it unconfined.

See [SECURITY.md](SECURITY.md) for the threat model.

---

## Capabilities, not assumptions

`server/platform.js` is the only file that knows which OS this is. Everything else
asks it. `server/capabilities.js` turns that into one row per optional feature:
available or not, and if not, **a sentence naming what is missing**.

Two rules:

1. **Probe, never infer.** "macOS therefore no pandoc" is wrong. Look for the binary.
2. **A missing capability is a sentence, not a boolean.** `reason` is read by a human
   who has to go install something.

The client fetches `/api/capabilities` once and hides rows that cannot work, tagging
each with `data-unavailable="<reason>"` so the answer is discoverable in devtools.
The server prints the same list at startup — only the *unavailable* ones, because a
list of what works is noise and a list of what does not is what an operator needs.

This is what makes "runs on Linux, macOS and Windows" an honest claim rather than an
aspiration: the parts that cannot work say so, by name, up front.

---

## Web Push, implemented by hand

`server/push.js` implements **RFC 8291** (message encryption) and **RFC 8292**
(VAPID) on `node:crypto` alone — no library.

Why bother: notifications generated by the page can only fire while the page is
awake, which on iOS is never, at exactly the moment you care. Real Web Push goes
through the service worker and reaches a **locked** phone.

The pieces: an ECDH P-256 key agreement with the subscription's public key, HKDF to
derive the content-encryption key and nonce, AES-128-GCM with the `aes128gcm`
content coding, and a signed VAPID JWT for the push service. It is about as much
crypto as you can reasonably do without a dependency, and it is testable because
every step has published vectors.

---

## Persistence: there isn't a database

- **Conversations** live in the Agent SDK's own JSONL session logs
  (`~/.claude/projects/**.jsonl`). Nothing is duplicated, and history is shared with
  the terminal by construction.
- **Everything else** is a tiny atomic JSON store: one file per collection under
  `DATA_DIR`, written temp-file-then-rename.
- **Runs** are in-memory and reset on restart.

One rule that is easy to break: `updateTasks()` in `server/ops/store.js` is the
**only** writer of the task store. It fires `onOpsChange`, which is streamed to any
open board. Calling `update()` directly persists correctly and is invisible to every
board on screen.

---

## The client

`public/app.js` is the entry; everything else lives in `public/js/`. It used to be
one 6,300-line IIFE. Three rules keep the split working — break any and the page
renders as dead static HTML:

1. **Nothing may import `public/app.js`.** It is loaded with a `?v=` cache-buster,
   so an `import` of `/app.js` is a *different URL* and the browser evaluates a
   second copy. Shared code lives in `public/js/`.
2. **Modules declare; they do not wire themselves up.** Listeners, restored
   preferences and first fetches go in an exported `initX()`, which `app.js` calls in
   a specific order. Reordering that list is the one edit that changes behaviour
   without changing code.
3. **A binding is written only by the module that declares it.** Cross-cutting state
   lives in `js/state.js`; read through the imported live binding, write through
   that module's setter. An ES module cannot assign to an imported binding, and a
   second writer is how a stale copy gets introduced.

---

## The design system

`public/plume.css` loads first on every page and owns the palette, four typefaces,
and the shared primitives. Before it existed, three stylesheets each had their own
`:root` and they had drifted.

Worth knowing:

- **A palette is not a theme.** `data-theme` stays `light`/`dark`; palettes ride on
  a separate `data-palette` attribute and each declares which mode it belongs to.
- **`--accent` is a fill; `--accent-text` is text.** Never write
  `color: var(--accent)` — the accent fill fails contrast as text on light
  backgrounds. `theme.js` derives an AA-legible text variant and the right ink for
  any custom accent, re-deriving when the mode flips.
- **Contrast is measured, not eyeballed.** All 9 palettes × 17 accents (153
  combinations) were verified in a live DOM against every surface. Worst ratio
  anywhere is 4.51. A few anchors moved off their canonical values to clear the
  floor; all hue-preserving, all listed in the stylesheet.
- **An accent text colour is derived against `--accent-dim` over `--surface-3`**,
  not against `--bg` — `--surface-3` is the surface furthest from the text in both
  modes, so clearing it clears everything above it. Checking against `--bg` passed a
  terracotta that scored 4.77 there and 3.85 on `--surface-3`, i.e. every accented
  label inside a menu was below AA while the check said it passed.
- **Avatars use `background-color`, never the `background` shorthand.** The
  shorthand resets `background-image`/`-size`/`-position`, and a profile photo is
  delivered as an inline `background-image`. That is exactly how the avatar broke
  once: a later `background: var(--accent)` wiped `cover`/`center` and a 256px face
  rendered at natural size in a 34px box.

The app icon is **generated**, not drawn: `scripts/brand/make-icons.py` writes every
size from one 32-unit geometry. The 32px favicon is a literal pixel grid rather than
a downsample, because a resampled arc at that size turns to soup. The Apple touch
icon is full-bleed and opaque on purpose — iOS applies its own squircle and paints
black behind any transparency, so a pre-rounded icon ships four black corners.

---

## Phone realities

- `html, body { overflow: hidden }` is load-bearing. The iOS keyboard shrinks only
  the *visual* viewport, so the page box stays full height while the app is cut to
  `--app-h` — leaving empty document below for iOS to scroll into.
- `unscroll()` undoes iOS's reveal-the-input scroll, which happens *before* the
  resize event tells us to shrink. Without it: "it jumps to the bottom and I can't
  see anything until I type."
- `syncViewport()` re-anchors the message list when the keyboard opens, but only if
  you were already near the bottom — a reader parked mid-history is left alone.
- The terminal key bar uses `pointerdown` + `preventDefault`, **not** `click`: a
  click moves focus off the terminal and dismisses the keyboard between every key.

---

## Testing

There is no test framework, deliberately — but there are two real harnesses:

- **`scripts/ops-harness/`** — a characterisation test over `operations.js`'s public
  exports plus a function-body hash check. Run it before and after any refactor
  there; a move must alter nothing. It caught a real latent bug during the module
  split.
- **`node --check`** is the syntax gate, and importing a module in Node is the
  reference check — `node --check` validates syntax only, so a missing import
  survives it.

For UI work: run an isolated server (`PORT=3099` with its own `DATA_DIR`) and drive
headless Chromium over CDP. Two passes are worth repeating after any layout change —
a walk of every surface at 320/390/768/1280 measuring overflow, escaping elements,
clipped text and sub-30px tap targets; and a DOM smoke test asserting the racks, the
composer's two rows, the settings tabs and the accent derivation.

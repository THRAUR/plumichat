# PlumiChat — context for a Claude Code session working in this repo

## What this is

A self-hosted web app that drives Claude Code from a phone. Express on Node 22,
vanilla ES modules in the browser, no build step, no framework, no database.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first — it covers the decisions
that are not obvious from the code.

## You may be running inside the thing you are editing

If this session was started *through* PlumiChat's own chat, it is a child of the
server process. Two consequences:

- **Anything that restarts, stops or reloads that process kills your own turn
  mid-sentence.** Never `pm2 restart` the app from inside a chat session. Let the
  human do it after your reply finishes.
- Changes to `server/*.js` need a restart to take effect. Changes under `public/`
  are live on a browser reload.

## This repo is the portable half of a pair

PlumiChat is developed against one maintainer's machine and released here. The two
share every feature and every fix; what this repo does differently is exactly what
makes it installable by someone else. Keep that property — it is the whole point of
this copy existing.

- **No personal name anywhere.** The product is *PlumiChat* in prose and `PLUMI_` in
  identifiers: `window.PLUMI_*`, the `plumi-turn-done` push tag, `plumi.pref.` keys,
  `PLUMI_*` environment variables. If you are porting a patch in, translate rather
  than paste — one name does not map to one other name.
- **Nothing may assume a particular machine.** No absolute paths belonging to a
  person, no "the slow disk" in a comment, and anything machine-specific defaults
  OFF: the two-copy deploy in `server/engine-ship.js` is inert unless
  `PLUMI_LIVE_CLONE` is set, and `server/push.js` falls back to a neutral contact.
- **A missing tool is a hidden feature, never a crash.** `server/platform.js`
  abstracts the OS and `server/capabilities.js` + `public/js/capabilities.js` gate
  the UI on what this box can actually do. `node-pty` is optional; a machine that
  cannot build it loses the terminal panel and nothing else. New code that shells
  out to something belongs behind a capability, and the startup banner should be
  able to say why it is unavailable.
- **This copy is ahead in places, deliberately.** It uses `--env-file-if-exists`, so
  there is no missing-`.env` failure, and macOS member confinement runs on the
  built-in seatbelt sandbox. Do not "fix" those back toward a simpler version.

## Verify like this

`node --check` is a **syntax** gate only — a missing import passes it. The real
check is loading the module:

```bash
node --check server/thing.js
node --input-type=module -e "await import('./server/thing.js')"
```

Touching `server/operations.js` or `server/ops/*`? Run `scripts/ops-harness/`
before and after. A refactor there must change nothing observable.

Frontend work: run a throwaway server (`PORT=3099` with its own `DATA_DIR`) and
drive headless Chromium over CDP. Assert a clean console — a broken import shows up
as a blank page, not an error.

## Rules with bugs behind them

**Do not strip or reformat comments.** They record *why* — which bug, which platform
quirk, which trade-off. They are the most valuable thing in the repo.

**Three client rules.** Break any and the page renders as dead static HTML:
1. Nothing may import `public/app.js` — it is the entry, loaded with a `?v=`
   cache-buster, so importing it evaluates a second copy. Shared code lives in
   `public/js/`.
2. Modules declare; they do not wire themselves up. Side effects go in an exported
   `initX()` that `app.js` calls in a specific order.
3. A binding is written only by the module that declares it. Cross-cutting state is
   in `js/state.js`: read the imported live binding, write through the owner's setter.

**Design tokens live only in `public/plume.css`.** `--accent` is a fill; text uses
`--accent-text`. An avatar is styled with `background-color`, never the `background`
shorthand (it would reset the `background-image` the photo is delivered as).

**`updateTasks()` in `server/ops/store.js` is the only writer of the task store.** It
fires the event open boards listen to. A direct `update()` persists correctly and is
invisible on screen.

**`options.mcpServers` in `server/claude.js` is MERGED, never assigned.** Long-term
memory and image generation are independent per-turn SDK servers and either may be
absent; a bare `options.mcpServers = x` silently costs an account with both one of
its two tools. Each in-process tool also needs its `mcp__<server>__<tool>` name in
`SAFE_TOOLS`, or it raises an approval card on every single call.

**An SDK MCP tool runs in the server process, OUTSIDE bubblewrap.** So a tool that
touches the disk is itself the confinement, not a thing the sandbox protects.
`server/memory.js` and `server/imagegen.js` both follow the one rule that makes that
safe: the container tag and the output folder are derived from the account that
started the turn, and no tool argument, request field or prompt may name either.

**The image engine in `server/imagegen.js` is probed, never assumed.** It keeps
`sd-server` resident so a picture costs 17s instead of 45 — but every path stays
alive without it: a box where the engine does not answer (no WSL `mirrored`
networking, a taken port, a CLI-only release) logs the reason once and makes every
picture with `sd-cli`, one model load at a time. Three things there are load-bearing
and were each a bug first:

- **The free-VRAM floor guards a model LOAD, so it belongs in the two places that
  perform one** — spawning the engine, and a CLI run. Asked once per picture it
  refuses every picture after the first, because a warm engine *is* the thing using
  the card; asked before `ensureEngine()` it also refuses an engine already loaded
  and waiting to be adopted.
- **`SIGTERM` has to reap the child.** It is what a process manager sends, and its
  default action never runs an `exit` listener — so every restart left 4.4 GB of the
  card held by an orphan with nothing alive to time it out.
- **A generous abort budget on the engine's own HTTP calls.** The enqueue POST
  usually answers in milliseconds, but the first one after a long idle can take
  tens of seconds while the OS pages the weights back in; a short ceiling turns
  that into a dead engine and the 45s fall-back this whole path exists to avoid.
- **The card can be lent out.** A process that needs the whole GPU (a Blender
  render, say) writes `~/.cache/plumi/gpu-lease.json` (or `PLUMI_GPU_LEASE`) and
  keeps touching it. While it is live, no picture starts (tool, panel or studio),
  the engine is stopped once the picture on the card finishes, and `<lease>.ack`
  tells the holder the card is clear. A file and not a route: the holder has no
  owner session, and loopback proves nothing here. It goes stale on its own 90s
  after the holder stops touching it.

`/sdui` proxies the WebUI compiled into `sd-server` and is **owner-only** — it is
another door onto the same card, and it is not member-confined.

**Never weaken member confinement.** `/api/chat` clamps members to `default`
permission mode server-side because `acceptEdits`/`bypassPermissions` skip
`canUseTool`, which *is* the confinement. Both layers are fail-closed and must stay
that way.

**Memory is scoped by the server, never by the model.** `server/memory.js` derives
each account's Supermemory container from the session; no tool argument, request
field or prompt can name one. A self-hosted server trusts every localhost request,
so member isolation is the sandbox (network namespace + `~/.supermemory` on
`denyRead`), not the key, and member memory is only allowed where that was verified.
Do not install Supermemory's Claude Code plugin to "simplify" this: it would run on
member turns and pre-approve its own tools past `canUseTool`.

**Platform differences go in `server/platform.js`,** never inline. Probe for a
binary; never infer from `process.platform`. If a feature can be unavailable, give
it a row in `server/capabilities.js` with a `reason` a human can act on.

**Copying out of the terminal goes through one walk: `joinLinks` in
`public/js/panels/term-copy.js`.** The link cards and the selectable screen text both
read Ink's hard-wrapped rows through it. They shipped as two walks that disagreed: a
sign-in URL was whole on its card while the screen text under it kept a line break and
an indent at every wrap, and selecting it there — the obvious move on a phone — copied
a link no browser will open. `tidyCopy` glues a URL-only line onto a line that ends
inside a link of 24+ characters; the floor is what keeps `…/done` above a one-word
line as two lines.

**Pasting IN is `term.paste()`, and the panel sizes itself from `visualViewport`.**
The `paste` key beside `copy` exists because xterm's only real input is a 1px
textarea parked under the cursor: a phone has nothing to long-press, so a sign-in
code copied in the browser had no way back into the prompt asking for it. It acts
on `pointerdown` — WebKit can swallow the click of a cancelled touch — with the
click as a fallback and a 700ms guard, so a browser that sends both still pastes
once. `term.paste()` and not a raw `{t:"i"}`: bracketed paste is what stops a
multi-line paste running itself. `--term-top` / `--term-vh` are written by
`panels/terminal.js` and read by `.term-modal` in the phone media query. `--app-h`
alone gets the height right but leaves the panel anchored to a layout-viewport top
iOS has already slid away to reveal the cursor — which is how you ended up reading
the TOP of the terminal while typing at the bottom of it.

## Wire-protocol pairs

These are matched. Rename one half and downloads or notification tap-through fail
silently:

| Token | Emitted by | Parsed by |
|---|---|---|
| `<!--plumi:download-->`, `<!--plumi:file-->` | `server/system-prompt.js` | `public/js/exports.js`, `js/panels/deliverables.js` |
| `plumi:open` postMessage | `public/sw.js` | `js/panels/notify.js`, `js/library.js` |
| `plumi-turn-done` tag | `public/sw.js` | `js/panels/notify.js` |
| `window.PlumiUI` | `public/ui.js` | settings / operations / grid |
| `window.PlumiTheme` | `public/theme.js` | `js/panels/theme-toggle.js`, settings |

## Safety

- Secrets live only in `.env` (gitignored). Agent turns get a scrubbed environment
  (`scrubbedEnv` in `server/claude.js`); `ANTHROPIC_API_KEY` is deliberately kept
  because the SDK subprocess needs it.
- `/api/ops/*`, the terminal, and engine updates are **owner-only**, not admin —
  each one escapes containment.
- The server binds loopback by default and refuses to start on a public interface
  with no auth configured. Do not "helpfully" relax either.

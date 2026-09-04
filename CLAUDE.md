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

**Never weaken member confinement.** `/api/chat` clamps members to `default`
permission mode server-side because `acceptEdits`/`bypassPermissions` skip
`canUseTool`, which *is* the confinement. Both layers are fail-closed and must stay
that way.

**Platform differences go in `server/platform.js`,** never inline. Probe for a
binary; never infer from `process.platform`. If a feature can be unavailable, give
it a row in `server/capabilities.js` with a `reason` a human can act on.

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

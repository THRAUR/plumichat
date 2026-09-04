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

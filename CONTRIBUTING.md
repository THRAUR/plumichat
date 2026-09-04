# Contributing

Issues and pull requests are welcome. This is a personal project run in the open, so
expect a human-speed response rather than a triage rota.

**The most useful contributions right now are macOS and Windows fixes.** Everything
platform-specific is isolated in `server/platform.js` and written against each
platform's documented behaviour, but only Linux is actually tested. If something
does not work on your machine, that is a real bug and I would like to know.

## Getting set up

```bash
git clone https://github.com/YOUR-USERNAME/plumichat.git
cd plumichat
npm install
npm start                      # http://localhost:3002
npm run dev                    # same, with --watch
```

There is no build step and no transpiler. What you edit is what runs: `public/` is
served as-is, so a browser reload is the whole frontend loop.

### Working against a throwaway instance

Never develop against the data directory you actually use. Give the dev server its
own everything:

```bash
PORT=3099 DATA_DIR=/tmp/pc-dev/data WORKSPACES_ROOT=/tmp/pc-dev/ws npm start
```

## Checks before you open a PR

There is no test framework — deliberately — but there are real checks.

```bash
# 1. Syntax gate for everything you touched
node --check server/thing.js

# 2. Does it actually LOAD? node --check validates syntax only, so a missing
#    import survives it. This is the check that catches that.
node --input-type=module -e "await import('./server/thing.js')"

# 3. If you touched server/operations.js or server/ops/*, run the harness.
#    It hashes function bodies and characterises the public exports: a refactor
#    must change nothing observable.
node scripts/ops-harness/behaviour.mjs before
#    ...make your change...
node scripts/ops-harness/behaviour.mjs after
```

### Frontend changes

Drive a headless Chromium over CDP against a throwaway server and assert the page
renders with a clean console. Two passes are worth repeating after any layout
change:

- a walk of every surface at 320 / 390 / 768 / 1280, measuring horizontal overflow,
  escaping elements, clipped text and tap targets under 30px
- a DOM smoke test asserting the nav racks, the composer's two rows, the settings
  sections and the accent derivation

## House rules

These are not style preferences; each one has a bug behind it.

**Comments explain WHY, and they are load-bearing.** The codebase is dense with
comments recording *why* something is the way it is — which bug, which platform
quirk, which trade-off. Do not strip them, and do not reformat code you are not
changing.

**Three client rules.** Break any and the page renders as dead static HTML:

1. **Nothing may import `public/app.js`.** It is the entry, loaded with a `?v=`
   cache-buster, so an `import` of `/app.js` is a *different URL* and the browser
   evaluates a second copy. Shared code goes in `public/js/`.
2. **Modules declare; they do not wire themselves up.** Listeners, restored
   preferences and first fetches go in an exported `initX()` that `app.js` calls in
   a specific order.
3. **A binding is written only by the module that declares it.** Cross-cutting state
   lives in `js/state.js`. Read through the imported live binding; write through
   that module's setter.

**Design tokens live in `public/plume.css`, and only there.** Do not redeclare one in
a page stylesheet — that drift is exactly what plume.css exists to end. `--accent` is
a *fill*; never write `color: var(--accent)`, use `--accent-text`.

**Style an avatar with `background-color`, never the `background` shorthand.** The
shorthand resets `background-image`, which is how the profile photo is delivered.

**One writer for the task store.** `updateTasks()` in `server/ops/store.js` is the
only function that may write it. It fires the change event that open boards listen
to; calling `update()` directly persists correctly and is invisible on screen.

**Never weaken member confinement.** `/api/chat` clamps a member's permission mode to
`default` server-side because `acceptEdits`/`bypassPermissions` skip `canUseTool` —
which *is* the confinement. If a change touches that path, say so explicitly in the
PR.

## Adding a platform-specific behaviour

Put it in `server/platform.js`, not inline. Two rules:

1. **Probe, never infer from the platform.** "macOS therefore no pandoc" is wrong.
   Look for the binary.
2. **If a feature can be unavailable, give it a row in `server/capabilities.js`**
   with a `reason` written for a human who has to go install something. The client
   hides the surface and the startup banner names the gap.

## Commit messages

Describe the behaviour that changed and why, not the files you touched. The git log
is documentation.

## Security

Do not open a public issue for a vulnerability. Use GitHub's private vulnerability
reporting. See [docs/SECURITY.md](docs/SECURITY.md).

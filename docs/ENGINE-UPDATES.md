# Engine updates

How PlumiChat updates the Claude engine it runs on, from the phone, without being able to
break the server that is serving the phone.

Implemented in [`server/engine.js`](../server/engine.js); surfaced as the owner-only
Engine card (`/api/engine/*`). Everything here is deliberately **read + stage + prove**,
stopping one step short of shipping — the ship flow stays the human one in
[`CLAUDE.md`](../CLAUDE.md).

---

## 1. There are two engines, and they update separately

They carry almost the same version number, which makes it very easy to believe there is
only one. There are two, they are separate installs, and updating one does nothing to the
other.

| | Chat engine | Terminal CLI |
|---|---|---|
| What it is | `@anthropic-ai/claude-agent-sdk` in `node_modules`, which **bundles its own CLI binary** (~215 MB) | The natively installed `claude` |
| Where it lives | `<repo>/node_modules/@anthropic-ai/claude-agent-sdk` | `~/.local/share/claude/versions/<version>`, with `~/.local/bin/claude` symlinked to the active one |
| What uses it | Every chat turn (`server/claude.js` → `query()`), Operations runs, title generation | The owner terminal panel, and therefore the interactive CLI's own features such as `/design-sync` |
| How it updates | `npm install` → a `package.json` bump that has to be shipped like any other code change | `claude install <version>`, in place, no repo involved |
| Version line | `0.3.x` | `2.1.x` |
| Auto-update | Off (`autoUpdates: false` in `~/.claude.json`) | Off, same setting |

Two consequences worth internalising:

- **A repo deploy does not move the terminal CLI**, and installing a CLI version does not
  move the chat engine. `engineStatus()` reports both plus the SDK's `bundledCli` — the CLI
  build the chat engine actually spawns, which is *not* the terminal's binary even when the
  numbers match.
- Releases ship roughly daily. `@anthropic-ai/claude-code` publishes both a `latest` and a
  more conservative `stable` dist-tag; the SDK publishes only `latest`.

---

## 2. What the panel reads

`engineStatus()` answers "what am I on, what is published, how far behind am I" and degrades
field-by-field: no npm, no network or a renamed binary nulls a single field instead of
failing the card.

- Installed SDK version, resolved through `require.resolve` — the copy the **running**
  process actually loaded, not whatever happens to sit in `../node_modules`.
- Installed CLI version, from `claude --version` called by **absolute path** (PM2's `PATH`
  does not contain `~/.local/bin`, so a bare `claude` is `ENOENT`).
- Published versions from `npm view <pkg> dist-tags --json`.
- `behind`: how many published releases sit between you and the head of the changelog. More
  honest than a version delta — 0.3.240 → 0.3.258 is eighteen releases, not eighteen of
  anything else.
- `paths`: where an update would and would not go, so the UI can state it rather than ask
  you to trust an invisible rule.

`whatsNew()` returns the changelog sections newer than your installed version, per engine.

### Changelog sources

```
https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md              (~600 KB)
https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md (~64 KB)
```

Both are cached **on disk** at `DATA_DIR/engine-changelog-{cli,sdk}.md` with a 30-minute TTL.
The disk cache is the point: when the box is offline or GitHub is unreachable is exactly when
someone is most likely to be poking at the engine, and a stale answer beats no answer. A
served-from-cache response is flagged `stale: true`. Only the head of each file is parsed —
both are newest-first, and nobody reads 600 KB of history on a phone.

---

## 3. The staged update

`applyUpdate({ target, version, dryRun, prune })`, where `target` is `sdk`, `cli` or `both`.
`dryRun` defaults to **true**: the safe call proves the new version works and changes nothing.

```
 1. refuse if busy      a chat turn is running → stop. The canary spawns another
                        ~340 MB CLI on a 5.9 GB box, and the CLI target repoints
                        ~/.local/bin/claude under any live interactive session.
 2. stage               copy the dev repo's package.json + lock into
                        ~/plumi-engine-staging and run a REAL
                        `npm install --ignore-scripts @anthropic-ai/claude-agent-sdk@<v>`
                        there. Staging is a sibling of the live clone, never inside it.
 3a. canary             write a tiny script into staging and run it in a CHILD PROCESS:
                        one real `query()` turn on model haiku that must reply "OK".
                        A child, because a new SDK that throws on import, hangs or leaks
                        must not be able to destabilise the live server — and an ES
                        module, once imported, can never be unloaded again.
 3b. Options diff       parse `export declare type Options` out of the staged sdk.d.ts and
                        compare it with today's. Two different answers:
                          lost           — a key claude.js passes that the new version
                                           dropped  → real breakage, fails the update
                          alreadyMissing — a key claude.js passes that TODAY already
                                           ignores → a pre-existing bug, not this upgrade
                        (A renamed option fails silently: the CLI just ignores it, and the
                        symptom surfaces three days later as "the model picker broke".)
 4. verdict             dryRun stops here, having proved it without moving a file the app
                        loads.
 5. promote             the ONLY write into a real repo: copy the vetted package.json +
                        package-lock.json into the DEV repo. Nothing else — not
                        node_modules, not a commit, not a push.
```

The terminal-CLI target is simpler because there is no repo in the loop: `claude install
<version>` drops the binary in `versions/` and repoints the symlink. With `prune: true` it
also deletes older versions — 852 MB of stale ones was in the audit — never the running one
and never the one just installed.

Every attempt, successful or not, is appended to the `engine-updates` store (last 50,
readable via `updateLog()`). When turns start failing three days later, "what did I change
to the engine, and when" is the first question.

### What it will never do

Hard rules, enforced in code by `assertNotLive()` on every filesystem write:

1. **Never `pm2` anything.** The session asking for the update is streaming *through* the
   live server; a restart from in there kills the very turn that requested it.
2. **Never install into the live clone** (`$PLUMI_LIVE_CLONE`). An `npm install`
   there swaps the SDK under a running process: the live server keeps the old module in
   memory and the next turn spawns a half-written binary.
3. **Never commit, never push, never touch git at all.** Shipping stays the human flow.

`engine.js` ships to the live clone like every other file, so it runs from *both* copies.
That is why the dev path is resolved explicitly rather than "relative to this file" — on the
live box, relative-to-this-file *is* the live clone.

### Env tunables

| Variable | Default | Purpose |
|---|---|---|
| `PLUMI_DEV_REPO` | the running checkout | The one tree a promote may write into |
| `PLUMI_LIVE_CLONE` | `$PLUMI_LIVE_CLONE` | The tree every write is checked against and refused |
| `PLUMI_ENGINE_STAGING` | `~/plumi-engine-staging` | Scratch install target |
| `PLUMI_ENGINE_NPM_MS` | `600000` | npm timeout; the SDK ships a ~215 MB binary |

Point the first three somewhere harmless when running the isolated test server
(`DATA_DIR` + `PORT`), so a test run can never write near the real trees.

---

## 4. After a green update — activating it

A successful non-dry run leaves the **dev repo's manifest bumped and its `node_modules`
untouched**. Nothing is live yet. Finish it by hand:

```bash
cd /path/to/plumichat
npm install                      # NOT --ignore-scripts here: node-pty must compile
git add package.json package-lock.json
git commit -m "Agent SDK: <old> -> <new>"
git push
```

Then the live clone. **A `git pull` moves the manifest, not `node_modules`** — without the
install step the server keeps running the old SDK and the version card keeps saying so:

```bash
cd ~/plumi-remote-terminal
git pull                         # or the in-app Deploy button
npm install                      # see the warning below
```

> Prefer `npm install` over `npm ci` in the live clone. `npm ci` deletes `node_modules`
> outright, and every chat turn spawns its CLI binary from there — doing that under a
> running server breaks any turn in flight and any turn started before the restart. Run it
> when nothing is running, and restart immediately after. (The in-app Deploy button does
> run `npm ci`, but only when the lockfile actually moved and no turn is running — and if
> that install fails it withholds `restartRequired` and warns, because a restart into a
> half-installed `node_modules` cannot boot. Fix it over SSH before restarting.)

Then **ask the user to restart** from the side-menu control. No agent restarts PM2.

---

## 5. Rollback

The bump is one line in `package.json`, so rolling back is the same flow with the old
version number:

```bash
cd /path/to/plumichat
npm install @anthropic-ai/claude-agent-sdk@<previous>
git commit -am "Agent SDK: roll back to <previous>"
git push
cd ~/plumi-remote-terminal && git pull && npm install
# then ask the user to restart
```

If the live server is *already broken* and waiting for a push is too slow, install directly
in the live clone and restart:

```bash
cd ~/plumi-remote-terminal
npm install @anthropic-ai/claude-agent-sdk@<previous>
# then ask the user to restart
```

…but reconcile the dev repo straight afterwards. That leaves the live clone with a dirty
`package.json`/lock, and the next `git pull` there will refuse or conflict — which is a much
worse problem to discover during the *next* incident.

Terminal CLI rollback is independent and takes effect immediately for new shells:

```bash
claude install <previous>        # repoints ~/.local/bin/claude
claude --version
```

An interactive `claude` already running inside the tmux session keeps the binary it started
with until that session is restarted.

---

## 6. Doing it entirely by hand

For when the button is unavailable — the server is down, or the change is being made from
the Ubuntu terminal.

```bash
# what is published
npm view @anthropic-ai/claude-agent-sdk dist-tags --json    # 'latest' only
npm view @anthropic-ai/claude-code       dist-tags --json    # 'stable' and 'latest'

# what is installed
node -p "require('/path/to/plumichat/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version"
~/.local/bin/claude --version

# what changed
curl -s https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md | head -100
curl -s https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md | head -100

# stage and prove it, exactly as the panel does
mkdir -p ~/plumi-engine-staging && cd ~/plumi-engine-staging
cp "/path/to/plumichat/package.json" \
   "/path/to/plumichat/package-lock.json" .
npm install --ignore-scripts @anthropic-ai/claude-agent-sdk@<version>
cat > canary.mjs <<'EOF'
import { query } from '@anthropic-ai/claude-agent-sdk';
let text = '';
for await (const m of query({ prompt: 'Reply with the single word OK',
  options: { model: 'haiku', persistSession: false, maxTurns: 1, settingSources: [] } })) {
  if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'text') text += b.text;
  if (m.type === 'result') break;
}
console.log('canary:', JSON.stringify(text));
EOF
node canary.mjs

# what the option surface gained or lost
diff <(grep -oP '^    \K[A-Za-z_$][\w$]*(?=\??\s*:)' \
        "/path/to/plumichat/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts" | sort -u) \
     <(grep -oP '^    \K[A-Za-z_$][\w$]*(?=\??\s*:)' \
        ~/plumi-engine-staging/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts | sort -u)
```

Green? Then copy `package.json` + `package-lock.json` from staging into the dev repo and
follow §4. Red? Delete `~/plumi-engine-staging` — nothing else was touched.

The terminal CLI, by hand:

```bash
claude install <version>                  # installs + repoints the symlink
ls -la ~/.local/bin/claude
du -sh ~/.local/share/claude/versions/*   # old versions are ~200 MB each; delete all but the live one
```

# PlumiChat Operations — Build Plan

Companion to [`OPERATIONS.md`](./OPERATIONS.md) (the operating rules). This is the
*how/when* — architecture, phased tasks at file level, and the prior-art we're
borrowing from. Written 2026-06-04; revised same day after deciding the
**box-sleeps + GitHub** deployment model (see §3).

---

## Status as of 2026-09-02

**The original note at the top of this file said "nothing here is built yet beyond what
`OPERATIONS.md` tags [BUILT]. No `server/*` code has changed." That has not been true for
months, and it was wrong in both directions.**

Since 2026-06-04, `server/operations.js` grew a complete **per-task** pipeline —
worktree-isolated run → reviewable patch → human approval → fail-closed apply → optional
test gate → commit and push. Meanwhile **none of the architecture in this document** was
built: no session batching, no GitHub, no PRs, no drain, no new modules. The 2026-09-02
a codebase audit flagged the drift; this
section and the re-tagged sections below are the correction.

### What shipped, mapped onto this plan's phases

| This plan says | Reality on 2026-09-02 |
|---|---|
| Phase 0 — `projects` + `sessions` collections, `tasks` → `requests` | **Not built.** One `operations` collection of tasks, plus an `opsNotes` collection for cross-area handoff notes. Tasks, not requests; no sessions. |
| Phase 0 — `drain.js`, `data/ops.busy`, `GET /api/ops/status` | **`GET /api/ops/status` is built** and returns `{ busy, running, queued, nextDueAt }` — the idle signal §3.1 asks for. `drain.js` and `data/ops.busy` are **not built**; nothing runs on boot. |
| Phase 0 — `operations.js` → `session.js` draining N requests into ONE worktree | **Not built.** One worktree per *task*. |
| Phase 1 — `github.js`, issues, branch, PR, `Closes #N`, merge observation | **Not built.** Operations never contacts GitHub. It commits and pushes on the project's current branch. |
| Phase 1 — onboarding, charters, repo-map, domain discovery, `.plumi/ops/` | **Not built.** Nothing writes that directory. |
| Phase 1 — routing by domain ownership | **Not built.** The human picks one of seven fixed areas on the form. |
| Phase 1 — two-tier report (`report.js`) | **Half.** The short summary is built (a required `### Summary` block, split from the narration, first line becomes the commit subject). The long executive report is not. |
| Phase 1 — UI lanes by status | **Built**, and better than planned: `GET /api/ops/meta` publishes the server's own status lanes, categories, retryable set, fix cap and per-project test-gate flags, so the board stopped keeping its own copy. |
| Phase 1 — `notify.js` | **Not built.** The runner has no notification hook of any kind. |
| Phase 1.5 — `sandbox-exec.js` (bwrap) to re-enable Bash | **Not built** — but see below: the gate landed without it. |
| Phase 1.5 — green-build gate | **Built, inverted.** The suite runs *after* the human approves, gating the push rather than the approval. |
| Phase 2 — passive ingest, reviewer agent, metrics, SQLite | **One foot in.** A configured project's redacted production error digest is fetched server-side and injected into its runs as context. No reviewer agent, nothing auto-files a task, no metrics, still the JSON store. |

### The two most important deviations

1. **Verification did not wait for the sandbox, because the orchestrator runs the tests.**
   §2's "deterministic shell, smart core" principle turned out to be the answer to Phase 1.5,
   not just an architectural preference. The server resolves a project's test command
   (a `.venv` plus pytest), runs it itself in a time-boxed child process, and treats exit
   code 5 as *no gate* rather than red. The agent's Bash is still denied — in the isolated
   run and in the fix-up passes alike. Principle 4 ("green-or-it-doesn't-ship") is real
   today without a single line of `sandbox-exec.js`.

2. **The human gate moved to the wrong side of verification.** Principle 4 wanted green as
   a *precondition for review*. The code approves first, applies to the real tree, then
   verifies and ships. That is a materially different risk posture: the operator approves an
   unverified diff, and the unattended stage runs in their repository rather than in a
   worktree. Restoring the designed order means running the suite **inside the worktree,
   before** approval — which is the honest remaining case for a sandbox (or simply for
   running the suite against the worktree, since the *server* is the one running it).

### What the shipped pipeline got right that this plan under-specified

Worth keeping if any of this is rebuilt. All of it came out of the audit's H4:

- **A patch is not safe to apply just because it exists.** Apply refuses when a target path
  is already dirty and *names the paths*; dry-runs with `git apply --check`; checks for
  unmerged index entries after a 3-way apply (a conflicted merge can still exit 0); and on
  any failure rolls the patch's own paths back and parks the task in a terminal,
  non-approvable `apply_failed`. This plan's Phase 0 never mentions the failure path.
- **Commit scope must be attributed, not inferred.** "Everything that changed since we
  started" sweeps in a concurrent chat turn or the operator's own edit. The scope is now
  *the patch's paths ∪ the paths a fix-up agent actually wrote*, both recorded at the moment
  they happen (from git's own numstat, and from the tool calls themselves). Anything else
  that changed is reported on the task and left alone.
- **Git plumbing must be NUL-delimited.** Porcelain C-quotes any path with a space or a
  non-ASCII byte; this operator's filenames are routinely Traditional Chinese, and they were
  being silently dropped from the ship. Every path now comes from `-z` output, sliced by
  offset, never split on a delimiter.
- **Path commands must run at the repo root.** `git status` prints repo-root-relative paths;
  `git add`/`commit` interpret pathspecs relative to the cwd. Those agree only when the
  project *is* the repo root.
- **Ownership is a security boundary.** Every `/api/ops/*` route is owner-only. Admin-only
  let an invited admin run autonomous agents on any project and push under the box's git
  identity.
- **The vocabulary belongs to the server.** Statuses, categories and tunables were
  maintained in four places; they now live in one and are published by `/api/ops/meta`.

### Still true, still the direction

Everything below stays as written, re-tagged. The session model, charters and domain
memories, GitHub-issue intake, PR-merge approval and the sleep contract are the intended
shape — they are simply not what the code does. **Before rebuilding any of it, read §9**:
Claude Code now ships primitives that overlap large parts of this architecture.

### Tag legend

| Tag | Meaning |
|---|---|
| **[BUILT]** | In the code today, in the shape described. |
| **[PARTIAL]** | Something real exists, in a different shape. |
| **[NOT BUILT]** | No code. Still the intended direction. |
| **[PHASE 2]** | Deferred on purpose. |

---

## 0. Decisions locked (2026-06-04)

All five stand as the agreed direction. **None is in the code.**

| Topic | Decision | Today |
|---|---|---|
| Deployment | **Box truly sleeps** most of the day. PlumiChat owns the wake/sleep mechanism; PlumiChat must be *compatible* (run-on-wake, signal-when-idle). | **[PARTIAL]** — signal-when-idle exists (`GET /api/ops/status`); run-on-wake does not. |
| Intake / queue | **GitHub Issues** — file a request as an issue from the phone; durable + audit-logged + works while the box is asleep. | **[NOT BUILT]** — the in-app board is the only intake. |
| Approval → main | **Merge the session's Pull Request** = approval = lands on `main`. | **[NOT BUILT]** — approval is a tap in the app; a green gate pushes to the current branch. |
| Specialists | Discovered per project at onboarding. | **[NOT BUILT]** — a fixed seven-value area enum. |
| Artifacts (memory + reports) | Committed in the project repo under `.plumi/ops/`. | **[NOT BUILT]** — memory is run history + handoff notes in PlumiChat's store. |

---

## 1. Prior-art synthesis — what we steal, what we avoid

Surveyed: Claude Code Action, OpenHands, SWE-agent, Aider, Sweep, Ellipsis, Tusk,
CodeRabbit, Cursor background agents, Copilot coding agent, Devin, Sourcegraph
Batch Changes, plus orchestrators (Composio AO, Bernstein).

**Steal:**
- **Cron/CI-triggered headless agent that opens a PR** (Claude Code Action, Sweep,
  Ellipsis) — exactly our wake→work→PR shape. **[PARTIAL]** — scheduled headless runs are
  built (per task, on a ticker); the PR half is not.
- **Worktree-per-run isolation** (Cursor bg agents, Composio AO) — we already have it. **[BUILT]**
- **Deterministic orchestration** (Bernstein): queue draining, worktree setup,
  routing, branch/PR plumbing = plain code, zero LLM. Model only for index/code/report.
  **[BUILT]** — and it paid off more than expected; see the Status section.
- **Run tests/lint and self-iterate before proposing** (Ellipsis, Sweep, Tusk):
  green build is a precondition for opening the PR for approval. **[BUILT, INVERTED]** —
  tests run and a capped fix-up loop self-iterates, but *after* approval, gating the push.
- **Aider tree-sitter repo-map** (AST symbol graph + PageRank, no embeddings) to
  split a codebase into domains and route a request — cheap to refresh per commit. **[NOT BUILT]**
- **Issue→PR linking** (`Closes #N`) so merging auto-closes the request. **[NOT BUILT]**
- **Per-repo "Learnings" memory from feedback** (CodeRabbit) → common + per-domain memory.
  **[PARTIAL]** — prior-run outcomes and cross-area handoff notes are injected into the next
  run, with an explicit instruction to treat a recurring problem as a failed previous fix.
  It lives in PlumiChat's store, not the repo.
- **State-grouped dashboard** (Composio AO) — operations.html lanes by status. **[BUILT]**

**Avoid:** *(all still avoided, and mostly still unproven — the guards below are the ones
that exist)*
- **Fat, sprawling diffs** — localized changes merge, big ones get rejected. Mitigate
  "one commit per session" with a split threshold (§6). **[NOT BUILT]** — no threshold.
  The review pane truncates a large patch for display but applies it whole.
- **Auto-merge without a human gate** (the cardinal sin) — the PR merge is the gate; never
  auto-merge. **[HELD]** — the gate is the in-app Accept instead, and it is non-skippable.
- **Approving on a red build** — #1 failed-PR cause. **[INVERTED]** — see the Status
  section. The operator today approves *before* anything has been verified; the suite gates
  the push, not the approval.
- **Free-for-all agent swarms** — keep specialists loosely coupled, single-writer per
  worktree, deterministic merge. **[HELD, trivially]** — one agent per task.
- **Prompt-injection from repo files / issue text** — untrusted; redact secrets; a
  README/issue can't dictate actions. **[PARTIAL]** — respected in the live-signals path
  (server-side key, redacted at source); no scanner, no enforcement, and reads are not
  path-confined.
- **Context token blow-up** — budget the repo-map/memory. **[PARTIAL]** — the injected
  memory is capped (a handful of prior runs, a bounded set of notes, a truncated signal
  digest). There is no repo-map to budget.

---

## 2. Architecture principles

1. **Deterministic shell, smart core.** Orchestrator (issue drain, schedule,
   worktree, routing, branch/PR, idle signal) = plain Node. LLM only for index/code/report.
   **[BUILT]** — the single most load-bearing principle in the shipped code.
2. **Session is the unit.** A wake's queued issues for one project batch into one
   session → one worktree → one PR → one merge. **[NOT BUILT]** — the task is the unit.
3. **Single-writer worktree.** Specialists run **sequentially** in one worktree → one clean
   diff. **[BUILT]** — one writer, because there is one agent.
4. **Green-or-it-doesn't-ship.** A PR is only opened-for-approval if verification passes;
   else it stays draft/`needs_attention`. **[BUILT, INVERTED]** — green gates the *ship*,
   not the review. `verify_failed` / `ship_failed` stand in for `needs_attention`.
5. **Human gate, reversible.** Merge = approval; a bad merge is revertable. **[PARTIAL]** —
   the gate is the in-app Accept; reversal is a manual `git revert`.
6. **Crash-safe via GitHub.** All work is pushed to a remote branch before the box can power
   down — nothing lives only on the sleeping box. **[NOT BUILT]** — an unshipped task lives
   entirely on the box, as a patch file under `DATA_DIR`. An interrupted run is recovered by
   re-running the task, not from a remote.
7. **Untrusted inputs.** Repo files, issue text, LINE messages, tickets are untrusted;
   secrets never enter reports/memories. **[PARTIAL]** — see §1.

---

## 3. The sleep-compatible architecture **[NOT BUILT — except the idle signal]**

PlumiChat powers the box up/down on his own schedule. PlumiChat's job is to be a clean
**run-on-wake, signal-when-idle** worker, with GitHub as the always-up surface for
both intake (issues) and approval (PR merge).

```
 Phone (GitHub app, abroad) ──▶ open an Issue, label ops:queued    [GitHub: always up, durable]
                                          │
       PlumiChat's external trigger powers the box UP at a set hour
                                          ▼
        [PlumiChat boots] ── run-on-wake drain (deterministic):
          git pull main  →  fetch open `ops:queued` issues per project
          →  ONE worktree  →  specialists (sequential)  →  verify (green)
          →  push session branch  →  OPEN PR  (body = short summary,
             "Closes #12, #15"; long report committed under .plumi/ops/reports/)
          →  write IDLE signal ───────────▶ PlumiChat's controller powers box DOWN
                                          │
   (box asleep)  PlumiChat opens the PR on his phone, taps Merge ──▶ squash-merge → main
                                          │                          (auto-closes the issues)
                                          ▼
        next wake: git pull the merged main, drain newly-queued issues
```

**Why this is sleep-safe:** intake (issues) and approval (merge) both happen on
GitHub, which is always up and phone-accessible from Asia — so the box only needs
to be awake to *do work*, never to receive requests or to approve them. Because the
branch + PR are pushed before the idle signal, powering down loses nothing.

**What runs instead today:** a 30-second ticker sweeps for due scheduled tasks while the
process is up. Intake, approval and the work all require the box to be awake and PlumiChat to
be reachable. A task in `needs_approval` waits, unnotified, until someone opens the board.

### 3.1 Integration contract with PlumiChat's wake/sleep controller
PlumiChat exposes a tiny, stable contract so PlumiChat's power mechanism can drive it:
- **On boot:** a one-shot drain runs automatically. Provide all three so PlumiChat can
  pick: (a) a `systemd`/PM2 boot hook that calls it, (b) `POST /api/ops/drain` for a
  controller to hit, (c) an idempotent "already draining" guard. **[NOT BUILT]** — no
  drain, no boot hook, no `/api/ops/drain`. The runner does resume its schedule ticker on
  boot, so *scheduled* work restarts by itself; queued work waits for the next tick.
- **Idle/busy signal:** PlumiChat maintains `data/ops.busy` (present = working) **and**
  `GET /api/ops/status → { busy, sessions[] }`. The controller powers down when idle.
  **[PARTIAL — this is the one piece that exists]** `GET /api/ops/status` is live and
  owner-only, returning `{ busy, running[], queued, nextDueAt }`: `busy` is true whenever a
  task is running, verifying, fixing or shipping, or anything is queued, and `nextDueAt` is
  the earliest upcoming scheduled run. A controller has everything it needs to decide
  "nothing here objects to sleeping". The `data/ops.busy` file does not exist — a file is
  still worth adding for a controller that cannot make an authenticated HTTP call.
- **Safe-to-sleep guarantee:** PlumiChat only goes idle after every session branch + PR
  is confirmed pushed to the remote. If a run is interrupted, the next boot recovers
  from the remote branch / marks the session `error`. **[NOT BUILT]** — an interrupted
  run leaves a task mid-status and its patch on local disk. Interrupted *worktrees* are now
  pruned rather than leaked, and a failed run is retryable in place — but only while nothing
  of it has reached the operator's tree.
- **Catch-up on wake:** every boot does `git fetch && pull` (or rebases the worktree
  base) so it builds on already-merged PRs. **[NOT BUILT]** — but the *symptom* it guards
  against is now handled at the other end: a patch captured against a HEAD that has since
  moved fails the apply gate, rolls back and parks in `apply_failed` telling the operator to
  re-run against current code.

> The actual power-up/down (Windows Task Scheduler "wake to run", WoL, BIOS RTC) is
> PlumiChat's to own — PlumiChat just has to be drain-on-boot + idle-signalling.

---

## 4. Data model & new modules **[NOT BUILT]**

None of these modules exists. Everything below lives in one file, `server/operations.js`,
plus its routes in `server/index.js`.

**Store collections** (`server/store.js`) — *planned:*
- `projects`: `{ id, name, path, repo, charter, schedule?, domains[], status, memoryDir }`
- `requests`: `{ id, projectId, issueNumber, prompt, source: github|manual|line|ticket, status, createdAt }`
- `sessions`: `{ id, projectId, requestIds[], status, worktree, branch, prNumber, prUrl, diff, shortSummary, reportPath, verify:{…}, startedAt, finishedAt }`

*Actual, today:* one `operations` collection of task records (project folder name, prompt,
area, model, optional schedule, status, summary/detail, per-file diff breakdown, ship files,
test output, ship commit) capped to a bounded history of terminal tasks; plus an `opsNotes`
collection of cross-area handoff notes. Patches and worktrees are files under `DATA_DIR`.

**Session status machine** — *planned:*
`scheduled → running → verifying → pr_open (awaiting merge) | needs_attention → merged`
(+ `rejected`, `error`, `cancelled`). "Approve" is no longer a PlumiChat endpoint — it's a
GitHub merge PlumiChat observes.

*Actual, today* (task, not session, and defined once in `operations.js` and published by
`/api/ops/meta`): active `queued | scheduled | running | verifying | fixing | shipping |
needs_approval`; terminal `applied | shipped | done | rejected | cancelled | error |
verify_failed | ship_failed | apply_failed`; retryable-in-place `error | cancelled |
apply_failed | verify_failed | ship_failed`.

**New server modules — all [NOT BUILT]:**
- `server/github.js` — Octokit-ish wrapper: list/label issues, create branch/PR,
  poll merge state, close issues. Token from `.env` (repo scope).
- `server/onboarding.js` — charter + repo-map (tree-sitter) + domain discovery →
  writes common/domain memories under `<project>/.plumi/ops/`.
- `server/intake.js` — durable queue, default adapter = GitHub Issues (manual/local fallback).
- `server/session.js` — the session runner (refactor of `operations.js`): one
  worktree, sequential specialists, verify, diff, report, branch, PR.
- `server/drain.js` — the run-on-wake entrypoint + idle signal + safe-to-sleep guard.
- `server/report.js` — two-tier report (short PR body + long executive md, fixed schema).
- `server/notify.js` — optional LINE/push on PR-opened. *(PlumiChat now has a Web Push layer;
  this is the cheapest unbuilt item in either document — the runner has no notification
  hook at all today.)*
- `server/sandbox-exec.js` — Phase 1.5: bwrap-confined Bash so specialists run tests.
  *(A bubblewrap sandbox now exists in PlumiChat for member chat Bash. The building block is
  on the box; nothing points it at the Operations runner.)*

**Touched:** `server/operations.js` (→ `session.js`), `server/index.js` (routes:
`/api/ops/drain`, `/api/ops/status`, webhook), `server/claude.js` (specialist
context), `server/sandbox.js` (read-confinement + bwrap), `public/operations.html`
(session lanes + PR links + verify status), `public/settings.html`/new onboarding view.
*(Of these, only `/api/ops/status` exists — alongside `/api/ops/meta` and the per-task patch
route, which this plan never anticipated but the review gate needed. The audit also
recommends splitting `operations.js` and replacing the board's full poll with SSE.)*

---

## 5. Phased plan (file-level)

### Phase 0 — Foundations
- [ ] Add `projects` + `sessions` collections; migrate `tasks`→`requests`. **[NOT BUILT]**
- [~] `server/drain.js`: idempotent run-on-wake drain + `data/ops.busy` + `GET /api/ops/status`.
      **[PARTIAL]** — `GET /api/ops/status` shipped inside `operations.js`. No drain, no busy file.
- [ ] Refactor `operations.js` → `session.js` that drains N requests in ONE worktree → one
      combined diff. **[NOT BUILT]** — one worktree per task.

### Phase 1 — The GitHub loop (edit-and-review; no Bash yet)
- [ ] `server/github.js`: read `ops:queued` issues, create branch + PR with `Closes #N`,
      poll/observe merge. **[NOT BUILT]**
- [ ] **Onboarding:** charter form → folder pick → indexing → repo-map → propose domains →
      write `<project>/.plumi/ops/{charter.md,memory/common.md,memory/domains/*.md}`.
      **[NOT BUILT]** — the folder pick's sandbox + git checks exist.
- [ ] **Routing:** map each issue to domain(s) via repo-map ownership. **[NOT BUILT]**
- [ ] **Session run:** sequential specialists in one worktree (common + domain memory);
      capture combined diff. **[PARTIAL]** — one agent in one worktree, fed run-history and
      handoff-note memory; diff capture is built and binary-safe.
- [ ] **Reporting:** `report.js` → short PR body + long report in `.plumi/ops/reports/`.
      **[PARTIAL]** — short summary built; long report not.
- [ ] **PR open + idle:** push branch, open PR, write idle signal. **[NOT BUILT]**
- [ ] **Merge observation:** webhook or next-wake poll marks session `merged`; pull main.
      **[NOT BUILT]**
- [x] **UI:** operations.html lanes (queued / running / … / merged) with PR links.
      **[BUILT, without PR links]** — and the lanes now come from `/api/ops/meta` rather than
      a client-side copy, plus a patch route so the operator reads the diff before approving.
- [ ] Optional `notify.js` LINE/push when a PR opens. **[NOT BUILT]**

### Phase 1.5 — Sandbox unlock (enables real verification)
- [ ] `sandbox-exec.js`: **bwrap**-confined Bash (fs = worktree, network off/allowlisted) →
      re-enable Bash safely. **[NOT BUILT]** — Bash stays denied for the runner and the
      fix-up agent. *The verification this was blocking arrived anyway: the server runs the
      suite itself.* What a sandbox would still buy is (a) letting the agent iterate against
      tests inside the worktree before approval, and (b) closing the network gap.
- [x] **Green-build gate:** specialists run the domain's tests/lint; PR opens for approval
      only if green, else `needs_attention` + capped self-iteration.
      **[BUILT, INVERTED]** — the *server* runs pytest after the human approves, with a
      capped confined fix-up loop on red, and ships only on green. Exit code 5 counts as no
      gate; a timeout counts as "could not verify". Projects without a `.venv` + pytest stop
      at `applied`.
- [ ] Path-confine reads/Grep/Glob (close info-disclosure gap). **[NOT BUILT]**

### Phase 2 — Passive pipelines (the payoff)
- [~] Ingest LINE transcripts + error/bug/ticket streams → **reviewer agent** screens →
      auto-files issues. **[PARTIAL]** — a project can be configured with a production error
      digest endpoint; PlumiChat fetches it server-side (the API key never enters a prompt, a
      tool call or the agent's view) and injects a redacted "what is broken now" section into
      that project's runs. No reviewer agent; nothing is auto-filed.
- [ ] Quality metrics on bot in/out; dashboards. **[NOT BUILT]**
- [ ] Graduate the store to **SQLite** for analytics. **[NOT BUILT]** — still the JSON store,
      now with a bounded history cap so `operations.json` cannot grow forever.

---

## 6. Added features (from prior art) — triaged

| # | Feature | Phase | Status | Note |
|---|---|---|---|---|
| 1 | **Squash-merge = 1 commit/session** | 1 | **[NOT BUILT]** | No PR. One commit per *task*, on the current branch, scoped to that task's own files. |
| 2 | **Revert path** | 1 | **[NOT BUILT]** | Manual `git revert`. The ship records the short SHA and branch on the task, which is what you need to do it. |
| 3 | **Green-build gate** + capped self-iteration | 1.5 | **[BUILT, INVERTED]** | Runs after approval, gates the push. Capped fix-up passes are built. |
| 4 | **Session split threshold** | 1.5 | **[NOT BUILT]** | No threshold. The review pane truncates a large patch for display; the apply is whole-patch. |
| 5 | **Optional async plan-gate for risky tasks** | 1.5 | **[NOT BUILT]** | |
| 6 | **Saved trajectory / replay** per session | 1.5 | **[PARTIAL]** | A bounded per-task event log (tool calls, notices, errors) plus the agent's full narration is kept and shown in the detail pane. Not a replayable trajectory. |
| 7 | **Executive report fixed schema** | 1 | **[PARTIAL]** | The *short* recap has a fixed schema, enforced by an output suffix on every run and parsed back out. The long report does not exist. |
| 8 | **bwrap ephemeral sandbox** | 1.5 | **[NOT BUILT here]** | Built elsewhere in PlumiChat (member chat Bash). Not wired to Operations. |
| 9 | **Cross-project fan-out** | later | **[NOT BUILT]** | |
| 10 | **Cross-area handoff notes** | — | **[BUILT, unplanned]** | A run may leave a note for another area; that area's next run receives it, and it is acknowledged only on a terminal success. The nearest thing to inter-specialist communication that exists. |

---

## 7. Open items & risks

**Still to confirm** *(all still open)*
- PR-merge-as-approval vs. keep direct-to-main-with-in-window-approval. **The code took the
  second option by default**, without the decision being revisited: approval is an in-app tap
  and a green gate pushes to the current branch.
- Does each managed project have a GitHub remote? GitHub intake needs one; non-GitHub
  projects fall back to local/manual intake. *(Today the ship step needs only a working
  `git push origin <current branch>`; it refuses on a detached HEAD and reports a failed push
  verbatim rather than pretending.)*
- One GitHub token (repo scope) in `.env`; pick fine-grained PAT vs a GitHub App. *(Today the
  push borrows the box's own git credentials — which is exactly why `/api/ops/*` had to
  become owner-only.)*

**Risks**
- Bash-disabled until Phase 1.5 ⇒ no real verification in Phase 1. **Resolved differently:**
  the server runs the suite. The residual is that the agent cannot iterate against tests
  before approval.
- Merge blast radius ⇒ mitigated by the PR gate + green-build gate + revert path.
  **Partly unmitigated:** there is no PR gate. The mitigations that exist are the apply
  gates, the attributed commit scope, the green suite, and never force-pushing or skipping
  hooks.
- Interrupted run while powering down ⇒ everything is on the remote branch; next boot
  recovers. **Not true today:** an unshipped task exists only on the box. Worktrees are
  pruned and failed runs are retryable, but the recovery story is "re-run it".
- Memory tokens/cost ⇒ repo-map budget + summarized memories. **Bounded, not budgeted.**
- Subagent memories are siloed ⇒ route shared facts up to common memory. **Still true**; the
  handoff-note mechanism is the partial answer.
- **New, from the audit: the network is not sandboxed.** The worktree gates *file* changes
  behind review. Fetch-capable tools are allowed during a run, and the apply/verify/ship
  stages operate on the operator's real repository.

---

## 8. The first PR I'd open **[SUPERSEDED BY EVENTS]**

Phase 0 + the GitHub read path: `projects`/`sessions` in the store, `drain.js`
(run-on-wake + idle signal), `github.js` issue-read, and the `session.js` refactor
that drains a project's `ops:queued` issues into **one** worktree and produces
**one** combined diff + summary — stopping at a **draft PR** (no auto-merge, no
sandbox). That lands the whole sleep→drain→PR spine end-to-end with near-zero risk;
onboarding, the green-build gate, and the bwrap sandbox follow as separate PRs.

*What actually got built first was the opposite half — hardening the per-task pipeline that
already existed, because it was the thing running unattended against real repositories. If
this plan is picked up again, the first PR should be re-chosen against §9 rather than
restarted from here.*

---

## 9. What Claude Code now ships that overlaps this design

**Written 2026-09-02.** Most of §3's spine — background sessions, worktree isolation,
scheduling, listing and re-attaching — is now a first-class feature of the `claude` CLI that
PlumiChat already has installed and already drives in the owner terminal. Before rebuilding a
bespoke runner, weigh becoming **the phone UI over these primitives** instead.

The relevant surface, from the installed CLI:

| Primitive | What it gives you | Which part of this plan it covers |
|---|---|---|
| `claude --bg` (`--background`) | Starts a session in the background and returns immediately, printing an id that `claude attach`, `logs`, `stop` and `rm` take. With `--resume <session-id>` it continues an existing session. | The runner's whole process-lifecycle problem: spawning, detaching, reattaching, stopping. |
| `-w, --worktree [name]` | Creates a git worktree for the session. (`--tmux` additionally puts it in a tmux session.) | §2 principle 3 and Phase 0's worktree setup — the isolation PlumiChat hand-rolls. |
| `claude agents` / `claude agents --json` | Lists active sessions (interactive *and* background) as JSON without needing a TTY — explicitly for scripting. `--all` includes completed ones, `--cwd <path>` filters by directory. `respawn [id]` restarts one, or all. | The board's state model and the `GET /api/ops/status` idle signal, for free and from the source of truth. |
| `/schedule` | Cron-scheduled routines. Note these are **cloud** agents, not box-local — a different execution environment from everything in this document. | Phase 0's scheduling, if the work suits running off-box. |
| `/loop` | Runs a prompt or slash command on a recurring interval, locally, optionally self-paced. | The 30-second ticker and recurring routines, box-local. |

**What that would change.** PlumiChat stops owning: worktree creation and teardown, worktree
leak-pruning, the abort/cancel plumbing, the run registry, and most of the status vocabulary.
It keeps owning the things no CLI will do for it — the **approval gate**, the **fail-closed
apply**, the **attributed commit scope**, the **test gate**, ownership/auth, and the phone UI.
That is the right split: those five are the parts this repo got right and had to fix by hand,
and they are exactly the parts a generic background-agent runner does not have opinions about.

**What to check before committing to it,** none of which is answered yet:

- Can a background session's *file changes* be held back for review, or does it write
  directly into its worktree with no gate before the human sees them? The whole safety model
  here is "the diff is reviewed before it reaches the operator's tree".
- Can a per-session tool policy be enforced (the equivalent of denying Bash and confining
  writes), or does confinement have to move to the OS sandbox at that point?
- `/schedule` running in the cloud is a real architectural difference — a cloud agent cannot
  see this box's projects. Box-local recurrence is `/loop` or PlumiChat's own ticker.
- Both engines update roughly daily and independently (see
  [`ENGINE-UPDATES.md`](./ENGINE-UPDATES.md)). Building on CLI flags means the staged canary
  in `server/engine.js` becomes load-bearing for Operations too, not just for chat.

The audit files this as **F10**, after the phone-experience and security work — and notes
that rebuilding on native primitives removes most of finding **H4** rather than patching it.
Its flag spelling for the worktree option differs from the installed CLI's; the table above
is what `claude --help` reports today.

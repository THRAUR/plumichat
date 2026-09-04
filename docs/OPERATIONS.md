# PlumiChat Operations — Rules & Operating Model

> **Two documents.** This one holds the *operating rules*. The architecture, the
> phased file-level tasks and the prior-art survey live in
> [`OPERATIONS-BUILD-PLAN.md`](./OPERATIONS-BUILD-PLAN.md).

---

## Status as of 2026-09-02

**Read this before trusting anything below it.**

The body of this document was written on 2026-06-04 as a *spec*. For three months
its tags were wrong in both directions: work tagged **[NEW]** had shipped, and work
tagged **[BUILT]** had never been written. The full-codebase audit
A codebase audit called that out. This
section, and the re-tagged sections beneath it, are the correction.

The one-line version: **the code implements a per-*task* pipeline; this document
specifies a per-*session* one.** Both are coherent designs. Only the first one runs.

### Tag legend

| Tag | Meaning |
|---|---|
| **[BUILT]** | In the code today, in the shape the section describes. |
| **[PARTIAL]** | Something real exists, in a different shape. The note says how it differs. |
| **[NOT BUILT]** | No code. Still the intended direction — kept on purpose, not left behind by accident. |
| **[SUPERSEDED]** | The code deliberately went the other way. Kept as the record of a decision that was reversed. |
| **[PHASE 2]** | Deferred on purpose. |

### What exists today

The unit of work is a **task**, and one task is one run:

- **Isolated run.** A queued task runs the Agent SDK autonomously inside a throwaway
  git worktree checked out at the project's current HEAD. File writes are confined to
  that worktree by `canUseTool`; Bash is denied outright; `AskUserQuestion` auto-proceeds
  because nobody is watching. Nothing touches the operator's working tree during the run.
- **Patch, then a human tap.** The result is captured as a binary-safe patch
  (`git diff --cached --binary`) plus a summary, and the task parks in `needs_approval`.
  A per-task patch route serves that diff to the board, so the approval gate is no longer
  blind — the operator reads the change before allowing it near their tree.
- **Apply that fails closed.** Accept refuses when any file the patch touches is already
  dirty (and names those files), dry-runs with `git apply --check`, checks for unmerged
  index entries after a 3-way apply, and on any failure rolls the patch's own paths back
  and parks the task in `apply_failed` — a terminal, non-approvable, re-runnable status.
  The old behaviour left conflict markers in the real tree with the Accept button still armed.
- **An optional test gate that ships.** Where a project has a `.venv` and pytest, an
  automated stage runs the suite against the applied tree; on red a confined fix-up agent
  gets a capped number of repair passes; on green the task's changes are committed and
  pushed. The commit scope is strictly *the patch's paths ∪ the paths a fix-up agent
  actually wrote*, recorded from the tool calls themselves — so a concurrent chat turn or
  an operator edit during the verify window is logged and left alone, never swept into an
  `ops:` commit. pytest exit code 5 ("no tests collected") counts as *no gate*, not as red;
  a timeout is reported as "could not verify", not as green. **Projects with no test gate
  stop at `applied`: no gate, no unattended push.**
- **Git plumbing is NUL-delimited** end to end, so filenames with spaces and CJK
  characters survive the ship instead of being silently dropped.
- **Owner-only.** Every `/api/ops/*` route is gated on the owner. They used to be
  admin-only, which let an invited admin run autonomous agents against any project and
  push under the box's git identity.
- **Synchronous board APIs.** `GET /api/ops/meta` publishes the server's own categories,
  fix-attempt cap, status lanes, retryable set and per-project test-gate flags, so the
  client stops maintaining a fourth copy of the vocabulary. `GET /api/ops/status` reports
  `{ busy, running, queued, nextDueAt }` — **this is the idle signal §7 and the build plan
  asked for**, and it is real.
- **Lifecycle correctness.** Cancel takes effect during a run's first seconds instead of
  being a silent no-op; deleting a task is refused while it is in flight; Accept and Reject
  hold a transition lock so a double-tap cannot apply a patch twice; interrupted runs no
  longer leak registered git worktrees.

Intake and memory, as they actually work:

- **Intake is the in-app board.** A form: project, prompt, area, model, optional schedule.
  Schedules are per *task* — one-off, daily or weekly, in the timezone of the device that
  set them — and a single global runner takes them one at a time.
- **An optional live production signal.** A project can be configured (`data/ops-signals.json`
  or the `OPS_SIGNALS` env var) with a base URL, path and API key; PlumiChat fetches a redacted
  error digest server-side and injects it into that project's runs as the freshest "what is
  broken right now" section. The key never enters a prompt or a tool call. This is the closest
  thing to a passive pipeline that exists — but it is *context for a run*, not an auto-filed task.
- **Memory is prompt-injected, not committed.** Each run is handed a summary of the prior
  runs of the same routine (with their outcomes and ship commits) and any cross-area handoff
  notes addressed to its area, plus instructions to treat a recurring problem as a failed
  previous fix. That memory lives in the task store, not in files in the project repo.

### What is not built

None of the following exists in any form. It is kept below because it is still the
intended direction, not because anyone believes it shipped.

- **The session** as the unit of work — batching a project's due tasks into one run, one
  worktree, one combined diff, one approval.
- **Onboarding**: charters, the indexing pass, discovered domains, specialist agents,
  common and per-domain memories, and the whole `<project>/.plumi/ops/` artifact tree.
  Nothing writes that directory.
- **GitHub Issues intake**, session branches, pull requests, `Closes #N` linking, and
  **approval by merging a PR**. Operations never talks to GitHub. It commits and pushes on
  the project's *current branch*.
- **The long executive report.** The short summary exists; the two-tier report does not.
- **The sleep contract, half of it.** `GET /api/ops/status` is real. `POST /api/ops/drain`
  and the `data/ops.busy` file are not; nothing runs a drain on boot.
- **The modules the build plan names**: `github.js`, `drain.js`, `session.js`, `report.js`,
  `onboarding.js`, `intake.js`, `notify.js`, `sandbox-exec.js`. None of them exist;
  everything lives in `server/operations.js`.
- **Any Operations notification.** Nothing in the runner reaches the push layer, so a task
  parking in `needs_approval` does not reach a locked phone.

### Four things that landed inverted, and are worth knowing

1. **Approval is a precondition for verification, not the other way round.** §7 says a
   session reaches `needs_approval` only once its tests are green. The code does the
   reverse: the human approves the patch, it is applied to the real tree, *then* the gate
   runs and ships on green. The human therefore approves an unverified diff, and the
   automated stage is what runs unattended in their tree.
2. **Verification arrived without the Phase 1.5 sandbox** — because the *server* runs the
   test suite as plain code (`resolveTestCommand` + a time-boxed spawn), not the agent. The
   agent's Bash is still denied, in both the isolated run and the fix-up passes. §4's rule
   stands for the agent; it stopped being a blocker for the gate.
3. **The commit-and-push §2.5 called a reversal has happened** — for gated projects only.
   §7 then superseded it with PR-merge approval, which has *not* happened. So the "superseded"
   note in §2.5 currently points at something less real than the thing it supersedes.
4. **Areas are a fixed enum, not discovered domains.** Seven server-owned categories
   (`general`, `payments`, `translation`, `support`, `health`, `branding`, `billing`)
   group and colour the board and route handoff notes between runs. They are not discovered
   per project, they carry no memory file, and one agent — not a specialist — runs the task.

### One invariant, added 2026-09-04

`updateTasks()` in `server/operations.js` is the **only** writer of the task store. It exists so the
board can be pushed rather than polled: it fires `onOpsChange`, which `index.js` streams to any open
board over `GET /api/ops/stream`. A new mutation that calls `update(COLLECTION, …)` directly would
still persist correctly and still be completely invisible to every board on screen — which is a far
more confusing bug than a write that fails. Route it through `updateTasks()`.

### One risk that is still real

The isolated run gates **file** changes behind human review; it does not sandbox the
**network**. Bash is denied, but the reading and fetching tools are allowed by default, and
stages 2–3 (apply, verify, ship) operate on the operator's real repository. Treat repo
contents and any ingested signal as untrusted input.

---

## 0. Locked decisions (2026-06-04)

Five decisions, all still the agreed direction, **none of them in the code today**.

| Question | Decision | Today |
|---|---|---|
| How a session's work reaches main | **Merge the session's Pull Request** (async, from the phone) = approval = lands on `main`. Supersedes "push straight to main": the box is asleep at approval time, so the gate lives on GitHub. | **[NOT BUILT]** — approval is a tap in the app; a green gate commits and pushes to the current branch. No branch, no PR. |
| How specialists / domains are defined | **Discovered per project** by the onboarding agents. | **[NOT BUILT]** — a fixed seven-value area enum, server-owned, published by `/api/ops/meta`. |
| Where memories + long reports live | **In the project repo** (committed → travels to GitHub). | **[NOT BUILT]** — memory is prior-run summaries and handoff notes in PlumiChat's own store, injected into the prompt. |
| How sessions are timed | **Box sleeps; PlumiChat owns wake/sleep.** PlumiChat drains the queue on wake and signals idle once the PR is open. | **[PARTIAL]** — the idle signal exists (`GET /api/ops/status`); the drain-on-wake does not. Scheduling is per-task, on a ticker, and assumes the box is up. |
| How requests are filed | **GitHub Issues** (filed from the phone; durable while the box sleeps). | **[NOT BUILT]** — the in-app board is the only intake. |

---

## 1. Core concepts

- **Project (onboarded).** An Operations-managed project: a folder path, a
  *charter*, a discovered set of *domains*, per-domain + common *memories*, and a
  *schedule*. Must be a git repo with at least one commit. **[PARTIAL]** — the
  git-repo and sandbox-containment requirements are **[BUILT]**, and `/api/ops/meta`
  reports which root projects exist and which have a test gate. There is no onboarded-
  project *record*: no charter, no domains, no memory directory, no per-project schedule.
  A task simply names a folder.
- **Charter.** The detailed context PlumiChat gives at onboarding: what he wants
  Operations to do for this project, priorities, no-go zones, and the working
  definition of "good." **[NOT BUILT]**
- **Domain + Specialist.** A discovered area of mastery inside the project (e.g.
  "LINE webhook", "billing", "chat UI"). Each domain has its own memory and is
  worked by a specialist agent fed by *its* memory + the common memory.
  **[PARTIAL]** — a fixed enum of seven *areas* exists and does three things: it
  groups and colours the board, it seeds the commit subject, and it addresses the
  cross-area handoff notes a run may leave for another area's next run. Nothing is
  discovered, there is no per-domain memory file, and there is no specialist agent —
  one agent runs the whole task.
- **Common memory.** Shared project context every specialist reads: architecture,
  stack, conventions, glossary, build/test commands, risk areas. **[NOT BUILT]**
- **Request / Task.** A unit of requested work tied to one project; enters that
  project's queue. **[BUILT]** — and it is the unit the runner actually operates on.
- **Session.** All of a project's due work, run together at a scheduled hour →
  one combined commit + one report + one approval. **[NOT BUILT]**

---

## 2. Lifecycle (the rules)

### 2.1 Onboarding — one-time per project, re-runnable **[NOT BUILT]**

Only step 3's checks exist. There is no onboarding flow, and nothing writes `.plumi/ops/`.

1. **Add project** in Operations.
2. **Charter:** PlumiChat asks for detailed context (what Operations should do here,
   priorities, no-go zones, definition of "good"). Saved as `.plumi/ops/charter.md`.
3. **Folder:** pick the exact folder via the file service (must resolve inside the
   sandbox root, and be a git repo w/ a commit). **[BUILT: sandbox + git checks]**
4. **Indexing:** a team of latest-Opus agents reads the whole codebase in parallel
   and *compartmentalizes* it:
   - Writes the **common memory** → `.plumi/ops/memory/common.md`.
   - **Discovers domains** and writes a memory per domain →
     `.plumi/ops/memory/domains/<domain>.md` (what it owns, key files, invariants,
     how to test it, known pitfalls).
   - Proposes the domain roster for PlumiChat to confirm/edit before it's saved.
5. All onboarding artifacts are **committed to the project repo** so they reach
   GitHub. (Re-running indexing refreshes them as the project evolves.)

> Open point, still open: today transcripts may use `.plumi/` in each project.
> Operations artifacts would live under `.plumi/ops/` to avoid clashing, and would be
> intentionally committed (verify the transcript dir's gitignore status during build).

### 2.2 Intake & routing **[PARTIAL]**

- Every request must name a project (the picker). It enters that project's queue
  as `queued`. **[BUILT]**
- At session start a cheap **router/triage** pass reads the request + common
  memory + domain index, tags the domain(s) it touches, and names the lead
  specialist. Batching groups the queue by domain. **[NOT BUILT]** — the human
  picks the area on the form; nothing routes, nothing batches.
- Request sources:
  - **Manual** (PlumiChat types one) — Phase 1. **[BUILT]**, and it is the only source.
  - **Passive pipelines** (LINE transcripts, error/bug/ticket streams) — **[PHASE 2]**;
    a reviewer agent pre-screens each ("is this good / does this need a fix?") and only
    then files a task. **[PARTIAL]** — a configured project's redacted **production error
    digest** is fetched server-side and injected into its runs as a "what is broken now"
    section. There is no reviewer agent and no auto-filed task: the digest steers an
    existing scheduled run rather than creating work.

### 2.3 Scheduled session — per-project set hours **[PARTIAL — per task, not per session]**

- Each project has its own schedule (set hours, a few times/day). At a slot, if
  the queue has due items, **one session** runs. **[PARTIAL]** — the schedule lives on
  a *task*, not a project: one-off, daily or weekly, in the timezone of the device that
  set it, swept by a ticker. A due task spawns its own run; nothing batches a project's
  due work together.
- **One session at a time globally** — projects take turns. **[BUILT: single
  `running` flag / `kick()`]** — one *task* at a time, globally.
- Mechanics:
  1. Create **one** isolated worktree at the project's HEAD. **[BUILT]** — one per task.
  2. Run the involved specialists **in sequence** inside that single worktree
     (router order), each fed its domain memory + common memory + its task(s).
     Edits stack → the session produces **one combined diff**. **[NOT BUILT]** — one
     agent, one task, one diff. It *is* fed the operational memory described above.
  3. Each specialist **verifies its own work** (runs the domain's tests/lint).
     ⚠️ Requires Bash, currently disabled for safety — see §4. **[NOT BUILT, and
     partly unnecessary]** — the agent still cannot run anything, but the *server* runs
     the suite after approval. See §4 and inversions 1–2 in the Status section.
  4. Capture the combined diff + each specialist's notes. **[BUILT: diff capture]** —
     with a per-file breakdown recorded at capture time, so the review pane costs no git call.

### 2.4 Reporting — two tiers **[PARTIAL]**

- **Short summary** = the commit message body. Per problem: what was wrong → how
  it was fixed → how it works now. This is what PlumiChat reads to approve. **[BUILT]** —
  every run is asked for a `### Summary` block, which is split out of the narration so
  the board shows the recap by default and the reasoning a tap away. Its first line
  becomes the commit subject; the full body is the agent's narration, not a curated report.
- **Long executive report** ("before-the-PDF" writeup): full detail across all
  specialists — decisions, trade-offs, verification results, residual risks.
  Saved to `.plumi/ops/reports/<date>-<session-id>.md` (on disk + GitHub). **[NOT BUILT]**

### 2.5 Approval → main **[PARTIAL — the reversal happened; the PR did not]**

> The original note here read "superseded by §7 (box-sleeps): approval is now merging the
> session's PR". That is still the *intent*, but PR-merge approval is **[NOT BUILT]**,
> while the in-app commit-and-push below **is** what runs. The supersession is on paper only.

- Session lands in `needs_approval` with the combined diff, the short summary, and
  a link to the long report. **[PARTIAL]** — a *task* lands in `needs_approval` with its
  diff (readable through the patch route) and its short summary. No long report.
- PlumiChat reviews and approves (one tap). **[BUILT]**
- On approval: apply the combined diff to the working tree → **commit** (short
  summary as the message; the long report committed alongside under
  `.plumi/ops/reports/`) → **push straight to main**.
  **One session = one commit = one push.** **[PARTIAL]** — Accept applies the patch to
  the real working tree, fail-closed (see the Status section). Where the project has a
  pytest gate, a green suite then commits *the task's own files* and pushes to the
  **current branch** — not necessarily `main`, never force, never `--no-verify`, and never
  a file the task did not touch. Where there is no gate, it stops at `applied` and the
  commit is the operator's to make.
- **This reverses today's behavior**, where Accept = `git apply --3way` into the
  working tree *uncommitted, never pushed*. The new Accept commits + pushes. **[BUILT
  for gated projects; the ungated path is still apply-and-stop.]**
- **Reject** discards the session (worktree + patch dropped). **Modify** = send
  back with notes and re-run. **[BUILT: reject]**. **[PARTIAL: modify]** — a task that
  has not started can be edited, and a *failed* run can be retried in place; there is no
  "send back with notes" from `needs_approval`, and a task already applied to the tree
  refuses a retry rather than duplicating the work.

### 2.6 Feedback loop **[PARTIAL]**

- After a pushed session, update the touched domain memories + common memory with
  what changed and how it works now, so specialists keep mastering their area.
  Committed with the session (or folded into an indexing refresh). **[NOT BUILT as
  written]** — nothing writes memory files, and nothing is committed as memory. What
  exists instead: each run of a recurring routine is handed the outcomes and summaries
  of its own prior runs (with ship commits) and any open handoff notes from other areas,
  and is told to treat a recurring problem as a *failed* previous fix rather than repeat
  it. Handoff notes are acknowledged only when a run reaches a terminal success, so a
  cancelled run cannot swallow another area's message. It is a real feedback loop; it
  lives in PlumiChat's store, not in the project repo.

---

## 3. State machine

**Today [BUILT]** — the real vocabulary, defined once in `server/operations.js` and
published to the board by `/api/ops/meta` (the audit found it maintained in four places):

- **Active / awaiting a human:** `queued`, `scheduled`, `running`, `verifying`, `fixing`,
  `shipping`, `needs_approval`. Never pruned from history.
- **Terminal:** `applied`, `shipped`, `done`, `rejected`, `cancelled`, `error`,
  `verify_failed`, `ship_failed`, `apply_failed`.
- **Retryable in place:** `error`, `cancelled`, `apply_failed`, `verify_failed`,
  `ship_failed` — but only while nothing of the task has reached the operator's tree.
- The happy paths are `queued → running → needs_approval → applied` (no test gate) and
  `queued → running → needs_approval → verifying → [fixing] → shipping → shipped` (gated).

**Target [NOT BUILT]:**
- Task: `queued → routed → (batched into session)`
- Session: `scheduled → running → needs_approval → committed → pushed`
  (or `rejected` / `error`)
- The Accept transition moves from `→ applied` to `→ committed → pushed`.
  (That last move has effectively happened for gated projects — see §2.5 — but for a
  *task*, not a session, and without a PR.)

---

## 4. Constraints baked into the rules

- **Verification needs a real sandbox.** Specialists must run tests/lint to prove
  a fix is good, but the autonomous policy currently **disables Bash** (it can
  escape the worktree via `cd`/absolute paths). Rule: re-enabling Bash for
  autonomous runs requires real OS sandboxing (bwrap/container). Until then,
  sessions are **edit-and-review only**; verification is static/best-effort.
  **[PARTIAL — the rule holds; the conclusion no longer does]** Bash is still denied,
  in the isolated run *and* in the fix-up passes, and re-enabling it still requires real
  OS sandboxing. But verification no longer waited for that: the **server** runs the
  project's suite itself, as plain code, in a time-boxed child process after the patch is
  applied. The agent never gets a shell; the deterministic shell runs the tests. The
  remaining gap is real but narrower — an agent cannot iterate against the suite *inside
  the worktree, before* the human approves.
- **Commit + push is deliberate.** It overrides the current "never auto-commit,
  never push" safety stance — but it stays **human-approved** (the approval tap),
  never unattended. **[BUILT]** — and the module header now says so. It said the opposite
  for months, which is how the audit found it. The push happens *after* the tap and *only*
  behind a green suite, and it is scoped to the task's own files.
- **Lifeline first.** Operations never touches system services, networking, or
  ports. Pushes happen only after PlumiChat approves. (See `system-constraints`.) **[BUILT]**
- **Sandbox containment.** Project folders must resolve inside the allowed root.
  **[BUILT: sandbox.js]**
- **No secrets in artifacts.** Reads aren't path-confined today, so reports and
  memories must never embed secrets; redact `.env`-like content. **[NOT BUILT as a
  guard]** — nothing scans a summary for secrets. The one place it was designed in is the
  live-signals fetch, where the API key is used server-side and never enters a prompt, a
  tool call or the agent's view, and the digest is redacted at its source. Reads are still
  not path-confined.
- **The network is not sandboxed. [STANDING RISK]** The worktree gates *file* changes
  behind human review. Fetch-capable tools are allowed by default during a run, and the
  apply/verify/ship stages operate on the operator's real repository. Repo files and any
  ingested signal are untrusted input.

---

## 5. Phasing

- **Phase 1 (now):** onboarding (charter + folder + indexing → common/domain
  memories committed under `.plumi/ops/`), manual intake, per-project schedule,
  single-worktree multi-specialist session, two-tier report, approve → commit →
  push to main. Verification limited until the sandbox lands.
  **[PARTIAL]** — manual intake, scheduling (per task), the isolated worktree, the short
  summary and approve → commit → push all landed. Onboarding, domain memories, the
  multi-specialist session and the long report did not.
- **Phase 1.5:** OS sandbox (bwrap/container) → re-enable confined Bash →
  specialists run tests; path-confine reads. **[NOT BUILT — and partly overtaken]** The
  test gate exists without it (the server runs the suite). A bwrap sandbox now exists in
  PlumiChat for *member chat* Bash, so the building block is on the box and could be pointed
  at the Operations runner; nothing does that yet. Reads are still unconfined.
- **Phase 2 (passive):** ingest LINE transcripts + error/bug/ticket streams →
  reviewer agent screens → auto-files tasks; quality metrics. The JSON store is
  the seam to graduate to SQLite for this analytics phase. **[PHASE 2 — one foot in]**
  The production error digest is a live ingest of exactly this kind, but it is injected as
  run context, not screened and filed as a task. No metrics; still the JSON store.

---

## 6. Repo artifact layout (managed projects) **[NOT BUILT]**

Nothing writes this tree today. Operations keeps everything in PlumiChat's own store and in
`DATA_DIR` (worktrees and patches); nothing of it reaches the project repo except the
`ops:` commit itself.

```
<project>/.plumi/ops/
  charter.md                     # the onboarding context
  memory/common.md               # shared project context
  memory/domains/<domain>.md     # one per discovered specialist
  reports/<date>-<session>.md    # long executive reports
```

All committed (these are the artifacts that should reach GitHub).

---

## 7. Amendments from prior-art research (2026-06-04)

Rules added/sharpened after surveying Claude Code Action, OpenHands, Aider, Sweep,
Ellipsis, CodeRabbit, Cursor, Devin, Sourcegraph et al. Details + sources in the
build plan.

- **Box sleeps; PlumiChat is wake-compatible. [DECISION — half built]** PlumiChat powers the box
  up/down himself; PlumiChat runs a deterministic **drain-on-wake** (git pull → read
  GitHub `ops:queued` issues → session → open PR) and writes an **idle signal**
  (`data/ops.busy` + `GET /api/ops/status`) once the PR is pushed, so the controller
  can power down safely. Intake (GitHub Issues) and approval (PR merge) both live on
  GitHub — always up and phone-reachable from abroad — so the box is only awake to
  *do work*.
  **Today: `GET /api/ops/status` is built** and returns `{ busy, running, queued, nextDueAt }`
  — `busy` false, `queued` zero and no imminent `nextDueAt` means nothing in Operations
  objects to the box sleeping. The drain-on-wake, the `data/ops.busy` file and the whole
  GitHub half are **[NOT BUILT]**.
- **Green build is a precondition for approval. [BUILT, INVERTED]** A session reaches
  `needs_approval` only if its tests/lint pass; otherwise `needs_attention`.
  **Today the order is the other way round:** the human approves the patch, it is applied
  to the real tree, and *then* the suite runs and gates the push. So a green build is a
  precondition for **shipping**, not for approval — the operator approves an unverified
  diff, and `verify_failed` / `ship_failed` are the statuses that stand in for
  `needs_attention`. Getting the designed order back means running the suite *inside the
  worktree before* approval, which is the honest remaining case for the Phase 1.5 sandbox.
- **Approval = PR merge; reversible. [NOT BUILT]** Approval is merging the session's
  PR (squash → one commit on `main`), done from the phone — supersedes "push
  straight to main" because the box is asleep at approval time. The gate stays
  non-skippable; a bad merge is reversible (revert PR / next-wake `git revert`).
  **Today:** approval is a tap in PlumiChat; the gate is non-skippable but it is *in* the app,
  so it only works while the box is up. Reversal is a manual `git revert`.
- **Notify-to-approve. [NOT BUILT]** Opening the PR already notifies via GitHub; an
  optional LINE/push mirrors it. PlumiChat approves from the phone anytime — the box
  can be asleep. **Today:** the runner has no notification hook at all. A task can sit in
  `needs_approval` indefinitely with nothing telling anyone. PlumiChat now has a Web Push
  layer; wiring the board's `needs_approval` transition into it is the cheapest item in
  this whole document.
- **Untrusted inputs. [PARTIAL]** Repo files, LINE messages, and tickets are untrusted
  (prompt-injection); secrets never enter reports or memories. **Today:** the principle is
  respected in the live-signals path (server-side key, redacted at source) and the digest
  is fed to the agent as data. There is no scanner and no enforcement.
- **Deterministic orchestration. [BUILT — the strongest-held principle here]** Queue,
  schedule, worktree, routing, and the commit gate are plain code; the model is used only
  to index, code, and report. Everything except the agent's own edits is plain Node: the
  ticker, the worktree, the patch capture, the apply gates and rollback, the test run, the
  ship scope and the commit. It is also *why* the test gate could ship without a sandbox.
- **Fat-diff guard. [NOT BUILT]** "One commit per session" keeps a split threshold: a
  session whose diff is too large splits into multiple commits to stay reviewable.
  There is no threshold; the review pane truncates a large patch for display but applies
  it whole.
- **Memory/indexing approach. [NOT BUILT]** Aider-style tree-sitter repo-map for
  domain discovery + routing; per-domain memories + a shared common memory
  (subagent memories are siloed, so shared facts route up to common). The memory that
  exists is run history and handoff notes (§2.6), not a repo map.

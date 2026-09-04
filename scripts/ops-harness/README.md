# Operations refactor harness

`server/operations.js` drives an autonomous agent against real git working trees
and has no unit tests. This is what made splitting it (audit § 4.3) a safe change
rather than a hopeful one, and it is here so the next person moving code in that
module can do the same thing instead of reading 2,000 lines and hoping.

Two independent checks, because they catch different mistakes:

**`bodies.py` — did anything get rewritten on the way across?**
Extracts every top-level function from a set of files, normalises whitespace and
hashes the body. A mechanical move should report every function as either moved
or unchanged, and nothing as disappeared or altered. Any intentional edit shows up
by name, so it is declared rather than buried in a large diff.

```
python3 scripts/ops-harness/bodies.py before server/operations.js
# ...do the move...
python3 scripts/ops-harness/bodies.py after server/operations.js server/ops/*.js
python3 scripts/ops-harness/bodies.py diff
```

**`behaviour.mjs` — does the module still DO the same thing?**
A characterisation test: it exercises the public exports against a throwaway
`DATA_DIR` and records everything it sees, including thrown errors. Run it before
the change to make a golden file, run it after, diff the two.

```
node scripts/ops-harness/behaviour.mjs before
# ...do the move...
node scripts/ops-harness/behaviour.mjs after
```

It deliberately never calls `runNow()`, `acceptTask()` or `initRunner()` — those
start an autonomous agent or apply a patch to a real tree. Every task it creates is
scheduled for 2030, because `createTask()` with no schedule calls `kick()` and the
runner would pick it up immediately.

Two things it learned the hard way, kept as comments in the code:

- The fixture task has to be injected THROUGH `store.js`, not by writing the JSON
  file. `store.read()` memoises per collection, so a file written behind its back is
  never seen — the first cut of this harness quietly recorded `needsApproval: 0`.
- Board order for tasks that tie on `createdAt` is settled by their random id, so it
  is stable within a run but not reproducible across runs. Assert the CONTENT of the
  list, and assert stability separately by reading it twice.

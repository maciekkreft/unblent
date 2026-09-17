# Plan: test flakiness and speed

Baseline 2026-09-17, quiet box (load 0.1), browser phase only: 105 tests, 183 s, all pass.
Slowest: dock 16.5/13.3 s, reader 16.0/12.8 s, cm6 7.9/7.1 s (webkit/chromium).
Tests > 4 s: layout switch (webkit 4.6 s), delete commits (4.1 s). Budget is 5 s wall clock.

## RESULT (2026-09-17)

Full both-engine gate 183s → 158.9s (144s at low load). Everyday gate is now WebKit + scoped:
all-tests WebKit ~86–96s, a single stem far less. 0 failures. 8 headroom warnings name the book +
dock tests (3.2–3.9s) for later. **Shared browser was dropped**: measured 86s vs 86s WebKit-only
with/without it — `--experimental-test-isolation=none` already shares the node process, launches are
cheap and once-per-suite, so it gave 0 speedup, used more RAM, and degraded the shared WebKit
process enough to fail book-toc after ~10 suites. The real speedup was dropping `networkidle`. A2/A3
reverted in architecture.md; A1 (lock + headroom) and A4 (scoped WebKit gate) kept. Also fixed two
flakes surfaced: book-reader reader-app (reload raced cold `?since=` fetches → await sync first) and
note-editor-cm6 j/k motion (transient caretLine mis-read mid-remeasure → `restLine` settles first).

| # | Step | Status |
|---|---|---|
| 0 | Amendments A1, A4 applied; A2/A3 (shared browser) reverted after measurement | done |
| 1a | `check.py`: exclusive `flock` on `.check.lock` around the test phase; a second run waits and says so | todo |
| 1b | `check.py`: browser phase uses a reporter that yields per-test durations; print a named warning for every test over 50% of budget (not a failure) | todo |
| 1c | Fix the tests the warning names: find where the 2.5 s+ goes (trace per test), remove fixed sleeps, use `page.clock` where a real timer is waited on | todo |
| 2a | `checks/browsers.mjs`: one real browser per engine per process; `launch()` returns a handle whose `close()` closes only the contexts opened through it; relaunch if the real browser disconnected; rule becomes "a test owns its contexts" | todo |
| 2b | Replace `waitUntil: "networkidle"` (24 sites) with `domcontentloaded` + the wait for the element each test already does next | todo |
| 2c | Re-measure; record numbers here; bare `check.py` passes; commit "Test speed" | todo |
| 3 | Scoped gate (amendment A4) — separate decision, not part of this commit | drafted |

Order: 1a → 1b → 2a → 2b → 1c (1c last: the overhead removal changes which tests are slow).
Verification: run the browser phase once before/after with the spec reporter, compare totals and
the >50% list; then once more with a second `check.py --only notes` started concurrently to see
the lock hold. No looping to measure flakiness.

Not in scope: moving page assertions into machine tests (done per component when next touched).

## Amendment drafts (architecture.md) — need approval

**A1, §11 intro, after "…a slow test is found by name rather than hidden in a total."**
> One test phase runs at a time on a host: the check takes an exclusive lock before its tests and a
> second run waits for it, because a wall-clock budget means nothing while two runs share the cores.
> A test that uses more than half its budget is named in a warning, so a test with no headroom is
> found before load makes it fail.

**A2, §11.2 row "A test owns its browser" → "A test owns its contexts"**
> Browser rule: the check preloads a hook that keeps one browser per engine for the run and hands
> each test a handle to it; closing the handle closes the contexts the test opened. The hook fails
> any test leaving a context open when it ends, closes it at once, and fails the run if a suite
> leaves one open, so a timed-out test cannot leak pages into the next and exhaust the host.

**A3, §10 Tests row**, append: "One browser per engine is shared by the run; a test isolates itself with its own context."

**A4 (step 3), §11 — replaces "one `check` command is the definition of done: a bare `check.py`…"**
> The definition of done is `check.py --changed`: every static rule, every Node and API test, and
> the WebKit browser tests reachable from the change (its one-hop bus partners and page-mates); an
> infrastructure change still reaches everything. The bare `check.py` — every test, WebKit then
> Chromium — is the push gate: a pre-push hook runs it, and nothing is pushed red. Chromium runs at
> task end only for tests that exist for it alone (the WebAuthn ceremony). The task-end gate so grows
> with the change, not with the system.

Consequential edits for A4: §10 Tests row ("WebKit at task end, both engines before push"),
CLAUDE.md ("the bare full run must pass before reporting done" → `--changed`; UI verification by
hand stays WebKit then Chromium), `check.py --help`, a `deploy/`-free `.githooks/pre-push`
(new top-level dir → §11.1 listing) or `git config core.hooksPath checks/hooks`.
Trade-off to decide: a Chromium-only regression is found at push, not at task end.

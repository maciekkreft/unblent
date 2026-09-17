# Working here

@architecture.md

The architecture is the spec. If a request conflicts with it, name the section and propose the document change; never work around it.

- architecture.md describes the target. `components/` and `git log` describe
  what exists; the components the document names are examples, mostly unbuilt.
- Where the architecture is silent, do not improvise: propose the amendment,
  then wait, the same as for a conflict.
- Smallest scope first: one component or one piece of infrastructure per task.
  Decisions and contracts are agreed before any code (section 9, step 2).
- Run `python3 checks/check.py --help` for what to run when; `check.py --changed`
  (static + WebKit tests reachable from your change) must pass before reporting
  done, and the bare full run (both engines, all tests) is the pre-push gate the
  `.githooks/pre-push` hook runs. One test phase runs at a time per host (a lock);
  a test past half its 5s budget is named in a warning.
- Ask before changing `tokens/tokens.css`, `tokens/icons.js`, an event, the document facts list (7.5), or `architecture.md`. Propose, then wait.
- Comments say why, or cite an architecture section. Never what the code does, never history.
- UI/UX must satisfy Don Norman's principles (The Design of Everyday Things): one conceptual model, visible signifiers, natural mapping, immediate feedback, constraints, discoverability, and forgiveness (every action reversible in one step).
- Verify UI in WebKit, then Chromium, on the desk and in the phone preview (`data-viewport="phone"`, set through `viewport-switch` or localStorage key `viewport`), before reporting done.
- Commits: 2-3 words, no attribution trailers, same-session fixes amend.

# Reading the slip-box

The dev&prod server runs at 127.0.0.1:8080 and reloads on every edit. Before wiring a component, read what exists from the running system rather than from the code:

- `curl -s 127.0.0.1:8080/api/catalog` — every component's manifest, status, and who it interacts with.
- `curl -s 127.0.0.1:8080/api/catalog/contracts` — every event, query and command with its JSON Schema, owner, consumers and askers.
- `curl -s 127.0.0.1:8080/api/pages` — the pages and their kinds.

The :8080 server writes into the real `data/`. To drive a page with a forged session cookie (a Playwright experiment, a single test by hand), never point it at :8080: start a throwaway server on another port and target that, so nothing lands in `data/` or R2:

```sh
UNBLENT_DATA=$(mktemp -d) RP_ID=localhost MAX_USERS=1 .venv/bin/uvicorn server.main:app --port 8090
# then UNBLENT_URL=http://127.0.0.1:8090
```

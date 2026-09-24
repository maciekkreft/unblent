# Working here

@architecture.md

The architecture is the spec. If a request conflicts with it, name the section and propose the document change; never work around it.

- architecture.md describes the target. `components/` and `git log` describe
  what exists; the components the document names are examples, mostly unbuilt.
- Where the architecture is silent, do not improvise: propose the amendment,
  then wait, the same as for a conflict.
- Smallest scope first: one component or one piece of infrastructure per task.
  Decisions and contracts are agreed before any code (section 9, step 2).
- Run `python3 checks/check.py --help` for what to run when. `check.py --changed`
  must pass before reporting done: every static rule, then in WebKit the changed
  components' own tests, one smoke test per page that holds them, and the
  partners' tests only when a contract file or the manifest's contract changed.
  The bare full run (both engines, all tests) is the pre-push gate the
  `.githooks/pre-push` hook runs. One test phase runs at a time per host (a lock);
  a test past half its 5s budget is named in a warning. A test run prints one line
  per file, a failure's reason under its name, and at the end of the browser phase
  where its time went (launches, page loads, the rest). Add `--verbose` together
  with `--only <component>` to see every test.
- Ask before changing `tokens/tokens.css`, `tokens/icons.js`, an event, the document facts list (7.5), or `architecture.md`, and before saving or changing a memory. Propose, then wait.
- Comments say why, or cite an architecture section. Never what the code does, never history.
- UI/UX must satisfy Don Norman's principles (The Design of Everyday Things): one conceptual model, visible signifiers, natural mapping, immediate feedback, constraints, discoverability, and forgiveness (every action reversible in one step) (one exception: `profile-switch`, architecture §12).
- Build a change to what the user sees straight into the product page. Do not add a page attribute to turn it on or off.
- Verify UI in WebKit on the desk and in the phone preview (`data-viewport="phone"`, set through `viewport-switch` or localStorage key `viewport`), before reporting done; the push runs both engines.
- Commits: 2-3 words, no attribution trailers, same-session fixes amend.
- Talk to the user as the product owner: simple language and business terms, no technical jargon. Say what the user will see and what it costs; keep component names, contracts and code detail for plan files, proposals that need them, and the code itself.
- Write `architecture.md`, `CLAUDE.md` and plan files in plain English: say literally what a thing does and how to use it. No slogans and no figures of speech.

# Reading the slip-box

The server at 127.0.0.1:8080 is both dev and production, and reloads on every edit. It can list every component, every contract (event, query and command) and every page. Ask it before searching the code: `python3 checks/show.py --help`. Read a component's code only when the listing does not answer the question.

That server writes into the real `data/`. To drive a page with a forged session cookie (a Playwright experiment, a single test by hand), never point it at :8080: `python3 checks/check.py --server` starts a throwaway server on another port and prints the `UNBLENT_URL` and `UNBLENT_DATA` to use, so nothing lands in `data/` or R2.

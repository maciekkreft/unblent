# Working here

@architecture.md

The architecture is the spec. If a request conflicts with it, name the section and propose the document change; never work around it.

- architecture.md describes the target. `components/` and `git log` describe
  what exists; the components the document names are examples, mostly unbuilt.
- Where the architecture is silent, do not improvise: propose the amendment,
  then wait, the same as for a conflict.
- Smallest scope first: one component or one piece of infrastructure per task.
  Decisions and contracts are agreed before any code (section 9, step 2).
- Run `python3 checks/check.py --help` for what to run when; the bare full run
  (`python3 checks/check.py`) must pass before reporting done.
- Ask before changing `tokens/tokens.css`, `tokens/icons.js`, an event, the document facts list (7.5), or `architecture.md`. Propose, then wait.
- Comments say why, or cite an architecture section. Never what the code does, never history.
- UI/UX must satisfy Don Norman's principles (The Design of Everyday Things): one conceptual model, visible signifiers, natural mapping, immediate feedback, constraints, discoverability, and forgiveness (every action reversible in one step).
- Verify UI in WebKit, then Chromium, on the desk and in the phone preview (`data-viewport="phone"`, set through `viewport-switch` or localStorage key `viewport`), before reporting done.
- Commits: 2-3 words, no attribution trailers, same-session fixes amend.
- Design together: when asked to brainstorm or decide, interview first if the need is unclear, lead with one recommendation and why, list the alternatives with pros, cons and consequences, illustrate anything complex with ASCII or an example, and write no code until the decision is agreed.

# Reading the slip-box

The dev server runs at 127.0.0.1:8080 and reloads on every edit. Before wiring a component, read what exists from the running system rather than from the code:

- `curl -s 127.0.0.1:8080/api/catalog` — every component's manifest, status, and who it interacts with.
- `curl -s 127.0.0.1:8080/api/catalog/contracts` — every event, query and command with its JSON Schema, owner, consumers and askers.
- `curl -s 127.0.0.1:8080/api/pages` — the pages and their kinds.

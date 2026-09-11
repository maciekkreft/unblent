# Working here

@architecture.md

The architecture is the spec. If a request conflicts with it, name the section and propose the document change; never work around it.

- architecture.md describes the target. `components/` and `git log` describe
  what exists; the components the document names are examples, mostly unbuilt.
- Where the architecture is silent, do not improvise: propose the amendment,
  then wait, the same as for a conflict.
- Smallest scope first: one component or one piece of infrastructure per task.
  Decisions and contracts are agreed before any code (section 9, step 2).
- `python3 checks/check.py --static` after every edit; the full run before
  reporting done.
- Ask before changing `tokens/tokens.css`, an event, the document facts list (7.5), or `architecture.md`. Propose, then wait.
- Comments say why, or cite an architecture section. Never what the code does, never history.
- Verify UI in WebKit, then Chromium, before reporting done.
- Commits: 2-3 words, no attribution trailers, same-session fixes amend.

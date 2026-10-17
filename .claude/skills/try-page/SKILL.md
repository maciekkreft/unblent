---
name: try-page
description: Make a try page for one tool (Chats, Books, the Journal, ...), the page at /try/<name> that someone without an account opens from a shared link. Use when the owner asks to share a tool by a link or to add a try page.
---

# Making a try page for X

A try page shares one tool by a link, `unblent.com/try/<name>`, with someone who has
no account (architecture.md 8). The Evaluators try page is the first one; copy it.

## 1. Copy the page file

Copy `pages/try/evaluators.html` to `pages/try/<name>.html`. The server serves it at
`/try/<name>` and the Pages list picks it up with no other change. Then:

- Keep `<meta name="kind" content="try" />`. Set `<title>` to the tool's name; it is
  the name shown at the top of the page.
- Keep these facts, which every try page needs: `color-scheme`, `trace`, `viewport`,
  `settings`, `session`, and `notice-stack` for Undo. Add only the facts and views X
  uses, the same tags X has on the product page (`pages/index.html`), inside one
  `dock-desk`.
- Leave out `page-nav`, `viewport-switch`, `layout-switch`, `profile-switch`,
  `session-switch`, `settings-sheet` and the Books panel (`book-shelf`). A try page
  has no page links, no switches and no sign-in. Its only control is the free-use bar
  (`free-use`), once it is built.

## 2. Decide what X needs

Write these down and agree them with the owner before writing code:

- **What surrounds X.** What X is kept with. Evaluators are kept with the Journal: on a
  try page `books` always reports the Journal as the open book, so every view that
  follows the open book shows the Journal. Say what plays that part for X, or that X
  stands alone.
- **Starters.** What a new visitor gets a copy of, chosen by the owner in
  Administration › Starters. Starters need one more group there, with this page's link.
- **The providers X spends on.** Jev, Anthropic, or none. A guest spends only on the
  guest keys, within the limits (architecture.md 7.7). A provider without a guest key is
  not offered to guests, so say what X shows then.
- **The first thing that needs the server.** That fact asks `session: guest` when nobody
  is signed in, and goes on as the new guest; `llm`'s `decide` is the example. Opening
  the page, and writing things that stay in the browser, makes nothing on the server.
  If that fact does not yet declare `session: guest` in its `asks`, this is a contract
  change: propose it first.
- **What a guest is told** when X cannot run for them, in words for a visitor: never
  "Add a key in Settings", since a guest has no Settings.

## 3. Check

- Add one browser test, beside the evaluator list's `tests/try.test.mjs`: a fresh
  browser opens `/try/<name>`, uses X, sees that nothing was sent to the server before
  the first use that needs it, then that use makes the guest, and nothing fails in the
  console. Everything else is tested in Node.
- Run `python3 checks/check.py --changed` once, at the end. It runs the page check, the
  smoke test that loads every changed page, and the test above.

## 4. Look at it on the desk and on the phone

Start a throwaway server with `python3 checks/check.py --server`, never the one on
:8080, which writes the real data. In WebKit, from a fresh browser:

- on the desk (1280 × 800), and
- on the phone preview: set localStorage `viewport` to `phone` before the page loads,
  at 390 × 844,

open `/try/<name>`, use X as a visitor would until the first use that needs the
server, then reload and see that the work is still there. Look at a screenshot of each
and compare it with the screens the owner approved.

# Roadmap

Where Unblent is heading and the work around it: directions, decided work not done yet, the launch, community posts and ways of showing the work. Nothing here is a rule; the rules are in `architecture.md`, and a numbered reference such as (architecture.md 3.1) points to a section there.

---

## 1. Directions

Where the product is heading. Nothing here is designed or built; each line is one sentence, and a proposal says how it leaves every line open.

- An open-source Mac release: a free ePub reader with notes, the journal and highlights, usable from the keyboard alone with Vim keys, installed with one `brew` command and working offline for one person, with the Choice Point sheet, Evaluators and Values, checked offline by Kev in Ollama; unblent.com becoming its landing page and the hosted app moving to app.unblent.com (sketch: `~/.claude/plans/open-source-mac-release.md`; landing page design, Paper, in light and dark with real screenshots: https://claude.ai/artifact/E2p4LZcZ7dvfZ7jguv6K2d).

- Evaluators that trigger tools, where an evaluator notices something in what the user writes (a yes / no or pick-one judgment by Jev), a tool does something, and a tool can be set to run when an evaluator fires; these tools act, unlike the chat's tools of 7.7, which only look things up.
- Try pages for Chats, Books and the Journal, each one more page under `/try/`, made as the try-page skill describes (sketch: `~/.claude/plans/try-links.md`).
- Money limits for chats, so an account can cap what its own key spends.
- Revoking a connected Mac from the web, from a list of the account's device sign-ins.
- Paying for sync, so a client turns Can sync on for their own account.
- A guest keeping their work by adding a passkey, which turns the guest into an ordinary account.
- A record of every use and what it cost, for audit, beside the running totals.
- Telegram notifications to the owner, for example when a new guest arrives or a limit is reached.
- One note linked to many books at once.
- Unlinking a note.
- Evaluators reading the journal, with Jev's answers shown beside a day, as a component of its own: a fact that owns those answers, not something added back into `journal`, which owns only the days (architecture.md 3.1).
- A jump from a highlight to its passage, with one step back to the reading place.
- Sending a note's text to the chat as the next message, so a note that holds a useful question can be used again with any book.
- OpenAI itself as a model provider, beside Ollama on the user's own computer, which the Mac app already offers.
- SubQ (subq.ai) as a second provider of decisions beside Jev, its decision service having the same shape as Jev's but its own model name, price and errors, to be designed rather than switched in through server settings (sketch: `~/.claude/plans/subq-provider.md`).
- A chat kept open while the subject changes (the device preference that keeps the open note and chat), learning what is open now from what is added at the end of the conversation, never from a change to its beginning.
- A command overlay opened from the keyboard, where the user types what they want (open a book, show a note, move a tab) and it is carried out through commands the views declare, each argument chosen from a list a fact provides (sketch: `~/.claude/plans/command-overlay.md`).
- A fast decision model such as Jev (typesafe.ai), which writes no text and picks one of up to 255 options or answers yes or no with a probability, for understanding a typed command in the overlay and for choosing among tools if they become many (sketch: `~/.claude/plans/command-overlay.md`).
- A developer mode for the admin only, a per-device switch in Settings shown only to the admin and on by default, showing the bus's refusals, page errors and failed server requests as dismissable notices while it is on, so a wrong message is seen at once and not only in the console or on the Trace page; other accounts see nothing of it (sketch: `~/.claude/plans/developer-notices.md`; the design: https://claude.ai/artifact/RxS3qmAAqbjDmjCgXArdGw).
- A component map: one page that draws every component and every contract between them as a picture, shows a manifest or a schema on click, and lights each line as the message travels while the product is used in another tab; it replaces the Contracts and Components pages, which only agents read through `show.py` (sketch: `~/.claude/plans/component-map.md`).
- Sheets offered by topic: each book states its topic, a sheet belongs to books on its topic (the Choice Point to books on acceptance and commitment therapy, ACT), and the user picks a sheet from a list of topics or sheet names; the journal knows no kind of sheet.
- Export of the notes and journal days to a folder of markdown files, one file per note with its id, links, type and dates at the top and links between notes written so Obsidian can follow them, as a zip each owner (`notes`, `journal`) offers from its own server module; it settles the file format an import, or notes kept as files on a Mac, would build on (Slip-Box design: https://claude.ai/artifact/ULdQHXCXAdGvujbs1tGYBY).
- A generator kind that writes under a line given a chosen answer to an evaluator's question, which is not designed yet.
- Hiding an evaluator's mark and its hint on one line of a day that can still be edited, leaving a faint dot that shows them again (sketch: `~/.claude/plans/hints-and-locks.md`).
- The push gate also covering the phone preview and signed-in and signed-out use in both browsers, run only when the owner pushes by hand, never by a coding session (sketch: `~/.claude/plans/hints-and-locks.md`).
- Notes and chats kept with the day they were made, so each day shows only its own, with a checkbox on a note or a chat that shows it on every day.
- Summaries of journal days, shown to the user beside each day; today the journal summary generator writes one sentence per day, which only the chat reads.
- Summaries of book chapters, shown to the user beside each chapter.
- A Wheel of Life sheet, the coaching exercise in which a person rates the areas of their life, on the topic of coaching (see the sheets offered by topic above), which can be added to every journal.
- Getting books from https://standardebooks.org/ebooks and other places whose books are legal to download, from inside the app.
- Versions of a note, as a new feature: each version of a note is kept, and the user can compare two versions and see what changed between them, with a vendored library that finds the differences.
- A set of example goals for the Therapy Goal evaluator, each with the answer it should get, run again after a change to the evaluator's options to show which answers moved (sketch: `~/.claude/plans/evaluator-dataset.md`).
- Copying a choice point, or any later kind of sheet, from an earlier day to today as the next version of the original, which stays unchanged, with a link in the bottom left corner of the copy that opens the version it continues.
- `gt` and `gT` with Vim keys on, showing the next and previous tab of the group that has the keyboard, the same as Ctrl+. and Ctrl+, do today, from the book reader, the journal and the note editors as well.
- Hashtag checks shown more clearly, after the hashtag checks of architecture.md section 13 that are being built: a line with a finding gets a wavy underline like a spelling mistake, and a one-line strip in the journal's footer names what was found and offers Ignore and Edit evaluator; with it, the Evaluators tab is built like Generators, with an On tick box, the name and the description always shown, and only the questions folded. Choice Point's headings could then be ordinary text that names their evaluators (plan: `~/.claude/plans/journal-checks.md`; the post and the design: https://claude.ai/artifact/Vip5vDUPrFeiLzGHNmZiX9).
- A weekly series of eight posts in the owner's community r/PracticePsychology, teaching the Choice Point and Values from *ACT Made Simple* to people practicing on their own, each ending with how Unblent's free journal holds the practice (section 4; the plan and the first post: https://claude.ai/artifact/Uozrxwx742EPpQEXuXbAUo).
- Shared packages: a small marketplace where people share with each other book-scoped things, such as sheets, evaluators and generators, each package linked to one specific book and made available to others only after the owner, or an agent working for the owner, has checked that it does not break the app, that it belongs to its book, and that it respects copyright.
- Mac features released one per version: the Release switches of the website's Features tab (architecture.md 12), as they stand at the moment a version is built, are frozen into that version (architecture.md 3.1), because a Mac that is not connected never asks the website for them; each feature is labeled "Works offline" (on the Mac, no account) or "Uses an AI service" (needs an account and the user's own key), and the features that work offline come first (plan: `~/.claude/plans/choice-point-release.md`).

Self-help reading on the Mac (the roadmap desk, a sketch of each idea: https://claude.ai/artifact/UUwTqbhoDg3SoCAJmy1yvy):

- Reading aloud on the Mac: hovering a paragraph in the book reader shows a speaker icon, and a click reads that one paragraph aloud with a voice model running on the Mac, such as Kokoro-82M or a newer one chosen by listening to samples, because the feature is worth building only if the voice is pleasant for a whole chapter; decided for the first version: the voice is built into the Mac app and downloaded once from Settings, and on app.unblent.com the paragraph is read by Inworld on the account's own key (design: https://claude.ai/artifact/MGYSVSEu4WfV1uRmgaerE4).
- Talking with a book's expert by voice on the Mac: the user speaks, the Mac hears and writes it down locally, the book's expert (above) answers, and the answer is read aloud with the local voice (reading aloud, above), all on the user's own MacBook with no service and no cost.
- Pictures of ideas: from what the user highlighted in a chapter, the Mac draws a picture of one idea in the background with a local image model, such as mflux, started by hand, kept with the book and shown beside the highlights; it is tried on one chapter first to learn whether the wait and the battery it costs give enough value.
- Summaries that unfold: each book in the library gets a summary made by a local model that the user can switch between one sentence, one paragraph, one page, two pages, four pages and so on, each length written from the one above it (not now).
- Commands that act: the command overlay (above) carries out real actions on the user's data, such as finding every note on one topic, moving them under a note or linking them to a book, with Jev choosing what was meant and a language model only where words must be written, so it is fast, cheap and reliable; every action is one of the commands and events the components already declare and is undone with one Undo, unlike the chat's tools, which only read (architecture.md 7.7).
- Book experts: ten popular self-help books each come with a carefully written chat start that talks as an expert on that book, offered when a chat is started beside it: *No Bad Parts* (IFS), *One Small Step Can Change Your Life*, a book by Mark Hyman, *Atomic Habits*, and the rest chosen from Amazon's self-help bestsellers; a chat can still use the tools as today, and the prompt teaches the book's ideas without quoting its text; decided for the first version: the user writes each book's prompt and switches its expert on in a Book experts tab of the gear's sheet, the experts show on a shelf above a new chat that can be folded, kept folded in this browser, and the ten ready-made prompts come later (design: https://claude.ai/artifact/MGYSVSEu4WfV1uRmgaerE4).
- Comments from the experts in the background: the book experts read new journal days, notes and highlights by themselves and leave short comments beside them, so the user finds a comment while looking through the journal or the notes, and a notification says what was commented on without the user asking (design of the experts it builds on: https://claude.ai/artifact/MGYSVSEu4WfV1uRmgaerE4).
- Chapter tests: for a chapter the user picks, a language model writes a short test of several kinds (pick one, true or false, order the steps, explain in your own words), Jev checks the answers that have one right choice and a language model checks the written ones, and the result is kept with the chapter so the user can take the test again later.

---

## 2. To do

Work that is decided but not done yet. Remove a line when its work is done.

- Make CHANGELOG.md the source of each GitHub release's notes, so the release workflow copies that version's section into the release, and fill in the missing versions 0.2.0, 0.2.1 and 0.2.2.
- Allow selecting read-only text and copying it, or linking it into text that can be edited, in Notes and the Journal only.
- The status check also reads each Reddit post's upvotes and views, through a Chrome browser driven by Playwright from Python and signed in to the owner's Reddit account, because Reddit shows them only to someone signed in and blocks this server otherwise. Each post's text, links and comments are already read from Reddit's public feeds by `/opt/unblent-site/scripts/reddit.py`.
- Erase what the server keeps for an Undo (architecture.md 12) when the step can no longer be undone or redone, not only when it is pushed past the last 100 steps: a deleted book's files, a deleted guest's files and spending, and the API keys kept under a step. Today two cases keep them on the server for good. First, when the user undoes a step and then makes a new change, the undone step leaves the redo list, but `undo` emits no `step.dropped` for it. Second, the steps of a browser that never reaches 100 steps, or whose undo list is lost, are never dropped. The first needs `step.dropped` to also be emitted for a step that leaves the redo list (a change to that event's meaning, which needs the owner's approval). The second needs an age limit, such as 30 days, after which the server erases them by itself.

---

## 3. Launch tasks

The work of launching Unblent for Mac (section 1, first line). When the owner asks what is to be done, answer from this section: first what is due today, then what comes later. Each task says how its result is measured. Remove a line when its work is done.

How results are measured:

- **Visits from each place.** Every post links to the landing page with its own `ref`, such as `https://unblent.com/?ref=hn`. The landing server writes every request to its log, so the visits from one place are the requests for `/?ref=<place>`.
- **Downloads.** GitHub counts each download of `Unblent.dmg`, from Homebrew or the landing page, per release. It does not say where the person came from.
- **Interest.** GitHub stars, and the people who leave an email address in the landing page's form, counted by Kit.
- **Wishes and problems.** GitHub issues and Discussions › Ideas.
- One short report puts these numbers side by side, before a post and again a day after it.

### Later

- Announce Chats with Ollama in r/macapps and r/LocalLLaMA, each after reading its rules on posts about one's own work. Link `?ref=reddit`.
- Show HN at https://news.ycombinator.com/submit, on a Tuesday, Wednesday or Thursday between 8 and 10 a.m. US Eastern time. Link `?ref=hn`.
- Product Hunt, on a different weekday from Show HN, with a picture or a short clip. Link `?ref=producthunt`.
- Reddit: r/vim, r/Journaling, r/macapps, r/ebooks, r/Zettelkasten, r/PKMS, r/vim, r/opensource and r/SideProject, a few days apart, each after reading its rules on posts about one's own work. Link `?ref=<subreddit>`, such as `?ref=macapps`.
- Mastodon and Bluesky, with the README screenshot. Link `?ref=mastodon` or `?ref=bluesky`.
- Lobsters, with the "show" tag, once a member invites the owner. Link `?ref=lobsters`.
- AlternativeTo, as an alternative to Apple Books, Calibre, Readwise and Kindle; MacUpdate; and the lists jaywcjlove/awesome-mac, serhii-londar/open-source-mac-os-apps and iCHAIT/awesome-macOS on GitHub.
- Indie Hackers, the story of building it (optional).
- Paid ads in ChatGPT and on Reddit, each with a small fixed budget and its own `ref`, decided after the first posts show which audience responds.

---

## 4. Community posts

Series of posts written for one online community, planned after the launch posts (section 3). A series is not posted until what it describes is in the free Mac app. Remove a line when its work is done. The plan of the posts, what each covers and how each links to Unblent: https://claude.ai/artifact/Uozrxwx742EPpQEXuXbAUo.

### r/PracticePsychology: the Choice Point series

- Who it is for: people who have heard of acceptance and commitment therapy (ACT) and want to practice the Choice Point and the Values exercises every day on their own, without a therapist.
- What it teaches: the theory a reader needs to do the two exercises, as Russ Harris explains it in *ACT Made Simple*, in the posts' own words and with the book named as the source. No text or diagram is copied from the book. Each post ends with one exercise to try that day, which works on paper as well as in Unblent.
- When it is posted: a post goes up only once the free Mac app has what it teaches. The series starts with the Choice Point, released in the Mac app before the Values list, which needs more work first. A post may show the marks with a note that on a Mac they come from Kev in Ollama, free and offline after a small download, or from Jev, an AI service used with the user's own key; every exercise in a post can be done for free and offline (plan: `~/.claude/plans/choice-point-release.md`).
- How the posts are written: an AI writes each draft, and the owner rewrites it in their own voice before posting. The community is the owner's own, so the owner sets its rules.
- How each post mentions Unblent: one short paragraph at the end, after the exercise, saying the owner keeps their own daily practice in Unblent's journal, that it is free and open source forever (MIT license), that it works offline on a Mac, and which part of the post it holds (the sheet, the values, the day's page). It links the GitHub repository, https://github.com/maciekkreft/unblent, and the landing page with `?ref=reddit`, so visits are counted as section 3 says.
- How often: one post a week, eight posts, each linking to the ones before it.

---

## 5. Visibility: showing my work

Ideas for showing how Unblent is built, so that people find it through the work itself. Nothing here is planned yet. Each piece links to the landing page with its own `ref`, such as `https://unblent.com/?ref=youtube`, so its visits are counted as section 3 says. Remove a line when its work is done.

- A video that shows how Unblent was built, with a visualization of its components and of the messages they send each other on the bus.

---

## 6. Cleanup

Plan files that nothing in this roadmap points to any more, because their ideas were dropped or replaced. Delete each one from `~/.claude/plans/`, then remove its line, and remove this section once it is empty.

- `bullets-types-links.md`
- `line-pipes.md`
- `book-tools.md`
- `landing-analytics.md`

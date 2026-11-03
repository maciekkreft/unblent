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
- The side-dock chat, now being built, knowing more of what the reader is looking at: the open book and the chapter being read.
- Every chat able to draw on the whole library — every book, note and highlight — so that what the reader marked and wrote shapes the answers.
- One note linked to many books at once.
- Unlinking a note.
- Highlights in the journal, made the same way as in any other book (sketch: `~/.claude/plans/journal-book.md`).
- Evaluators reading the journal, with Jev's answers shown beside a day, as a component of its own: a fact that owns those answers, not something added back into `journal`, which owns only the days (architecture.md 3.1).
- A jump from a highlight to its passage, with one step back to the reading place.
- Sending a note's text to the chat as the next message, so a note that holds a useful question can be used again with any book.
- Any OpenAI-compatible model provider: OpenAI itself, and a server on the user's own computer such as Ollama.
- SubQ (subq.ai) as a second provider of decisions beside Jev, its decision service having the same shape as Jev's but its own model name, price and errors, to be designed rather than switched in through server settings (sketch: `~/.claude/plans/subq-provider.md`).
- A chat kept open while the subject changes (the device preference that keeps the open note and chat), learning what is open now from what is added at the end of the conversation, never from a change to its beginning.
- A command overlay opened from the keyboard, where the user types what they want (open a book, show a note, move a tab) and it is carried out through commands the views declare, each argument chosen from a list a fact provides (sketch: `~/.claude/plans/command-overlay.md`).
- A fast decision model such as Jev (typesafe.ai), which writes no text and picks one of up to 255 options or answers yes or no with a probability, for understanding a typed command in the overlay and for choosing among tools if they become many (sketch: `~/.claude/plans/command-overlay.md`).
- A developer mode for the admin only, a per-device switch in Settings shown only to the admin and on by default, showing the bus's refusals, page errors and failed server requests as dismissable notices while it is on, so a wrong message is seen at once and not only in the console or on the Trace page; other accounts see nothing of it (sketch: `~/.claude/plans/developer-notices.md`; the design: https://claude.ai/artifact/RxS3qmAAqbjDmjCgXArdGw).
- A component map: one page that draws every component and every contract between them as a picture, shows a manifest or a schema on click, and lights each line as the message travels while the product is used in another tab; it replaces the Contracts and Components pages, which only agents read through `show.py` (sketch: `~/.claude/plans/component-map.md`).
- Tools a book teaches: while reading, the user writes a judgment the book describes as yes/no questions with yes and no criteria, Jev scores each, and the geometric mean is the result, tried on a typed title in a Tools tab beside the Reader (sketch: `~/.claude/plans/book-tools.md`).
- A written tool offered to the chat beside the built-in ones, switched on per tool in its editor and per book in Settings under "What the chat may use", the chat naming the tool and the book it came from when it uses one (sketch: `~/.claude/plans/book-tools.md`).
- A written tool run on a passage the user selects, not only on typed text (sketch: `~/.claude/plans/book-tools.md`).
- A built-in tool that fills a new tool's page from the passage being read, and another that scores how well a tool's questions and criteria match what the book says (sketch: `~/.claude/plans/book-tools.md`).
- Optional questions and weights in a written tool's score, only if a real tool asks for them (sketch: `~/.claude/plans/book-tools.md`).
- Sheets placed inside a journal day's text, where the user inserts a choice point or a later kind of sheet between paragraphs and the day's text keeps one placeholder line where it stands, the journal knowing no kind of sheet, and sheets made before this still shown under the text (sketch: `~/.claude/plans/bullets-types-links.md`).
- Export of the notes and journal days to a folder of markdown files, one file per note with its id, links, type and dates at the top and links between notes written so Obsidian can follow them, as a zip each owner (`notes`, `journal`) offers from its own server module; it settles the file format an import, or notes kept as files on a Mac, would build on (Slip-Box design: https://claude.ai/artifact/ULdQHXCXAdGvujbs1tGYBY).
- A note's text changeable only on the day it was written and in the hour after its last edit, as a journal day is, while its type and its links can always be changed and a note is never deleted; highlights are not affected (sketch: `~/.claude/plans/hints-and-locks.md`).
- A chat from an earlier day shown read only, with a read-only text box and a greyed-out Send, and not deletable (sketch: `~/.claude/plans/hints-and-locks.md`).
- A generator kind that writes under a line given a chosen answer to an evaluator's question, which is not designed yet.
- Hiding an evaluator's mark and its hint on one line of a day that can still be edited, leaving a faint dot that shows them again (sketch: `~/.claude/plans/hints-and-locks.md`).
- The push gate also covering the phone preview and signed-in and signed-out use in both browsers, run only when the owner pushes by hand, never by a coding session (sketch: `~/.claude/plans/hints-and-locks.md`).
- Notes and chats kept with the day they were made, so each day shows only its own, with a checkbox on a note or a chat that shows it on every day.
- A summary of a note made in a chat, where the note is placed in the chat's history, the input box holds the default summary prompt from Settings for the user to change before sending, the user can first highlight and comment the passages the summary must keep, and the summary is saved only after the user confirms that it says what the note says.
- Highlights and comments on past journal days, and summaries of journal days made the same way as a summary of a note.
- A summary saved as the next version of the note or journal day it summarises, so opening that note or day shows the summary, with a switch to each earlier version.
- To consider, in place of a note that becomes read only after its first day: a note editable freely on the day it was made, where an edit on a later day makes a new version of the note instead of changing it, a switch at the bottom of the editor moves between the versions, and only the latest version can be edited.
- A set of example goals for the Therapy Goal evaluator, each with the answer it should get, run again after a change to the evaluator's options to show which answers moved (sketch: `~/.claude/plans/evaluator-dataset.md`).
- Copying a choice point, or any later kind of sheet, from an earlier day to today as the next version of the original, which stays unchanged, with a link in the bottom left corner of the copy that opens the version it continues.
- `gt` and `gT` with Vim keys on, showing the next and previous tab of the group that has the keyboard, the same as Ctrl+. and Ctrl+, do today, from the book reader, the journal and the note editors as well.
- Pipes, where a line in a journal day or a note names steps after it with `|` (an evaluator, a hint, later any step that turns text into text with a model), the line runs through them in order when the user presses Run, and each step's result is kept and shown under the line, never written into the text unless the user inserts it (sketch: `~/.claude/plans/line-pipes.md`).
- Hashtag checks shown more clearly, after the hashtag checks of architecture.md section 13 that are being built: a line with a finding gets a wavy underline like a spelling mistake, and a one-line strip in the journal's footer names what was found and offers Ignore and Edit evaluator; with it, the Evaluators tab is built like Generators, with an On tick box, the name and the description always shown, and only the questions folded. Choice Point's headings could then be ordinary text that names their evaluators (plan: `~/.claude/plans/journal-checks.md`; the post and the design: https://claude.ai/artifact/Vip5vDUPrFeiLzGHNmZiX9).
- A weekly series of eight posts in the owner's community r/PracticePsychology, teaching the Choice Point and Values from *ACT Made Simple* to people practicing on their own, each ending with how Unblent's free journal holds the practice (section 4; the plan and the first post: https://claude.ai/artifact/Uozrxwx742EPpQEXuXbAUo).
- Shared packages: a small marketplace where people share with each other book-scoped things, such as sheets, evaluators and generators, each package linked to one specific book and made available to others only after the owner, or an agent working for the owner, has checked that it does not break the app, that it belongs to its book, and that it respects copyright.
- Mac features released one per version: the Release switches of the website's Features tab (architecture.md 12), as they stand at the moment a version is built, are frozen into that version (architecture.md 3.1), because a Mac that is not connected never asks the website for them; each feature is labeled "Works offline" (on the Mac, no account) or "Uses an AI service" (needs an account and the user's own key), and the features that work offline come first (plan: `~/.claude/plans/choice-point-release.md`).
- Usage by feature: the admin sees in Settings which features each account and all accounts use and where time goes, counted from the names and times of events on the bus, never their contents, grouped into features; off by default in the Mac app, where the user may turn it on to help the developer (sketch: `~/.claude/plans/usage-stats.md`; the design of the Usage tab, with example data: https://claude.ai/artifact/XQzCz2e8B9LSanHmjqcsYW).

---

## 2. To do

Work that is decided but not done yet. Remove a line when its work is done.

- Make CHANGELOG.md the source of each GitHub release's notes, so the release workflow copies that version's section into the release, and fill in the missing versions 0.2.0, 0.2.1 and 0.2.2.
- Clarify items 10–20 below before planning them. Analyze each item, ask the owner about everything that needs the owner's decision, and give a recommendation with every question. The goal is to settle every item, so that the next step can be a plan of several steps, carried out by several Opus agents coordinated from one session.
  - 10. A note can be sent to the stage. Could the journal be sent to the side dock in the same way, and how?
  - 14. The side dock's open tab does not follow the stage's open tab. For example, with Chats open beside the Journal, switching to a book keeps Chats open; switching to Notes there and going back to the Journal shows Notes. Should the side dock remember its open tab for each stage tab?
  - 19. A past journal day is read only and does not allow Vim's visual mode to select and copy text. Can it?
  - 20. Make it possible everywhere to select read-only text and copy it, or link it into any text that can be edited. Where should this be allowed, and where restricted?
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

- Before the broad launch (Show HN, Product Hunt and the Reddit communities other than r/PracticePsychology): Chats in the Mac app, working with any OpenAI-compatible server, including Ollama on the user's own computer, so the launch can say the reader answers questions about the user's books, notes and highlights offline and without a paid key.
- Announce offline checks with Kev in Ollama (Choice Point marks, Evaluators and Values) in r/macapps and r/LocalLLaMA, each after reading its rules on posts about one's own work. Link `?ref=reddit`.
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

Ideas for showing how Unblent is built, so that people find it through the work itself. Nothing here is planned yet. Each piece links to the landing page with its own `ref`, such as `https://unblent.com/?ref=blog-rag`, so its visits are counted as section 3 says. Remove a line when its work is done.

- A blog tutorial that shows how to build RAG (search that finds the right passages and gives them to the language model) over a library of books, using the approach of the book *Evals for AI Engineers*.
- An article and a video for software engineers, starting a YouTube channel for Unblent, about its architecture: each component is separate from top to bottom, from its view to its own database, so it can be added or removed alone and affects other components only through the contracts they share; components never connect directly and talk only through events, commands and queries on the bus; and because every change is a recorded event, Undo and Redo are part of the design rather than added later. The article explains why each decision was made, the values behind it, and what follows for development, such as how easy it makes the code for coding agents to change, and how counting usage by feature comes almost free because every action is already an event.
- Landing page visits measured without cookies or outside services: country, city, time on the page, how far visitors scroll, and which visits are bots, reported by the status check beside the visits per `ref`, with the website's privacy text updated to say so (sketch: `~/.claude/plans/landing-analytics.md`).
- An article on Medium.com about the architecture of Unblent, with pictures, because Medium readers like technical articles and a post there can bring visits to the website. It links to the landing page with `?ref=medium`.

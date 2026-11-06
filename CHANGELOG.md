# Changelog

All notable changes to Unblent for Mac are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The Wheel of Life, a new journal sheet. Rate eight areas of your life (Health, Work, Money,
  Family, Love, Friends, Growth and Fun) with an Actual and a Wanted score from 1 to 10, and
  see where the gap is biggest. A new wheel starts with Wanted taken from your last one. Done
  folds it into a card with a small wheel and each area's gap. It works by mouse or by
  keyboard, with Vim keys if you have them on, works offline, and costs nothing.

### Changed

- Today's journal page has one + Add sheet row in place of a row for each sheet. It opens a
  list with a line about each sheet and what it comes from, so a day shows only what you add
  to it. Your values and the Wheel of Life leave the list while they are on the day.
- A Choice Point or Your values box that takes the keyboard below the fold now scrolls into
  sight.

## [0.6.0] — 2026-11-06

### Added

- Reading aloud, on your own Mac. Download the Kokoro voice once in Settings › This device,
  and books are read aloud offline, at no cost. Point at a paragraph and click the speaker
  in the margin to hear it, or press Read page in the footer. The paragraph being read is
  tinted and the word being said lights up.
- Highlights and comments on past journal days, with Copy, Copy link and Remove. Following a
  link to one opens that day at the passage.
- A comment on any highlight in a book.
- In a chat, with Vim keys on, a cursor in the answers. It moves as it does in the book
  reader, and `v` and Enter mark a passage.
- In a chat, the lookups of journal day text and of books now link to what they read.
- With Vim keys on, `dd` then `p` or `P` brings back a deleted note, chat or book in a new
  place.
- The Books shelf keeps the order you set.

### Changed

- A selection is a highlight as soon as you make it, with no button to press. Both of its
  ends have handles you can drag, with a finger or a mouse, and Undo takes back each move.
- Your values shows one mark per line. It is red and names each value the line goes against,
  green when the line serves a value, and uncolored when it can't tell.
- A folded Choice Point shows all four boxes, read only, with the marks on each line.
- A Choice Point can be deleted again, with the Delete button to the left of Done. Undo
  brings it back.

### Fixed

- Selecting text with a finger no longer jumps to everything above where it started. This
  applies to books and to chats, including across two lines.

## [0.5.0] — 2026-11-03

### Added

- Checks on your writing, made on your own Mac. Each line of a Choice Point gets a mark,
  your values and their examples are checked, with the evaluators you choose in Settings. The checks come from the Kev decision model in
  [Ollama](https://ollama.com): no account, no key, no cost, and nothing leaves your Mac.
  Run `ollama pull kev:0.8b-mlx-bf16` (Ollama 0.40.4 or later).
- The Mac app is now the same app as app.unblent.com, with the same panels, Settings and
  layout. Only signing in differs: the Mac has its own account, connected to the website
  from Settings › Account.
- Values: your own list of values, kept by day, shown on each journal day.
- Evaluators, in Settings › Evaluators: Goal Type, Value Type and Value Example come with
  the app, and Your Values is built from your values. Write your own: a name and yes/no or
  pick-one questions.
- Generators, written by the chat model in Ollama: a suggested value under a value that
  was marked red, a one-sentence summary of each past journal day, and a title for each chat.
- Settings › Your account › Evaluating chooses who makes the checks, the same way the chat
  is set up: Provider (Ollama on this Mac, or Jev with your own key), then Model, any model
  downloaded in Ollama, Kev first. Settings says when Ollama is not running or Kev is not
  downloaded, and how to fix it.
- Hashtag checks in notes and journal days. Write a line such as
  `Things on my mind tonight #in-my-control`, and every line you finish in the paragraph
  or list below it gets the answer's icon and name at its end. A hashtag names one of your
  evaluators by its name, with hyphens for spaces; several hashtags give several answers,
  and a hashtag that names no evaluator stays grey. In my control, Thinking traps and
  Fact or story come with the app.
- Typing `#` on a line in a note or a journal day lists your evaluators, so you can pick
  one by name.
- Enter at the end of a hashtag line starts a list below it, so each line you write there
  is checked.
- Settings › This device › Beta releases, in the Mac app, offers test builds of the next
  version as updates.

## [0.4.1] — 2026-10-31

### Changed

- The Notes list no longer has a Highlights row. Your highlights stay in the book, where
  you made them, and you can still copy or remove each one there.

### Fixed

- Highlighting in books works again. On some Macs, dragging over text with the mouse
  or trackpad made no highlight.

## [0.4.0] — 2026-10-30

### Added

- Chats. Ask questions about the book you are reading, your notes, your highlights and
  your journal, and the answer can look up the chapter, the note or the day it needs.
  Answers come from [Ollama](https://ollama.com) running on your own Mac, with the
  gemma4:e4b-mlx model by default: no account, no key, no cost, and nothing leaves your Mac, so it
  works offline. Install Ollama, run `ollama pull gemma4:e4b-mlx`, and open Chats.
- Settings › Your account chooses where answers come from: Ollama on this Mac, with
  any model you downloaded, or Anthropic with your own API key. When Ollama is not
  running, Settings and the chat say so and offer Try again.

## [0.3.0] — 2026-10-29

### Added

- A Choice Point sheet on every journal day, the tool from acceptance and commitment
  therapy that Russ Harris describes in *ACT Made Simple*. Under the day's text, *New
  choice point* opens a sheet with four boxes: the situation, the thoughts and feelings it
  brought up, what you did when hooked (away) and what you did or could do unhooked
  (towards). Done folds it into a card; a card opens again with a click. Works offline,
  with no account.

## [0.2.4] — 2026-10-25

### Added

- Numbered lists that keep their own numbering, checklists you tick with a click or
  Ctrl+Enter, and quotes drawn with a bar, in notes, the journal and every other place
  you write. A line starting with "-" shows a dash, and one starting with "*" a dot.
- Web addresses in notes, Highlights and the journal are links. A click opens one in your
  browser, and so does gx with Vim keys.
- With Vim keys on a journal day, j and k move from the day's text down to the values and
  the choice points and back; Enter opens a card, o adds a choice point, and j and k move
  between the boxes of an open one.
- When the Mac is connected to an account: Vim keys in a chat's conversation (j, k, gg, G,
  Ctrl+d, Ctrl+u to scroll, i to type), and a Feature flags tab for the admin.

### Changed

- A pinned note or chat shown at the top of the list says where it comes from, such as
  "From Journal", instead of "Open from elsewhere".
- The values' Earlier versions lists only days whose values differ, never an empty day.

### Fixed

- Jev no longer checks a line holding no letter or digit, such as "*" or "-".

## [0.2.3] — 2026-10-24

### Added

- When the Mac is connected to an account: a Values sheet on every journal day, under
  the day's text, where you write your own values. Each version is kept by day.
- The evaluator Your values, in the Journal's Evaluators. It checks each Towards line of
  a choice point against your values and shows one compass mark: green when the line
  serves a value, red when it goes against one, grey when Jev can't tell.
- In Settings, a choice point box can be checked by a second evaluator ("Also check
  with").

### Changed

- The Evaluators pin is off at first, and the list shows when an evaluator is pinned.
- An evaluator from another book that was ticked "Show in journal" now belongs to the
  Journal, so it is listed there again.

### Fixed

- A choice point whose boxes hold only spaces or blank lines is no longer kept.

## [0.2.2] — 2026-10-24

### Changed

- Connecting to an account no longer asks you to choose: an account that already has
  notes, journal days or books shows them, and an empty account receives what the Mac
  had. Nothing is ever deleted from the account.
- Disconnecting keeps on the Mac everything it showed while connected, as its own copy.
  The Mac's earlier files are moved aside to a backup folder, not deleted.

## [0.2.1] — 2026-10-24

### Fixed

- Connecting to an account on app.unblent.com no longer fails. In 0.2.0 it failed on
  every Mac.

## [0.2.0] — 2026-10-24

### Added

- Connect the Mac to an account on app.unblent.com, from a new Account tab in Settings.
  While connected, the Mac shows that account, the same as the website and the phone,
  and syncs with it. The account needs sync turned on by the admin first. Disconnect
  stops syncing.

### Fixed

- When two devices each start the same journal day, the journal shows one day for the
  date and asks you which to keep, instead of showing two. An empty copy or a copy with
  the same text is dropped by itself.

## [0.1.2] — 2026-10-23

### Fixed

- Today's journal page no longer jumps while you type in it.

## [0.1.1] — 2026-10-23

### Changed

- A new app icon.
- The Vim keys list in Settings no longer mentions the chat box, which the Mac app
  does not have.

### Added

- Forms on GitHub for reporting a problem and for asking for something new, and
  [Discussions › Ideas](https://github.com/maciekkreft/unblent/discussions/categories/ideas)
  for voting on ideas.
- A line at the bottom of Settings: "Something not working, or an idea? Send
  feedback". The link opens the GitHub page where you choose a form to fill in.

### Fixed

- A link to a web page, in a book or in Settings, now opens in your own browser, and
  Unblent stays where you were. Before, such a link in a book did nothing.

## [0.1.0] — 2026-10-22

The first release.

### Added

- An ePub reader for DRM-free books, with a shelf of your books on the left and the
  book's contents beside it. *Meditations* by Marcus Aurelius, from Standard Ebooks, is
  on the shelf on first start.
- Highlights: mark a passage, add a comment to it, and see all of a book's highlights
  together in its Highlights note.
- Notes per book, shown beside the page you are reading. A note can also be opened in
  the middle panel.
- Links to highlights: copy a link to a passage and paste it into a note or a journal
  day. The link opens the book at that passage.
- A daily journal, one page per day. Only today's page can be edited (yesterday's stays
  open until 1 a.m.); past days are read-only.
- Vim keys, off by default: with them on, reading, moving between panels, highlighting
  and writing all work from the keyboard. "Show the keys" in Settings lists them.
- A light and a dark look that follow macOS.
- Updates from inside the app: when a new version is ready, the app asks you to
  *Restart to update* or *Later*.
- Install with Homebrew (`brew install --cask maciekkreft/unblent/unblent`) or from
  `Unblent.dmg`. Apple Silicon, macOS 12 or later.
- Everything is stored on your Mac, in `~/Library/Application Support/Unblent`. There is
  no account and no sync.

[Unreleased]: https://github.com/maciekkreft/unblent/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/maciekkreft/unblent/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/maciekkreft/unblent/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/maciekkreft/unblent/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/maciekkreft/unblent/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/maciekkreft/unblent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/maciekkreft/unblent/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/maciekkreft/unblent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/maciekkreft/unblent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/maciekkreft/unblent/releases/tag/v0.1.0

# Changelog

All notable changes to Unblent for Mac are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/maciekkreft/unblent/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/maciekkreft/unblent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/maciekkreft/unblent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/maciekkreft/unblent/releases/tag/v0.1.0

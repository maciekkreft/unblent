"""Prints the GitHub release text of one version: its section of CHANGELOG.md, then how
to download. Usage: python3 mac/release-notes.py 0.3.0. A version the changelog does not
list, such as a test build, gets only the download line."""

import re
import sys
from pathlib import Path

# The cask, the landing page and the update check each need one of the release's files;
# a reader of the Releases page needs only the first.
DOWNLOAD = (
    "**Download:** `Unblent.dmg` (Apple Silicon, macOS 12 or later), open it and drag "
    "Unblent to Applications. Or: `brew install --cask maciekkreft/unblent/unblent`. "
    "The other files are what the app downloads when it updates itself."
)


def section(changelog, version):
    match = re.search(
        rf"^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## \[|^\[[^\]]+\]: )",
        changelog,
        re.S | re.M,
    )
    return match.group(1).strip() if match else ""


def notes(version):
    changelog = (Path(__file__).resolve().parent.parent / "CHANGELOG.md").read_text()
    body = section(changelog, version)
    return f"{body}\n\n{DOWNLOAD}\n" if body else f"{DOWNLOAD}\n"


if __name__ == "__main__":
    sys.stdout.write(notes(sys.argv[1]))

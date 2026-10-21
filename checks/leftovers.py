#!/usr/bin/env python3
"""Lists test servers and test browsers left running by a session that has ended.

A throwaway server (`check.py --server`, a check's own test server) or a browser a test
launched belongs to a Claude Code session while some process above it is that session's
`claude`, or to a check while that `check.py` runs. Once the session or the check that
started it is gone, the process is re-parented away from it and nothing will ever stop
it: on this 4 GB host it then holds memory until someone kills it. This reads /proc only, so it takes milliseconds.

    python3 checks/leftovers.py          list leftovers, exit 1 when there are any
    python3 checks/leftovers.py --kill   stop them

The live server on :8080 is never a leftover, and neither is anything outside this
project's test servers and Playwright's browsers.
"""
import os
import signal
import sys
from pathlib import Path


def _cmdline(pid):
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    except OSError:
        return []


def _parent(pid):
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return 0
    # The command name in field 2 may hold spaces and parentheses; fields after it don't.
    return int(stat.rsplit(")", 1)[1].split()[1])


# A check the owner runs by hand, or the pre-push hook runs, has no session above it but
# is still alive and will stop its own server, so a live check owns what it started.
def _is_owner(pid):
    args = _cmdline(pid)
    if not args:
        return False
    if os.path.basename(args[0].decode(errors="replace")) == "claude":
        return True
    return any(arg.endswith(b"checks/check.py") for arg in args[:2])


def _owned_by_session(pid):
    seen = set()
    while pid > 1 and pid not in seen:
        seen.add(pid)
        if _is_owner(pid):
            return True
        pid = _parent(pid)
    return False


def _kind(args):
    text = b" ".join(args).decode(errors="replace")
    if "uvicorn" in text and "server.main:app" in text and "--port 8080" not in text:
        return "test server"
    if "ms-playwright" in text and ("--type=" not in text):
        return "test browser"
    return None


def leftovers():
    me = os.getpid()
    found = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit() or int(entry.name) == me:
            continue
        pid = int(entry.name)
        kind = _kind(_cmdline(pid))
        if kind and not _owned_by_session(pid):
            found.append((pid, kind, b" ".join(_cmdline(pid)).decode(errors="replace")[:140]))
    return found


def main():
    found = leftovers()
    for pid, kind, text in found:
        print(f"{pid}  {kind}  {text}")
    if "--kill" in sys.argv[1:]:
        for pid, _, _ in found:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        print(f"stopped {len(found)}" if found else "no leftovers")
        return 0
    if not found:
        print("no leftovers")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())

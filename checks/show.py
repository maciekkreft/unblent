#!/usr/bin/env python3
"""Prints what the running server reports about components, contracts and pages
(architecture.md 7.1, 7.2, 11.1), stdlib only. The raw contracts reply carries every
schema in full; one line per contract is what a reader needs first."""

import json
import sys
import urllib.error
import urllib.request

URL = "http://127.0.0.1:8080"

USAGE = """Prints what the running server reports (architecture.md 7.1).

  python3 checks/show.py components         every component: kind, status, emits, consumes, answers, asks
  python3 checks/show.py contracts          every event, query and command, one line each
  python3 checks/show.py contracts <name>   one contract in full: its schema and who consumes or asks it
                                            (an event `note.changed`, a query or command `read`, or `notes: read`)
  python3 checks/show.py pages              every page and its kind

  --url <base>   another server (default http://127.0.0.1:8080)
"""


def _fields(schema) -> str:
    schema = schema or {}
    branches = schema.get("oneOf") or schema.get("anyOf")
    if branches:
        return " | ".join(_fields(branch) for branch in branches)
    props = schema.get("properties") or {}
    return "{ " + ", ".join(props) + " }" if props else "{}"


def _columns(rows: list) -> list:
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]) - 1)]
    return ["  ".join([*(cell.ljust(w) for cell, w in zip(row, widths)), row[-1]]).rstrip() for row in rows]


def contract_lines(contracts: dict) -> list:
    lines = []
    events = [(e["name"], "owner: " + e["owner"], _fields(e["schema"])) for e in contracts["events"]]
    queries = [
        (f"{q['target']}: {q['name']}", _fields(q["payload"]),
         "→ " + _fields(q["reply"]) + "; superseded by " + ", ".join(q.get("supersededBy") or ["nothing"]))
        for q in contracts["queries"]
    ]
    commands = [(f"{c['target']}: {c['name']}", _fields(c["payload"])) for c in contracts["commands"]]
    for title, rows in (("events", events), ("queries", queries), ("commands", commands)):
        if rows:
            lines += [f"{title} ({len(rows)})", *_columns(rows), ""]
    return lines[:-1]


def find_contracts(contracts: dict, name: str) -> list:
    """Every contract called `name`: an event by its dotted name, a query or command by
    its bare name or as `target: name`."""
    found = [e for e in contracts["events"] if e["name"] == name]
    for entry in contracts["queries"] + contracts["commands"]:
        if name in (entry["name"], f"{entry['target']}: {entry['name']}"):
            found.append(entry)
    return found


def component_lines(catalog: dict) -> list:
    lines = []
    for c in catalog["components"]:
        head = [c["name"], c["kind"] or "?", c["status"]]
        head += [c[key] for key in ("shape", "role") if c.get(key)]
        lines.append("  ".join(head))
        for key in ("emits", "consumes", "answers", "accepts", "asks"):
            if c.get(key):
                lines.append(f"    {key}: " + ", ".join(c[key]))
    return lines


def page_lines(pages: dict) -> list:
    return _columns([(p["kind"], p["path"], p["title"]) for p in pages["pages"]])


def _get(base: str, path: str) -> dict:
    try:
        with urllib.request.urlopen(base + path, timeout=10) as response:
            return json.load(response)
    except (urllib.error.URLError, OSError) as error:
        sys.exit(f"show.py: {base}{path} did not answer ({error}); is the server running?")


def main() -> None:
    argv = sys.argv[1:]
    base = URL
    if "--url" in argv:
        at = argv.index("--url")
        if at + 1 >= len(argv):
            sys.exit("show.py: --url needs a value")
        base = argv[at + 1].rstrip("/")
        del argv[at:at + 2]
    if not argv or "--help" in argv or "-h" in argv:
        print(USAGE)
        return
    what, rest = argv[0], argv[1:]
    if what == "components":
        print("\n".join(component_lines(_get(base, "/api/catalog"))))
    elif what == "pages":
        print("\n".join(page_lines(_get(base, "/api/pages"))))
    elif what == "contracts" and not rest:
        print("\n".join(contract_lines(_get(base, "/api/catalog/contracts"))))
    elif what == "contracts":
        name = " ".join(rest)
        found = find_contracts(_get(base, "/api/catalog/contracts"), name)
        if not found:
            sys.exit(f"show.py: no event, query or command is called {name!r}")
        print(json.dumps(found if len(found) > 1 else found[0], indent=2))
    else:
        sys.exit(USAGE)


if __name__ == "__main__":
    main()

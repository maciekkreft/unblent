#!/usr/bin/env python3
"""Writes the evaluators and box settings every new Mac starts with (architecture.md
3.4) into mac/checks/, from the owner's own on the server host: the admin's evaluators
Goal Type, Value Type and Value Example, which evaluator checks each Choice Point box,
and which checks the values and their examples. Nothing else of the owner's is read or
written: no answers, no text the owner wrote in a journal, no values.

    python3 mac/export-checks.py [--data DIR] [--out DIR]

--data is the server's data folder, data/ by default; --out is where the files go,
mac/checks/ by default. The output is committed; the Mac's evaluators,
choice-point-checks and value-checks server modules each import their own file from
it, once per Mac. Standard library only.
"""

import argparse
import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "mac" / "checks"

NAMES = ("Goal Type", "Value Type", "Value Example")
# Your values is built by evaluators from each user's own values under this fixed id
# (components/evaluators/machine.js), so a box may name it on any Mac; its questions are
# the owner's own values, so their settings are never exported.
YOURS = "0000000000000000000000YVAS"
# The books every Mac has: the journal and the first book (components/books). An
# evaluator kept with any other book is kept with the journal on the Mac.
JOURNAL = "00000000000000000000000JRN"
FIRST_BOOK = "0000000000000000000000MED1"
FIELDS = ("away", "towards", "situation", "thoughts")


def fail(message: str) -> None:
    print(f"export-checks: {message}", file=sys.stderr)
    sys.exit(1)


def connect(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        fail(f"{path} does not exist")
    # Read only, so a run on the host can never change the owner's files.
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def admin(data: Path) -> str:
    # The admin is the account registered first with a passkey (3.4), the same rule as
    # components/session/server/registry.py.
    with closing(connect(data / "session.db")) as connection:
        row = connection.execute("SELECT id FROM users WHERE guest = 0 ORDER BY created_at, rowid LIMIT 1").fetchone()
    if row is None:
        fail("the registry holds no passkey account")
    return row["id"]


def evaluators(folder: Path) -> list[dict]:
    with closing(connect(folder / "evaluators.db")) as connection:
        rows = connection.execute("SELECT * FROM evaluators WHERE deleted = 0 ORDER BY id").fetchall()
    found = {}
    for row in rows:
        name = row["name"].strip().casefold()
        for wanted in NAMES:
            if name == wanted.casefold():
                if wanted in found:
                    fail(f"the admin has more than one evaluator named {wanted!r}")
                found[wanted] = row
    missing = [name for name in NAMES if name not in found]
    if missing:
        fail("the admin has no evaluator named " + ", ".join(repr(n) for n in missing))
    out = []
    for name in NAMES:
        row = found[name]
        book = row["book"]
        if book not in (JOURNAL, FIRST_BOOK):
            print(f"note: {row['name']} is kept with a book a Mac does not have; on the Mac it is kept with the journal")
            book = JOURNAL
        keys = row.keys()
        out.append({
            "id": row["id"],
            "book": book,
            "name": row["name"],
            "description": row["description"] if "description" in keys else "",
            "on": bool(row["on"]),
            "questions": json.loads(row["questions"]),
            "position": row["position"] if "position" in keys else None,
        })
    return out


def kept(evaluator, known: set[str], where: str) -> bool:
    if evaluator is None or evaluator in known or evaluator == YOURS:
        return True
    print(f"note: {where} names an evaluator that is not exported; it is left out")
    return False


def entry(evaluator: str, questions: list, where: str, asked: set[str]) -> list:
    if evaluator == YOURS and questions:
        print(f"note: {where} shows Your values question by question; those are the owner's own values, so it is shown as one mark")
        return []
    out = []
    for setting in questions:
        when = setting.get("when")
        # A mark shown only after an answer to one of Your values' questions names one of
        # the owner's own values, which no Mac has.
        if when and when.get("question") not in asked:
            print(f"note: {where} shows a mark only after an answer of a question that is not exported; it is shown always")
            setting = {**setting, "when": None}
        out.append(setting)
    return out


def boxes(folder: Path, known: set[str], asked: set[str]) -> list[dict]:
    path = folder / "choice-point-checks.db"
    if not path.is_file():
        print("note: the admin has no box settings")
        return []
    with closing(connect(path)) as connection:
        rows = {row["field"]: row for row in connection.execute("SELECT * FROM boxes")}
    out = []
    for field in FIELDS:
        row = rows.get(field)
        if row is None:
            continue
        evaluator, questions = row["evaluator"], json.loads(row["questions"])
        if not kept(evaluator, known, f"the {field} box"):
            evaluator, questions = None, []
        also = []
        for further in json.loads(row["also"]) if "also" in row.keys() and row["also"] else []:
            where = f"the {field} box's Also check with"
            if kept(further["evaluator"], known, where):
                also.append({"evaluator": further["evaluator"], "questions": entry(further["evaluator"], further["questions"], where, asked)})
        out.append({"field": field, "evaluator": evaluator,
                    "questions": entry(evaluator, questions, f"the {field} box", asked) if evaluator else [], "also": also})
    return out


def value_settings(folder: Path, known: set[str]) -> dict:
    path = folder / "value-checks.db"
    row = None
    if path.is_file():
        with closing(connect(path)) as connection:
            row = connection.execute("SELECT values_ev, examples_ev FROM settings WHERE key = 'settings'").fetchone()
    if row is None:
        print("note: the admin has no values settings")
        return {"values": None, "examples": None}
    return {
        "values": row["values_ev"] if kept(row["values_ev"], known, "the values setting") else None,
        "examples": row["examples_ev"] if kept(row["examples_ev"], known, "the examples setting") else None,
    }


def write(out: Path, name: str, value: dict) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {out / name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, default=ROOT / "data", help="the server's data folder (default data/)")
    parser.add_argument("--out", type=Path, default=OUT, help="where the files go (default mac/checks/)")
    args = parser.parse_args()
    folder = args.data / admin(args.data)
    listed = evaluators(folder)
    known = {e["id"] for e in listed}
    asked = {q.get("id") for e in listed for q in e["questions"]}
    # Read everything before writing anything, so a failure leaves mac/checks/ as it was.
    settings = boxes(folder, known, asked), value_settings(folder, known)
    write(args.out, "evaluators.json", {"evaluators": listed})
    write(args.out, "choice-point-checks.json", {"boxes": settings[0]})
    write(args.out, "value-checks.json", {"settings": settings[1]})


if __name__ == "__main__":
    main()

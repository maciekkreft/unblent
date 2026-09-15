"""The server side of ``catalog`` (architecture.md 3.4, 7.3): reads every
component's manifest with the same reader the check uses, so the page and the
check cannot disagree, and computes who interacts with whom."""

import json
import subprocess
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()

ROOT = Path(__file__).resolve().parents[3]
COMPONENTS = ROOT / "components"


# Reading the manifests spawns Node, and every view on a page asks at load, so
# the result is kept until any machine changes (11: the full check has a budget).
_cache: tuple[tuple, dict] | None = None


def _read_manifests() -> dict:
    global _cache
    machines = sorted(str(p.relative_to(ROOT)) for p in COMPONENTS.glob("*/machine.js"))
    stamp = tuple((m, (ROOT / m).stat().st_mtime_ns) for m in machines)
    if _cache is not None and _cache[0] == stamp:
        return _cache[1]
    result = subprocess.run(
        ["node", "--import", "./checks/register.mjs", "checks/manifests.mjs", *machines],
        cwd=ROOT, capture_output=True, text=True, timeout=30, check=True,
    )
    _cache = (stamp, json.loads(result.stdout))
    return _cache[1]


def _records(manifests: dict) -> list:
    records = []
    for path, manifest in manifests.items():
        directory = ROOT / Path(path).parent
        meta = manifest["meta"]
        is_fact = meta["kind"] == "fact"
        records.append({
            "name": directory.name,
            # Section 7.3: built when the browser entry exists, planned otherwise.
            "status": "built" if any((directory / e).is_file() for e in ("view.js", "fact.js")) else "planned",
            "kind": meta["kind"],
            "shape": meta.get("shape") if is_fact else None,
            "owns": meta.get("owns") if is_fact else None,
            "attributes": meta.get("attributes") if not is_fact else None,
            "role": meta.get("role") if not is_fact else None,
            "emits": meta["emits"],
            "consumes": manifest["consumes"],
            "accepts": manifest["accepts"],
            "answers": manifest["answers"],
            "asks": meta.get("asks", []),
            "interacts": [],
        })
    return sorted(records, key=lambda r: r["name"])


def _link(records: list) -> None:
    """Section 7.3: from manifests alone, who each component interacts with."""
    for record in records:
        for event in record["emits"]:
            for other in records:
                if other is not record and event in other["consumes"]:
                    record["interacts"].append({"with": other["name"], "via": event, "how": "emits"})
        for event in record["consumes"]:
            for other in records:
                if other is not record and event in other["emits"]:
                    record["interacts"].append({"with": other["name"], "via": event, "how": "consumes"})
        for ask in record["asks"]:
            target, _, query = ask.partition(": ")
            record["interacts"].append({"with": target, "via": query, "how": "asks"})
        for query in record["answers"]:
            for other in records:
                if other is not record and f"{record['name']}: {query}" in other["asks"]:
                    record["interacts"].append({"with": other["name"], "via": query, "how": "answers"})
        record["interacts"].sort(key=lambda i: (i["with"], i["via"], i["how"]))


def _schema(component: str, kind: str, name: str) -> dict:
    return json.loads((COMPONENTS / component / kind / f"{name}.json").read_text())


def _contracts(records: list) -> dict:
    """Section 7.2: pivot the schema files into the shared vocabulary. An event's
    consumers and a query's askers are read from the manifests, the same source as
    the interactions, so the contracts page and the components page cannot diverge."""
    events, queries, commands = [], [], []
    for record in records:
        owner = record["name"]
        for name in record["emits"]:
            events.append({
                "name": name,
                "owner": owner,
                "schema": _schema(owner, "events", name),
                "consumers": sorted(o["name"] for o in records if name in o["consumes"]),
            })
        for name in record["answers"]:
            schema = _schema(owner, "queries", name)
            queries.append({
                "target": owner,
                "name": name,
                "payload": schema["payload"],
                "reply": schema["reply"],
                "askers": sorted(o["name"] for o in records if f"{owner}: {name}" in o["asks"]),
            })
        for name in record["accepts"]:
            commands.append({
                "target": owner,
                "name": name,
                "payload": _schema(owner, "commands", name),
            })
    events.sort(key=lambda e: e["name"])
    queries.sort(key=lambda q: (q["target"], q["name"]))
    commands.sort(key=lambda c: (c["target"], c["name"]))
    return {"events": events, "queries": queries, "commands": commands}


@router.get("")
def list_components():
    try:
        manifests = _read_manifests()
    except (subprocess.SubprocessError, OSError, ValueError):
        return JSONResponse({"error": "unavailable"}, status_code=503)
    records = _records(manifests)
    _link(records)
    return {"components": records}


@router.get("/contracts")
def list_contracts():
    try:
        manifests = _read_manifests()
        records = _records(manifests)
        return _contracts(records)
    except (subprocess.SubprocessError, OSError, ValueError):
        return JSONResponse({"error": "unavailable"}, status_code=503)

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


def _read_manifests() -> dict:
    machines = sorted(str(p.relative_to(ROOT)) for p in COMPONENTS.glob("*/machine.js"))
    result = subprocess.run(
        ["node", "--import", "./checks/register.mjs", "checks/manifests.mjs", *machines],
        cwd=ROOT, capture_output=True, text=True, timeout=30, check=True,
    )
    return json.loads(result.stdout)


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


@router.get("")
def list_components():
    try:
        manifests = _read_manifests()
    except (subprocess.SubprocessError, OSError, ValueError):
        return JSONResponse({"error": "unavailable"}, status_code=503)
    records = _records(manifests)
    _link(records)
    return {"components": records}

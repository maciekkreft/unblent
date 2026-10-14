#!/usr/bin/env python3
"""The one check command (architecture.md 11), stdlib only. `--static` is the fast phase."""

import ast
import contextlib
import fnmatch
import fcntl
import glob
import hashlib
import http.client
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR_JSON = json.loads((ROOT / "vendor" / "vendor.json").read_text())
IMPORTMAP = VENDOR_JSON["importmap"]
ALLOWED_BARE = set(IMPORTMAP["imports"]) | {"bus", "store", "icons"}

# Section 11: the fast phase runs after every edit within one second in total; a
# test has its own budget, so the full run's length may grow with the system
# while no single test may.
STATIC_BUDGET_S = 1.0
TEST_TIMEOUT_MS = 5000
# Section 11: a test past half its budget has no headroom left for a loaded host.
HEADROOM_MS = TEST_TIMEOUT_MS / 2
# The task-end gate runs browser tests in WebKit (11). Every two-engine test names its
# engine "in <engine>"; a Chromium-only test (the WebAuthn ceremony) does not, so it stays.
SKIP_CHROMIUM = "--test-skip-pattern=in chromium"


def _dotenv() -> dict:
    """KEY=VALUE lines from the gitignored .env: machine-specific settings such
    as PLAYWRIGHT_MODULE, so no tracked file carries a local path."""
    env = {}
    dotenv = ROOT / ".env"
    if dotenv.is_file():
        for line in dotenv.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def fail(file: str, rule: str, detail: str) -> None:
    print(f"FAIL [{rule}]\n  {file}\n  {detail}", file=sys.stderr)
    sys.exit(1)


# --- Vendor check (architecture.md 10) ------------------------------------------

_SOURCEMAP = re.compile(r"^//[#@]\s*sourceMappingURL=(\S+)\s*$", re.M)


def check_vendor() -> None:
    listed = {}
    for pkg in VENDOR_JSON["packages"]:
        for rel, digest in pkg.get("files", {}).items():
            listed[rel] = digest
    present = {str(f.relative_to(ROOT / "vendor")).replace("\\", "/")
               for f in (ROOT / "vendor").rglob("*") if f.is_file()} - {"vendor.json"}
    for rel in sorted(present - set(listed)):
        fail(f"vendor/{rel}", "vendor check (10)", "file is not listed in vendor/vendor.json")
    for rel in sorted(set(listed) - present):
        fail(f"vendor/{rel}", "vendor check (10)", "listed in vendor/vendor.json but missing")
    for rel, digest in sorted(listed.items()):
        file = ROOT / "vendor" / rel
        actual = hashlib.sha256(file.read_bytes()).hexdigest()
        if actual != digest:
            fail(f"vendor/{rel}", "vendor check (10)",
                 f"sha256 {actual} does not match vendor.json ({digest}); re-vendor from the recorded source")
        if file.suffix in (".js", ".css"):
            for ref in _SOURCEMAP.findall(file.read_text(errors="replace")):
                if not (file.parent / ref).is_file():
                    fail(f"vendor/{rel}", "vendor check (10)",
                         f"sourceMappingURL={ref} does not resolve; vendor the map beside the file")


# --- Layout check (architecture.md 11.1) -----------------------------------------

def _documented_layout() -> set:
    doc = (ROOT / "architecture.md").read_text()
    start = doc.index("The components tree sits inside")
    block = doc[start:].split("```")[1]
    return {m.group(1) for m in re.finditer(r"^([\w.-]+)/", block, re.M)}


def check_layout() -> None:
    documented = _documented_layout()
    for entry in sorted(ROOT.iterdir()):
        if entry.is_dir() and not entry.name.startswith(".") and entry.name != "__pycache__":
            if entry.name not in documented:
                fail(entry.name + "/", "layout check (11.1)",
                     "top-level directory is not in the architecture's layout listing; add it there or remove it")


# --- Manifest check (architecture.md 7.3) ----------------------------------------

_KINDS = {"fact", "view"}
_SHAPES = {"local-only", "replicated", "remote-only"}
_ASK = re.compile(r"^[\w-]+: [\w-]+$")


def read_manifests() -> dict:
    machines = sorted(glob.glob("components/*/machine.js", root_dir=ROOT))
    if not machines:
        return {}
    result = subprocess.run(
        ["node", "--import", "./checks/register.mjs", "checks/manifests.mjs", *machines],
        cwd=ROOT, capture_output=True, text=True,
    )
    if result.returncode != 0:
        fail("components/*/machine.js", "manifest check (7.3)",
             "a machine failed to import in Node:\n" + result.stderr.strip())
    return json.loads(result.stdout)


def check_manifests(manifests: dict) -> None:
    for path, manifest in manifests.items():
        if "error" in manifest:
            fail(path, "manifest check (7.3)", manifest["error"])
        meta = manifest["meta"]
        if not isinstance(meta, dict):
            fail(path, "manifest check (7.3)", "machine has no `meta`")
        name = Path(path).parent.name
        if manifest["id"] != name:
            fail(path, "manifest check (7.3)", f"machine id {manifest['id']!r} must equal the directory name {name!r}")
        if meta.get("kind") not in _KINDS:
            fail(path, "manifest check (7.3)", f"meta.kind must be one of {sorted(_KINDS)}")
        if "status" in meta:
            fail(path, "manifest check (7.3)",
                 "status is derived from the browser entry (7.3); remove meta.status")
        # Section 7.3: what the component does for the user is read from the running
        # system, so architecture.md need not list it.
        if not (isinstance(meta.get("description"), str) and meta["description"].strip()):
            fail(path, "manifest check (7.3)",
                 "meta.description must be a non-empty string saying what the component does for the user")
        if not isinstance(meta.get("emits"), list):
            fail(path, "manifest check (7.3)", "meta.emits must be a list, empty if it emits nothing")
        asks = meta.get("asks", [])
        # The wildcard `*: tool` (7.7) lets an asker ask any query marked as a tool; every
        # other ask names one target and query.
        if not (isinstance(asks, list) and all(isinstance(a, str) and (a == "*: tool" or _ASK.match(a)) for a in asks)):
            fail(path, "manifest check (7.3)", 'meta.asks must be a list of "target: query" strings (or the wildcard "*: tool")')
        if meta["kind"] == "fact":
            if meta.get("shape") not in _SHAPES:
                fail(path, "manifest check (7.3)", f"a fact component's meta.shape must be one of {sorted(_SHAPES)}")
            if not (isinstance(meta.get("owns"), str) and meta["owns"].strip()):
                fail(path, "manifest check (7.3)", "a fact component's meta.owns must be a non-empty string naming the fact")
            if "attributes" in meta:
                fail(path, "manifest check (7.3)", "a fact component has no attributes")
            if "role" in meta:
                fail(path, "manifest check (7.3)", "a fact component has no role (7.3)")
        else:
            if "shape" in meta:
                fail(path, "manifest check (7.3)", "a view component has no shape")
            if "owns" in meta:
                fail(path, "manifest check (7.3)", "a view component owns no fact")
            if not isinstance(meta.get("attributes"), list):
                fail(path, "manifest check (7.3)", "a view component's meta.attributes must be a list, empty if none")
            # role is optional (7.3): a lowercase name for a slot of interchangeable
            # implementations. Validated only when present.
            if "role" in meta:
                role = meta["role"]
                if not (isinstance(role, str) and role and role == role.lower()):
                    fail(path, "manifest check (7.3)", "meta.role must be a non-empty lowercase string")


# --- Role check (architecture.md 7.3, 11.2) --------------------------------------

def check_roles(manifests: dict) -> None:
    """Section 11.2, roles are coherent: every view declaring a role exposes the
    same contract, so the composer can swap one member for another without
    surprising a neighbour. The four the manifest names — emits, asks, accepts,
    answers — are compared as sorted sets."""
    groups = {}
    for path, manifest in manifests.items():
        role = manifest["meta"].get("role")
        if role:
            groups.setdefault(role, []).append((path, manifest))
    for role, members in groups.items():
        if len(members) < 2:
            continue
        def contract(m):
            return (
                tuple(sorted(set(m["meta"].get("emits", [])))),
                tuple(sorted(set(m["meta"].get("asks", [])))),
                tuple(sorted(set(m["accepts"]))),
                tuple(sorted(set(m["answers"]))),
            )
        first_path, first = members[0]
        want = contract(first)
        for path, manifest in members[1:]:
            if contract(manifest) != want:
                fail(path, "role check (11.2)",
                     f"role {role!r} members must share one contract (emits, asks, accepts, answers); "
                     f"{Path(path).parent.name} differs from {Path(first_path).parent.name}")


# --- Composer checks (architecture.md 3.6, 11.2) ---------------------------------

# The composer is the one thing outside components/ that may cross a component
# boundary, and only to import a role member's view.js by its URL (11.2).
_COMPOSER_DYNAMIC = re.compile(r"""\bimport\s*\(\s*([`'"])([^`'"]+)\1""")
_COMPOSER_VIEW_URL = re.compile(r"^/static/components/(?:[\w-]+|\$\{[^}]+\})/view\.js$")


def check_composer_imports() -> None:
    """Section 11.2: the composer imports bus, store or icons and vendored names,
    stays inside composer/ for relative paths, and reaches across a component
    boundary only through a dynamic import of a role member's view.js URL."""
    for path in sorted(glob.glob("composer/*.js", root_dir=ROOT)):
        file = ROOT / path
        src = _strip_comments(file.read_text())
        dynamic = {m.group(2) for m in _COMPOSER_DYNAMIC.finditer(src)}
        statics = set(_STATIC_IMPORT.findall(src))
        for spec in sorted(statics | dynamic):
            if spec in dynamic and _COMPOSER_VIEW_URL.match(spec):
                continue
            if spec.startswith("."):
                if ".." in spec.split("/"):
                    fail(path, "composer import check (11.2)",
                         f'relative import "{spec}" escapes composer/')
                target = (file.parent / spec).resolve()
                if file.parent not in target.parents and target != file.parent:
                    fail(path, "composer import check (11.2)",
                         f'relative import "{spec}" leaves composer/')
            elif spec.startswith("/"):
                fail(path, "composer import check (11.2)",
                     f'absolute import "{spec}" is only allowed as a dynamic import of a '
                     "role member's /static/components/<name>/view.js")
            elif spec not in ALLOWED_BARE:
                fail(path, "composer import check (11.2)",
                     f'bare import "{spec}" is not a vendored name, bus, store, or icons')


def check_composer() -> None:
    """Section 11.2, the composer stays in its lane: it changes only role-bearing
    elements, in place, and never writes the document root, body, head or title."""
    for path in sorted(glob.glob("composer/*.js", root_dir=ROOT)):
        src = _strip_comments((ROOT / path).read_text())
        for m in _DOC_OTHER.finditer(src):
            fail(path, "composer check (11.2)",
                 f"writes to document.{m.group(1)}; the composer never touches the document (3.6)")
        for m in _DOC_ELEMENT_WRITE.finditer(src):
            fail(path, "composer check (11.2)",
                 f"writes to document.documentElement.{m.group(1)}; the composer changes only role elements (3.6)")


# --- Component check (architecture.md 11.1) --------------------------------------

_ALLOWED_ENTRIES = {"machine.js", "view.js", "fact.js", "store.js", "events", "queries", "commands", "server", "tests"}
_KIND_FORBIDS = {"view": {"store.js", "server", "queries", "fact.js"}, "fact": {"view.js"}}


def check_component_dirs(manifests: dict) -> None:
    for comp in sorted(p for p in (ROOT / "components").iterdir() if p.is_dir()):
        rel = f"components/{comp.name}"
        entries = {e.name for e in comp.iterdir() if e.name != "__pycache__"}
        if "machine.js" not in entries:
            fail(rel, "component check (11.1)", "no machine.js; the manifest is read from it")
        for extra in sorted(entries - _ALLOWED_ENTRIES):
            fail(f"{rel}/{extra}", "component check (11.1)",
                 f"not one of {sorted(_ALLOWED_ENTRIES)}")
        meta = manifests[f"{rel}/machine.js"]["meta"]
        for forbidden in sorted(entries & _KIND_FORBIDS.get(meta["kind"], set())):
            fail(f"{rel}/{forbidden}", "component check (11.1)",
                 f"a {meta['kind']} component does not have this")
        if "view.js" in entries:
            src = (comp / "view.js").read_text()
            if f'customElements.define("{comp.name}"' not in src:
                fail(f"{rel}/view.js", "component check (11.1)",
                     f'must define the custom element "{comp.name}", the directory name')
        # A component is built when its browser entry exists (7.3), and a built one has tests.
        if (entries & {"view.js", "fact.js"}) and not list(comp.glob("tests/*.test.mjs")):
            fail(f"{rel}/tests", "component check (11.1)", "a built component has tests")


# --- Contract check (architecture.md 7.1, 7.2, 11.2) -----------------------------

_DRAFT = "https://json-schema.org/draft/2020-12/schema"


def _parse_schema(path: str, file: Path) -> dict:
    try:
        return json.loads(file.read_text())
    except json.JSONDecodeError as exc:
        fail(path, "contract check (11.2)", f"is not valid JSON: {exc}")


def _check_draft(path: str, schema: object, what: str) -> None:
    if not isinstance(schema, dict):
        fail(path, "contract check (11.2)", f"{what} must be a JSON Schema object")
    if schema.get("$schema") != _DRAFT:
        fail(path, "contract check (11.2)",
             f'{what} must state the draft: "$schema": "{_DRAFT}"')


def check_contracts(manifests: dict) -> None:
    """Section 7.2: every declared emit has events/<name>.json, every answered
    query queries/<name>.json ({ payload, reply }, with an optional supersededBy the
    supersession check owns), every accepted command commands/<name>.json; each
    schema states the draft, and a schema file with no matching declaration or
    handler fails, so the contracts cannot drift."""
    for path, manifest in manifests.items():
        comp = ROOT / Path(path).parent
        rel = f"components/{comp.name}"
        expected = {
            "events": set(manifest["meta"].get("emits", [])),
            "queries": set(manifest["answers"]),
            "commands": set(manifest["accepts"]),
        }
        singular = {"events": "event", "queries": "query", "commands": "command"}
        for kind, names in expected.items():
            directory = comp / kind
            present = {f.stem for f in directory.glob("*.json")} if directory.is_dir() else set()
            for name in sorted(names - present):
                fail(f"{rel}/{kind}/{name}.json", "contract check (11.2)",
                     f"{comp.name} declares {singular[kind]} {name!r} but its schema file is missing")
            for name in sorted(present - names):
                fail(f"{rel}/{kind}/{name}.json", "contract check (11.2)",
                     f"schema file has no matching {singular[kind]} declaration or handler on {comp.name}")
            for name in sorted(names & present):
                schema_path = f"{rel}/{kind}/{name}.json"
                schema = _parse_schema(schema_path, directory / f"{name}.json")
                if kind == "queries":
                    for key in ("payload", "reply"):
                        if key not in schema:
                            fail(schema_path, "contract check (11.2)",
                                 f"a query schema must have a {key!r} key ({{ payload, reply }})")
                        _check_draft(schema_path, schema[key], key)
                    # Section 7.2, 7.7: a query schema file holds only these keys; `tool`
                    # opts the query in as a tool and must be a { description, label } of
                    # non-empty strings.
                    for key in schema:
                        if key not in ("payload", "reply", "supersededBy", "tool"):
                            fail(schema_path, "contract check (11.2)",
                                 f"unknown top-level key {key!r} in a query schema (only payload, reply, supersededBy, tool)")
                    if "tool" in schema:
                        tool = schema["tool"]
                        ok = isinstance(tool, dict) and all(
                            isinstance(tool.get(f), str) and tool.get(f).strip() for f in ("description", "label")
                        )
                        if not ok:
                            fail(schema_path, "contract check (11.2)",
                                 "a query's tool entry must be a { description, label } of non-empty strings (7.7)")
                else:
                    _check_draft(schema_path, schema, "the schema")


# --- Supersession check (architecture.md 4.2, 4.3, 11.2) -------------------------

def supersession_breaks(recs: dict, schemas: dict) -> list:
    """Section 4.2, 4.3: the decision, pure over dicts so a unit test can exercise it
    without git or the tree. recs is {name: manifest}; schemas is {(owner, query):
    schema_dict}. Every query names the events that supersede its answer in a
    supersededBy list of strings; every name is one the owner emits; and every asker
    of the query consumes every event that supersedes it, so "query for the start,
    subscribe for the rest" holds by construction. Returns (owner, query, detail)
    triples, one per break."""
    out = []
    for owner, q in sorted(schemas):
        sup = schemas[(owner, q)].get("supersededBy")
        if not isinstance(sup, list) or not all(isinstance(n, str) for n in sup):
            out.append((owner, q, f"{owner}: {q} has no supersededBy list of event names"))
            continue
        emits = recs.get(owner, {}).get("meta", {}).get("emits", [])
        for ev in sup:
            if ev not in emits:
                out.append((owner, q, f"{owner}: {q} is superseded by {ev}, which {owner} does not emit"))
        for name in sorted(recs):
            m = recs[name]
            # The wildcard `*: tool` (7.7) asks no specific query, so it does not bring the
            # follow-what-you-ask duty: its holder need not consume a tool's supersededBy.
            asks = [a for a in m["meta"].get("asks", []) if a != "*: tool"]
            if f"{owner}: {q}" not in asks:
                continue
            for ev in sup:
                if ev not in m["consumes"]:
                    out.append((owner, q, f"{name} asks {owner}: {q} but does not consume {ev}, which supersedes it"))
    return out


def check_supersession(manifests: dict) -> None:
    """Section 4.2, 4.3, 11.2: the bus holds a query's supersededBy events for the
    asker until the reply lands; this rule makes the declaration answerable — every
    superseding event is one the owner emits, and every asker of a query follows
    what supersedes it. Reads the query schemas from the tree and defers the decision
    to supersession_breaks."""
    recs = {Path(p).parent.name: m for p, m in manifests.items()}
    schemas = {}
    for path in manifests:
        comp = ROOT / Path(path).parent
        qdir = comp / "queries"
        if not qdir.is_dir():
            continue
        for f in sorted(qdir.glob("*.json")):
            schemas[(comp.name, f.stem)] = _parse_schema(f"components/{comp.name}/queries/{f.stem}.json", f)
    for owner, q, detail in supersession_breaks(recs, schemas):
        fail(f"components/{owner}/queries/{q}.json", "supersession check (11.2)", detail)


# --- Schema compatibility check (architecture.md 7.1, 7.2, 11.2) -----------------

_SCHEMA_GLOBS = [
    "components/*/events/*.json",
    "components/*/queries/*.json",
    "components/*/commands/*.json",
]


def _schema_changes() -> list:
    """Section 11.2: the schema files git sees changed against HEAD, staged or not,
    as (status, path) with status 'M' or 'D'. --no-renames so a rename reads as a
    delete plus an add, which at the contract level is a removal and an addition. An
    add is additive and ignored. A non-repo or a repo with no HEAD yields nothing, so
    the rule is silent where there is no previous commit to compare against."""
    result = subprocess.run(
        ["git", "diff", "--name-status", "--no-renames", "HEAD", "--", *_SCHEMA_GLOBS],
        cwd=ROOT, capture_output=True, text=True,
    )
    if result.returncode != 0:
        return []
    changes = []
    for line in result.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) != 2:
            continue
        status, path = parts[0].strip(), parts[1].strip()
        if status in ("M", "D"):
            changes.append((status, path))
    return changes


def _types(schema: dict) -> set:
    """The `type` keyword as a set, whether a string or a list."""
    t = schema.get("type")
    if isinstance(t, str):
        return {t}
    if isinstance(t, list):
        return set(t)
    return set()


def schema_breaks(old: object, new: object, path: str = "") -> list:
    """Section 7.1: the ways one schema may not shrink relative to an older one,
    each as a line naming where inside the schema it happened. A pure structural
    diff, keyword-aware, descending only where both sides are schema objects. A
    boolean schema (`true`/`false`) is a schema: `true` accepts anything, so a
    narrowing to an object or to `false` is a break."""
    breaks = []
    here = path or "(root)"

    # A boolean schema on either side: only true -> anything-narrower breaks.
    if isinstance(old, bool) or isinstance(new, bool):
        if old is True and new is not True:
            breaks.append(f"{here}: schema narrowed from accept-anything (true)")
        return breaks
    if not isinstance(old, dict) or not isinstance(new, dict):
        return breaks

    old_props = old.get("properties", {})
    new_props = new.get("properties", {}) if isinstance(new.get("properties"), dict) else {}
    if isinstance(old_props, dict):
        for name in old_props:
            if name not in new_props:
                breaks.append(f"{here}/properties/{name}: field removed or renamed")
            else:
                breaks += schema_breaks(old_props[name], new_props[name],
                                        f"{here}/properties/{name}")

    old_req = set(old.get("required", []))
    new_req = set(new.get("required", []))
    for name in sorted(new_req - old_req):
        breaks.append(f"{here}/required: new required field {name!r}")

    old_types, new_types = _types(old), _types(new)
    if old_types and new_types:
        lost = old_types - new_types
        if lost:
            breaks.append(f"{here}/type: type narrowed, lost {sorted(lost)}")

    if "enum" in old and "enum" in new:
        lost = [v for v in old["enum"] if v not in new["enum"]]
        if lost:
            breaks.append(f"{here}/enum: value(s) removed {lost}")

    if "const" in old and old.get("const") != new.get("const"):
        breaks.append(f"{here}/const: const changed")

    for key in ("oneOf", "anyOf", "allOf"):
        if key in old and isinstance(old[key], list):
            new_list = new.get(key) if isinstance(new.get(key), list) else []
            if len(new_list) < len(old[key]):
                breaks.append(f"{here}/{key}: branch removed "
                              f"({len(old[key])} -> {len(new_list)})")
            for i in range(min(len(old[key]), len(new_list))):
                breaks += schema_breaks(old[key][i], new_list[i], f"{here}/{key}/{i}")

    if "items" in old:
        breaks += schema_breaks(old["items"], new.get("items", True), f"{here}/items")

    for container in ("$defs", "patternProperties"):
        old_c = old.get(container)
        if isinstance(old_c, dict):
            new_c = new.get(container) if isinstance(new.get(container), dict) else {}
            for name, sub in old_c.items():
                if name not in new_c:
                    breaks.append(f"{here}/{container}/{name}: removed")
                else:
                    breaks += schema_breaks(sub, new_c[name], f"{here}/{container}/{name}")

    old_ap, new_ap = old.get("additionalProperties"), new.get("additionalProperties")
    if new_ap is False and old_ap is not False:
        breaks.append(f"{here}/additionalProperties: closed (was open)")
    elif isinstance(old_ap, dict):
        breaks += schema_breaks(old_ap, new_ap if new_ap is not None else True,
                                f"{here}/additionalProperties")

    return breaks


def _tool_queries(manifests: dict) -> list:
    """Section 7.7: every (owner, query) whose schema carries a tool entry, read from
    the tree, so the wildcard ask `*: tool` can be expanded to the queries it reaches."""
    out = []
    for path in manifests:
        comp = ROOT / Path(path).parent
        qdir = comp / "queries"
        if not qdir.is_dir():
            continue
        for f in sorted(qdir.glob("*.json")):
            try:
                schema = json.loads(f.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            if isinstance(schema, dict) and isinstance(schema.get("tool"), dict):
                out.append((comp.name, f.stem))
    return out


def _contract_parties(manifests: dict) -> dict:
    """Section 7.3: who a contract's change affects, from manifests alone. For an
    event, its emitters and consumers; for a query, its answerer and askers; for a
    command, only the acceptor, since nothing records who sends one. Reimplemented
    like _interaction_graph because the check cannot import a component (11.2)."""
    recs = {Path(p).parent.name: m for p, m in manifests.items()}
    tools = _tool_queries(manifests)
    parties = {"events": {}, "queries": {}, "commands": {}}
    for name, m in recs.items():
        for ev in m["meta"].get("emits", []):
            parties["events"].setdefault(ev, {"emitters": set(), "consumers": set()})["emitters"].add(name)
        for ev in m["consumes"]:
            parties["events"].setdefault(ev, {"emitters": set(), "consumers": set()})["consumers"].add(name)
        for q in m["answers"]:
            parties["queries"].setdefault(q, {"answerers": set(), "askers": set()})["answerers"].add(name)
        for ask in m["meta"].get("asks", []):
            # The wildcard reaches every tool-marked query (7.7); a plain ask names one.
            if ask == "*: tool":
                for _owner, q in tools:
                    parties["queries"].setdefault(q, {"answerers": set(), "askers": set()})["askers"].add(name)
                continue
            q = ask.split(":", 1)[1].strip() if ":" in ask else ask.strip()
            parties["queries"].setdefault(q, {"answerers": set(), "askers": set()})["askers"].add(name)
        for cmd in m["accepts"]:
            parties["commands"].setdefault(cmd, {"acceptors": set()})["acceptors"].add(name)
    return parties


def _affected_line(kind: str, name: str, parties: dict) -> str:
    """One 'affected: … → …' line naming the components a break touches."""
    if kind == "events":
        p = parties["events"].get(name, {})
        emit = ", ".join(sorted(p.get("emitters", []))) or "?"
        cons = ", ".join(sorted(p.get("consumers", []))) or "none"
        return f"affected: emitted by {emit} → consumed by {cons}"
    if kind == "queries":
        p = parties["queries"].get(name, {})
        ans = ", ".join(sorted(p.get("answerers", []))) or "?"
        ask = ", ".join(sorted(p.get("askers", []))) or "none"
        return f"affected: answered by {ans} → asked by {ask}"
    p = parties["commands"].get(name, {})
    acc = ", ".join(sorted(p.get("acceptors", []))) or "?"
    return f"affected: accepted by {acc} (senders are not recorded)"


def check_schema_compat(manifests: dict) -> None:
    """Section 7.1, 11.2: a contract only grows. Every changed events/, queries/ or
    commands/ schema is compared against HEAD; a removed or renamed field, a new
    required field, a narrowed type, a lost enum/const value, a dropped oneOf branch,
    additionalProperties closing, or a schema deleted while its component remains,
    each fails, naming the path inside the schema and the components affected."""
    parties = _contract_parties(manifests)
    known = {Path(p).parent.name for p in manifests}
    for status, path in _schema_changes():
        parts = Path(path).parts
        if len(parts) != 4:
            continue
        _, comp, kind, filename = parts
        name = filename[:-5] if filename.endswith(".json") else filename
        if status == "D":
            if comp in known:
                fail(path, "schema compatibility (11.2)",
                     f"schema removed while component {comp!r} remains; a contract only grows. "
                     f"{_affected_line(kind, name, parties)}")
            continue
        old_text = subprocess.run(
            ["git", "show", f"HEAD:{path}"], cwd=ROOT, capture_output=True, text=True,
        )
        if old_text.returncode != 0:
            continue
        try:
            old = json.loads(old_text.stdout)
            new = json.loads((ROOT / path).read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if kind == "queries":
            breaks = []
            for key in ("payload", "reply"):
                if key in old:
                    breaks += schema_breaks(old[key], new.get(key, {}), key)
        else:
            breaks = schema_breaks(old, new)
        if breaks:
            detail = "; ".join(breaks) + f". {_affected_line(kind, name, parties)}"
            fail(path, "schema compatibility (11.2)", detail)


# --- Import check (architecture.md 11.2) -----------------------------------------

_STATIC_IMPORT = re.compile(
    r"""(?:\bimport\b|\bexport\b)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]"""
)
_DYNAMIC_IMPORT = re.compile(r"""\bimport\s*\(\s*['"]([^'"]+)['"]""")
_LINE_COMMENT = re.compile(r"//[^\n]*")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)


def _strip_comments(src: str) -> str:
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", src))


def kit_mentions(src: str, names: list) -> list:
    """The component names, and static component paths, a kit source names as whole
    words outside comments (11.2): a helper about one component belongs in that
    component's tests, so deleting the component deletes the helper with it."""
    text = _strip_comments(src)
    found = [n for n in sorted(names) if re.search(rf"(?<![\w-]){re.escape(n)}(?![\w-])", text)]
    if "/static/components/" in text:
        found.append("/static/components/")
    return found


def check_kit(manifests: dict) -> None:
    path = ROOT / "checks" / "kit.mjs"
    if not path.exists():
        return
    names = [Path(m).parent.name for m in manifests]
    for name in kit_mentions(path.read_text(), names):
        fail("checks/kit.mjs", "kit check (11.2)",
             f"the kit names {name!r}; a helper about one component lives in that component's tests")


def check_imports() -> None:
    for path in sorted(glob.glob("components/*/*.js", root_dir=ROOT)):
        file = ROOT / path
        component_dir = file.parent
        src = _strip_comments(file.read_text())
        specifiers = _STATIC_IMPORT.findall(src) + _DYNAMIC_IMPORT.findall(src)
        for spec in specifiers:
            if spec.startswith("."):
                if ".." in spec.split("/"):
                    fail(path, "import check (11.2)",
                         f'relative import "{spec}" escapes the component directory')
                target = (component_dir / spec).resolve()
                if component_dir not in target.parents and target != component_dir:
                    fail(path, "import check (11.2)",
                         f'relative import "{spec}" leaves {component_dir.name}/')
            elif spec.startswith("/"):
                fail(path, "import check (11.2)",
                     f'absolute import "{spec}" is not allowed; use a bare name or a local path')
            elif spec not in ALLOWED_BARE:
                fail(path, "import check (11.2)",
                     f'bare import "{spec}" is not a vendored name, bus, store, or icons')


# A server module (11.2) may import the standard library, the packages named in
# requirements.txt and what they in turn depend on, or a sibling inside its own server/.
def _requirements() -> set:
    names = set()
    for line in (ROOT / "requirements.txt").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            names.add(re.split(r"[\[<>=!~ ]", line, maxsplit=1)[0].replace("-", "_").lower())
    return names | {"starlette", "pydantic"}


def check_python_imports() -> None:
    allowed = sys.stdlib_module_names | _requirements()
    for path in sorted(glob.glob("components/*/server/*.py", root_dir=ROOT)):
        tree = ast.parse((ROOT / path).read_text(), filename=path)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level > 0:
                    continue
                names = [node.module or ""]
            else:
                continue
            for name in names:
                # A server module may reach the entry's user infrastructure (11.1).
                if name == "server.user":
                    continue
                top = name.split(".")[0]
                if top not in allowed:
                    fail(path, "import check (11.2)",
                         f'import "{name}" is not the standard library, a requirements.txt package, '
                         "server.user, or a relative module inside server/")


# --- Store check (architecture.md 11.2) ------------------------------------------

# A call, not the definition: `function openStore(` is excluded so a store.js may
# still name its own wrapper (viewport's does).
_OPENSTORE_CALL = re.compile(r"(?<!function )openStore\(")
_OPENSTORE_LITERAL = re.compile(r"""openStore\(\s*(['"])([^'"]*)\1""")


def check_store(manifests: dict) -> None:
    """Section 11.2, one owner per fact: a component reaches the store only through
    the bare `store` module, only from a fact's store.js or fact.js (views open
    none), and every openStore() opens the database bearing the component's own name."""
    kinds = {Path(p).parent.name: m["meta"].get("kind") for p, m in manifests.items()}
    for path in sorted(glob.glob("components/*/*.js", root_dir=ROOT)):
        _, comp, file = Path(path).parts
        src = _strip_comments((ROOT / path).read_text())
        if "store" in (_STATIC_IMPORT.findall(src) + _DYNAMIC_IMPORT.findall(src)):
            if file not in ("store.js", "fact.js"):
                fail(path, "store check (11.2)",
                     "only a fact component's store.js or fact.js may import the store")
            if kinds.get(comp) != "fact":
                fail(path, "store check (11.2)",
                     f"{comp} is a {kinds.get(comp)} component; only a fact opens a store")
        calls = _OPENSTORE_CALL.findall(src)
        literals = _OPENSTORE_LITERAL.findall(src)
        if len(calls) != len(literals):
            fail(path, "store check (11.2)",
                 "openStore(...) must take a string-literal name, the component's own")
        for _quote, name in literals:
            if name != comp:
                fail(path, "store check (11.2)",
                     f'openStore("{name}") must open the database named "{comp}", the component\'s own')


# --- Page check (architecture.md 8) ----------------------------------------------

# The five page kinds of section 8; duplicated in the pages router, which the
# check cannot import, so the two lists cannot share a definition.
PAGE_KINDS = ("tokens", "contracts", "components", "stem", "app")


class PageChecker(HTMLParser):
    def __init__(self, path: str):
        super().__init__()
        self.path = path
        self._script_type = None
        self._script_src = None
        self._script_data = ""
        self.kinds = []
        self.custom = []

    def _fail(self, detail: str) -> None:
        fail(self.path, "page check (8)", detail)

    def handle_decl(self, decl: str) -> None:
        if decl.lower() != "doctype html":
            self._fail(f"unexpected declaration <!{decl}>")

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "-" in tag:
            self.custom.append((tag, attrs.get("id")))
            return
        if tag in ("html", "head", "body", "meta", "title"):
            if tag == "meta" and attrs.get("name") == "kind":
                self.kinds.append(attrs.get("content"))
            return
        if tag == "link":
            if attrs.get("rel") != "stylesheet":
                self._fail(f"<link> must be rel=stylesheet, got rel={attrs.get('rel')!r}")
            href = attrs.get("href", "")
            if not href.startswith("/static/tokens/"):
                self._fail(f"<link> href {href!r} is not under /static/tokens/")
            return
        if tag == "script":
            self._script_type = attrs.get("type")
            self._script_src = attrs.get("src")
            self._script_data = ""
            if self._script_type == "importmap":
                if self._script_src is not None:
                    self._fail("importmap <script> must not have a src")
            elif self._script_type == "module":
                src = self._script_src or ""
                # A page may load a built component's browser entry, or the composer
                # (3.6), the one shared infrastructure a page composes with (8).
                if not src.startswith("/static/components/") and src != "/static/composer/composer.js":
                    self._fail(f"module <script> src {src!r} is not under /static/components/ or the composer")
            else:
                self._fail(f"<script> type must be importmap or module, got {self._script_type!r}")
            return
        self._fail(f"tag <{tag}> is not allowed on a page")

    def handle_data(self, data: str) -> None:
        if self._script_type is not None:
            self._script_data += data

    def handle_endtag(self, tag):
        if tag != "script":
            return
        if self._script_type == "importmap":
            try:
                parsed = json.loads(self._script_data)
            except json.JSONDecodeError as exc:
                self._fail(f"importmap is not valid JSON: {exc}")
            if parsed != IMPORTMAP:
                self._fail("importmap does not equal vendor.json's importmap")
        elif self._script_type == "module" and self._script_data.strip():
            self._fail("module <script> must not have an inline body")
        self._script_type = self._script_src = None
        self._script_data = ""


def duplicate_id_problems(custom: list) -> list:
    """The distinct-id rule (4.1): a page addresses two instances of one view as
    `<name>#<id>`, so a tag used more than once needs an id on each occurrence,
    all distinct, and no id is reused on the page. `custom` is (tag, id-or-None)
    for every custom element in document order. Returns one detail per problem."""
    problems = []
    seen_tags = [t for t, _ in custom]
    for tag in dict.fromkeys(seen_tags):
        if seen_tags.count(tag) > 1:
            ids = [i for t, i in custom if t == tag]
            if any(i is None for i in ids):
                problems.append(f"<{tag}> appears {len(ids)} times; each needs a distinct id (4.1)")
            elif len(set(ids)) != len(ids):
                problems.append(f"<{tag}> appears {len(ids)} times with a repeated id (4.1)")
    ids_all = [i for _, i in custom if i is not None]
    for dup in dict.fromkeys(i for i in ids_all if ids_all.count(i) > 1):
        problems.append(f'id "{dup}" is used more than once on the page (4.1)')
    return problems


def check_pages() -> None:
    for path in sorted(glob.glob("pages/**/*.html", root_dir=ROOT, recursive=True)):
        checker = PageChecker(path)
        checker.feed((ROOT / path).read_text())
        if len(checker.kinds) != 1 or checker.kinds[0] not in PAGE_KINDS:
            fail(path, "page check (8)",
                 f"a page needs exactly one meta[name=kind] naming one of "
                 f"{PAGE_KINDS}, got {checker.kinds}")
        for detail in duplicate_id_problems(checker.custom):
            fail(path, "page check (8)", detail)


# --- Page composition check (architecture.md 8) ----------------------------------

def check_page_components(manifests: dict) -> None:
    kinds = {Path(p).parent.name: m["meta"].get("kind") for p, m in manifests.items()}
    # A component is built when its directory holds a browser entry (7.3).
    entries = {
        Path(p).parent.name: {
            e for e in ("view.js", "fact.js") if (ROOT / Path(p).parent / e).is_file()
        }
        for p in manifests
    }
    for path in sorted(glob.glob("pages/**/*.html", root_dir=ROOT, recursive=True)):
        html = (ROOT / path).read_text()
        view_scripts = set(re.findall(r'src="/static/components/([\w-]+)/view\.js"', html))
        fact_scripts = set(re.findall(r'src="/static/components/([\w-]+)/fact\.js"', html))
        tags = set(re.findall(r"<([a-z][\w]*-[\w-]*)[\s>]", html))
        for tag in sorted(tags):
            if kinds.get(tag) != "view" or "view.js" not in entries.get(tag, set()):
                fail(path, "page check (8)", f"<{tag}> is not a built view")
            if tag not in view_scripts:
                fail(path, "page check (8)", f"<{tag}> is used but its view.js is not loaded")
        for comp in sorted(view_scripts - tags):
            fail(path, "page check (8)", f"{comp}/view.js is loaded but <{comp}> is not on the page")
        for comp in sorted(fact_scripts):
            if kinds.get(comp) != "fact":
                fail(path, "page check (8)", f"{comp}/fact.js is loaded but {comp} is not a fact component")


# --- Document check (architecture.md 7.5) ----------------------------------------

# A write to the document's root element; a bare read such as
# getComputedStyle(document.documentElement) has no write property after it.
_DOC_ELEMENT_WRITE = re.compile(
    r"document\.documentElement\s*\.\s*(dataset|setAttribute|removeAttribute|classList|style|className)"
)
_DOC_OTHER = re.compile(r"document\.(body|head|title)\b")


def _document_facts() -> dict:
    """The 7.5 table: component name → the attribute suffix it may write."""
    doc = (ROOT / "architecture.md").read_text()
    block = doc[doc.index("### 7.5"):]
    block = block[: block.index("\n---")]
    return {
        m.group(1): m.group(2)
        for m in re.finditer(r"^\|\s*`([\w-]+)`\s*\|\s*`data-([\w-]+)`\s*\|", block, re.M)
    }


def _camel(name: str) -> str:
    return re.sub(r"-(\w)", lambda m: m.group(1).upper(), name)


def check_document_writes() -> None:
    facts = _document_facts()
    for path in sorted(glob.glob("components/*/*.js", root_dir=ROOT)):
        src = _strip_comments((ROOT / path).read_text())
        for m in _DOC_OTHER.finditer(src):
            fail(path, "document check (7.5)",
                 f"writes to document.{m.group(1)}; only a document fact touches the document (7.5)")
        _, name, file = Path(path).parts
        allowed = []
        if file == "fact.js" and name in facts:
            attr = facts[name]
            allowed = [
                re.compile(rf"document\.documentElement\.dataset\.{_camel(attr)}\b"),
                re.compile(rf'document\.documentElement\.setAttribute\(\s*["\']data-{re.escape(attr)}["\']'),
            ]
        for m in _DOC_ELEMENT_WRITE.finditer(src):
            if any(a.match(src, m.start()) for a in allowed):
                continue
            fail(path, "document check (7.5)",
                 f"writes to document.documentElement.{m.group(1)}; "
                 "only a listed document fact writes its own data- attribute (7.5)")


# --- Style check (architecture.md 11.2) ------------------------------------------

_CSS_TEMPLATE = re.compile(r"css`([^`]*)`")
_HTML_TEMPLATE = re.compile(r"html`([^`]*)`", re.DOTALL)
_STYLE_ATTR = re.compile(r'style="([^"]*)"')
_HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")
_VAR = re.compile(r"var\([^)]*\)")
_FONT_PROPS = ("font-size", "font-family", "font-weight", "line-height")
# Percentages, `fr` and unitless calc() factors are relative, so they pass.
_LENGTH_PROPS = (
    "margin", "padding", "gap", "inset", "top", "right", "bottom", "left",
    "width", "height", "min-width", "min-height", "max-width", "max-height",
    "flex-basis", "grid-template-columns", "grid-template-rows", "grid-auto-columns",
    "grid-auto-rows", "border-width", "outline-width", "outline-offset", "translate",
)
_LENGTH = re.compile(r"(-?\d*\.?\d+)(px|r?em|ch|ex|vw|vh|vmin|vmax|pt|pc|cm|mm|in|q)\b", re.I)
_DIGIT = re.compile(r"\d")


def _check_declaration(prop: str, value: str, path: str, where: str) -> None:
    prop = prop.strip().lower()
    value = value.strip()
    lowered = value.lower()
    if _HEX.search(value) or "rgb(" in lowered or "hsl(" in lowered:
        fail(path, "style check (11.2)", f"{where}: literal colour in {prop}: {value!r}")
    residue = _VAR.sub("", value)
    if any(prop == p or prop.startswith(p + "-") for p in _FONT_PROPS):
        if '"' in residue or "'" in residue or (_DIGIT.search(residue) and residue.strip() != "0"):
            fail(path, "style check (11.2)", f"literal value on {prop}: {value!r}")
    if any(prop == p or prop.startswith(p + "-") for p in _LENGTH_PROPS):
        for number, _unit in _LENGTH.findall(residue):
            if float(number) != 0:
                fail(path, "style check (11.2)", f"non-zero literal length on {prop}: {value!r}")


def _scan_css(text: str, path: str, where: str) -> None:
    text = _BLOCK_COMMENT.sub("", text)
    for decl in re.split(r"[;{}]", text):
        if ":" not in decl:
            continue
        prop, _, value = decl.partition(":")
        if not value.strip():
            continue
        _check_declaration(prop, value, path, where)


def check_styles() -> None:
    for path in sorted(glob.glob("components/*/*.js", root_dir=ROOT)):
        src = (ROOT / path).read_text()
        for css in _CSS_TEMPLATE.findall(src):
            _scan_css(css, path, "css template")
        for tpl in _HTML_TEMPLATE.findall(src):
            for style in _STYLE_ATTR.findall(tpl):
                _scan_css(style, path, "inline style")


# --- Icon check (architecture.md 7.6) --------------------------------------------

# A view names an icon as a literal, so the vocabulary is checked without running
# anything: every glyph in tokens/icons.js has a user, every use has a glyph.
_ICON_CALL = re.compile(r'\bicon\("([a-z0-9-]+)"\)')
_ICON_NAME = re.compile(r'^\s*"?([a-z0-9-]+)"?:', re.M)


def check_icons() -> None:
    src = (ROOT / "tokens" / "icons.js").read_text()
    body = src[src.index("const GLYPHS = {"):]
    body = body[: body.index("\n};")]
    known = set(_ICON_NAME.findall(body))
    used = {}
    for path in sorted(glob.glob("components/*/view.js", root_dir=ROOT)):
        for name in _ICON_CALL.findall(_strip_comments((ROOT / path).read_text())):
            used.setdefault(name, path)
    for name, path in sorted(used.items()):
        if name not in known:
            fail(path, "icon check (7.6)", f'icon("{name}") is not in tokens/icons.js; propose it first (7.6)')
    for name in sorted(known - set(used)):
        fail("tokens/icons.js", "icon check (7.6)", f'icon "{name}" is used by no view; remove it (7.6)')


# --- Backup check (architecture.md 11.2) -----------------------------------------

BACKUP_UNIT = "unblent-litestream"
BACKUP_CONFIG = ROOT / "deploy" / "litestream.yml"
# One read of the log covers every judgement below. A database stays judged for this
# long after its last change; a change older than the log read is not judged.
BACKUP_WINDOW_S = 15 * 60
# Litestream retries a failing database with waits that double up to about five
# minutes, so a failure that is still going on has logged an error within this time.
BACKUP_ERROR_S = 10 * 60
# Litestream logs a sync of every database every 10 seconds, changed or not, so this
# window says whether it runs now without depending on the owner's activity.
BACKUP_SYNC_S = 2 * 60
# The sync line is written at the start of a round, before that round uploads, so the
# latest line reads behind whenever something was saved in the last ten seconds. Only a
# change older than this many seconds and still not online is a failure.
BACKUP_GRACE = 30
# deploy/litestream.yml's sync-interval, and how far a file's beat may wander from it.
BACKUP_BEAT = 10
BACKUP_BEAT_SLACK = 0.02
_LOG_TIME = re.compile(r"^time=(\S+) level=(\w+) msg=(?:\"([^\"]*)\"|(\S+))")
_LOG_DB = re.compile(r"\bdb=(\S+)")
_LOG_MAX_TXID = re.compile(r"\bmaxTXID=(\w+)")
_LOG_TXIDS = re.compile(r"\btxid\.replica=(\w+) txid\.db=(\w+)")


def _log_seconds(stamp: str) -> float:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


def _ago(seconds: float) -> str:
    minutes = round(seconds / 60)
    return f"{round(seconds)} seconds" if minutes < 2 else f"{minutes} minutes"


def backup_problems(lines: list, changed: dict, now: float) -> list:
    """What is wrong with the backup, judged from its log lines since now - BACKUP_WINDOW_S
    and from `changed`, each database file's last change on disk (its path under data/ →
    seconds since the epoch); [] when healthy."""
    problems = []
    errors = []
    # The log names a file without its folder, and every account has its own notes.db.
    # Each file keeps its own 10-second beat from when it was opened, so its lines land at
    # the same fraction of the interval: that tells same-named files apart.
    syncs = {}
    uploaded = {}
    for line in lines:
        if not (m := _LOG_TIME.match(line)):
            continue
        when = _log_seconds(m.group(1))
        msg = m.group(3) or m.group(4)
        if m.group(2) == "ERROR":
            if now - when <= BACKUP_ERROR_S:
                errors.append(f"{msg} ({d.group(1)})" if (d := _LOG_DB.search(line)) else msg)
            continue
        if msg == "replica sync" and (t := _LOG_TXIDS.search(line)) and (d := _LOG_DB.search(line)):
            line_round = (when, int(t.group(1), 16), int(t.group(2), 16))
            same = syncs.setdefault(d.group(1), [])
            for rounds in same:
                apart = when - rounds[-1][0]
                if apart > BACKUP_BEAT / 2 \
                        and abs((apart + BACKUP_BEAT / 2) % BACKUP_BEAT - BACKUP_BEAT / 2) <= BACKUP_BEAT_SLACK:
                    rounds.append(line_round)
                    break
            else:
                same.append([line_round])
        elif msg == "ltx file uploaded" and (d := _LOG_DB.search(line)):
            # An upload belongs to the round that started it: the file of that name whose
            # last sync line was behind by this upload, else the one whose came last.
            same = syncs.get(d.group(1), [])
            top = int(x.group(1), 16) if (x := _LOG_MAX_TXID.search(line)) else -1
            key = max(range(len(same)), key=lambda i: (same[i][-1][1] < top <= same[i][-1][2], same[i][-1][0]),
                      default=-1)
            uploaded.setdefault(d.group(1), {})[key] = when
    if errors:
        problems.append(f"{len(errors)} errors in the last {BACKUP_ERROR_S // 60} minutes, the latest: {errors[-1]}")
    recent = [(db, [r for r in rounds if now - r[0] <= BACKUP_SYNC_S]) for db, same in syncs.items() for rounds in same]
    recent = [(db, rounds) for db, rounds in recent if rounds]
    if not recent:
        problems.append(f"no database was synced in the last {BACKUP_SYNC_S // 60} minutes")
    for db, rounds in sorted(recent, key=lambda s: s[0]):
        newest_when, online, _ = rounds[-1]
        settled = [r for r in rounds if newest_when - r[0] >= BACKUP_GRACE]
        # Without a round that old (the service just started) there is nothing to judge yet.
        if settled and online < settled[-1][2]:
            problems.append(f"{db} has a change older than {BACKUP_GRACE} seconds that is not online "
                            f"(online {online:x}, needed {settled[-1][2]:x})")
    # Litestream's own count of what is on disk can freeze while the file keeps changing
    # (11.2): only the file's own change time against the last upload shows that. Files of
    # one name are told apart only by their beats, so the latest change is matched to the
    # latest upload, the next to the next.
    by_name = {}
    for path, when in changed.items():
        if BACKUP_GRACE < now - when <= BACKUP_WINDOW_S:
            by_name.setdefault(Path(path).name, []).append((when, path))
    for name, files in sorted(by_name.items()):
        uploads = sorted(uploaded.get(name, {}).values(), reverse=True)
        for i, (when, path) in enumerate(sorted(files, reverse=True)):
            if i >= len(uploads):
                problems.append(f"{path} changed {_ago(now - when)} ago and has not been copied online since")
            elif uploads[i] < when:
                problems.append(f"{path} changed {_ago(now - when)} ago and has not been copied online since; "
                                f"its last copy is {_ago(now - uploads[i])} old")
    return problems


def backup_files() -> dict:
    """Every database deploy/litestream.yml replicates, its path under its data directory →
    when it last changed. A write lands in the -wal file; the main file also changes when
    Litestream checkpoints, which adds nothing to copy, so the main file counts only
    without a -wal."""
    config = BACKUP_CONFIG.read_text()
    base = Path(re.search(r"^\s*-\s*dir:\s*(\S+)", config, re.M).group(1))
    pattern = re.search(r'^\s*pattern:\s*"?([^"\s]+)', config, re.M).group(1)
    recursive = re.search(r"^\s*recursive:\s*true\b", config, re.M) is not None
    files = {}
    for folder, dirs, names in os.walk(base):
        # Litestream's own folders beside each database hold no database.
        dirs[:] = [d for d in dirs if recursive and not d.startswith(".")]
        for name in fnmatch.filter(names, pattern):
            path = os.path.join(folder, name)
            when = None
            for candidate in (f"{path}-wal", path):
                try:
                    when = os.stat(candidate).st_mtime
                    break
                except FileNotFoundError:
                    continue
            if when is not None:
                files[os.path.relpath(path, base)] = when
    return files


def check_backup() -> None:
    # Only the production host runs the backup; elsewhere there is nothing to check.
    state = subprocess.run(["systemctl", "show", "-p", "LoadState", "-p", "ActiveState", BACKUP_UNIT],
                           capture_output=True, text=True)
    fields = dict(line.partition("=")[::2] for line in state.stdout.splitlines())
    if state.returncode != 0 or fields.get("LoadState") != "loaded":
        return
    where = f"deploy/systemd/{BACKUP_UNIT}.service"
    if fields.get("ActiveState") != "active":
        fail(where, "backup check (11.2)", f"the backup is {fields.get('ActiveState')}: sudo systemctl start {BACKUP_UNIT}")
    since = f"-{BACKUP_WINDOW_S // 60}min"
    # The journal is read while the files are listed.
    log = subprocess.Popen(["journalctl", "-u", BACKUP_UNIT, "--since", since, "--no-pager", "-o", "cat"],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    files = backup_files()
    out, err = log.communicate()
    if log.returncode != 0:
        fail(where, "backup check (11.2)", f"cannot read the backup's log: {err.strip()}")
    problems = backup_problems(out.splitlines(), files, time.time())
    if problems:
        fail(where, "backup check (11.2)",
             "the backup is failing: " + "; ".join(problems) + f". Read: journalctl -u {BACKUP_UNIT} --since {since}")


# --- Unused tokens (architecture.md 7.4) -----------------------------------------

def report_unused_tokens() -> None:
    css = (ROOT / "tokens" / "tokens.css").read_text()
    root_block = css[css.index(":root {"):]
    root_block = root_block[: root_block.index("}")]
    names = re.findall(r"^\s*(--[\w-]+)\s*:", root_block, re.M)
    sources = "".join((ROOT / p).read_text() for p in glob.glob("components/*/*.js", root_dir=ROOT))
    sources += (ROOT / "tokens" / "base.css").read_text()
    unused = [n for n in names if n not in sources]
    if unused:
        print(f"note: {len(unused)} of {len(names)} tokens are referenced by no component: {' '.join(unused)}")


# --- Browser tests (architecture.md 10) ------------------------------------------

def _free_port() -> int:
    # Several tabs may run the full check at once; a port chosen by the kernel
    # cannot collide with theirs.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait_for_server(port: int, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
            conn.request("GET", "/")
            if conn.getresponse().status < 500:
                return True
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass
        time.sleep(0.3)
    return False


@contextlib.contextmanager
def _throwaway_server(port: int):
    """The server the tests run against, and the one `--server` keeps up for an
    experiment by hand: yields (port, data_dir), and stops the server and deletes the
    directory on the way out."""
    uvicorn = ROOT / ".venv" / "bin" / "uvicorn"
    if not uvicorn.exists():
        fail("checks/check.py", "tests",
             f"{uvicorn} is missing; create the venv with "
             "`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`")
    # Section 5, 3.4: the session router needs RP_ID, MAX_USERS and a data directory;
    # a throwaway one per run keeps the suite off the real data/ and its passkeys and
    # per-user files disposable. RP_ID=localhost lets WebAuthn accept any port.
    data_dir = tempfile.mkdtemp(prefix="unblent-test-data-")
    # No starter keys (architecture.md 12): a forged test account would otherwise
    # judge on the owner's real Jev key and spend it.
    server_env = {
        **_dotenv(), **os.environ,
        "RP_ID": "localhost", "MAX_USERS": "1", "UNBLENT_DATA": data_dir,
        "SEED_API_KEYS": "",
    }
    server = subprocess.Popen(
        # Warnings only: the access log would drown the per-file progress; an error still prints.
        [str(uvicorn), "server.main:app", "--host", "127.0.0.1", "--port", str(port),
         "--log-level", "warning"],
        cwd=ROOT, env=server_env,
    )
    try:
        if not _wait_for_server(port):
            fail("checks/check.py", "tests",
                 f"server did not answer on port {port}")
        yield port, data_dir
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
        shutil.rmtree(data_dir, ignore_errors=True)


def serve(port: int) -> None:
    """`--server`: the throwaway server for a forged-cookie experiment (10, Tests row),
    so nothing a person or an agent tries by hand lands in the real data/."""
    with _throwaway_server(port) as (port, data_dir):
        print(f"throwaway server is up; Ctrl-C stops it and deletes its data\n"
              f"  export UNBLENT_URL=http://127.0.0.1:{port}\n"
              f"  export UNBLENT_DATA={data_dir}", flush=True)
        # Both Ctrl-C and a `kill` must unwind through this `with`, or the server and its
        # directory would be left behind. SIGINT is handled explicitly rather than left to
        # KeyboardInterrupt, because a shell that starts this in the background inherits
        # SIGINT ignored, and then Ctrl-C alone would not stop it.
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
        signal.pause()


# --- Change-scoped selection (architecture.md 11) --------------------------------
# The full run is the definition of done, but while iterating the edit loop and the
# Stop hook may narrow it to the tests reachable from what changed: the changed
# components' own tests, those of their one-hop bus partners, and every test that
# opens a changed page or a page holding a changed component. Any infrastructure
# change still runs everything. `affected` is None for the full run, or the set of
# test files to run.

_INFRA_DIRS = {"bus", "store", "checks", "vendor", "tokens", "server"}
_INFRA_FILES = {".env", "requirements.txt"}
_TAG = re.compile(r"<([a-z][\w]*-[\w-]*)[\s>]")
_ENTRY = re.compile(r"/static/components/([\w-]+)/(?:view|fact)\.js")
# Section 11: a test opens the product by naming `/` right after its base URL.
_OPENS_PRODUCT = re.compile(r"\}/[`'\"]")


def _page_address(path: str) -> str:
    """The URL a page is served at (11.1): pages/index.html is `/`, the rest drop
    `pages` and `.html`."""
    rel = Path(path).relative_to("pages").with_suffix("")
    return "/" if str(rel) == "index" else f"/{rel.as_posix()}"


def _page_holdings() -> dict:
    """Section 8: each page's address and the components it holds, by tag or by the
    browser entry it loads (a fact has no tag)."""
    pages = {}
    for path in sorted(glob.glob("pages/**/*.html", root_dir=ROOT, recursive=True)):
        text = (ROOT / path).read_text()
        pages[_page_address(path)] = set(_TAG.findall(text)) | set(_ENTRY.findall(text))
    return pages


def _opens(src: str, address: str) -> bool:
    if address == "/":
        return bool(_OPENS_PRODUCT.search(src))
    return re.search(re.escape(address) + r"(?![\w-])", src) is not None


def _interaction_graph(manifests: dict) -> dict:
    """Section 7.3: who each component interacts with, from manifests alone. The
    same rule as catalog/server/router.py `_link`, reimplemented because the check
    cannot import a component. Undirected: a contract-preserving edit can only break
    a component's own tests and those of its direct bus partners."""
    recs = {Path(p).parent.name: m for p, m in manifests.items()}
    tools = _tool_queries(manifests)
    adj = {name: set() for name in recs}
    for name, m in recs.items():
        emits = set(m["meta"].get("emits", []))
        consumes = set(m["consumes"])
        for other, om in recs.items():
            if other == name:
                continue
            if emits & set(om["consumes"]) or consumes & set(om["meta"].get("emits", [])):
                adj[name].add(other)
                adj[other].add(name)
        for ask in m["meta"].get("asks", []):
            # The wildcard reaches every component owning a tool-marked query (7.7).
            targets = {owner for owner, _q in tools} if ask == "*: tool" else {ask.split(":", 1)[0].strip()}
            for target in targets:
                if target in recs and target != name:
                    adj[name].add(target)
                    adj[target].add(name)
    return adj


SMOKE_TEST = "components/pages/tests/smoke.test.mjs"
_CONTRACT_DIRS = {"events", "queries", "commands"}


def classify_changes(changed_paths: list, manifests: dict):
    """The changed components and the edited page addresses, or None when everything
    must run: an infrastructure, structural, or unclassifiable change (7.3, 11)."""
    known = {Path(p).parent.name for p in manifests}
    seeds = set()
    pages = set()
    for cp in changed_paths:
        cp = cp.replace("\\", "/").strip()
        if not cp:
            continue
        parts = Path(cp).parts
        top = parts[0]
        if top in _INFRA_DIRS or cp in _INFRA_FILES:
            return None
        if top == "components":
            # A fully deleted component leaves the manifests, so its name is
            # unknown here: the graph it was part of changed, run everything.
            if len(parts) < 2 or parts[1] not in known:
                return None
            seeds.add(parts[1])
        elif top == "pages" and cp.endswith(".html"):
            pages.add(_page_address(cp))
        else:
            return None
    if not seeds and not pages:
        return None
    return seeds, pages


def contract_files_changed(changed_paths: list) -> set:
    """The components whose events/, queries/ or commands/ gained, lost or changed a
    file: a contract change whatever the manifest says (11). The git listing holds
    untracked files too, so an added schema counts."""
    found = set()
    for cp in changed_paths:
        parts = Path(cp.replace("\\", "/").strip()).parts
        if len(parts) >= 4 and parts[0] == "components" and parts[2] in _CONTRACT_DIRS:
            found.add(parts[1])
    return found


def contract_of(manifest: dict) -> tuple:
    """What a component says on the bus (7.3): the part of its manifest a partner can
    depend on. Consumes counts, unlike in check_roles, because a partner's emit that
    the component stops handling is what breaks the partner's test."""
    meta = manifest.get("meta") or {}
    return (tuple(sorted(set(meta.get("emits") or []))),
            tuple(sorted(set(meta.get("asks") or []))),
            tuple(sorted(set(manifest.get("consumes") or []))),
            tuple(sorted(set(manifest.get("accepts") or []))),
            tuple(sorted(set(manifest.get("answers") or []))))


def contracts_changed(seeds: set, manifests: dict, head_manifests: dict) -> set:
    """The seeds whose contract differs from HEAD's. A seed HEAD has no manifest for is
    new, or unreadable there: its partners have never run against it, so it counts."""
    by_name = {Path(p).parent.name: m for p, m in manifests.items()}
    return {s for s in seeds
            if s not in head_manifests or contract_of(by_name.get(s) or {}) != contract_of(head_manifests[s])}


def _head_manifests(seeds: set) -> dict:
    """HEAD's manifest of each seed HEAD has, by component name. The seeds' directories
    are extracted whole from HEAD so a machine's relative imports resolve, and read by
    the same reader as the working tree's; the loader resolves bare names against
    ROOT. Paid in the test phase, once. Anything unreadable is left out, which counts
    as a contract change: the safe direction."""
    present = [s for s in sorted(seeds)
               if subprocess.run(["git", "cat-file", "-e", f"HEAD:components/{s}/machine.js"],
                                 cwd=ROOT, capture_output=True).returncode == 0]
    if not present:
        return {}
    with tempfile.TemporaryDirectory(prefix="unblent-head-") as tmp:
        archive = subprocess.run(["git", "archive", "HEAD", *(f"components/{s}" for s in present)],
                                 cwd=ROOT, capture_output=True)
        if archive.returncode != 0:
            return {}
        subprocess.run(["tar", "-x", "-C", tmp], input=archive.stdout, capture_output=True)
        machines = [f"{tmp}/components/{s}/machine.js" for s in present]
        result = subprocess.run(["node", "--import", "./checks/register.mjs", "checks/manifests.mjs", *machines],
                                cwd=ROOT, capture_output=True, text=True)
        if result.returncode != 0:
            return {}
        return {Path(p).parent.name: m for p, m in json.loads(result.stdout).items() if "error" not in m}


def affected_tests(changed_paths: list, manifests: dict, tests: list, contract_changed=frozenset()):
    """The test files, out of `tests`, that a change can break, with the addresses of
    the pages whose smoke test covers the change's place on them; or None to run
    everything (11). A changed component reaches its own tests and the smoke test of
    every page holding it; its one-hop partners' tests only when it is in
    `contract_changed`. An edited page reaches its smoke test and every test that
    names its address."""
    classified = classify_changes(changed_paths, manifests)
    if classified is None:
        return None
    seeds, edited_pages = classified
    graph = _interaction_graph(manifests)
    owners = set(seeds)
    for s in seeds & set(contract_changed):
        owners |= graph.get(s, set())
    addresses = set(edited_pages)
    for address, held in _page_holdings().items():
        if held & seeds:
            addresses.add(address)
    result = set()
    for f in tests:
        if Path(f).parts[1] in owners or (f == SMOKE_TEST and addresses):
            result.add(f)
        elif edited_pages:
            src = (ROOT / f).read_text()
            if any(_opens(src, a) for a in edited_pages):
                result.add(f)
    return result, addresses


def _changed_paths_from_git() -> list:
    """Repo-root-relative paths git sees changed against HEAD: staged, unstaged and
    untracked. A rename's new name is what changed; its old name reads as a deletion,
    which affected_tests turns into a full run."""
    paths = set()
    status = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT,
                            capture_output=True, text=True).stdout
    for line in status.splitlines():
        entry = line[3:] if len(line) > 3 else ""
        if " -> " in entry:  # rename: keep the new name
            entry = entry.split(" -> ", 1)[1]
        if entry:
            paths.add(entry.strip().strip('"'))
    diff = subprocess.run(["git", "diff", "--name-only", "HEAD"], cwd=ROOT,
                          capture_output=True, text=True).stdout
    paths.update(p for p in diff.splitlines() if p.strip())
    return sorted(paths)


def _resolve_only(value: str, manifests: dict) -> list:
    """--only takes component names or paths, comma-separated. A bare component name
    becomes its component directory; a path (with a slash, or a root file such as
    architecture.md that the Stop hook records) passes through to be classified; a
    token that is neither fails rather than silently narrowing."""
    known = {Path(p).parent.name for p in manifests}
    out = []
    for token in value.split(","):
        token = token.strip()
        if not token:
            continue
        if "/" not in token and token in known:
            out.append(f"components/{token}/machine.js")
        elif "/" in token or (ROOT / token).exists():
            out.append(token)
        else:
            fail("checks/check.py", "--only", f"unknown component or path {token!r}; not one of {sorted(known)}")
    return out


@contextlib.contextmanager
def _test_lock():
    # Section 11: one test phase at a time on a host. The lock lives in the temp
    # directory, not the tree, so every worktree of every session contends for the same one.
    with open(Path(tempfile.gettempdir()) / "unblent-check.lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("waiting: another check is running its tests on this host (11)", flush=True)
            fcntl.flock(lock, fcntl.LOCK_EX)
        yield


VERBOSE = False


def _node_test(files: list, env=None, extra=()) -> subprocess.Popen:
    """One `node --test` process over files, its per-test durations written beside it.
    It prints one line per file (checks/progress.mjs), or every test with `--verbose`."""
    fd, durations = tempfile.mkstemp(prefix="unblent-durations-", suffix=".jsonl")
    os.close(fd)
    reporters = (["--test-reporter=spec", "--test-reporter-destination=stdout"] if VERBOSE else
                 ["--test-reporter=./checks/progress.mjs", "--test-reporter-destination=stderr"])
    proc = subprocess.Popen(
        ["node", "--import", "./checks/register.mjs", *extra,
         "--test", "--experimental-test-isolation=none", f"--test-timeout={TEST_TIMEOUT_MS}",
         *reporters,
         "--test-reporter=./checks/durations.mjs", f"--test-reporter-destination={durations}",
         *files], cwd=ROOT, env=env,
    )
    proc.durations = durations
    return proc


def _where(row: dict) -> str:
    try:
        return str(Path(row["file"]).relative_to(ROOT))
    except (KeyError, ValueError):
        return row.get("file") or "?"


def headroom_warnings(rows: list) -> list:
    """The warning line for every test past half its budget (11), worst first. Pure over
    the duration rows so checks/tests can exercise it without a node run."""
    lines = []
    for row in sorted(rows, key=lambda r: -(r.get("ms") or 0)):
        if (row.get("ms") or 0) > HEADROOM_MS:
            lines.append(f"warning: {_where(row)}: \"{row['name']}\" took {row['ms'] / 1000:.1f}s, over half "
                         f"its {TEST_TIMEOUT_MS / 1000:.0f}s budget (11): no headroom on a loaded host")
    return lines


def failed_tests(rows: list) -> list:
    """One line per failed test, so a red run ends by naming what broke instead of
    leaving it somewhere in the log. Pure over the rows, like headroom_warnings."""
    lines = []
    for row in rows:
        if row.get("failed"):
            lines.append(f"{_where(row)}: \"{row.get('name', '?')}\"")
    return lines


def browser_summary(rows: list, wall_s: float) -> list:
    """Where the browser phase's time went (11): one line splitting launches, page loads
    and the rest, then the slowest loads by name. The rows are a run's duration rows,
    each test's `loads` tallied by checks/browsers.mjs and the launches in the one
    `summary` row per node process. Pure, like headroom_warnings."""
    tests = [row for row in rows if "summary" not in row]
    summaries = [row["summary"] for row in rows if "summary" in row]
    launches = sum(s.get("launches") or 0 for s in summaries)
    launch_s = sum(s.get("launch_ms") or 0 for s in summaries) / 1000
    loads = [(load.get("ms") or 0, load.get("url") or "?", row)
             for row in tests for load in (row.get("loads") or [])]
    load_s = sum(ms for ms, _, _ in loads) / 1000
    rest_s = max(wall_s - launch_s - load_s, 0)
    lines = [f"browser: {len(tests)} tests {wall_s:.1f}s — launches {launches} ({launch_s:.1f}s), "
             f"page loads {len(loads)} ({load_s:.1f}s), the rest {rest_s:.1f}s"]
    for ms, url, row in sorted(loads, key=lambda load: -load[0])[:5]:
        address = urllib.parse.urlsplit(url).path or url
        lines.append(f"  slowest load {ms / 1000:.1f}s {address}  {_where(row)} \"{row.get('name', '?')}\"")
    return lines


def _read_durations(proc: subprocess.Popen) -> list:
    path = Path(proc.durations)
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    path.unlink(missing_ok=True)
    for line in headroom_warnings(rows):
        print(line, file=sys.stderr)
    return rows


def _failure_detail(rows: list) -> str:
    names = failed_tests(rows)
    if not names:
        return "node --test reported failures"
    return f"{len(names)} failed:\n    " + "\n    ".join(names)


def _run_node(files: list, env=None) -> list | None:
    """None when every test passed, else the duration rows naming what failed."""
    proc = _node_test(files, env)
    proc.wait()
    rows = _read_durations(proc)
    return None if proc.returncode == 0 else rows


def run_tests(affected=None, webkit_only=False, pages=()) -> None:
    # affected is None for the full run (the definition of done); a set of test
    # files narrows to the tests reachable from a change (11). A narrowed run never
    # touches infrastructure tests, since any infra change runs everything. `pages`
    # names the addresses the page smoke test loads; empty, it loads every page.
    scoped = affected is not None
    # Every test process, pure or browser, reaches the kit the way it reaches Playwright:
    # through a path in the environment, never an import across components (10).
    os.environ["UNBLENT_KIT"] = str(ROOT / "checks" / "kit.mjs")

    # Component tests split three ways, read once each so a rename cannot mis-sort:
    # a browser test drives Playwright (`.launch(`), an api test hits the live server
    # (UNBLENT_URL) without a browser, the rest are pure-Node actor tests. A scoped
    # run keeps only the affected test files (11).
    comp_tests = sorted(glob.glob("components/*/tests/*.test.mjs", root_dir=ROOT))
    if scoped:
        comp_tests = [f for f in comp_tests if f in affected]
    browser, api, pure = [], [], []
    for f in comp_tests:
        src = (ROOT / f).read_text()
        # A kit user keeps a literal `engine.launch()` in its source for this sort.
        if ".launch(" in src:
            browser.append(f)
        elif "UNBLENT_URL" in src:
            api.append(f)
        else:
            pure.append(f)

    # The bus and the store are infrastructure, pure Node: their tests need neither
    # the venv nor the server, and only an infra change (a full run) reaches them.
    # The budget is per test (11), so a file must not count as one: without isolation,
    # node times each test alone rather than the file, whose lifetime includes the
    # bus's own timers.
    node_tests = ([] if scoped else
                  sorted(glob.glob("bus/tests/*.test.mjs", root_dir=ROOT)) +
                  sorted(glob.glob("store/tests/*.test.mjs", root_dir=ROOT)) +
                  sorted(glob.glob("checks/tests/*.test.mjs", root_dir=ROOT))) + pure
    if node_tests:
        failed = _run_node(node_tests)
        if failed is not None:
            fail("pure-node tests", "node tests", _failure_detail(failed))

    # checks/tests is the check's own unit tests (11.1): pure stdlib, no server and no
    # browser, so a checks-only change stays cheap. Only an infra change reaches them.
    checks_tests = [] if scoped else sorted(glob.glob("checks/tests/*.test.py", root_dir=ROOT))
    for test in checks_tests:
        _run_python_test(test, "checks tests", "check unit test reported failures")

    # server/tests is the entry's own; only an infra change (a full run) reaches it.
    server_tests = [] if scoped else sorted(glob.glob("server/tests/*.test.py", root_dir=ROOT))

    # The whole point of scoping: a change that touches no browser or api test never
    # boots the server or Playwright, so a single-component actor edit is instant.
    if not browser and not api and not server_tests:
        return

    with _throwaway_server(_free_port()) as (port, data_dir):
        # UNBLENT_DATA travels to the tests too: their cookie-forging helpers refuse
        # to run without it, so a suite pointed by hand at the dev server never writes
        # into the real data/ (architecture.md section 10, Tests row).
        env = {**_dotenv(), **os.environ, "UNBLENT_URL": f"http://127.0.0.1:{port}", "UNBLENT_DATA": data_dir}
        if pages:
            env["UNBLENT_PAGES"] = ",".join(sorted(pages))

        for test in server_tests:
            _run_python_test(test, "server tests", "server-entry HTTP test reported failures", env)

        # The loader lets a machine test import its actor (bare `xstate`); it is inert
        # for the browser tests, whose only bare import is Playwright by path.
        if api:
            failed = _run_node(api, env)
            if failed is not None:
                fail("components/*/tests api", "api tests", _failure_detail(failed))

        if browser:
            if "PLAYWRIGHT_MODULE" not in env:
                fail(".env", "browser tests",
                     "PLAYWRIGHT_MODULE is not set; add PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs to .env")
            _run_browser(browser, env, webkit_only)


def _run_python_test(test: str, rule: str, detail: str, env=None) -> None:
    """One unittest file, quiet like the node tests: one line when it passes, its whole
    output when it fails."""
    started = time.perf_counter()
    result = subprocess.run([sys.executable, test] + (["-v"] if VERBOSE else []),
                            cwd=ROOT, env=env, capture_output=not VERBOSE, text=True)
    if result.returncode != 0:
        if not VERBOSE:
            sys.stderr.write(result.stdout + result.stderr)
        fail(test, rule, detail)
    if not VERBOSE:
        print(f"ok   {test:<52} {time.perf_counter() - started:5.1f}s", file=sys.stderr, flush=True)


def _run_browser(files: list, env: dict, webkit_only: bool) -> None:
    # CHECK_BROWSER_WORKERS parallel node processes over the one server (10, 11).
    # Default 1 (serial): on this two-core host a second concurrent browser starves
    # the first of CPU and pushes the heaviest tests (dock, notes save, layout
    # switch) past the per-test five-second budget (11), so parallelism trades a
    # ~1.4x speed-up for flakes and is opt-in. Raise it where cores are plentiful.
    # With more than one worker the per-file lines of the workers interleave, but each
    # line names its file, so attribution survives. `--test-isolation=none`
    # runs a worker's files in one process; a process per file would cost ten
    # seconds of start-ups alone.
    workers = min(int(os.environ.get("CHECK_BROWSER_WORKERS", "1")), len(files)) or 1
    chunks = [files[i::workers] for i in range(workers)]
    procs = []
    started = time.perf_counter()
    for chunk in chunks:
        if not chunk:
            continue
        # checks/browsers.mjs is the browser rule (11.2): one browser per engine for the
        # worker, and any test that leaves a context open fails and has it closed at once,
        # so a timed-out test cannot leak pages into the next and exhaust the host.
        extra = ["--import", "./checks/browsers.mjs"] + ([SKIP_CHROMIUM] if webkit_only else [])
        procs.append(_node_test(chunk, env, extra))
    failed = None
    seen = []
    for proc in procs:
        proc.wait()
        rows = _read_durations(proc)
        seen += rows
        if proc.returncode != 0:
            failed = (failed or []) + rows
    # Pass or fail, so a red run's time is understood too (11).
    for line in browser_summary(seen, time.perf_counter() - started):
        print(line, file=sys.stderr)
    if failed is not None:
        fail("components/*/tests", "browser tests", _failure_detail(failed))




def _timed(timings: list, name: str, func, *args):
    started = time.perf_counter()
    result = func(*args)
    timings.append((time.perf_counter() - started, name))
    return result


def _enforce_budget(timings: list, budget: float, phase: str) -> None:
    total = sum(t for t, _ in timings)
    if total > budget:
        slowest = ", ".join(f"{name} {t:.2f}s" for t, name in sorted(timings, reverse=True)[:3])
        fail("checks/check.py", "time budget (11)",
             f"{phase} took {total:.2f}s, budget {budget:.0f}s; slowest: {slowest}. "
             "Optimise it, or move the slow part out of the fast phase so the after-edit run stays instant.")


def _server_port(argv: list) -> int:
    value = argv[argv.index("--server") + 1: argv.index("--server") + 2]
    if value and not value[0].isdigit():
        fail("checks/check.py", "--server", "expects a port number or nothing: --server [port]")
    return int(value[0]) if value else 8090


def _only_value(argv: list) -> str:
    if "--only" in argv:
        i = argv.index("--only")
        if i + 1 < len(argv):
            return argv[i + 1]
        fail("checks/check.py", "--only", "expects a value: --only <comma-separated components or paths>")
    return ""


USAGE = """The one check command (architecture.md 11).

  after every edit      python3 checks/check.py --static
                        every static rule, <1s
  before done           python3 checks/check.py --changed
                        static + tests reachable from your changes, browser
                        tests in WebKit (or --only <components>)
  before push           python3 checks/check.py
                        every static rule + ALL tests, WebKit then Chromium;
                        the pre-push hook in .githooks/ runs it
  by hand               python3 checks/check.py --server [port]
                        the throwaway server the tests use (temporary data
                        directory, port 8090 unless given), until Ctrl-C; for
                        an experiment with a forged session cookie

  Tests print one line per file, and a failure's reason under its name.
  --verbose prints every test instead; use it with --only <component>.
"""


def main() -> None:
    argv = sys.argv[1:]
    if "--help" in argv or "-h" in argv:
        print(USAGE)
        return
    if "--server" in argv:
        serve(_server_port(argv))
        return
    global VERBOSE
    VERBOSE = "--verbose" in argv
    static_only = "--static" in argv
    changed = "--changed" in argv
    only = _only_value(argv)
    timings = []
    _timed(timings, "vendor", check_vendor)
    _timed(timings, "layout", check_layout)
    manifests = _timed(timings, "manifests", read_manifests)
    _timed(timings, "manifest check", check_manifests, manifests)
    _timed(timings, "role check", check_roles, manifests)
    _timed(timings, "component dirs", check_component_dirs, manifests)
    _timed(timings, "contract check", check_contracts, manifests)
    _timed(timings, "supersession check", check_supersession, manifests)
    _timed(timings, "schema compatibility", check_schema_compat, manifests)
    _timed(timings, "imports", check_imports)
    _timed(timings, "kit", check_kit, manifests)
    _timed(timings, "composer imports", check_composer_imports)
    _timed(timings, "composer", check_composer)
    _timed(timings, "python imports", check_python_imports)
    _timed(timings, "store check", check_store, manifests)
    _timed(timings, "pages", check_pages)
    _timed(timings, "page components", check_page_components, manifests)
    _timed(timings, "document", check_document_writes)
    _timed(timings, "styles", check_styles)
    _timed(timings, "icons", check_icons)
    _timed(timings, "backup", check_backup)
    _enforce_budget(timings, STATIC_BUDGET_S, "the fast phase")
    if static_only:
        return
    report_unused_tokens()
    # Bare check.py is the push gate: affected stays None, everything runs in both engines.
    # --changed / --only are the task-end gate: the tests reachable from what changed, in
    # WebKit (11).
    affected = None
    pages = set()
    if changed or only:
        paths = []
        if changed:
            paths += _changed_paths_from_git()
        if only:
            paths += _resolve_only(only, manifests)
        # Partners join only for a component whose contract changed (11): a schema file
        # added, changed or removed, or a manifest that differs from HEAD's.
        contract = set()
        classified = classify_changes(paths, manifests)
        if classified is not None:
            seeds, _ = classified
            contract = contract_files_changed(paths) | contracts_changed(seeds, manifests, _head_manifests(seeds))
        picked = affected_tests(paths, manifests,
                                sorted(glob.glob("components/*/tests/*.test.mjs", root_dir=ROOT)), contract)
        if picked is not None:
            affected, pages = picked
    with _test_lock():
        _timed(timings, "tests", run_tests, affected, bool(changed or only), pages)
    scope = "all" if affected is None else (
        ", ".join(sorted(f"{Path(f).parts[1]}/{Path(f).name.removesuffix('.test.mjs')}" for f in affected)) or "none")
    if pages:
        scope += "; pages: " + ", ".join(sorted(pages))
    scope += "; webkit" if changed or only else "; webkit, chromium"
    print(f"OK: {', '.join(name for _, name in timings)} in {sum(t for t, _ in timings):.1f}s [tests: {scope}]")


if __name__ == "__main__":
    main()

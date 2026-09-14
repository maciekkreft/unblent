#!/usr/bin/env python3
"""The one check command (architecture.md 11), stdlib only. `--static` is the fast phase."""

import ast
import glob
import hashlib
import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
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
        if not isinstance(meta.get("emits"), list):
            fail(path, "manifest check (7.3)", "meta.emits must be a list, empty if it emits nothing")
        asks = meta.get("asks", [])
        if not (isinstance(asks, list) and all(isinstance(a, str) and _ASK.match(a) for a in asks)):
            fail(path, "manifest check (7.3)", 'meta.asks must be a list of "target: query" strings')
        if meta["kind"] == "fact":
            if meta.get("shape") not in _SHAPES:
                fail(path, "manifest check (7.3)", f"a fact component's meta.shape must be one of {sorted(_SHAPES)}")
            if not (isinstance(meta.get("owns"), str) and meta["owns"].strip()):
                fail(path, "manifest check (7.3)", "a fact component's meta.owns must be a non-empty string naming the fact")
            if "attributes" in meta:
                fail(path, "manifest check (7.3)", "a fact component has no attributes")
        else:
            if "shape" in meta:
                fail(path, "manifest check (7.3)", "a view component has no shape")
            if "owns" in meta:
                fail(path, "manifest check (7.3)", "a view component owns no fact")
            if not isinstance(meta.get("attributes"), list):
                fail(path, "manifest check (7.3)", "a view component's meta.attributes must be a list, empty if none")


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
    query queries/<name>.json ({ payload, reply }), every accepted command
    commands/<name>.json; each schema states the draft, and a schema file with no
    matching declaration or handler fails, so the contracts cannot drift."""
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
                else:
                    _check_draft(schema_path, schema, "the schema")


# --- Import check (architecture.md 11.2) -----------------------------------------

_STATIC_IMPORT = re.compile(
    r"""(?:\bimport\b|\bexport\b)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]"""
)
_DYNAMIC_IMPORT = re.compile(r"""\bimport\s*\(\s*['"]([^'"]+)['"]""")
_LINE_COMMENT = re.compile(r"//[^\n]*")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)


def _strip_comments(src: str) -> str:
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", src))


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

    def _fail(self, detail: str) -> None:
        fail(self.path, "page check (8)", detail)

    def handle_decl(self, decl: str) -> None:
        if decl.lower() != "doctype html":
            self._fail(f"unexpected declaration <!{decl}>")

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "-" in tag:
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
                if not src.startswith("/static/components/"):
                    self._fail(f"module <script> src {src!r} is not under /static/components/")
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


def check_pages() -> None:
    for path in sorted(glob.glob("pages/**/*.html", root_dir=ROOT, recursive=True)):
        checker = PageChecker(path)
        checker.feed((ROOT / path).read_text())
        if len(checker.kinds) != 1 or checker.kinds[0] not in PAGE_KINDS:
            fail(path, "page check (8)",
                 f"a page needs exactly one meta[name=kind] naming one of "
                 f"{PAGE_KINDS}, got {checker.kinds}")


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


def run_tests() -> None:
    # The bus and the store are infrastructure, pure Node: their tests need neither
    # the venv nor the server, so they run first and on their own. The budget is per
    # test (11), so a file must not count as one: without isolation, node times each
    # test alone rather than the file, whose lifetime includes the bus's own timers.
    node_tests = sorted(glob.glob("bus/tests/*.test.mjs", root_dir=ROOT)) + \
        sorted(glob.glob("store/tests/*.test.mjs", root_dir=ROOT))
    if node_tests:
        result = subprocess.run(
            ["node", "--import", "./checks/register.mjs", "--test",
             "--experimental-test-isolation=none", f"--test-timeout={TEST_TIMEOUT_MS}",
             *node_tests], cwd=ROOT,
        )
        if result.returncode != 0:
            fail("bus/tests, store/tests", "node tests", "node --test reported failures")

    uvicorn = ROOT / ".venv" / "bin" / "uvicorn"
    if not uvicorn.exists():
        fail("checks/check.py", "tests",
             f"{uvicorn} is missing; create the venv with "
             "`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`")

    # Browser tests drive Playwright; server tests are stdlib HTTP against the entry.
    browser_tests = sorted(glob.glob("components/*/tests/*.test.mjs", root_dir=ROOT))
    server_tests = sorted(glob.glob("server/tests/*.test.py", root_dir=ROOT))
    if not browser_tests and not server_tests:
        return
    port = _free_port()
    # Section 5, 3.4: the session router needs RP_ID, MAX_USERS and a data directory;
    # a throwaway one per run keeps the suite off the real data/ and its passkeys and
    # per-user files disposable. RP_ID=localhost lets WebAuthn accept any port.
    data_dir = tempfile.mkdtemp(prefix="unblent-test-data-")
    server_env = {
        **_dotenv(), **os.environ,
        "RP_ID": "localhost", "MAX_USERS": "1", "UNBLENT_DATA": data_dir,
    }
    server = subprocess.Popen(
        [str(uvicorn), "server.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=ROOT, env=server_env,
    )
    try:
        if not _wait_for_server(port):
            fail("checks/check.py", "tests",
                 f"server did not answer on port {port}")
        env = {**_dotenv(), **os.environ, "UNBLENT_URL": f"http://127.0.0.1:{port}"}

        for test in server_tests:
            result = subprocess.run([sys.executable, test], cwd=ROOT, env=env)
            if result.returncode != 0:
                fail(test, "server tests", "server-entry HTTP test reported failures")

        if browser_tests:
            if "PLAYWRIGHT_MODULE" not in env:
                fail(".env", "browser tests",
                     "PLAYWRIGHT_MODULE is not set; add PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs to .env")
            # The loader lets a machine test import its actor (bare `xstate`); it is
            # inert for the browser tests, whose only bare import is Playwright by path.
            # One process for every file: node's default is a process per file,
            # and sixteen start-ups alone cost ten seconds of wall clock. The flag
            # is `--test-isolation=none` from Node 23.
            result = subprocess.run(
                ["node", "--import", "./checks/register.mjs", "--test",
                 "--experimental-test-isolation=none", f"--test-timeout={TEST_TIMEOUT_MS}",
                 *browser_tests],
                cwd=ROOT, env=env,
            )
            if result.returncode != 0:
                fail("components/*/tests", "browser tests", "node --test reported failures")
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
        shutil.rmtree(data_dir, ignore_errors=True)




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
             "Optimise it, or move the slow part out of the fast phase so the after-edit hook stays instant.")


def main() -> None:
    static_only = "--static" in sys.argv[1:]
    timings = []
    _timed(timings, "vendor", check_vendor)
    _timed(timings, "layout", check_layout)
    manifests = _timed(timings, "manifests", read_manifests)
    _timed(timings, "manifest check", check_manifests, manifests)
    _timed(timings, "component dirs", check_component_dirs, manifests)
    _timed(timings, "contract check", check_contracts, manifests)
    _timed(timings, "imports", check_imports)
    _timed(timings, "python imports", check_python_imports)
    _timed(timings, "store check", check_store, manifests)
    _timed(timings, "pages", check_pages)
    _timed(timings, "page components", check_page_components, manifests)
    _timed(timings, "document", check_document_writes)
    _timed(timings, "styles", check_styles)
    _timed(timings, "icons", check_icons)
    _enforce_budget(timings, STATIC_BUDGET_S, "the fast phase")
    if static_only:
        return
    report_unused_tokens()
    _timed(timings, "tests", run_tests)
    print(f"OK: {', '.join(name for _, name in timings)} in {sum(t for t, _ in timings):.1f}s")


if __name__ == "__main__":
    main()

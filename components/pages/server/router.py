"""The server side of ``pages`` (architecture.md 3.4): walks ``pages/`` and
returns one record per page. It cannot import the entry (``server/main.py``), so
it finds the repository root by climbing the tree; the URL rule mirrors the
``/design/{name}`` route (11.1), a page's directory naming its URL prefix. A
page's kind comes from its ``<meta name="kind">`` (section 8), not its directory."""

import html.parser
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()

ROOT = Path(__file__).resolve().parents[3]

# The five page kinds in composition order (architecture.md 8); the nav lists in it.
KINDS = ("tokens", "contracts", "components", "stem", "app")


class _Head(html.parser.HTMLParser):
    """First ``<title>`` text and the ``meta[name=kind]`` content, either ``None``."""

    def __init__(self):
        super().__init__()
        self._in_title = False
        self.title = None
        self.kind = None

    def handle_starttag(self, tag, attrs):
        if tag == "title" and self.title is None:
            self._in_title = True
        elif tag == "meta" and dict(attrs).get("name") == "kind":
            self.kind = dict(attrs).get("content")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and self.title is None:
            self.title = data.strip()


def _head(file: Path) -> _Head:
    parser = _Head()
    parser.feed(file.read_text(encoding="utf-8"))
    return parser


@router.get("")
def list_pages():
    try:
        pages = []
        for file in sorted((ROOT / "pages").glob("*/*.html")):
            head = _head(file)
            # A malformed page still lists rather than 500s; the page check rejects it.
            kind = head.kind or file.parent.name
            pages.append(
                {"path": f"/{file.parent.name}/{file.stem}", "title": head.title or file.stem, "kind": kind}
            )
        pages.sort(key=lambda p: (KINDS.index(p["kind"]) if p["kind"] in KINDS else len(KINDS), p["path"]))
        return {"pages": pages}
    except OSError:
        return JSONResponse({"error": "unavailable"}, status_code=503)

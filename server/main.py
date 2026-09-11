"""FastAPI entry point (architecture.md 11.1). Named ``server`` rather than
``app`` so it never clashes with ``pages/apps/`` or an app component."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.responses import Response
from starlette.types import Scope

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
COMPONENTS = ROOT / "components"
TOKENS = ROOT / "tokens"
PAGES_DESIGN = ROOT / "pages" / "design"

# Section 11.1: source and tests never reach the browser.
_BLOCKED_SEGMENTS = {"server", "tests"}


class RevalidatingStaticFiles(StaticFiles):
    """Revalidate every response, so an edit is visible on reload without a build step."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


class ComponentStaticFiles(RevalidatingStaticFiles):

    async def get_response(self, path: str, scope: Scope) -> Response:
        if _BLOCKED_SEGMENTS.intersection(path.split("/")):
            raise HTTPException(status_code=404)
        return await super().get_response(path, scope)


app = FastAPI()

app.mount("/static/vendor", RevalidatingStaticFiles(directory=VENDOR), name="vendor")
app.mount("/static/components", ComponentStaticFiles(directory=COMPONENTS), name="components")
app.mount("/static/tokens", RevalidatingStaticFiles(directory=TOKENS), name="tokens")


@app.api_route("/", methods=["GET", "HEAD"])
async def index() -> RedirectResponse:
    return RedirectResponse("/design/tokens")


@app.api_route("/design/{name}", methods=["GET", "HEAD"])
async def design_page(name: str) -> FileResponse:
    page = PAGES_DESIGN / f"{name}.html"
    if not page.is_file() or page.parent != PAGES_DESIGN:
        raise HTTPException(status_code=404)
    return FileResponse(page, headers={"Cache-Control": "no-cache"})

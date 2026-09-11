"""FastAPI entry point (architecture.md 11.1). Named ``server`` rather than
``app`` so it never clashes with ``pages/apps/`` or an app component."""

import importlib.util
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
BUS = ROOT / "bus"
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


# Section 3.4: the server discovers routers by walking the components directory;
# each fact component with a server module is mounted at /api/<component>.
def _include_component_routers() -> None:
    for router_file in sorted(COMPONENTS.glob("*/server/router.py")):
        name = router_file.parent.parent.name
        spec = importlib.util.spec_from_file_location(f"components.{name}.server.router", router_file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        app.include_router(module.router, prefix=f"/api/{name}")


_include_component_routers()

app.mount("/static/vendor", RevalidatingStaticFiles(directory=VENDOR), name="vendor")
app.mount("/static/components", ComponentStaticFiles(directory=COMPONENTS), name="components")
app.mount("/static/tokens", RevalidatingStaticFiles(directory=TOKENS), name="tokens")
# ComponentStaticFiles so the bus's tests/ 404, the same as a component's (11.1).
app.mount("/static/bus", ComponentStaticFiles(directory=BUS), name="bus")


@app.api_route("/", methods=["GET", "HEAD"])
async def index() -> RedirectResponse:
    return RedirectResponse("/design/tokens")


@app.api_route("/design/{name}", methods=["GET", "HEAD"])
async def design_page(name: str) -> FileResponse:
    page = PAGES_DESIGN / f"{name}.html"
    if not page.is_file() or page.parent != PAGES_DESIGN:
        raise HTTPException(status_code=404)
    return FileResponse(page, headers={"Cache-Control": "no-cache"})

"""FastAPI entry point (architecture.md 11.1). Named ``server`` rather than
``app`` so it never clashes with an app page or an app component."""

import importlib.util
import sys
import types
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.responses import Response
from starlette.types import Scope

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
COMPONENTS = ROOT / "components"
TOKENS = ROOT / "tokens"
BUS = ROOT / "bus"
STORE = ROOT / "store"
COMPOSER = ROOT / "composer"
INDEX = ROOT / "pages" / "index.html"
PAGES_DESIGN = ROOT / "pages" / "workshop" / "design"
PAGES_APPS = ROOT / "pages" / "workshop" / "apps"

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
        # A server module may import a relative module inside its own server/ (11.2),
        # so its package must resolve: register it in sys.modules with the server
        # directory as its search path before the router is executed.
        package = f"components.{name}.server"
        if package not in sys.modules:
            pkg = types.ModuleType(package)
            pkg.__path__ = [str(router_file.parent)]
            pkg.__package__ = package
            sys.modules[package] = pkg
        spec = importlib.util.spec_from_file_location(f"{package}.router", router_file)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        app.include_router(module.router, prefix=f"/api/{name}")


_include_component_routers()

app.mount("/static/vendor", RevalidatingStaticFiles(directory=VENDOR), name="vendor")
app.mount("/static/components", ComponentStaticFiles(directory=COMPONENTS), name="components")
app.mount("/static/tokens", RevalidatingStaticFiles(directory=TOKENS), name="tokens")
# ComponentStaticFiles so the bus's tests/ 404, the same as a component's (11.1).
app.mount("/static/bus", ComponentStaticFiles(directory=BUS), name="bus")
# The store interface (11.1), served like the bus; its tests/ 404 the same way.
app.mount("/static/store", ComponentStaticFiles(directory=STORE), name="store")
# The composer (3.6), the second shared infrastructure a page composes with; its
# tests/ 404 the same way as the bus's.
app.mount("/static/composer", ComponentStaticFiles(directory=COMPOSER), name="composer")


@app.api_route("/", methods=["GET", "HEAD"])
async def index() -> FileResponse:
    # The product (architecture.md 8, 11.1): the app page at /. The workshop lives
    # under /workshop/; everything else is the product.
    return FileResponse(INDEX, headers={"Cache-Control": "no-cache"})


@app.api_route("/workshop/design/{name}", methods=["GET", "HEAD"])
async def design_page(name: str) -> FileResponse:
    page = PAGES_DESIGN / f"{name}.html"
    if not page.is_file() or page.parent != PAGES_DESIGN:
        raise HTTPException(status_code=404)
    return FileResponse(page, headers={"Cache-Control": "no-cache"})


@app.api_route("/workshop/apps/{name}", methods=["GET", "HEAD"])
async def app_page(name: str) -> FileResponse:
    page = PAGES_APPS / f"{name}.html"
    if not page.is_file() or page.parent != PAGES_APPS:
        raise HTTPException(status_code=404)
    return FileResponse(page, headers={"Cache-Control": "no-cache"})

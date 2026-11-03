"""The server side of ``updates`` (architecture.md 3.4, 10): whether this Mac is offered
test versions of the app, kept as ``{"test": bool}`` in ``updates.json`` in the data
folder, where the Mac app reads it before it checks for updates. Only the local edition
answers. The website has no Mac app to offer them: a read there answers 200 with
``{"here": false}`` rather than 404, because the product page reads it on every load
and a 4xx is a failure of the page (11.2); not 204 either, which Chromium reports as an
aborted request. A write there answers 404.

A missing or broken file means off, the same as the Mac app reads it.
"""

import json
import os
import tempfile

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from server.user import DATA, local_user

router = APIRouter()

FILE = "updates.json"


def read_test() -> bool:
    try:
        value = json.loads((DATA / FILE).read_text()).get("test")
    except (OSError, ValueError, AttributeError):
        return False
    return value is True


def write_test(test: bool) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    # Written whole and then renamed, so the Mac app never reads half a file.
    handle, name = tempfile.mkstemp(dir=DATA, prefix=".updates-", suffix=".json")
    try:
        with os.fdopen(handle, "w") as out:
            json.dump({"test": test}, out)
        os.replace(name, DATA / FILE)
    except BaseException:
        os.unlink(name)
        raise


def _not_here():
    return JSONResponse({"error": "not-found"}, status_code=404)


@router.get("")
async def read():
    if not local_user():
        return {"here": False}
    return {"test": await run_in_threadpool(read_test)}


@router.put("")
async def edit(request: Request):
    if not local_user():
        return _not_here()
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict) or set(body) != {"test"} or not isinstance(body["test"], bool):
        return JSONResponse({"error": "bad-request"}, status_code=400)
    await run_in_threadpool(write_test, body["test"])
    return {"test": await run_in_threadpool(read_test)}

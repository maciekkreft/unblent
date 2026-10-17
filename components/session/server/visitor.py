"""What the server records about who is visiting (architecture.md 3.4): the
country and city Cloudflare's visitor location headers report, and the browser,
the system, and phone or desk, read from the user agent. Nothing else: no source
tag and no referrer. Shown only to the admin, in People (12).
"""

import re

from fastapi import Request

# Order matters: most browsers' user agents also name the ones they descend from
# (Edge says Chrome and Safari, Chrome says Safari), so the most specific is tried first.
_BROWSERS = (
    (r"EdgiOS|EdgA?/|Edg/", "Edge"),
    (r"OPR/|OPiOS|Opera", "Opera"),
    (r"SamsungBrowser", "Samsung Internet"),
    (r"FxiOS|Firefox/", "Firefox"),
    (r"CriOS|Chrome/|Chromium/", "Chrome"),
    (r"Safari/", "Safari"),
)

_SYSTEMS = (
    (r"iPhone|iPod", "iOS"),
    (r"iPad", "iPadOS"),
    (r"Android", "Android"),
    (r"CrOS", "ChromeOS"),
    (r"Windows", "Windows"),
    (r"Mac OS X|Macintosh", "macOS"),
    (r"Linux", "Linux"),
)


def _first(table, agent: str) -> str:
    for pattern, name in table:
        if re.search(pattern, agent):
            return name
    return ""


def from_agent(agent: str) -> dict:
    """{"browser", "system", "device"} from a User-Agent; empty names when unknown.
    A tablet counts as a desk: the product lays it out like one."""
    system = _first(_SYSTEMS, agent)
    phone = system == "iOS" or (system == "Android" and "Mobile" in agent) or "Mobi" in agent
    return {"browser": _first(_BROWSERS, agent), "system": system, "device": "phone" if phone else "desk"}


def _header(request: Request, name: str) -> str:
    value = (request.headers.get(name) or "").strip()
    # Starlette decodes header bytes as Latin-1, but Cloudflare sends a city such as
    # Kraków in UTF-8, so the bytes are read again as UTF-8.
    try:
        return value.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value


def from_request(request: Request) -> dict:
    """Every detail recorded for a visit (3.4). Cloudflare reports XX for a country
    it does not know and T1 for Tor; neither is a place, so both read as unknown."""
    country = _header(request, "cf-ipcountry").upper()
    if not re.fullmatch(r"[A-Z]{2}", country) or country in ("XX", "T1"):
        country = ""
    return {
        "country": country,
        "city": _header(request, "cf-ipcity")[:80],
        **from_agent(request.headers.get("user-agent") or ""),
    }

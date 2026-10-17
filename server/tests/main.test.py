"""HTTP tests for the server entry (architecture.md 11.1). Stdlib only, run
against the live check server; UNBLENT_URL is set by checks/check.py."""

import http.client
import os
import unittest
from collections import namedtuple
from urllib.parse import urlparse

Reply = namedtuple("Reply", "status headers")


def _request(path: str) -> Reply:
    base = os.environ["UNBLENT_URL"]  # e.g. http://127.0.0.1:8099
    parts = urlparse(base)
    conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=5)
    try:
        # No client-side redirect following: the redirect itself is under test.
        conn.request("GET", path)
        res = conn.getresponse()
        res.read()
        return Reply(res.status, res.headers)
    finally:
        conn.close()


class ServerEntry(unittest.TestCase):
    def test_root_serves_the_product(self):
        # Section 8: / is the product app page (pages/index.html), served no-cache
        # like the other pages, not a redirect into the workshop.
        res = _request("/")
        self.assertEqual(res.status, 200)
        self.assertTrue(res.headers.get("Content-Type", "").startswith("text/html"))
        self.assertEqual(res.headers.get("Cache-Control"), "no-cache")

    def test_unknown_design_page_404s(self):
        self.assertEqual(_request("/workshop/design/does-not-exist").status, 404)

    def test_app_page_serves_and_guards(self):
        # Section 11.1: /workshop/apps/<name> serves pages/workshop/apps/<name>.html,
        # 404 otherwise, with the same parent guard as /workshop/design/<name>.
        self.assertEqual(_request("/workshop/apps/does-not-exist").status, 404)
        self.assertEqual(_request("/workshop/apps/foo%2F..%2Fbar").status, 404)

    def test_try_page_serves_and_guards(self):
        # Section 11.1: /try/<name> serves pages/try/<name>.html, 404 otherwise.
        res = _request("/try/evaluators")
        self.assertEqual(res.status, 200)
        self.assertEqual(res.headers.get("Cache-Control"), "no-cache")
        self.assertEqual(_request("/try/does-not-exist").status, 404)
        self.assertEqual(_request("/try/foo%2F..%2Fbar").status, 404)

    def test_legacy_urls_404(self):
        # The workshop moved under /workshop/; the old flat URLs are gone (only the owner used them).
        self.assertEqual(_request("/design/tokens").status, 404)
        self.assertEqual(_request("/apps/notes").status, 404)

    def test_static_responses_are_no_cache(self):
        # The header the edit-and-reload story rests on, on every static mount.
        for path in (
            "/static/tokens/tokens.css",
            "/static/components/token-sheet/machine.js",
            "/static/vendor/vendor.json",
            "/static/bus/bus.js",
            "/static/store/store.js",
            "/static/editor/editor.js",
        ):
            res = _request(path)
            self.assertEqual(res.status, 200, path)
            self.assertEqual(res.headers.get("Cache-Control"), "no-cache", path)

    def test_source_and_tests_never_served(self):
        # Section 11.1: a component's server/ and tests/ must not reach the browser.
        self.assertEqual(
            _request("/static/components/token-sheet/tests/view.test.mjs").status, 404
        )
        self.assertEqual(
            _request("/static/components/token-sheet/server/router.py").status, 404
        )
        # The bus is infrastructure, but its tests/ are hidden the same way.
        self.assertEqual(_request("/static/bus/tests/bus.test.mjs").status, 404)
        # The store interface (11.1) hides its tests/ the same way.
        self.assertEqual(_request("/static/store/tests/store.test.mjs").status, 404)
        # The editor kit (11.1) hides its tests/ the same way.
        self.assertEqual(_request("/static/editor/tests/editor.test.mjs").status, 404)

    def test_component_routers_are_discovered(self):
        # Section 3.4: a component's server module is mounted at /api/<component>,
        # without a trailing-slash redirect.
        res = _request("/api/catalog")
        self.assertEqual(res.status, 200)
        self.assertTrue(res.headers.get("Content-Type", "").startswith("application/json"))
        self.assertEqual(_request("/api/does-not-exist").status, 404)
        self.assertEqual(_request("/static/components/catalog/server/router.py").status, 404)

    def test_design_name_cannot_escape_pages_dir(self):
        # Whether routing or the page.parent guard enforces it, the outcome is 404.
        self.assertEqual(_request("/workshop/design/foo%2F..%2Fbar").status, 404)


if __name__ == "__main__":
    unittest.main()

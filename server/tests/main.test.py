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
    def test_root_redirects_to_tokens(self):
        res = _request("/")
        self.assertIn(res.status, (301, 302, 303, 307, 308))
        self.assertEqual(res.headers.get("Location"), "/design/tokens")

    def test_unknown_design_page_404s(self):
        self.assertEqual(_request("/design/does-not-exist").status, 404)

    def test_static_responses_are_no_cache(self):
        # The header the edit-and-reload story rests on, on every static mount.
        for path in (
            "/static/tokens/tokens.css",
            "/static/components/token-sheet/machine.js",
            "/static/vendor/vendor.json",
            "/static/bus/bus.js",
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

    def test_design_name_cannot_escape_pages_dir(self):
        # Whether routing or the page.parent guard enforces it, the outcome is 404.
        self.assertEqual(_request("/design/foo%2F..%2Fbar").status, 404)


if __name__ == "__main__":
    unittest.main()

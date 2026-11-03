import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The server module (3.4) against a throwaway data folder of its own, in one python
// process, because the local edition is chosen by the environment.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const SCRIPT = `
import json, os
from fastapi import FastAPI
from fastapi.testclient import TestClient
import components.updates.server.router as updates

app = FastAPI()
app.include_router(updates.router, prefix="/api/updates")
client = TestClient(app)

def call(method, body=None):
    r = client.request(method, "/api/updates", json=body)
    return [r.status_code, r.json() if r.content else None]

out = {}
out["web"] = call("GET")
out["webWrite"] = call("PUT", {"test": True})
os.environ["UNBLENT_LOCAL_USER"] = "0123abcd"
out["fresh"] = call("GET")
out["on"] = call("PUT", {"test": True})
out["read"] = call("GET")
out["bad"] = [call("PUT", b)[0] for b in ({"test": "yes"}, {}, {"test": True, "x": 1}, [])]
out["off"] = call("PUT", {"test": False})
(updates.DATA / "updates.json").write_text("{not json")
out["broken"] = call("GET")
out["fixed"] = call("PUT", {"test": True})
print(json.dumps(out))
`;

test("only a Mac reads and writes the switch, a missing or broken file is off, and the website has none", () => {
  const data = mkdtempSync(join(tmpdir(), "updates-server-"));
  try {
    const out = JSON.parse(
      execFileSync(`${ROOT}.venv/bin/python`, ["-c", SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, UNBLENT_DATA: data, UNBLENT_LOCAL_USER: "" },
      }),
    );
    assert.deepEqual(out.web, [200, { here: false }], "the website has nothing to show, and no 4xx or 204 on every page load");
    assert.deepEqual(out.webWrite, [404, { error: "not-found" }]);
    assert.deepEqual(out.fresh, [200, { test: false }], "off while there is no file");
    assert.deepEqual(out.on, [200, { test: true }]);
    assert.deepEqual(out.read, [200, { test: true }]);
    assert.deepEqual(out.bad, [400, 400, 400, 400]);
    assert.deepEqual(out.off, [200, { test: false }]);
    assert.deepEqual(out.broken, [200, { test: false }], "a broken file is off");
    assert.deepEqual(out.fixed, [200, { test: true }]);
    assert.deepEqual(JSON.parse(readFileSync(join(data, "updates.json"), "utf8")), { test: true }, "the file the Mac app reads");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

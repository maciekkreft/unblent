import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The server module (3.4) against a throwaway data directory of its own, in one python
// process, because data/flags.db is shared by every account: switching a feature on the
// check's server would change what every other test sees.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const SCRIPT = `
import json
from fastapi import FastAPI
from fastapi.testclient import TestClient
from server.user import SESSION_COOKIE, session_token
from components.flags.server.router import router

app = FastAPI()
app.include_router(router, prefix="/api/flags")
client = TestClient(app)
cookie = lambda token: {SESSION_COOKIE: token}
admin = cookie(session_token("a1", admin=True))
viewing = cookie(session_token("g1", guest=True, viewer="a1"))
someone = cookie(session_token("u1"))

def call(method, cookies=None, body=None):
    client.cookies.clear()
    for name, value in (cookies or {}).items():
        client.cookies.set(name, value)
    r = client.request(method, "/api/flags", json=body)
    return [r.status_code, r.json()]

out = {}
out["fresh"] = call("GET")
out["notAdmin"] = call("PUT", someone, {"feature": "chats", "on": False})
out["viewing"] = call("PUT", viewing, {"feature": "chats", "on": False})
out["bad"] = [call("PUT", admin, b)[0] for b in ({"feature": "news", "on": False}, {"feature": "chats"}, {"feature": "chats", "on": "no"}, {"feature": "chats", "on": False, "x": 1}, [])]
out["off"] = call("PUT", admin, {"feature": "highlights", "on": False})
call("PUT", admin, {"feature": "chats", "on": False})
out["twice"] = call("PUT", admin, {"feature": "chats", "on": False})
out["signedOut"] = call("GET")
out["someone"] = call("GET", someone)
out["admin"] = call("GET", admin)
out["adminViewing"] = call("GET", viewing)
out["back"] = call("PUT", admin, {"feature": "highlights", "on": True})
print(json.dumps(out))
`;

test("anyone reads which features are off; only the admin switches one, and sees every feature", () => {
  const data = mkdtempSync(join(tmpdir(), "flags-server-"));
  try {
    const out = JSON.parse(
      execFileSync(`${ROOT}.venv/bin/python`, ["-c", SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, UNBLENT_DATA: data, SESSION_SECRET: "flags-test-secret", UNBLENT_LOCAL_USER: "" },
      }),
    );
    assert.deepEqual(out.fresh, [200, { off: [], hidden: [] }], "every feature is on at first");
    assert.deepEqual(out.notAdmin, [403, { error: "not-admin" }]);
    assert.deepEqual(out.viewing, [403, { error: "not-admin" }], "not while the admin views as someone");
    assert.deepEqual(out.bad, [400, 400, 400, 400, 400]);
    assert.deepEqual(out.off, [200, { off: ["highlights"], hidden: [] }], "the admin sees every feature");
    assert.deepEqual(out.twice, [200, { off: ["chats", "highlights"], hidden: [] }], "turning off twice is once, in the tab's order");
    assert.deepEqual(out.signedOut, [200, { off: ["chats", "highlights"], hidden: ["chats", "highlights"] }]);
    assert.deepEqual(out.someone, out.signedOut);
    assert.deepEqual(out.admin, [200, { off: ["chats", "highlights"], hidden: [] }]);
    assert.deepEqual(out.adminViewing, out.signedOut, "viewing as someone, the admin sees what they see");
    assert.deepEqual(out.back, [200, { off: ["chats"], hidden: [] }]);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

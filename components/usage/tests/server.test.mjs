import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The server module (5) against a throwaway data directory of its own, in one python
// process, because who=all reads every account's file under the data directory: on the
// check's server it would see what every other test wrote.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const SCRIPT = `
import json
from datetime import date, timedelta
from fastapi import FastAPI
from fastapi.testclient import TestClient
from server.user import DATA, SESSION_COOKIE, session_token
import components.usage.server.router as usage

app = FastAPI()
app.include_router(usage.router, prefix="/api/usage")
client = TestClient(app)
cookie = lambda token: {SESSION_COOKIE: token}
admin = cookie(session_token("a1", admin=True))
viewing = cookie(session_token("u1", viewer="a1"))
someone = cookie(session_token("u1"))
other = cookie(session_token("u2"))

def call(method, path, cookies=None, body=None):
    client.cookies.clear()
    for name, value in (cookies or {}).items():
        client.cookies.set(name, value)
    r = client.request(method, "/api/usage" + path, json=body)
    return [r.status_code, r.json()]

today = date.today().isoformat()
old = (date.today() - timedelta(days=200)).isoformat()
A, B = "01ARZ3NDEKTSV4RRFFQ69G5AAA", "01ARZ3NDEKTSV4RRFFQ69G5BBB"
row = lambda device, day, feature, ms: {"id": f"{device}:{day}:{feature}", "device": device, "day": day, "feature": feature, "ms": ms}

out = {"today": today}
out["signedOut"] = call("PUT", "", None, {"totals": [row(A, today, "notes", 1)]})
out["store"] = call("PUT", "", someone, {"totals": [row(A, today, "notes", 1000), row(A, today, "journal", 500), row(A, old, "notes", 9)]})
out["later"] = call("PUT", "", someone, {"totals": [row(A, today, "notes", 3000)]})
out["again"] = call("PUT", "", someone, {"totals": [row(A, today, "notes", 3000)]})
out["device"] = call("PUT", "", someone, {"totals": [row(B, today, "notes", 2000)]})
out["you"] = call("GET", "/summary?who=you", someone)
out["otherFresh"] = call("GET", "/summary?who=you", other)
out["otherMadeNoFile"] = (DATA / "u2" / "usage.db").exists()
call("PUT", "", other, {"totals": [row(A, today, "notes", 100), row(A, today, "chats", 50)]})
out["all"] = call("GET", "/summary?who=all", admin)
out["notAdmin"] = call("GET", "/summary?who=all", someone)
out["viewing"] = call("GET", "/summary?who=all", viewing)
out["badWho"] = call("GET", "/summary?who=them", someone)[0]
bad = [
    {"totals": [row(A, today, "games", 1)]},
    {"totals": [row(A, "11/03/2026", "notes", 1)]},
    {"totals": [row(A, today, "notes", -1)]},
    {"totals": [row(A, today, "notes", 1.5)]},
    {"totals": [row(A, today, "notes", True)]},
    {"totals": [{**row(A, today, "notes", 1), "id": "x"}]},
    {"totals": [{**row(A, today, "notes", 1), "extra": 1}]},
    {"totals": [row("me", today, "notes", 1)]},
    {"totals": []},
    {"rows": []},
    [],
]
out["bad"] = [call("PUT", "", someone, b) for b in bad]
print(json.dumps(out))
`;

test("totals are stored last write wins, summed across devices, and added up across accounts for the admin only", () => {
  const data = mkdtempSync(join(tmpdir(), "usage-server-"));
  try {
    const out = JSON.parse(
      execFileSync(`${ROOT}.venv/bin/python`, ["-c", SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, UNBLENT_DATA: data, SESSION_SECRET: "usage-test-secret", UNBLENT_LOCAL_USER: "" },
      }),
    );
    const day = out.today;
    assert.equal(out.signedOut[0], 401);
    assert.deepEqual(out.store, [200, { stored: 3 }]);
    assert.deepEqual(out.later, [200, { stored: 1 }]);
    assert.deepEqual(out.again, out.later, "a write sent twice does no harm");
    assert.deepEqual(out.device, [200, { stored: 1 }]);
    assert.deepEqual(
      out.you,
      [200, { days: [{ day, feature: "journal", ms: 500 }, { day, feature: "notes", ms: 5000 }], accounts: 1 }],
      "the later total replaced the first, the two devices add up, and a day older than 182 days is left out",
    );
    assert.deepEqual(out.otherFresh, [200, { days: [], accounts: 1 }]);
    assert.equal(out.otherMadeNoFile, false, "asking makes no file");
    assert.deepEqual(out.all, [
      200,
      { days: [{ day, feature: "journal", ms: 500 }, { day, feature: "notes", ms: 5100 }, { day, feature: "chats", ms: 50 }], accounts: 2 },
    ]);
    assert.deepEqual(out.notAdmin, [403, { error: "not-admin" }]);
    assert.deepEqual(out.viewing, [403, { error: "not-admin" }], "not while the admin views as someone");
    assert.equal(out.badWho, 400);
    for (const [status, body] of out.bad) assert.deepEqual([status, body], [400, { error: "bad-request" }]);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

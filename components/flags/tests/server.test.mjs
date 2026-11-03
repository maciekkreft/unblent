import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The server module (3.4) against a throwaway data directory of its own, in one python
// process, because data/flags.db is shared by every account: releasing a feature on the
// check's server would change what every other test sees.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const SCRIPT = `
import json, os
from pathlib import Path
from fastapi import FastAPI
from fastapi.testclient import TestClient
from server.user import SESSION_COOKIE, session_token
import components.flags.server.router as flags

app = FastAPI()
app.include_router(flags.router, prefix="/api/flags")
client = TestClient(app)
cookie = lambda token: {SESSION_COOKIE: token}
admin = cookie(session_token("a1", admin=True))
viewing = cookie(session_token("g1", guest=True, viewer="a1"))
someone = cookie(session_token("u1"))
guest = cookie(session_token("g2", guest=True))

def call(method, cookies=None, body=None):
    client.cookies.clear()
    for name, value in (cookies or {}).items():
        client.cookies.set(name, value)
    r = client.request(method, "/api/flags", json=body)
    return [r.status_code, r.json()]

# Rows kept for a feature that no longer has a flag are left in place and ignored.
with flags._connect(flags.DATA / "flags.db", flags._RELEASE + "CREATE TABLE IF NOT EXISTS turned_on (feature TEXT PRIMARY KEY, at INTEGER NOT NULL);") as c:
    c.execute("INSERT INTO off VALUES ('undo', 1)")
    c.execute("INSERT INTO turned_on VALUES ('undo', 1)")
with flags._connect(flags.user_dir("u1") / "flags.db", flags._SHOW) as c:
    c.execute("INSERT INTO hidden VALUES ('undo', 1)")

out = {}
out["fresh"] = call("GET")
out["someoneFresh"] = call("GET", someone)
out["notAdmin"] = call("PUT", someone, {"feature": "choice-points", "on": False})
out["viewing"] = call("PUT", viewing, {"feature": "choice-points", "on": False})
out["bad"] = [call("PUT", admin, b)[0] for b in ({"feature": "chats", "on": False}, {"feature": "undo", "on": True}, {"feature": "undo", "on": False, "column": "show"}, {"feature": "choice-points"}, {"feature": "choice-points", "on": "no"}, {"feature": "choice-points", "on": False, "x": 1}, {"feature": "choice-points", "on": False, "column": "all"}, [])]
out["held"] = call("PUT", admin, {"feature": "choice-points", "on": False})
out["twice"] = call("PUT", admin, {"feature": "choice-points", "on": False, "column": "release"})
out["signedOut"] = call("GET")
out["someone"] = call("GET", someone)
out["admin"] = call("GET", admin)
out["adminViewing"] = call("GET", viewing)
out["back"] = call("PUT", admin, {"feature": "choice-points", "on": True})
out["slipOn"] = call("PUT", admin, {"feature": "slip-box", "on": True})
out["slipOnTwice"] = call("PUT", admin, {"feature": "slip-box", "on": True})
out["someoneSlip"] = call("GET", someone)
out["showSignedOut"] = call("PUT", None, {"feature": "choice-points", "on": False, "column": "show"})
out["guestHides"] = call("PUT", guest, {"feature": "choice-points", "on": False, "column": "show"})
out["someoneElse"] = call("GET", someone)
out["guestAgain"] = call("GET", guest)
out["guestShows"] = call("PUT", guest, {"feature": "choice-points", "on": True, "column": "show"})
out["adminHides"] = call("PUT", admin, {"feature": "choice-points", "on": False, "column": "show"})
out["slipOff"] = call("PUT", admin, {"feature": "slip-box", "on": False})
out["someoneSlipOff"] = call("GET", someone)

# The local edition (3.4): Release is the frozen list, or everything without it.
os.environ["UNBLENT_LOCAL_USER"] = "l1"
flags.FROZEN = Path(os.environ["UNBLENT_DATA"]) / "released.json"
out["localNone"] = call("GET")
flags.FROZEN.write_text(json.dumps({"released": ["undo"]}))
out["localFrozen"] = call("GET")
out["localRelease"] = call("PUT", None, {"feature": "choice-points", "on": True})
out["localShow"] = call("PUT", None, {"feature": "choice-points", "on": False, "column": "show"})
print(json.dumps(out))
`;

test("anyone reads Release and Show; only the admin on the website releases, every signed-in account shows for itself", () => {
  const data = mkdtempSync(join(tmpdir(), "flags-server-"));
  try {
    const out = JSON.parse(
      execFileSync(`${ROOT}.venv/bin/python`, ["-c", SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, UNBLENT_DATA: data, SESSION_SECRET: "flags-test-secret", UNBLENT_LOCAL_USER: "" },
      }),
    );
    const ALL = ["choice-points", "slip-box"];
    const p = (released, hidden, shown = ALL) => [200, { off: ALL.filter((f) => !released.includes(f)), hidden, released, shown }];
    assert.deepEqual(out.fresh, p(["choice-points"], ["slip-box"]), "every feature is released at first, except Slip-Box, and a row kept for Undo is ignored");
    assert.deepEqual(out.someoneFresh, out.fresh, "a Show row kept for Undo is ignored");
    assert.deepEqual(out.notAdmin, [403, { error: "not-admin" }]);
    assert.deepEqual(out.viewing, [403, { error: "not-admin" }], "not while the admin views as someone");
    assert.deepEqual(out.bad, [400, 400, 400, 400, 400, 400, 400, 400], "an unknown feature, Undo included, is refused");
    assert.deepEqual(out.held, p([], []), "the admin on the website still sees what is not released");
    assert.deepEqual(out.twice, out.held, "holding back twice is once");
    assert.deepEqual(out.signedOut, p([], ALL));
    assert.deepEqual(out.someone, out.signedOut);
    assert.deepEqual(out.admin, out.held);
    assert.deepEqual(out.adminViewing, out.signedOut, "the admin viewing as someone sees what they see");
    assert.deepEqual(out.back, p(["choice-points"], []));
    assert.deepEqual(out.slipOn, p(ALL, []), "the admin releases Slip-Box");
    assert.deepEqual(out.slipOnTwice, out.slipOn, "releasing twice is once");
    assert.deepEqual(out.someoneSlip, p(ALL, []), "released for everyone");
    assert.deepEqual(out.showSignedOut, [401, { error: "signed-out" }]);
    assert.deepEqual(out.guestHides, p(ALL, ["choice-points"], ["slip-box"]), "a guest hides a feature from itself");
    assert.deepEqual(out.someoneElse, p(ALL, []), "and from no one else");
    assert.deepEqual(out.guestAgain, out.guestHides, "kept for the account");
    assert.deepEqual(out.guestShows, p(ALL, []));
    assert.deepEqual(out.adminHides, p(ALL, ["choice-points"], ["slip-box"]), "Show hides from the admin too");
    assert.deepEqual(out.slipOff, p(["choice-points"], ["choice-points"], ["slip-box"]), "held back again, the admin still sees it");
    assert.deepEqual(out.someoneSlipOff, p(["choice-points"], ["slip-box"]));
    assert.deepEqual(out.localNone, p(ALL, []), "a Mac without the frozen list releases everything");
    assert.deepEqual(out.localFrozen, p([], ALL), "a Mac hides what the frozen list does not release, from its admin too");
    assert.deepEqual(out.localRelease, [403, { error: "not-admin" }], "Release is set only on the website");
    assert.deepEqual(out.localShow, p([], ALL, ["slip-box"]), "Show works on a Mac");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

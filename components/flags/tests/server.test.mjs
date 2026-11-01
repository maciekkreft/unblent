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

out = {}
out["fresh"] = call("GET")
out["notAdmin"] = call("PUT", someone, {"feature": "choice-points", "on": False})
out["viewing"] = call("PUT", viewing, {"feature": "choice-points", "on": False})
out["bad"] = [call("PUT", admin, b)[0] for b in ({"feature": "chats", "on": False}, {"feature": "evaluators", "on": False}, {"feature": "undo"}, {"feature": "undo", "on": "no"}, {"feature": "undo", "on": False, "x": 1}, {"feature": "undo", "on": False, "column": "all"}, [])]
out["held"] = call("PUT", admin, {"feature": "choice-points", "on": False})
out["twice"] = call("PUT", admin, {"feature": "choice-points", "on": False, "column": "release"})
out["signedOut"] = call("GET")
out["someone"] = call("GET", someone)
out["admin"] = call("GET", admin)
out["adminViewing"] = call("GET", viewing)
out["back"] = call("PUT", admin, {"feature": "choice-points", "on": True})
out["undoOn"] = call("PUT", admin, {"feature": "undo", "on": True})
out["undoOnTwice"] = call("PUT", admin, {"feature": "undo", "on": True})
out["showSignedOut"] = call("PUT", None, {"feature": "undo", "on": False, "column": "show"})
out["guestHides"] = call("PUT", guest, {"feature": "undo", "on": False, "column": "show"})
out["someoneElse"] = call("GET", someone)
out["guestAgain"] = call("GET", guest)
out["guestShows"] = call("PUT", guest, {"feature": "undo", "on": True, "column": "show"})
out["adminHides"] = call("PUT", admin, {"feature": "undo", "on": False, "column": "show"})
out["undoOff"] = call("PUT", admin, {"feature": "undo", "on": False})

# The local edition (3.4): Release is the frozen list, or everything without it.
os.environ["UNBLENT_LOCAL_USER"] = "l1"
flags.FROZEN = Path(os.environ["UNBLENT_DATA"]) / "released.json"
out["localNone"] = call("GET")
flags.FROZEN.write_text(json.dumps({"released": ["undo"]}))
out["localFrozen"] = call("GET")
out["localRelease"] = call("PUT", None, {"feature": "choice-points", "on": True})
out["localShow"] = call("PUT", None, {"feature": "undo", "on": False, "column": "show"})
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
    const p = (released, hidden, shown = ["choice-points", "undo"]) => [200, { off: ["choice-points", "undo"].filter((f) => !released.includes(f)), hidden, released, shown }];
    assert.deepEqual(out.fresh, p(["choice-points"], ["undo"]), "every feature is released at first, except Undo");
    assert.deepEqual(out.notAdmin, [403, { error: "not-admin" }]);
    assert.deepEqual(out.viewing, [403, { error: "not-admin" }], "not while the admin views as someone");
    assert.deepEqual(out.bad, [400, 400, 400, 400, 400, 400, 400], "an unknown feature, a removed one included, is refused");
    assert.deepEqual(out.held, p([], []), "the admin on the website still sees what is not released");
    assert.deepEqual(out.twice, out.held, "holding back twice is once");
    assert.deepEqual(out.signedOut, p([], ["choice-points", "undo"]));
    assert.deepEqual(out.someone, out.signedOut);
    assert.deepEqual(out.admin, out.held);
    assert.deepEqual(out.adminViewing, out.signedOut, "the admin viewing as someone sees what they see");
    assert.deepEqual(out.back, p(["choice-points"], []));
    assert.deepEqual(out.undoOn, p(["choice-points", "undo"], []), "the admin releases Undo");
    assert.deepEqual(out.undoOnTwice, out.undoOn, "releasing twice is once");
    assert.deepEqual(out.showSignedOut, [401, { error: "signed-out" }]);
    assert.deepEqual(out.guestHides, p(["choice-points", "undo"], ["undo"], ["choice-points"]), "a guest hides a feature from itself");
    assert.deepEqual(out.someoneElse, p(["choice-points", "undo"], []), "and from no one else");
    assert.deepEqual(out.guestAgain, out.guestHides, "kept for the account");
    assert.deepEqual(out.guestShows, p(["choice-points", "undo"], []));
    assert.deepEqual(out.adminHides, p(["choice-points", "undo"], ["undo"], ["choice-points"]), "Show hides from the admin too");
    assert.deepEqual(out.undoOff, p(["choice-points"], ["undo"], ["choice-points"]));
    assert.deepEqual(out.localNone, p(["choice-points", "undo"], []), "a Mac without the frozen list releases everything");
    assert.deepEqual(out.localFrozen, p(["undo"], ["choice-points"]), "a Mac hides what the frozen list does not release, from its admin too");
    assert.deepEqual(out.localRelease, [403, { error: "not-admin" }], "Release is set only on the website");
    assert.deepEqual(out.localShow, p(["undo"], ["choice-points", "undo"], ["choice-points"]), "Show works on a Mac");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

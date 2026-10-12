import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Starter keys (architecture.md 12) are decided in the server module, so the router is
// loaded in one python process the way server/main.py loads it, against a throwaway
// data directory and with Jev's HTTP call faked: nothing here reaches typesafe.ai.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const SCRIPT = `
import importlib.util, json, os, sys, types
package = "components.llm.server"
pkg = types.ModuleType(package)
pkg.__path__ = ["components/llm/server"]
sys.modules[package] = pkg
spec = importlib.util.spec_from_file_location(package + ".router", "components/llm/server/router.py")
router = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = router
spec.loader.exec_module(router)
jev = sys.modules[package + ".jev_adapter"]

sent = []
fail = [False]
def send(key, payload):
    sent.append(key)
    if fail[0]:
        return None, "overloaded", 0
    return {"answers": {"q": {"type": "noul", "noul": 0.5}}}, None, 3
jev.send = send

Q = [{"id": "q", "instructions": "Is it?"}]
def decide(user):
    return router._decide(user, {}, Q)
def jev_of(user):
    return router.read(user)["jev"]
def own(user, key):
    return router._apply(user, {"provider": None, "effort": None, "ttl": None, "model": None, "key": None, "jevKey": key})["jev"]

out = {}
os.environ["SEED_API_KEYS"] = "TYPESAFE_AI_API_KEY,NO_SLOT,,"
os.environ["TYPESAFE_AI_API_KEY"] = "starter-secret"
os.environ["NO_SLOT"] = "ignored"

# An account that existed before has an llm.db already, so it gets no starter row.
router.user_dir("old").joinpath("llm.db").touch()
out["old"] = [jev_of("old"), decide("old"), sent[:]]

out["fresh"] = jev_of("new")
out["first"] = decide("new")
fail[0] = True
out["failed"] = decide("new")
fail[0] = False
out["afterFail"] = jev_of("new")
out["keyUsed"] = sent[-1]

out["own"] = own("new", "own-secret")
before = len(sent)
out["ownDecide"] = decide("new")
out["ownKey"] = sent[-1]
out["ownLeft"] = jev_of("new")
out["removed"] = own("new", "")

for _ in range(99):
    decide("new")
out["last"] = jev_of("new")
before = len(sent)
out["usedUp"] = [decide("new"), len(sent) - before, jev_of("new")]
out["db"] = "starter-secret" in router.user_dir("new").joinpath("llm.db").read_bytes().decode("latin-1")

# The entry gone from .env: the row stays, but no key is usable.
jev_of("gone")
del os.environ["TYPESAFE_AI_API_KEY"]
out["unsetLater"] = [jev_of("gone"), decide("gone")]
# An entry unset when the account is made gives no row at all.
out["unsetAtStart"] = jev_of("unset")
os.environ["SEED_API_KEYS"] = "NO_SLOT,"
out["noSlot"] = jev_of("noslot")
print(json.dumps(out))
`;

test("a new account judges on the starter key for 100 answered requests; an own key wins", () => {
  const data = mkdtempSync(join(tmpdir(), "llm-starter-"));
  try {
    const out = JSON.parse(
      execFileSync(`${ROOT}.venv/bin/python`, ["-c", SCRIPT], {
        cwd: ROOT,
        // A throwaway secret for a throwaway directory: own keys are encrypted with it.
        env: { ...process.env, UNBLENT_DATA: data, SESSION_SECRET: "starter-test-secret" },
      }),
    );
    assert.deepEqual(out.old, [{ keySet: false }, { error: "no-key" }, []], "an existing account gets nothing");

    assert.deepEqual(out.fresh, { keySet: true, starterLeft: 100 });
    assert.equal(out.first.starterLeft, 99);
    assert.deepEqual(out.failed, { error: "overloaded" }, "a failed call carries no count");
    assert.deepEqual(out.afterFail, { keySet: true, starterLeft: 99 }, "and is not counted");
    assert.equal(out.keyUsed, "starter-secret");

    assert.deepEqual(out.own, { keySet: true }, "an own key hides the starter count");
    assert.equal(out.ownKey, "own-secret");
    assert.ok(!("starterLeft" in out.ownDecide), "an own-key answer is not counted");
    assert.deepEqual(out.removed, { keySet: true, starterLeft: 99 }, "removing the own key goes back to the starter key");

    assert.deepEqual(out.last, { keySet: false, starterLeft: 0 });
    assert.deepEqual(out.usedUp, [{ error: "no-key" }, 0, { keySet: false, starterLeft: 0 }], "at 100 nothing is sent");
    assert.equal(out.db, false, "the starter key is never written to the account's file");

    assert.deepEqual(out.unsetLater, [{ keySet: false, starterLeft: 100 }, { error: "no-key" }]);
    assert.deepEqual(out.unsetAtStart, { keySet: false });
    assert.deepEqual(out.noSlot, { keySet: false }, "a name with no slot is ignored");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

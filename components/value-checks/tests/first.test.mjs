import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The values settings a Mac starts with (3.4): the server module in one python process of
// its own, on a throwaway data directory, with a bundle folder this test writes, as
// mac/export-checks.py would. The local edition is the variable alone, so the same
// process also tries the web edition.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LOCAL = "c".repeat(32);
const VALUE = "01ARZ3NDEKTSV4RRFFQ69G5EV2";
const BUNDLE = { settings: { values: VALUE, examples: null } };

const SCRIPT = `
import importlib.util, json, os, shutil
from fastapi import FastAPI
from fastapi.testclient import TestClient
from server.user import DATA, SESSION_COOKIE, session_token

# The directory's name has hyphens, so the router is loaded from its file, as server/main.py does.
spec = importlib.util.spec_from_file_location("value_checks_router", "components/value-checks/server/router.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
router = module.router

app = FastAPI()
app.include_router(router, prefix="/api/value-checks")
client = TestClient(app)

def pull(cookie=None):
    client.cookies.clear()
    if cookie:
        client.cookies.set(SESSION_COOKIE, session_token(cookie))
    r = client.get("/api/value-checks")
    return [r.status_code, r.json()]

local = os.environ["UNBLENT_LOCAL_USER"]
out = {}
out["first"] = pull()
out["marked"] = (DATA / "first-value-checks").exists()
out["again"] = pull()
out["other"] = pull("someone")
shutil.rmtree(DATA / local, ignore_errors=True)
out["afterDisconnect"] = pull()
(DATA / "first-value-checks").unlink(missing_ok=True)
os.environ["UNBLENT_LOCAL_USER"] = ""
out["web"] = pull("webuser")
print(json.dumps(out))
`;

const run = (bundle) => {
  const data = mkdtempSync(join(tmpdir(), "value-checks-first-"));
  const folder = mkdtempSync(join(tmpdir(), "value-checks-bundle-"));
  try {
    if (bundle) writeFileSync(join(folder, "value-checks.json"), JSON.stringify(bundle));
    return JSON.parse(
      execFileSync(`${ROOT}.venv/bin/python`, ["-c", SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, UNBLENT_DATA: data, SESSION_SECRET: "first-test-secret", UNBLENT_LOCAL_USER: LOCAL, UNBLENT_FIRST_CHECKS: folder },
      }),
    );
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
};

const EMPTY = [200, { settings: null, answers: [], cursor: 0 }];

test("a new Mac gets the bundled values settings once, naming the bundled evaluator by its id", () => {
  const out = run(BUNDLE);
  assert.equal(out.marked, true);
  assert.deepEqual(out.first, [200, { settings: { values: VALUE, examples: null, version: 1 }, answers: [], cursor: 1 }]);
  assert.deepEqual(out.again, out.first, "a second pull adds none");
  assert.deepEqual(out.other, EMPTY, "another account on the Mac gets none");
  assert.deepEqual(out.afterDisconnect, EMPTY, "given once per Mac");
  assert.deepEqual(out.web, EMPTY, "the web edition gets none");
});

test("settings that are not well formed are not given", () => {
  const out = run({ settings: { values: "not an id", examples: null } });
  assert.deepEqual(out.first, EMPTY);
});

test("without a bundle nothing is given, and the Mac is not marked", () => {
  const out = run(null);
  assert.deepEqual(out.first, EMPTY);
  assert.equal(out.marked, false);
});

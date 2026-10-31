import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The evaluators a Mac starts with (3.4): the server module in one python process of
// its own, on a throwaway data directory, with a bundle folder this test writes, as
// mac/export-checks.py would. The local edition is the variable alone, so the same
// process also tries the web edition.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LOCAL = "c".repeat(32);
const JOURNAL = "00000000000000000000000JRN";
const QUESTION = { id: "01ARZ3NDEKTSV4RRFFQ69G5QQ1", kind: "yesno", text: "Is this a goal?", yes: "", no: "", options: [] };
const BUNDLE = {
  evaluators: [
    { id: "01ARZ3NDEKTSV4RRFFQ69G5EV1", book: JOURNAL, name: "Goal Type", description: "Goals.", on: true, questions: [QUESTION], position: "V" },
    { id: "01ARZ3NDEKTSV4RRFFQ69G5EV2", book: JOURNAL, name: "Value Type", description: "", on: false, questions: [], position: null },
    { id: "not an id", book: JOURNAL, name: "Broken", on: true, questions: [] },
  ],
};

const SCRIPT = `
import json, os, shutil
from fastapi import FastAPI
from fastapi.testclient import TestClient
from server.user import DATA, SESSION_COOKIE, session_token
from components.evaluators.server.router import router

app = FastAPI()
app.include_router(router, prefix="/api/evaluators")
client = TestClient(app)

def pull(cookie=None):
    client.cookies.clear()
    if cookie:
        client.cookies.set(SESSION_COOKIE, session_token(cookie))
    r = client.get("/api/evaluators")
    return [r.status_code, r.json()]

local = os.environ["UNBLENT_LOCAL_USER"]
out = {}
out["first"] = pull()
out["marked"] = (DATA / "first-evaluators").exists()
if not out["first"][1]["evaluators"]:
    print(json.dumps(out))
    raise SystemExit
out["again"] = pull()
out["other"] = pull("someone")
gone = out["first"][1]["evaluators"][0]
client.cookies.clear()
client.put("/api/evaluators/" + gone["id"], json={**gone, "deleted": True})
out["deleted"] = pull()
# A disconnect moves the account's files to the backup (5); the Mac is not given them again.
shutil.rmtree(DATA / local)
out["afterDisconnect"] = pull()
# The web edition, even on a host that never gave them and has a bundle, gets none.
(DATA / "first-evaluators").unlink()
os.environ["UNBLENT_LOCAL_USER"] = ""
out["web"] = pull("webuser")
print(json.dumps(out))
`;

const run = (bundle) => {
  const data = mkdtempSync(join(tmpdir(), "evaluators-first-"));
  const folder = mkdtempSync(join(tmpdir(), "evaluators-bundle-"));
  try {
    if (bundle) writeFileSync(join(folder, "evaluators.json"), JSON.stringify(bundle));
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

const names = (reply) => reply[1].evaluators.map((e) => [e.name, e.deleted]);

test("a new Mac's empty list gets the bundled evaluators once, under their own ids; a deleted one does not come back", () => {
  const out = run(BUNDLE);
  assert.equal(out.first[0], 200);
  assert.equal(out.marked, true);
  const [goal, value] = out.first[1].evaluators;
  assert.deepEqual(
    { ...goal, updatedAt: null },
    { id: BUNDLE.evaluators[0].id, book: JOURNAL, name: "Goal Type", description: "Goals.", on: true, journal: false, questions: [QUESTION], version: 1, updatedAt: null, deleted: false, position: "V" },
  );
  assert.equal(value.id, BUNDLE.evaluators[1].id);
  assert.equal(value.on, false);
  assert.equal(out.first[1].evaluators.length, 2, "an entry that is not well formed is left out");
  assert.deepEqual(names(out.again), names(out.first), "a second pull adds none");
  assert.deepEqual(out.other, [200, { evaluators: [], cursor: 0 }], "another account on the Mac gets none");
  assert.deepEqual(names(out.deleted), [["Value Type", false], ["Goal Type", true]], "the delete is kept");
  assert.deepEqual(out.afterDisconnect, [200, { evaluators: [], cursor: 0 }], "given once per Mac");
  assert.deepEqual(out.web, [200, { evaluators: [], cursor: 0 }], "the web edition gets none");
});

test("without a bundle nothing is given, and the Mac is not marked, so a later version's bundle still is", () => {
  const out = run(null);
  assert.deepEqual(out.first, [200, { evaluators: [], cursor: 0 }]);
  assert.equal(out.marked, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// The server module, tested against the check's throwaway server with a forged session
// cookie (an HMAC over the user id under SESSION_SECRET). Each test has its own user,
// hence its own wheels.db (5).
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshUser = () => `wheels-test-${Date.now()}-${counter++}`;
const freshCookie = () => cookieFor(freshUser());

const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5CP2";
const DAY = "2026-10-14";

const ACTUAL = [6, null, null, null, null, null, null, null];
const WANTED = [9, 8, 7, 6, 5, 4, 3, 2];
const OTHER = [1, null, null, null, null, null, null, 10];
const EMPTY = Array(8).fill({});
const said = (answer) => [answer, {}, {}, {}, {}, {}, {}, {}];

const body = (over = {}) => ({ day: DAY, actual: ACTUAL, wanted: WANTED, baseVersion: null, deleted: false, ...over });
const put = (id, payload, cookie) =>
  fetch(`${BASE_URL}/api/wheels/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
const pull = (since, cookie) => fetch(`${BASE_URL}/api/wheels?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

test("every route needs a signed-in user", async () => {
  assert.equal((await put(ID, body())).status, 401);
  assert.equal((await pull(0)).status, 401);
});

test("a create continues from the base the browser held, and any later write wins", async () => {
  const cookie = freshCookie();
  const created = await (await put(ID, body({ baseVersion: 3 }), cookie)).json();
  assert.deepEqual(created, { id: ID, day: DAY, actual: ACTUAL, wanted: WANTED, answers: EMPTY, version: 4, deleted: false });
  const res = await put(ID, body({ actual: OTHER, baseVersion: 1 }), cookie);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).version, 5, "a stale base is never refused");
  const again = await (await put(ID, body({ actual: OTHER, baseVersion: 1 }), cookie)).json();
  assert.equal(again.version, 5, "the same content is not a new version");
});

test("a day is set when the wheel is born and never changes", async () => {
  const cookie = freshCookie();
  await put(ID, body(), cookie);
  const moved = await (await put(ID, body({ day: "2026-10-15", actual: OTHER }), cookie)).json();
  assert.deepEqual([moved.day, moved.actual], [DAY, OTHER]);
});

test("a delete is a tombstone that always wins and is pulled like a change", async () => {
  const cookie = freshCookie();
  await put(ID, body(), cookie);
  await put(ID2, body({ actual: OTHER }), cookie);
  const gone = await (await put(ID, body({ deleted: true, baseVersion: 1 }), cookie)).json();
  assert.deepEqual([gone.deleted, gone.version], [true, 2]);
  const late = await (await put(ID, body({ actual: OTHER }), cookie)).json();
  assert.deepEqual([late.deleted, late.actual, late.version], [true, ACTUAL, 2], "a write onto a tombstone returns it");
  const restored = await (await put(ID, body({ actual: OTHER, baseVersion: 2 }), cookie)).json();
  assert.deepEqual([restored.deleted, restored.actual, restored.version], [false, OTHER, 3], "a restore write names the tombstone's version (5)");
  await put(ID, body({ deleted: true, baseVersion: 3 }), cookie);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.wheels.map((w) => [w.id, w.deleted]), [[ID2, false], [ID, true]]);
  const later = await (await pull(all.cursor, cookie)).json();
  assert.deepEqual(later, { wheels: [], cursor: all.cursor });
});

test("answers are kept, count as a change, and a write without them keeps those held", async () => {
  const cookie = freshCookie();
  const created = await (await put(ID, body({ answers: said({ one: "Low", ten: "High" }) }), cookie)).json();
  assert.deepEqual([created.answers, created.version], [said({ one: "Low", ten: "High" }), 1]);
  const same = await (await put(ID, body({ answers: said({ ten: "High", one: "Low", lower: "" }) }), cookie)).json();
  assert.equal(same.version, 1, "the same answers, in any order, are no new version");
  const changed = await (await put(ID, body({ answers: said({ one: "Lower" }) }), cookie)).json();
  assert.deepEqual([changed.answers, changed.version], [said({ one: "Lower" }), 2]);
  const kept = await (await put(ID, body({ actual: OTHER }), cookie)).json();
  assert.deepEqual([kept.actual, kept.answers, kept.version], [OTHER, said({ one: "Lower" }), 3]);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.wheels[0].answers, said({ one: "Lower" }), "a pull carries them");
});

test("a tombstone keeps its answers, and a restore write brings back those it names", async () => {
  const cookie = freshCookie();
  await put(ID, body({ answers: said({ closer: "Walk" }) }), cookie);
  const gone = await (await put(ID, body({ deleted: true, baseVersion: 1 }), cookie)).json();
  assert.deepEqual([gone.deleted, gone.answers], [true, said({ closer: "Walk" })]);
  const late = await (await put(ID, body({ answers: said({ one: "Late" }) }), cookie)).json();
  assert.deepEqual(late.answers, said({ closer: "Walk" }), "a write onto a tombstone returns it");
  const back = await (await put(ID, body({ baseVersion: 2, answers: said({ closer: "Run" }) }), cookie)).json();
  assert.deepEqual([back.deleted, back.answers, back.version], [false, said({ closer: "Run" }), 3]);
});

test("a database file from before answers gains the column and keeps its wheels", async () => {
  // node:sqlite is experimental; hush the one-time warning so the run stays clean.
  const saved = process.emitWarning;
  process.emitWarning = () => {};
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const user = freshUser();
    const dir = join(process.env.UNBLENT_DATA, user);
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "wheels.db"));
    // The schema before answers, with one live wheel and one tombstone.
    db.exec(
      "CREATE TABLE wheels (id TEXT PRIMARY KEY, day TEXT NOT NULL, actual TEXT NOT NULL, wanted TEXT NOT NULL, " +
        "version INTEGER NOT NULL, seq INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);",
    );
    const insert = db.prepare("INSERT INTO wheels (id, day, actual, wanted, version, seq, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run(ID, DAY, JSON.stringify(ACTUAL), JSON.stringify(WANTED), 2, 1, 0);
    insert.run(ID2, DAY, JSON.stringify(ACTUAL), JSON.stringify(WANTED), 3, 2, 1);
    db.close();
    const cookie = cookieFor(user);
    const { wheels } = await (await pull(0, cookie)).json();
    assert.deepEqual(wheels.map((w) => [w.id, w.actual, w.wanted, w.answers, w.version, w.deleted]), [
      [ID, ACTUAL, WANTED, EMPTY, 2, false],
      [ID2, ACTUAL, WANTED, EMPTY, 3, true],
    ]);
    const written = await (await put(ID, body({ answers: said({ one: "New" }) }), cookie)).json();
    assert.deepEqual([written.actual, written.answers, written.version], [ACTUAL, said({ one: "New" }), 3]);
    const unchanged = await (await put(ID, body(), cookie)).json();
    assert.deepEqual([unchanged.answers, unchanged.version], [said({ one: "New" }), 3], "the row can now hold answers");
  } finally {
    process.emitWarning = saved;
  }
});

test("stored answers that cannot be read count as empty", async () => {
  const saved = process.emitWarning;
  process.emitWarning = () => {};
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const user = freshUser();
    const cookie = cookieFor(user);
    await put(ID, body(), cookie);
    await put(ID2, body(), cookie);
    const db = new DatabaseSync(join(process.env.UNBLENT_DATA, user, "wheels.db"));
    const update = db.prepare("UPDATE wheels SET answers = ? WHERE id = ?");
    update.run("not json", ID);
    update.run('[{"one": 5, "ten": "kept", "other": "x"}, 7]', ID2);
    db.close();
    const { wheels } = await (await pull(0, cookie)).json();
    assert.deepEqual(wheels.map((w) => w.answers), [EMPTY, said({ ten: "kept" })]);
  } finally {
    process.emitWarning = saved;
  }
});

test("a body that is not a wheel is refused with a fixed reply", async () => {
  const cookie = freshCookie();
  const seven = [1, 2, 3, 4, 5, 6, 7];
  const withScore = (score) => [score, null, null, null, null, null, null, null];
  const bads = [
    body({ day: "14 Oct" }),
    body({ actual: seven }),
    body({ wanted: [...seven, 8, 9] }),
    body({ actual: "6" }),
    body({ actual: null }),
    body({ actual: withScore(0) }),
    body({ wanted: withScore(11) }),
    body({ actual: withScore(1.5) }),
    body({ actual: withScore(true) }),
    body({ wanted: withScore("6") }),
    body({ baseVersion: true }),
    body({ deleted: "no" }),
    body({ answers: null }),
    body({ answers: "none" }),
    body({ answers: [{}, {}] }),
    body({ answers: [...EMPTY, {}] }),
    body({ answers: [null, {}, {}, {}, {}, {}, {}, {}] }),
    body({ answers: said({ other: "x" }) }),
    body({ answers: said({ one: 5 }) }),
  ];
  for (const bad of bads) {
    const res = await put(ID, bad, cookie);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.deepEqual(await res.json(), { error: "bad-request" });
  }
  assert.equal((await put("not-an-id", body(), cookie)).status, 400);
  assert.equal((await pull("x", cookie)).status, 400);
  assert.deepEqual((await (await pull(0, cookie)).json()).wheels, [], "nothing refused was kept");
});

test("users never see each other's wheels", async () => {
  const a = freshCookie();
  const b = freshCookie();
  await put(ID, body(), a);
  assert.deepEqual((await (await pull(0, b)).json()).wheels, []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// The server module, tested against the check's throwaway server with a forged session
// cookie (an HMAC over the user id under SESSION_SECRET). Each test has its own user,
// hence its own matrices.db (5).
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshUser = () => `matrices-test-${Date.now()}-${counter++}`;
const freshCookie = () => cookieFor(freshUser());

const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5CP2";
const T1 = "01ARZ3NDEKTSV4RRFFQ69G5TA1";
const T2 = "01ARZ3NDEKTSV4RRFFQ69G5TA2";
const DAY = "2026-10-14";
const CREATED = "2026-10-14T09:00:00.000Z";

const task = (over = {}) => ({ id: T1, text: "Call the bank", place: null, done: false, ...over });
const TASKS = [task({ suggested: { place: "do", sure: false } }), task({ id: T2, text: "Tidy", place: "drop", done: true })];
const OTHER = [task({ place: "schedule" })];

const body = (over = {}) => ({ day: DAY, tasks: TASKS, createdAt: CREATED, baseVersion: null, deleted: false, ...over });
const put = (id, payload, cookie) =>
  fetch(`${BASE_URL}/api/matrices/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
const pull = (since, cookie) => fetch(`${BASE_URL}/api/matrices?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

test("every route needs a signed-in user", async () => {
  assert.equal((await put(ID, body())).status, 401);
  assert.equal((await pull(0)).status, 401);
});

test("a create continues from the base the browser held, and any later write wins", async () => {
  const cookie = freshCookie();
  const created = await (await put(ID, body({ baseVersion: 3, from: "2026-10-13" }), cookie)).json();
  assert.deepEqual(created, { id: ID, day: DAY, from: "2026-10-13", tasks: TASKS, createdAt: CREATED, version: 4, deleted: false });
  const res = await put(ID, body({ tasks: OTHER, baseVersion: 1 }), cookie);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).version, 5, "a stale base is never refused");
  const again = await (await put(ID, body({ tasks: OTHER, baseVersion: 1 }), cookie)).json();
  assert.equal(again.version, 5, "the same content is not a new version");
});

test("the day, the day copied from and when it was added are set at birth and never change", async () => {
  const cookie = freshCookie();
  await put(ID, body(), cookie);
  const moved = await (await put(ID, body({ day: "2026-10-15", from: "2026-10-01", createdAt: "2026-10-15T00:00:00.000Z", tasks: OTHER }), cookie)).json();
  assert.deepEqual([moved.day, moved.from, moved.createdAt, moved.tasks], [DAY, undefined, CREATED, OTHER]);
});

test("a delete is a tombstone that always wins and is pulled like a change", async () => {
  const cookie = freshCookie();
  await put(ID, body(), cookie);
  await put(ID2, body({ day: "2026-10-13", tasks: OTHER }), cookie);
  const gone = await (await put(ID, body({ deleted: true, baseVersion: 1 }), cookie)).json();
  assert.deepEqual([gone.deleted, gone.version, gone.tasks], [true, 2, TASKS]);
  const late = await (await put(ID, body({ tasks: OTHER }), cookie)).json();
  assert.deepEqual([late.deleted, late.tasks, late.version], [true, TASKS, 2], "a write onto a tombstone returns it");
  const restored = await (await put(ID, body({ tasks: OTHER, baseVersion: 2 }), cookie)).json();
  assert.deepEqual([restored.deleted, restored.tasks, restored.version], [false, OTHER, 3], "a restore write names the tombstone's version (5)");
  await put(ID, body({ deleted: true, baseVersion: 3 }), cookie);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.matrices.map((m) => [m.id, m.deleted]), [[ID2, false], [ID, true]]);
  const later = await (await pull(all.cursor, cookie)).json();
  assert.deepEqual(later, { matrices: [], cursor: all.cursor });
});

test("stored tasks that cannot be read count as none", async () => {
  // node:sqlite is experimental; hush the one-time warning so the run stays clean.
  const saved = process.emitWarning;
  process.emitWarning = () => {};
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const user = freshUser();
    const cookie = cookieFor(user);
    await put(ID, body(), cookie);
    await put(ID2, body({ day: "2026-10-13" }), cookie);
    mkdirSync(join(process.env.UNBLENT_DATA, user), { recursive: true });
    const db = new DatabaseSync(join(process.env.UNBLENT_DATA, user, "matrices.db"));
    const update = db.prepare("UPDATE matrices SET tasks = ? WHERE id = ?");
    update.run("not json", ID);
    update.run(JSON.stringify([7, { id: T1, text: 5 }, task({ place: "soon" }), task({ id: T2 })]), ID2);
    db.close();
    const { matrices } = await (await pull(0, cookie)).json();
    assert.deepEqual(matrices.map((m) => m.tasks), [[], [task({ id: T2 })]]);
  } finally {
    process.emitWarning = saved;
  }
});

test("a body that is not a matrix is refused with a fixed reply", async () => {
  const cookie = freshCookie();
  const bads = [
    body({ day: "14 Oct" }),
    body({ from: "yesterday" }),
    body({ createdAt: "soon" }),
    body({ createdAt: 5 }),
    body({ tasks: null }),
    body({ tasks: "none" }),
    body({ tasks: [task({ id: "x" })] }),
    body({ tasks: [task({ text: 5 })] }),
    body({ tasks: [task({ place: "later" })] }),
    body({ tasks: [task({ done: "yes" })] }),
    body({ tasks: [{ id: T1, text: "No place", done: false }] }),
    body({ tasks: [task({ other: 1 })] }),
    body({ tasks: [task({ suggested: { place: "do" } })] }),
    body({ tasks: [task({ suggested: { place: "now", sure: true } })] }),
    body({ tasks: [task(), task()] }),
    body({ baseVersion: true }),
    body({ deleted: "no" }),
  ];
  for (const bad of bads) {
    const res = await put(ID, bad, cookie);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.deepEqual(await res.json(), { error: "bad-request" });
  }
  assert.equal((await put("not-an-id", body(), cookie)).status, 400);
  assert.equal((await pull("x", cookie)).status, 400);
  assert.deepEqual((await (await pull(0, cookie)).json()).matrices, [], "nothing refused was kept");
});

test("users never see each other's matrices", async () => {
  const a = freshCookie();
  const b = freshCookie();
  await put(ID, body(), a);
  assert.deepEqual((await (await pull(0, b)).json()).matrices, []);
});

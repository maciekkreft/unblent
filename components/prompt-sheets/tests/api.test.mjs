import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The server module, tested against the check's throwaway server with a forged session
// cookie (an HMAC over the user id under SESSION_SECRET). Each test has its own user,
// hence its own prompt-sheets.db (5).
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshCookie = () => cookieFor(`prompt-sheets-test-${Date.now()}-${counter++}`);

const ID = "01ARZ3NDEKTSV4RRFFQ69G5PS1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5PS2";
const SET = "01ARZ3NDEKTSV4RRFFQ69G5ST1";
const DAY = "2026-10-14";

const body = (over = {}) => ({
  day: DAY,
  setId: SET,
  setName: "Evening review",
  basedOn: "Seneca, On Anger",
  answers: [
    { prompt: "What did I do well today?", answer: "A walk", fits: true },
    { prompt: "Where did I fall short?", answer: "", fits: null },
  ],
  baseVersion: null,
  deleted: false,
  ...over,
});
const put = (id, payload, cookie) =>
  fetch(`${BASE_URL}/api/prompt-sheets/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
const pull = (since, cookie) => fetch(`${BASE_URL}/api/prompt-sheets?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

test("every route needs a signed-in user", async () => {
  assert.equal((await put(ID, body())).status, 401);
  assert.equal((await pull(0)).status, 401);
});

test("a create continues from the base the browser held, keeps fits with the answers, and any later write wins", async () => {
  const cookie = freshCookie();
  const created = await (await put(ID, body({ baseVersion: 3 }), cookie)).json();
  const { baseVersion, deleted, ...fields } = body();
  assert.deepEqual(created, { id: ID, ...fields, version: 4, deleted: false });
  const answers = [{ prompt: "What did I do well today?", answer: "A run" }];
  const res = await put(ID, body({ answers, baseVersion: 1 }), cookie);
  assert.equal(res.status, 200);
  const later = await res.json();
  assert.equal(later.version, 5, "a stale base is never refused");
  assert.deepEqual(later.answers, [{ ...answers[0], fits: null }], "fits left out reads as not judged");
  const again = await (await put(ID, body({ answers, baseVersion: 1 }), cookie)).json();
  assert.equal(again.version, 5, "the same content is not a new version");
});

test("a day is set when the sheet is born and never changes", async () => {
  const cookie = freshCookie();
  await put(ID, body(), cookie);
  const moved = await (await put(ID, body({ day: "2026-10-15", setName: "Moved" }), cookie)).json();
  assert.deepEqual([moved.day, moved.setName], [DAY, "Moved"]);
});

test("a delete is a tombstone that always wins and is pulled like a change", async () => {
  const cookie = freshCookie();
  await put(ID, body(), cookie);
  await put(ID2, body({ setName: "Other" }), cookie);
  const gone = await (await put(ID, body({ deleted: true, baseVersion: 1 }), cookie)).json();
  assert.deepEqual([gone.deleted, gone.version], [true, 2]);
  const late = await (await put(ID, body({ setName: "Revived" }), cookie)).json();
  assert.deepEqual([late.deleted, late.setName, late.version], [true, "Evening review", 2], "a write onto a tombstone returns it");
  const restored = await (await put(ID, body({ setName: "Back", baseVersion: 2 }), cookie)).json();
  assert.deepEqual([restored.deleted, restored.setName, restored.version], [false, "Back", 3], "a restore write names the tombstone's version (5)");
  await put(ID, body({ deleted: true, baseVersion: 3 }), cookie);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.sheets.map((s) => [s.id, s.deleted]), [[ID2, false], [ID, true]]);
  const later = await (await pull(all.cursor, cookie)).json();
  assert.deepEqual(later, { sheets: [], cursor: all.cursor });
});

test("a body that is not a sheet is refused with a fixed reply", async () => {
  const cookie = freshCookie();
  const bad = [
    body({ day: "14 Oct" }),
    body({ setId: "set" }),
    body({ setName: 3 }),
    body({ basedOn: null }),
    body({ answers: "A walk" }),
    body({ answers: [{ prompt: "P?" }] }),
    body({ answers: [{ prompt: "P?", answer: "A", fits: "yes" }] }),
    body({ baseVersion: true }),
    body({ deleted: "no" }),
  ];
  for (const payload of bad) {
    const res = await put(ID, payload, cookie);
    assert.equal(res.status, 400, JSON.stringify(payload));
    assert.deepEqual(await res.json(), { error: "bad-request" });
  }
  assert.equal((await put("not-an-id", body(), cookie)).status, 400);
  assert.equal((await pull("x", cookie)).status, 400);
});

test("users never see each other's sheets", async () => {
  const a = freshCookie();
  const b = freshCookie();
  await put(ID, body(), a);
  assert.deepEqual((await (await pull(0, b)).json()).sheets, []);
});

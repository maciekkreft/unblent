import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../store.js";

// The store needs IndexedDB, absent in Node (3.2), so these tests cover only the
// surface — the shape and its argument rule. Behaviour (get/put/all round-trips)
// is exercised by the notes stem page test in a browser.

test("openStore refuses a name that is not a string (11.2, one owner per fact)", () => {
  assert.throws(() => openStore(123, { notes: "id" }), TypeError);
  assert.throws(() => openStore(undefined, { notes: "id" }), TypeError);
});

test("openStore returns exactly the six store methods", () => {
  const db = openStore("store-probe", { notes: "id, updatedAt" });
  try {
    assert.deepEqual(
      Object.keys(db).sort(),
      ["all", "close", "delete", "get", "put", "transaction"],
    );
    for (const name of Object.keys(db)) assert.equal(typeof db[name], "function");
  } finally {
    db.close();
  }
});

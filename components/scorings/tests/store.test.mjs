import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../store.js";

test("the history is written and read under the component's own key", () => {
  const map = new Map();
  globalThis.localStorage = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
  const store = openStore("scorings");
  assert.equal(store.read(), null);
  store.write("[]");
  assert.equal(map.get("scorings"), "[]");
  assert.equal(store.read(), "[]");
});

test("a browser that refuses storage reads null and drops the write", () => {
  globalThis.localStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  const store = openStore("scorings");
  assert.equal(store.read(), null);
  store.write("[]");
});

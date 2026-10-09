import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../store.js";

test("the envelope is written and read under the component's own key", () => {
  const map = new Map();
  globalThis.localStorage = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
  const store = openStore("cases");
  assert.equal(store.read(), null);
  store.write('{"version":1}');
  assert.equal(map.get("cases"), '{"version":1}');
  assert.equal(store.read(), '{"version":1}');
});

test("a browser that refuses storage reads null and drops the write", () => {
  const denied = () => {
    throw new Error("denied");
  };
  globalThis.localStorage = { getItem: denied, setItem: denied };
  const store = openStore("cases");
  assert.equal(store.read(), null);
  store.write("{}");
});

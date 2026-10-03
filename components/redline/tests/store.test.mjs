import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../store.js";

// A Map standing in for the browser's localStorage.
const fake = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  return map;
};

test("a text kept under the former name is moved to redline once", () => {
  const map = fake({ review: "kept" });
  assert.equal(openStore("redline").read(), "kept");
  assert.equal(map.get("redline"), "kept");
  assert.equal(map.has("review"), false);
});

test("a text already under redline wins and the former key is left alone", () => {
  const map = fake({ redline: "new", review: "old" });
  assert.equal(openStore("redline").read(), "new");
  assert.equal(map.get("review"), "old");
});

test("nothing under either name reads as null", () => {
  fake();
  assert.equal(openStore("redline").read(), null);
});

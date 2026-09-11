import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (architecture.md 3.2), so it is tested
// directly: create it, start it, read the snapshot. token-sheet has no events
// yet, so there is nothing to send; a later actor extends this with actor.send().

// Ordered so render order differs from input order: proves grouping follows the
// component's KNOWN_GROUPS, not the order tokens arrive in.
const tokens = [
  { name: "--space-1" },
  { name: "--color-bg" },
  { name: "--wobble-x" }, // unknown family: lands in `other`
  { name: "--color-fg" },
];

function groups() {
  const actor = createActor(machine, { input: { tokens } }).start();
  return actor.getSnapshot().context.groups;
}

test("groups are ordered by KNOWN_GROUPS and empty groups omitted", () => {
  assert.deepEqual(
    groups().map((g) => g.name),
    ["color", "space", "other"],
  );
});

test("an unknown family lands in `other`", () => {
  const other = groups().find((g) => g.name === "other");
  assert.deepEqual(
    other.tokens.map((t) => t.name),
    ["--wobble-x"],
  );
});

test("tokens of one family are collected together", () => {
  const color = groups().find((g) => g.name === "color");
  assert.deepEqual(
    color.tokens.map((t) => t.name),
    ["--color-bg", "--color-fg"],
  );
});

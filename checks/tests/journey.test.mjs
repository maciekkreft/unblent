// Unit tests for the kit's journey (architecture.md 9, 11): a journey over a fake page in
// checks/tests/fixtures/journey/walk.mjs, run in a node process of its own and read
// through the check's durations reporter, so no browser is needed. Run standalone
// (`node --test checks/tests/journey.test.mjs`) or through the full check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function walk(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "unblent-journey-"));
  const out = join(dir, "rows.jsonl");
  try {
    const run = spawnSync(process.execPath, [
      "--test", "--experimental-test-isolation=none",
      "--test-reporter=./checks/durations.mjs", `--test-reporter-destination=${out}`,
      "--test-reporter=tap", "--test-reporter-destination=stdout",
      "checks/tests/fixtures/journey/walk.mjs",
    ], { cwd: ROOT, env: { ...process.env, NODE_TEST_CONTEXT: "", UNBLENT_ISOLATE: "", FAULT: "", ...env }, encoding: "utf8" });
    const rows = readFileSync(out, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.name);
    return { rows, stdout: run.stdout, status: run.status, by: (name) => rows.find((row) => row.name === name) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a journey runs its steps in order in one visit, and its row counts them", () => {
  const { rows, stdout, status } = walk();
  assert.equal(status, 0, stdout);
  assert.deepEqual(rows.map((row) => [row.name, row.failed]), [
    ["j moves down", false], ["a row far away", false], ["k from row 3", false], ["a letter typed nothing", false], ["a walk", false],
  ]);
  assert.equal(rows.at(-1).steps, 4);
  // The steps are declared in the kit, but reported under the journey's own file.
  assert.ok(rows.every((row) => row.file.endsWith("fixtures/journey/walk.mjs")), JSON.stringify(rows.map((row) => row.file)));
  assert.equal(rows[0].steps, undefined);
  assert.match(stdout, /OPENS 1\b/);
  assert.doesNotMatch(stdout, /OPENS 2/);
});

test("a step that finds the page in the wrong state names the step before it", () => {
  const { stdout, status, by } = walk({ FAULT: "a row far away" });
  assert.notEqual(status, 0);
  assert.equal(by("a row far away").failed, false);
  assert.equal(by("k from row 3").failed, true);
  assert.match(stdout, /expected at its start the keyboard on row 3, but the keyboard is on row 7: the step before it, \\?"a row far away\\?", left the page in another state/);
  // The rest are skipped, not run on a page already wrong.
  assert.match(stdout, /a letter typed nothing # SKIP/);
});

test("a failed step lists what the user saw at every step", () => {
  const { stdout, by } = walk({ FAULT: "j moves down" });
  assert.equal(by("j moves down").failed, true);
  assert.match(stdout, /step \\?"j moves down\\?": the keyboard is on row 1/);
  assert.match(stdout, /what the user saw, step by step:/);
  assert.match(stdout, /\{\\?"step\\?":\\?"j moves down\\?",\\?"row\\?":1\}/);
});

test("isolated, each step that declares its start runs alone in a fresh visit, the others are skipped", () => {
  const { stdout, status, by } = walk({ UNBLENT_ISOLATE: "1", FAULT: "a row far away" });
  assert.equal(status, 0, stdout);
  assert.equal(by("k from row 3").failed, false);
  assert.match(stdout, /j moves down # SKIP continues from the step before it/);
  assert.match(stdout, /a letter typed nothing # SKIP/);
  assert.match(stdout, /OPENS 1\b/);
  assert.doesNotMatch(stdout, /OPENS 2/);
});

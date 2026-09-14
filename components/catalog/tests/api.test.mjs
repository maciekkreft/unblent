import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The server module is the far end of the same component (section 3), so it is
// tested from here against the live check server; UNBLENT_URL is set by check.py.
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const COMPONENTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const byName = (list) => Object.fromEntries(list.map((c) => [c.name, c]));

test("GET /api/catalog lists every component from its manifest", async () => {
  const res = await fetch(`${BASE_URL}/api/catalog`);
  assert.equal(res.status, 200);
  const { components } = await res.json();
  const dirs = readdirSync(COMPONENTS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(components.map((c) => c.name), dirs);

  const c = byName(components);
  assert.equal(c.catalog.status, "built");
  assert.equal(c.catalog.kind, "fact");
  assert.equal(c.catalog.shape, "remote-only");
  assert.deepEqual(c.catalog.answers, ["list", "contracts"]);
  assert.equal(c.catalog.attributes, null);

  assert.deepEqual(c["color-scheme"].emits, ["color-scheme.changed"]);
  assert.deepEqual(c["color-scheme"].accepts, []);
  assert.deepEqual(c["color-scheme"].interacts, [
    { with: "token-sheet", via: "color-scheme.changed", how: "emits" },
  ]);
  assert.deepEqual(c["token-sheet"].interacts, [
    { with: "color-scheme", via: "color-scheme.changed", how: "consumes" },
  ]);
  assert.equal(c["token-sheet"].shape, null);
});

test("GET /api/catalog/contracts pivots the schema files into the vocabulary", async () => {
  const res = await fetch(`${BASE_URL}/api/catalog/contracts`);
  assert.equal(res.status, 200);
  const { events, queries, commands } = await res.json();

  const scheme = events.find((e) => e.name === "color-scheme.changed");
  assert.ok(scheme, "the one event is listed");
  assert.equal(scheme.owner, "color-scheme");
  assert.deepEqual(scheme.consumers, ["token-sheet"]);
  assert.equal(scheme.schema.$schema, "https://json-schema.org/draft/2020-12/schema");

  const byKey = Object.fromEntries(queries.map((q) => [`${q.target}: ${q.name}`, q]));
  assert.deepEqual(byKey["catalog: list"].askers, ["component-list"]);
  assert.deepEqual(byKey["pages: list"].askers, ["page-nav", "settings-sheet"]);
  assert.ok("payload" in byKey["catalog: contracts"] && "reply" in byKey["catalog: contracts"]);
  assert.deepEqual(byKey["catalog: contracts"].askers, ["contract-list"]);

  const cmd = Object.fromEntries(commands.map((c) => [`${c.target}: ${c.name}`, c]));
  assert.ok("payload" in cmd["note-editor: focus"]);
  assert.ok("payload" in cmd["note-editor: load"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The server module is the far end of the same component (section 3), so it is
// tested from here against the live check server; UNBLENT_URL is set by check.py.
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PAGES = resolve(REPO, "pages", "workshop");
const INDEX = resolve(REPO, "pages", "index.html");
const TRY = resolve(REPO, "pages", "try");

// The six page kinds in the order of architecture.md 8.
const KINDS = ["tokens", "contracts", "components", "stem", "app", "try"];

// The expected list comes from the filesystem, so adding a page never breaks it.
function expected() {
  const rows = [];
  // The product at / (its URL is the root, not its directory), then the workshop pages.
  const index = readFileSync(INDEX, "utf-8");
  rows.push({
    path: "/",
    title: index.match(/<title>([^<]*)<\/title>/)?.[1].trim() || "index",
    kind: index.match(/<meta name="kind" content="([^"]*)"/)?.[1],
  });
  for (const dir of readdirSync(PAGES, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const file of readdirSync(resolve(PAGES, dir.name)).filter((f) => f.endsWith(".html"))) {
      const stem = file.replace(/\.html$/, "");
      const html = readFileSync(resolve(PAGES, dir.name, file), "utf-8");
      const title = html.match(/<title>([^<]*)<\/title>/)?.[1].trim() || stem;
      const kind = html.match(/<meta name="kind" content="([^"]*)"/)?.[1];
      rows.push({ path: `/workshop/${dir.name}/${stem}`, title, kind });
    }
  }
  // The try pages, served at /try/<name> (8, 11.1).
  for (const file of readdirSync(TRY).filter((f) => f.endsWith(".html"))) {
    const stem = file.replace(/\.html$/, "");
    const html = readFileSync(resolve(TRY, file), "utf-8");
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1].trim() || stem;
    const kind = html.match(/<meta name="kind" content="([^"]*)"/)?.[1];
    rows.push({ path: `/try/${stem}`, title, kind });
  }
  const rank = (k) => (KINDS.includes(k) ? KINDS.indexOf(k) : KINDS.length);
  return rows.sort((a, b) => rank(a.kind) - rank(b.kind) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

test("GET /api/pages lists every page with its title and kind", async () => {
  const res = await fetch(`${BASE_URL}/api/pages`);
  assert.equal(res.status, 200);
  const { pages } = await res.json();
  assert.deepEqual(pages, expected());
});

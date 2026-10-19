import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const SAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.epub");
const BOOK = "01K00000000000000000000RBK";

const put = async (cookie, path, type, body) => {
  const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
  assert.equal(res.status, 200, `PUT ${path}`);
};
const openOnServer = async (cookie) =>
  (await (await fetch(`${BASE_URL}/api/books?since=0`, { headers: { Cookie: `unblent_session=${cookie}` } })).json()).open?.id ?? null;

for (const engine of ENGINES.slice(0, 1)) {
  // A reload against real storage: the page reloads while the open book's write is still
  // on its way, and the write must neither fail in the browser nor be lost.
  test(`a reload right after opening a book loses nothing and reports no failure in ${engine.name}`, async () => {
    const cookie = forgeCookie("books-reload");
    await put(cookie, `/api/books/${BOOK}`, "application/epub+zip", readFileSync(SAMPLE));
    const browser = await engine.launch();
    try {
      const context = await browser.newContext();
      try {
        await signedIn(context, cookie);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/books`);
        const tile = page.locator("book-shelf").getByText("Sample Book", { exact: true }).first();
        await tile.waitFor();
        await tile.click();
        await page.reload();
        await page.waitForFunction(() => document.querySelector("book-reader")?.shadowRoot?.querySelector(".footer .chap")?.textContent.trim());
        await until(async () => (await openOnServer(cookie)) === BOOK);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
}

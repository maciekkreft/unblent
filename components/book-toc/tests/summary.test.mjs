import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The product page holds the journal, so `books` presents it there and the Books panel
// shows its contents. Until `generators` is on that page, its fact is added to the page
// this test loads; once it is, the page is served as it is.
const PAGE = `${BASE_URL}/`;
const GENERATORS = '<script type="module" src="/static/components/generators/fact.js"></script>';

const DAY_ID = "01K00000000000000000000DAY";
const SUMMARY = "A long walk by the river and a choice point about calling Mum.";

// A day three days back on this machine's clock: closed, so the journal shows it read
// only and today's empty page after it.
const pastDay = () => {
  const d = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const put = async (cookie, path, body) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", Cookie: `unblent_session=${cookie}` },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `PUT ${path}`);
};

// The contents rows as the user sees them: each row's title, whether it is marked, and
// the summary shown under it, if any.
const rows = (page) =>
  page.evaluate(() =>
    [...(document.querySelector("book-toc")?.shadowRoot?.querySelectorAll("li") ?? [])].map((li) => ({
      current: li.querySelector(".entry").classList.contains("current"),
      summary: li.querySelector(".summary")?.textContent.trim() ?? null,
    })),
  );

for (const engine of ENGINES) {
  // Browser: rendering and layout.
  test(`the journal's marked day shows its summary under its row in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    try {
      const problems = [];
      const cookie = forgeCookie("toc-summary");
      const day = pastDay();
      await put(cookie, "/api/journal/days", { record: { id: DAY_ID, day, text: "Walked by the river.", editedAt: Date.now() - 3 * 24 * 3600 * 1000 } });
      await put(cookie, `/api/generators/results/journal-summary:${day}`, { generator: "journal-summary", item: day, text: SUMMARY, source: "a".repeat(64) });
      await signedIn(context, cookie);
      const page = await context.newPage();
      watch(page, problems);
      await page.route(PAGE, async (route) => {
        const res = await route.fetch();
        const body = await res.text();
        await route.fulfill({ response: res, body: body.includes(GENERATORS) ? body : body.replace("</head>", `${GENERATORS}</head>`) });
      });
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-shelf")?.shadowRoot);
      const journal = page.locator("book-shelf").getByText("Journal", { exact: true }).first();
      await journal.waitFor();
      await journal.click();
      // Today's page is marked first and has no summary.
      await until(async () => (await rows(page)).length === 2);
      assert.deepEqual(await rows(page), [{ current: true, summary: null }, { current: false, summary: null }]);
      // Picking the past day marks it and shows its summary under it.
      await page.evaluate(() => document.querySelector("book-toc").shadowRoot.querySelectorAll(".entry")[1].click());
      await until(async () => (await rows(page))[1].summary === SUMMARY);
      assert.deepEqual(await rows(page), [{ current: false, summary: null }, { current: true, summary: SUMMARY }]);
      // The summary sits under its row, inside the contents' width.
      const box = await page.evaluate(() => {
        const r = document.querySelector("book-toc").shadowRoot;
        const entry = r.querySelectorAll(".entry")[1].getBoundingClientRect();
        const summary = r.querySelector(".summary").getBoundingClientRect();
        return { below: summary.top >= entry.bottom - 1, inside: summary.right <= entry.right + 1 && summary.height > 0 };
      });
      assert.deepEqual(box, { below: true, inside: true });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}

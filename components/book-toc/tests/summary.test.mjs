import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The product page holds the journal, so `books` presents it there and the Books panel
// shows its contents; `generators` is on that page too.
const PAGE = `${BASE_URL}/`;

const DAYS = [
  { id: "01K00000000000000000000DA3", back: 3, summary: "A long walk by the river and a choice point about calling Mum." },
  { id: "01K00000000000000000000DA5", back: 5, summary: "Planning the week and a hard talk at work." },
];

// A day some days back on this machine's clock: closed, so the journal shows it read
// only and today's empty page after it.
const pastDay = (back) => {
  const d = new Date(Date.now() - back * 24 * 3600 * 1000);
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
  test(`every journal day with a summary shows it under its row in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    try {
      const problems = [];
      const cookie = forgeCookie("toc-summary");
      for (const { id, back, summary } of DAYS) {
        const day = pastDay(back);
        await put(cookie, "/api/journal/days", { record: { id, day, text: "Walked by the river.", editedAt: Date.now() - back * 24 * 3600 * 1000 } });
        await put(cookie, `/api/generators/results/journal-summary:${day}`, { generator: "journal-summary", item: day, text: summary, source: "a".repeat(64) });
      }
      await signedIn(context, cookie);
      const page = await context.newPage();
      watch(page, problems);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-shelf")?.shadowRoot);
      const journal = page.locator("book-shelf").getByText("Journal", { exact: true }).first();
      await journal.waitFor();
      await journal.click();
      // Today's page is marked and has no summary; both past days show theirs unpicked.
      const [a, b] = DAYS.map((d) => d.summary);
      await until(async () => (await rows(page)).length === 3 && (await rows(page))[2].summary === b);
      assert.deepEqual(await rows(page), [
        { current: true, summary: null },
        { current: false, summary: a },
        { current: false, summary: b },
      ]);
      // Picking a day moves the mark and leaves every summary where it was.
      await page.evaluate(() => document.querySelector("book-toc").shadowRoot.querySelectorAll(".entry")[1].click());
      await until(async () => (await rows(page))[1].current);
      assert.deepEqual(await rows(page), [
        { current: false, summary: null },
        { current: true, summary: a },
        { current: false, summary: b },
      ]);
      // Each summary sits under its own row, inside the row's width, and the row's button
      // names it as its description.
      const boxes = await page.evaluate(() => {
        const r = document.querySelector("book-toc").shadowRoot;
        return [...r.querySelectorAll("li")].slice(1).map((li) => {
          const entry = li.querySelector(".entry");
          const summary = li.querySelector(".summary");
          const e = entry.getBoundingClientRect();
          const s = summary.getBoundingClientRect();
          return {
            below: s.top >= e.bottom - 1,
            inside: s.left >= e.left - 1 && s.right <= e.right + 1 && s.height > 0,
            described: r.getElementById(entry.getAttribute("aria-describedby")) === summary,
          };
        });
      });
      assert.deepEqual(boxes, [
        { below: true, inside: true, described: true },
        { below: true, inside: true, described: true },
      ]);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}

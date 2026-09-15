import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const SCREENSHOTS = resolve(REPO, ".screenshots");

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// The rows the trace-list table renders, one string per row, read from the
// shadow root so the assertion sees what the user sees.
const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelector("trace-list").shadowRoot.querySelectorAll("tbody tr.row")].map(
      (tr) => tr.textContent,
    ),
  );

const shadowHas = (page, sel) =>
  page.evaluate((sel) => Boolean(document.querySelector("trace-list").shadowRoot.querySelector(sel)), sel);
const shadowText = (page, sel) =>
  page.evaluate((sel) => document.querySelector("trace-list").shadowRoot.querySelector(sel)?.textContent.trim(), sel);
const clickClear = (page) =>
  page.evaluate(() => document.querySelector("trace-list").shadowRoot.querySelector(".clear").click());
// The table's scroll container: it fits when it cannot scroll sideways. 1px of
// slack: Chromium rounds a track up by a sub-pixel where WebKit lands exactly.
const overflow = (page) =>
  page.evaluate(() => {
    const s = document.querySelector("trace-list").shadowRoot.querySelector(".scroll");
    return { scrollWidth: s.scrollWidth, clientWidth: s.clientWidth };
  });

// A row for page-nav's pages: list query: kind query, name list, pages reached.
const isPagesList = (text) => text.includes("query") && text.includes("list") && text.includes("pages");

// The viewport switch lives on the stem; tests may not import across components,
// so the helper is copied from components/viewport/tests/page.test.mjs.
const clickSwitch = (page, label) =>
  page.evaluate((label) => {
    for (const b of document.querySelector("viewport-switch").shadowRoot.querySelectorAll("button")) {
      if (b.textContent.trim() === label) b.click();
    }
  }, label);

// WebKit first, then Chromium: a Safari-class engine is the stricter check. The
// stem page composes trace-list, which shows the page's own bus traffic (section
// 10); the one other view on it is page-nav, so its pages: list query must appear.
for (const engine of ENGINES) {
  test(`the trace page shows its own bus traffic in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const page = await browser.newPage();
    const problems = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
    });
    page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
    page.on("requestfailed", (req) =>
      problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`),
    );
    page.on("response", (res) => {
      if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
    });

    try {
      await page.goto(`${BASE_URL}/design/trace`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        [...document.querySelector("trace-list").shadowRoot.querySelectorAll("tbody tr.row")].some(
          (tr) => {
            const t = tr.textContent;
            return t.includes("query") && t.includes("list") && t.includes("pages");
          },
        ),
      );
      assert.ok((await rows(page)).some(isPagesList), "a pages: list row is shown");

      // Every row's seq is prefixed with # (the compact layout hides the header,
      // so the # must live in the cell); at rest the page's traffic is all queries
      // and replies, so the gesture/fact split is checked after the switch below.
      assert.ok((await rows(page)).every((t) => /#\d+/.test(t)), "each row's seq is prefixed with #");

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: resolve(SCREENSHOTS, `trace-list-${engine.name}.png`),
        fullPage: true,
      });

      // No heading: the card opens with the count and Clear. Clear empties the
      // display only (UI state, 3.1); the next bus traffic shows up again.
      assert.equal(await shadowHas(page, "h2"), false, "no heading above the table");
      assert.match(await shadowText(page, ".count"), /^\d+ records$/);
      await clickClear(page);
      await page.waitForFunction(
        () => document.querySelector("trace-list").shadowRoot.querySelectorAll("tbody tr.row").length === 0,
      );
      assert.equal(await shadowText(page, ".count"), "0 records");
      assert.ok(await shadowHas(page, ".empty"), "the empty state shows after Clear");

      // At a desk width between the stacked layout and the full table, the table
      // must still fit its container: nothing may push it into sideways scrolling.
      await page.setViewportSize({ width: 900, height: 800 });

      // In the phone preview the container query stacks each record, so the table
      // must fit the narrowed body: no horizontal overflow and no header row.
      await clickSwitch(page, "Phone");
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      await page.waitForFunction(
        () => document.querySelector("trace-list").shadowRoot.querySelectorAll("tbody tr.row").length > 0,
      );
      assert.ok((await rows(page)).length > 0, "traffic after Clear is shown again");

      const fit = await page.evaluate(() => {
        const root = document.querySelector("trace-list").shadowRoot;
        const scroll = root.querySelector(".scroll");
        const thead = root.querySelector("thead");
        return {
          // 1px of slack: Chromium rounds grid tracks up by a sub-pixel where
          // WebKit lands exactly, and a clipped column would overflow by a word.
          overflows: scroll.scrollWidth > scroll.clientWidth + 1,
          headerShown: getComputedStyle(thead).display !== "none",
        };
      });
      assert.ok(!fit.overflows, "the stacked records fit the phone width");
      assert.ok(!fit.headerShown, "the table header is hidden when stacked");
      const afterSwitch = await rows(page);
      assert.ok(
        afterSwitch.some((t) => t.includes("viewport.selected")),
        "the switch's own viewport.selected row reads on the phone",
      );
      // The switch is a view, so viewport.selected reads "gesture"; viewport is a
      // fact, so viewport.changed reads "fact" (4.3, fifth rule; fromKind). Neither
      // reads the bare "event".
      assert.ok(
        afterSwitch.some((t) => t.includes("viewport.selected") && t.includes("gesture")),
        "the view's event reads gesture",
      );
      assert.ok(
        afterSwitch.some((t) => t.includes("viewport.changed") && t.includes("fact")),
        "the fact's event reads fact",
      );
      await page.screenshot({ path: resolve(SCREENSHOTS, `trace-list-phone-${engine.name}.png`) });

      // Restore the desk so the stored choice does not leak into other tests, and
      // check the full table fits at the mid width too.
      await clickSwitch(page, "Desk");
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "desk");
      await page.waitForFunction(
        () => document.querySelector("trace-list").shadowRoot.querySelector("thead") !== null,
      );
      const desk = await overflow(page);
      assert.ok(desk.scrollWidth <= desk.clientWidth + 1, `the table fits a 900px desk, saw ${JSON.stringify(desk)}`);

      // A burst folds into one run row (task 2). Three quick viewport switches land
      // within the run gap, so their viewport.selected records read as one ×n line,
      // expandable to its member rows.
      await clickSwitch(page, "Phone");
      await clickSwitch(page, "Desk");
      await clickSwitch(page, "Phone");
      const runOf = () =>
        page.evaluate(() => {
          const root = document.querySelector("trace-list").shadowRoot;
          const tr = [...root.querySelectorAll("tbody tr.row.run")].find((r) =>
            r.textContent.includes("viewport.selected"),
          );
          if (!tr) return null;
          const m = tr.textContent.match(/×(\d+)/);
          return m ? Number(m[1]) : null;
        });
      await page.waitForFunction(() => {
        const root = document.querySelector("trace-list").shadowRoot;
        const tr = [...root.querySelectorAll("tbody tr.row.run")].find((r) => r.textContent.includes("viewport.selected"));
        return tr && Number((tr.textContent.match(/×(\d+)/) || [])[1]) >= 3;
      });
      const runCount = await runOf();
      assert.ok(runCount >= 3, `the switches fold into one run, saw ×${runCount}`);

      // Expanding the run shows its member rows, each carrying its own seq.
      await page.evaluate(() => {
        const root = document.querySelector("trace-list").shadowRoot;
        [...root.querySelectorAll("tbody tr.row.run")]
          .find((r) => r.textContent.includes("viewport.selected"))
          .click();
      });
      await page.waitForFunction(
        () => document.querySelector("trace-list").shadowRoot.querySelectorAll("tbody tr.row.member").length >= 3,
      );
      const members = await page.evaluate(() =>
        [...document.querySelector("trace-list").shadowRoot.querySelectorAll("tbody tr.row.member")].map((tr) => tr.textContent),
      );
      assert.ok(members.every((t) => /#\d+/.test(t)), "each member row carries its seq");
      assert.ok(
        members.filter((t) => t.includes("viewport.selected")).length >= 3,
        "the run's members are the switch's own events",
      );

      // Restore the desk so the stored choice does not leak into other tests.
      await clickSwitch(page, "Desk");
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "desk");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}

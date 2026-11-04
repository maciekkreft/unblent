import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The Slip-Box is not released until the admin releases it (3.1), so the account's
// picture of the features is answered by the route: every feature released and shown.
const showAll = (context) =>
  context.route(/\/api\/flags$/, (route) => route.fulfill({ json: { off: [], hidden: [], released: ["choice-points", "slip-box"], shown: ["choice-points", "slip-box"] } }));

const tiles = (page) =>
  page.evaluate(() =>
    [...(document.querySelector("book-shelf")?.shadowRoot?.querySelectorAll(".tile:not(.adding)") ?? [])].map((t) => ({
      title: t.querySelector(".title").textContent.trim(),
      tools: Boolean(t.querySelector(".actions")),
    })),
  );

const stageTabs = (page) =>
  page.evaluate(() =>
    [...(document.querySelector("dock-desk")?.shadowRoot?.querySelectorAll(".stage .own [role=tab]") ?? [])].map(
      (t) => `${t.textContent.trim()}${t.getAttribute("aria-selected") === "true" ? "*" : ""}`,
    ),
  );

// The tiles marked as selected, which is what draws the frame.
const framed = (page) =>
  page.evaluate(() =>
    [...document.querySelector("book-shelf").shadowRoot.querySelectorAll('.tile[aria-selected="true"]')].map((t) => t.querySelector(".title").textContent.trim()),
  );

const hint = (page) =>
  page.evaluate(() => document.querySelector("note-editor[stage]")?.shadowRoot?.querySelector(".cm-placeholder")?.textContent ?? null);

const JOURNAL = "00000000000000000000000JRN";
const SLIP_BOX = "00000000000000000000000SBX";

const openShelf = async (page) => {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await until(async () => {
    const titles = (await tiles(page)).map((t) => t.title);
    return titles.includes("Journal") && titles.includes("Slip-Box");
  });
};

const open = (page, title) =>
  page.evaluate(
    (title) => [...document.querySelector("book-shelf").shadowRoot.querySelectorAll(".tile")].find((t) => t.querySelector(".title")?.textContent.trim() === title).click(),
    title,
  );

const isFramed = (page, title) => until(async () => (await framed(page)).join() === title);

for (const engine of ENGINES) {
  // Browser: a page's composition (the shelf's tile opens a tab on the stage, whose editor
  // shows the hint, and the frame follows the tab in front).
  test(`the Slip-Box tile comes after the Journal and opens a framed Slip-Box tab in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(4000);
    try {
      await signedIn(context, forgeCookie("shelf-slipbox"));
      await showAll(context);
      const page = await context.newPage();
      const problems = watch(page);
      await openShelf(page);
      const [journal, slipBox] = await tiles(page);
      assert.deepEqual([journal.title, slipBox], ["Journal", { title: "Slip-Box", tools: false }]);

      await open(page, "Journal");
      await isFramed(page, "Journal");
      await open(page, "Slip-Box");
      await until(async () => (await stageTabs(page)).includes("Slip-Box*"));
      await until(async () => (await hint(page)) === "Write how your Slip-Box is arranged. The notes under it are beside.");
      await isFramed(page, "Slip-Box");

      await page.locator("dock-desk .stage .own [role=tab]", { hasText: "Journal" }).click();
      await isFramed(page, "Journal");
      await open(page, "Slip-Box");
      await isFramed(page, "Slip-Box");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  // Browser: a page's composition over real storage. The tabs are stored before the only
  // page load, because two page loads do not fit a test's budget in Chromium (11); that the
  // stage stores them is tested in Node. The Slip-Box tab comes back before it has any text
  // and in its place, the open book comes to the front, and the frame goes with it.
  test(`a stored Slip-Box tab comes back in its place in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(4000);
    try {
      await signedIn(context, forgeCookie("shelf-slipbox-stored"));
      await showAll(context);
      const opened = await context.request.put(`${BASE_URL}/api/books/${JOURNAL}/opened`);
      assert.ok(opened.ok(), "the journal is the account's open book");
      await context.addInitScript(
        ([journal, slipBox]) => {
          localStorage.setItem("book-stage.tabs", JSON.stringify([journal, slipBox]));
          localStorage.setItem("book-stage.tabs.notes", JSON.stringify([slipBox]));
        },
        [JOURNAL, SLIP_BOX],
      );
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await until(async () => (await stageTabs(page)).join() === "Journal*,Slip-Box");
      await isFramed(page, "Journal");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}

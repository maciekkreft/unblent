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

const hint = (page) =>
  page.evaluate(() => document.querySelector("note-editor[stage]")?.shadowRoot?.querySelector(".cm-placeholder")?.textContent ?? null);

for (const engine of ENGINES) {
  // Browser: a page's composition (the shelf's tile opens a tab on the stage, whose editor
  // shows the hint) and a reload against real storage (the tab is kept before any text).
  test(`the Slip-Box tile comes after the Journal and opens a Slip-Box tab that survives a reload in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(4000);
    try {
      await signedIn(context, forgeCookie("shelf-slipbox"));
      await showAll(context);
      const page = await context.newPage();
      // A reload cuts the first page's pulls short, which WebKit reports as "access control
      // checks" or a cancelled load; nothing is lost, since a pull runs again at load (5).
      const problems = watch(page, [], { ignore: [/due to access control checks|Load request cancelled/] });
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await until(async () => {
        const titles = (await tiles(page)).map((t) => t.title);
        return titles.includes("Journal") && titles.includes("Slip-Box");
      });
      const [journal, slipBox] = await tiles(page);
      assert.deepEqual([journal.title, slipBox], ["Journal", { title: "Slip-Box", tools: false }]);

      await page.evaluate(() =>
        [...document.querySelector("book-shelf").shadowRoot.querySelectorAll(".tile")].find((t) => t.querySelector(".title")?.textContent.trim() === "Slip-Box").click(),
      );
      await until(async () => (await stageTabs(page)).includes("Slip-Box*"));
      await until(async () => (await hint(page)) === "Write how your Slip-Box is arranged. The notes under it are beside.");

      await page.reload({ waitUntil: "domcontentloaded" });
      await until(async () => (await stageTabs(page)).includes("Slip-Box"));
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}

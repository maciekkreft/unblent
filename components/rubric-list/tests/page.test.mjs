import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Tools list on the Judge app page, walked as a user would. Tools are kept on this
// device, so a reload shows what was stored.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/apps/judge`;

// The list as the user reads it: each tool's name, the line under it, and its tick.
const tools = (page) =>
  page.evaluate(() =>
    [...document.querySelector("rubric-list").shadowRoot.querySelectorAll(".row[data-id]")].map((r) => ({
      name: r.querySelector(".name").textContent.trim(),
      sub: r.querySelector(".sub").textContent.trim(),
      ticked: r.querySelector('input[type="checkbox"]').checked,
    })),
  );

async function open(page) {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await until(async () => (await tools(page).catch(() => [])).length > 0);
}

for (const engine of ENGINES) {
  describe(`the Tools list in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    test("the example tools show their ticks, and a tick is kept after a reload", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await open(page);
        assert.deepEqual(await tools(page), [
          { name: "Goal or value", sub: "1 question", ticked: true },
          { name: "Goal or value (yes / no)", sub: "2 questions · off", ticked: false },
        ]);
        assert.equal(await page.locator("rubric-list .hint").textContent(), "Only detectors with a tick are used when judging.");

        await page.getByRole("checkbox", { name: "Use Goal or value (yes / no) when judging" }).check();
        await until(async () => (await tools(page))[1].sub === "2 questions");
        await page.waitForTimeout(120);
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await tools(page).catch(() => [])).length === 2);
        assert.deepEqual((await tools(page)).map((t) => t.ticked), [true, true]);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    test("switching to Replies shows its six tools with only Replyability ticked", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await open(page);
        await page.locator("project-bar button.open").click();
        await page.locator('project-bar [role="menuitemradio"]', { hasText: "Replies" }).click();
        await until(async () => (await tools(page)).length === 6);
        const list = await tools(page);
        assert.deepEqual(list.filter((t) => t.ticked).map((t) => t.name), ["Replyability"]);
        assert.ok(list.filter((t) => !t.ticked).every((t) => t.sub.endsWith("· off")));
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

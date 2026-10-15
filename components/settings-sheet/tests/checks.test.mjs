import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// A file of its own because the 5s budget (11) is per file, and its two loads of the
// product page leave no room beside the other settings tests.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

for (const engine of ENGINES) {
  describe(`Choice point checks in ${engine.name}`, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    // The choice point checks on the product page: folded until asked for, a box given an
    // evaluator and an expected answer, and the choice still there after a reload. The
    // evaluator is made through the evaluators API under the test's own login.
    test("the choice point checks fold open, and a box's evaluator and expected answer are kept", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("checks"));
        const id = (tail) => "01J" + "0".repeat(23 - tail.length) + tail;
        const evaluator = id("E1");
        const options = ["Behavioral Goal", "Emotional Goal"].map((name, i) => ({ id: id(`A${i}`), name, description: "" }));
        const put = await context.request.put(`${BASE_URL}/api/evaluators/${evaluator}`, {
          data: {
            book: id("B1"),
            name: "Therapy Goal",
            on: true,
            baseVersion: null,
            questions: [{ id: id("Q1"), kind: "pick", text: "Which kind of goal is it?", yes: "", no: "", options }],
          },
        });
        assert.equal(put.status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        const sheet = page.locator("settings-sheet");
        const towards = sheet.locator('.box[data-field="towards"]');
        const open = async () => {
          await page.locator("dock-desk .controls .pill").click();
          await sheet.locator("summary", { hasText: "Choose what Jev checks" }).click();
        };
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await sheet.locator(".checks details.keys-fold").waitFor({ state: "attached" });
        await page.locator("dock-desk .controls .pill").click();
        assert.equal(await towards.isVisible(), false, "the boxes are folded away at first");
        await sheet.locator("summary", { hasText: "Choose what Jev checks" }).click();
        await towards.locator('select[aria-label="Evaluator for Towards · unhooked"]').selectOption(evaluator);
        await towards.locator('select[aria-label="Answer expected for question 1"]').selectOption(options[0].id);

        await page.reload({ waitUntil: "domcontentloaded" });
        await open();
        await until(async () => (await towards.locator('select[aria-label="Answer expected for question 1"]').count()) === 1);
        assert.equal(await towards.locator('select[aria-label="Evaluator for Towards · unhooked"]').inputValue(), evaluator);
        assert.equal(await towards.locator('select[aria-label="Answer expected for question 1"]').inputValue(), options[0].id);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

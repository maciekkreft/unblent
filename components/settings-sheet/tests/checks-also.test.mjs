import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// A file of its own because the 5s budget (11) is per file, and its load of the product
// page leaves little room beside the other settings tests.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

for (const engine of ENGINES) {
  describe(`Also check with in ${engine.name}`, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    // Also check with: offered only under a box that has an evaluator, listing the other
    // evaluators with Your values among them; choosing Your values shows no question
    // settings for it, and None takes it away. That the choice is kept and asked is decided
    // in the two machines' Node tests (9).
    // Browser: a gesture.
    test("Also check with offers Your values under a checked box, and None takes it away", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("also"));
        const id = (tail) => "01J" + "0".repeat(23 - tail.length) + tail;
        const evaluator = id("E1");
        const question = id("Q1");
        const [made, stored] = await Promise.all([
          context.request.put(`${BASE_URL}/api/evaluators/${evaluator}`, {
            data: {
              book: id("B1"),
              name: "Therapy Goal",
              on: true,
              baseVersion: null,
              questions: [{ id: question, kind: "yesno", text: "Is it a behavior?", yes: "", no: "", options: [] }],
            },
          }),
          context.request.put(`${BASE_URL}/api/choice-point-checks/boxes/towards`, {
            data: { evaluator, questions: [{ id: question, show: true, expect: null, when: null, icons: {} }], baseVersion: null },
          }),
        ]);
        assert.deepEqual([made.status(), stored.status()], [200, 200]);
        const page = await context.newPage();
        const problems = watch(page);
        const sheet = page.locator("settings-sheet");
        const towards = sheet.locator('.box[data-field="towards"]');
        const also = towards.locator('select[aria-label="Also check Towards · unhooked with"]');
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await sheet.locator(".checks details.keys-fold").waitFor({ state: "attached" });
        await page.locator("dock-desk .controls .pill").click();
        await sheet.locator("summary", { hasText: "Choose what Jev checks" }).click();
        await also.waitFor();
        assert.equal(await sheet.locator('.box[data-field="away"] select[aria-label^="Also check"]').count(), 0, "a box without an evaluator offers none");
        const names = await also.locator("option").allInnerTexts();
        assert.deepEqual([names[0], names.includes("Your values"), names.includes("Therapy Goal")], ["None", true, false]);

        const questions = await towards.locator(".question").count();
        await also.selectOption({ label: "Your values" });
        await until(async () => (await also.inputValue()) === "0000000000000000000000YVAS");
        assert.equal(await towards.locator(".question").count(), questions, "Your values brings no question settings");
        await also.selectOption({ label: "None" });
        await until(async () => (await also.inputValue()) === "");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

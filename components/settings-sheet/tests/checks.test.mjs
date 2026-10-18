import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// A file of its own because the 5s budget (11) is per file, and its load of the product
// page leaves little room beside the other settings tests.
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

    // The choice point checks on the product page, in one load: folded until asked for, a
    // box's evaluator as the account holds it, with no expected answer or icon to set (the
    // evaluator holds both), and choosing an
    // evaluator for another box answered by its questions. The evaluator and the stored box
    // are made through the APIs under the test's own login; that a chosen box is kept and
    // synced is decided in choice-point-checks' Node tests (9).
    test("the choice point checks fold open, show a box's stored evaluator, and take a new one, with no expected answer or icon to set", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("checks"));
        const id = (tail) => "01J" + "0".repeat(23 - tail.length) + tail;
        const evaluator = id("E1");
        const question = id("Q1");
        const options = ["Behavioral Goal", "Emotional Goal"].map((name, i) => ({ id: id(`A${i}`), name, description: "" }));
        const [made, stored] = await Promise.all([
          context.request.put(`${BASE_URL}/api/evaluators/${evaluator}`, {
            data: {
              book: id("B1"),
              name: "Therapy Goal",
              on: true,
              baseVersion: null,
              questions: [
                { id: question, kind: "pick", text: "Which kind of goal is it?", yes: "", no: "", options },
                { id: id("Q2"), kind: "yesno", text: "Is it overt?", yes: "", no: "", options: [], on: false },
              ],
            },
          }),
          context.request.put(`${BASE_URL}/api/choice-point-checks/boxes/towards`, {
            data: {
              evaluator,
              questions: [{ id: question, show: true, expect: options[0].id, when: null, icons: {} }],
              baseVersion: null,
            },
          }),
        ]);
        assert.deepEqual([made.status(), stored.status()], [200, 200]);
        const page = await context.newPage();
        const problems = watch(page);
        const sheet = page.locator("settings-sheet");
        const towards = sheet.locator('.box[data-field="towards"]');
        const away = sheet.locator('.box[data-field="away"]');
        const shown = 'input[type="checkbox"]';
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await sheet.locator(".checks details.keys-fold").waitFor({ state: "attached" });
        await page.locator("dock-desk .controls .pill").click();
        assert.equal(await towards.isVisible(), false, "the boxes are folded away at first");
        await sheet.locator("summary", { hasText: "Choose what Jev checks" }).click();
        await until(async () => (await towards.locator(shown).count()) === 1);
        assert.equal(await towards.locator('select[aria-label="Evaluator for Towards · unhooked"]').inputValue(), evaluator);
        assert.equal(await towards.locator(shown).isChecked(), true);

        assert.equal(await away.locator(shown).count(), 0);
        await away.locator('select[aria-label="Evaluator for Away · hooked"]').selectOption(evaluator);
        await until(async () => (await away.locator(shown).count()) === 1);
        assert.equal(await away.locator(shown).isChecked(), true, "every question shown at first");

        const off = away.locator('.question[data-question="' + id("Q2") + '"]');
        assert.match(await off.innerText(), /Off in the evaluator/);
        assert.equal(await off.locator("input, select, button").count(), 0, "a question off in the evaluator has nothing to set");

        assert.equal(await sheet.getByText(/^Icon for /).count(), 0, "an answer's icon is chosen in the evaluator, not here");
        assert.equal(await sheet.locator('select[aria-label^="Answer expected"]').count(), 0, "and so is the answer expected");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

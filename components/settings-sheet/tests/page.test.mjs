import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The starter key row under Evaluating (architecture.md 12). The test server has no
// starter keys, so the page's reads of its own llm server are answered here: first a
// new account with 87 starter requests left, then the picture after an own key is saved.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const picture = (jev) => ({
  provider: "echo",
  providers: [
    { id: "anthropic", label: "Anthropic", keySet: false, needsKey: true },
    { id: "echo", label: "Echo", keySet: true, needsKey: false },
  ],
  model: "echo",
  models: [{ id: "echo", label: "Echo" }],
  effort: "default",
  efforts: ["default", "low", "medium", "high", "xhigh", "max"],
  ttl: "1h",
  jev,
});

const judging = (page) =>
  page.evaluate(() => {
    const group = document.querySelector("settings-sheet")?.shadowRoot?.querySelector(".judging");
    return group
      ? {
          text: group.textContent.replace(/\s+/g, " ").trim(),
          input: !!group.querySelector("input"),
          buttons: [...group.querySelectorAll("button")].map((b) => b.textContent.trim()),
        }
      : null;
  });

for (const engine of ENGINES) {
  describe(`Settings in ${engine.name}`, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    test("the count shows, and adding one's own key replaces it", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("starter"));
        const saved = [];
        await context.route("**/api/llm", async (route) => {
          if (route.request().method() === "PUT") {
            saved.push(route.request().postDataJSON());
            return route.fulfill({ json: picture({ keySet: true }) });
          }
          return route.fulfill({ json: picture({ keySet: true, starterLeft: 87 }) });
        });
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/llm`, { waitUntil: "domcontentloaded" });

        await until(async () => (await judging(page))?.text.includes("Starter key · 87 of 100 requests left"));
        const starter = await judging(page);
        assert.equal(starter.input, true, "the box for one's own key is open");
        assert.deepEqual(starter.buttons, ["Save"], "the starter key has no Replace or Remove");

        await page.locator('settings-sheet .key input[aria-label="Jev key"]').fill("jev-not-a-real-key");
        await page.locator("settings-sheet .judging button", { hasText: "Save" }).click();
        await until(async () => (await judging(page))?.text.includes("Key saved"));
        assert.deepEqual(saved, [{ jevKey: "jev-not-a-real-key" }]);
        assert.ok(!(await judging(page)).text.includes("Starter"), "the own key replaces the count");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
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

    test("the Vim keys list is folded away until asked for, with the switch on or off", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/settings`, { waitUntil: "domcontentloaded" });
        const fold = page.locator("settings-sheet details.keys-fold");
        const list = fold.locator("dl.keys").first();

        await fold.waitFor();
        assert.equal(await fold.getAttribute("open"), null, "the fold starts closed");
        assert.equal(await list.isVisible(), false, "the keys are hidden while it is closed");

        await fold.locator("summary", { hasText: "Show the keys" }).click();
        await until(() => list.isVisible());
        assert.ok((await fold.textContent()).includes("Ctrl+h, Ctrl+l"));

        await page.locator("settings-sheet .switches label", { hasText: "Vim keys" }).locator("input").click();
        await until(async () =>
          page.evaluate(() => JSON.parse(localStorage.getItem("settings") || "null")?.vimKeys === true),
        );
        assert.notEqual(await fold.getAttribute("open"), null, "turning Vim keys on leaves the fold open");
        assert.equal(await list.isVisible(), true);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The tool editor on the Judge app page, walked as a user would. Tools are kept on this
// device, so a reload shows what was stored.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/apps/judge`;
const GOAL_OR_VALUE = "01K6SEED00000000000000RB01";

// The editor as the user reads it: the name, and each question's kind, text, yes / no
// wording or options.
const shown = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("rubric-editor")?.shadowRoot;
    const name = root?.querySelector("input.title");
    if (!name) return null;
    return {
      name: name.value,
      questions: [...root.querySelectorAll(".question")].map((q) => ({
        kind: q.querySelector('.kind input:checked')?.value,
        text: q.querySelector("textarea.text").value,
        yes: q.querySelector("textarea.yes")?.value,
        options: [...q.querySelectorAll(".option")].map((o) => [o.querySelector("input").value, o.querySelector("textarea").value]),
      })),
    };
  });

// The Tools list as the user reads it: each tool's name and the line under it.
const listed = (page) =>
  page.evaluate(() =>
    [...document.querySelector("rubric-list").shadowRoot.querySelectorAll(".row[data-id]")].map((r) => [
      r.querySelector(".name").textContent.trim(),
      r.querySelector(".sub").textContent.trim(),
    ]),
  );

async function openGoalOrValue(page) {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.locator(`rubric-list .row[data-id="${GOAL_OR_VALUE}"] .open`).click();
  await until(async () => (await shown(page))?.name === "Goal or value");
}

for (const engine of ENGINES) {
  describe(`the tool editor in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    const run = (name, body) =>
      test(name, async () => {
        const context = await browser.newContext();
        context.setDefaultTimeout(4000);
        try {
          const page = await context.newPage();
          const problems = watch(page);
          await body(page);
          assert.deepEqual(problems, []);
        } finally {
          await context.close();
        }
      });

    run("Goal or value shows its pick question with Goal, Value and Other", async (page) => {
      await openGoalOrValue(page);
      assert.deepEqual((await shown(page)).questions, [
        {
          kind: "pick",
          text: "Is this a goal, a value, or neither?",
          yes: undefined,
          options: [
            ["Goal", "Something you can achieve and then it is finished."],
            ["Value", "An ongoing way of acting that is never finished."],
            ["Other", "Neither a goal nor a value."],
          ],
        },
      ]);
    });

    run("an added option is kept after a reload", async (page) => {
      await openGoalOrValue(page);
      await page.locator("rubric-editor").getByRole("button", { name: "Add an option" }).click();
      const focused = page.locator("rubric-editor .option input:focus");
      await focused.fill("Unsure");
      await focused.blur();
      await page.reload({ waitUntil: "domcontentloaded" });
      await until(async () => (await shown(page))?.questions[0].options.length === 4);
      assert.deepEqual((await shown(page)).questions[0].options.map(([name]) => name), ["Goal", "Value", "Other", "Unsure"]);
    });

    run("a removed option goes at once, and Undo brings it back", async (page) => {
      await openGoalOrValue(page);
      await page.locator("rubric-editor").getByRole("button", { name: "Remove option Value" }).click();
      await until(async () => (await shown(page)).questions[0].options.length === 2);
      const notice = page.locator("notice-stack .notice.removal");
      assert.equal((await notice.locator("p").textContent()).trim(), "Option “Value” removed.");
      await notice.getByRole("button", { name: "Undo" }).click();
      await until(async () => (await shown(page)).questions[0].options.length === 3);
      assert.deepEqual((await shown(page)).questions[0].options.map(([name]) => name), ["Goal", "Value", "Other"]);
    });

    run("a new tool with a yes / no question is listed with 1 question", async (page) => {
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await page.locator("rubric-list .row.new .open").click();
      const editor = page.locator("rubric-editor");
      await editor.getByPlaceholder("Name the detector").fill("Kindness");
      await editor.getByRole("textbox", { name: "Question 1" }).fill("Is it kind?");
      await editor.locator("textarea.yes").fill("it helps someone");
      await page.locator("list-then-item").getByRole("button", { name: "Back to Detectors" }).click();
      await until(async () => (await listed(page)).some(([name]) => name === "Kindness"));
      assert.deepEqual((await listed(page)).find(([name]) => name === "Kindness"), ["Kindness", "1 question"]);
    });

    run("switching a question to Pick one and back keeps its yes / no wording", async (page) => {
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await page.locator("rubric-list .row[data-id] .open", { hasText: "(yes / no)" }).click();
      await until(async () => (await shown(page))?.questions.length === 2);
      const first = page.locator("rubric-editor .question").first();
      const yes = (await shown(page)).questions[0].yes;
      await first.getByText("Pick one").click();
      await until(async () => (await shown(page)).questions[0].kind === "pick");
      assert.equal((await shown(page)).questions[0].options.length, 2);
      await first.getByText("Yes / no").click();
      await until(async () => (await shown(page)).questions[0].kind === "yesno");
      assert.equal((await shown(page)).questions[0].yes, yes);
      assert.ok(yes.length > 0);
    });
  });
}

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Evaluators tab of the gear's sheet on its stem page, where it stands as a dock tab
// beside the try page's list and editor. Each test is a fresh account with a forged
// session cookie; its evaluators are set up through the server's API.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory");

const PAGE = `${BASE_URL}/workshop/design/evaluators`;
const BOOK = "01K7TEST0000000000000000B1";
const ID = "01K7TEST0000000000000000E1";
const QUESTION = { id: "01K7TEST0000000000000000Q1", on: true, kind: "yesno", text: "Is it kind?", yes: "", no: "", options: [] };
const settings = (vimKeys) => JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: false, vimKeys });

// Where the keyboard is in the tab: a field by its kind, a box by its label.
const where = (page) =>
  page.evaluate(() => {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    if (!a?.closest?.("evaluator-settings") && a?.getRootNode()?.host?.localName !== "evaluator-settings") return a?.localName ?? null;
    if (a.classList.contains("cm-content")) return `box:${a.getAttribute("aria-label")}`;
    if (a.matches("a")) return "try";
    if (a.matches("button")) return `button:${a.textContent.trim()}`;
    if (a.matches("select")) return "select";
    if (a.matches("input[type=radio]")) return `radio:${a.value}`;
    if (a.matches("input")) return `${a.type}:${a.getAttribute("aria-label") ?? a.placeholder}`;
    return a.localName;
  });

async function open(browser, vimKeys) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(4000);
  await signedIn(context, forgeCookie("evaluator-settings"));
  await context.addInitScript((v) => localStorage.setItem("settings", v), settings(vimKeys));
  // One evaluator kept with a book, from before evaluators belonged to the account.
  const put = await context.request.put(`${BASE_URL}/api/evaluators/${ID}`, {
    data: { book: BOOK, name: "Kind or harsh", on: false, questions: [QUESTION], baseVersion: null, deleted: false },
  });
  assert.ok(put.ok(), "the evaluator is on the server");
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  const tab = page.locator("evaluator-settings");
  await tab.locator(`section.evaluator[data-id="${ID}"]`).waitFor();
  return { context, page, problems, tab };
}

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`evaluator-settings in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: a reload against real storage.
    test("an evaluator kept with a book shows open; a new one is kept with the Journal and is there after a reload", async () => {
      const { context, page, problems, tab } = await open(browser, false);
      try {
        assert.equal(await tab.locator(`section[data-id="${ID}"] input.title`).inputValue(), "Kind or harsh");
        assert.equal(await tab.locator("input[type=checkbox][aria-label^='Ask question']").count(), 1, "a tick per question, none for the evaluator");
        assert.equal(await tab.locator("a.try").getAttribute("href"), "/try/evaluators");

        await tab.getByRole("button", { name: "New evaluator" }).click();
        // The new one on top of the one kept with a book and Your values, built from the values.
        await until(async () => (await tab.locator("section.evaluator").count()) === 3);
        await until(async () => (await where(page)) === "text:Name the evaluator");
        await page.keyboard.type("Clear goal");
        await tab.locator("section.evaluator").first().locator('.question [data-field="text"] .cm-content').click();
        await page.keyboard.type("Is it a goal?");
        await tab.locator("a.try").focus();
        let mine = [];
        await until(async () => {
          mine = ((await (await context.request.get(`${BASE_URL}/api/evaluators?since=0`)).json()).evaluators ?? []).filter((e) => e.name === "Clear goal");
          return mine.length === 1 && mine[0].questions[0]?.text === "Is it a goal?";
        });
        assert.equal(mine[0].book, "00000000000000000000000JRN");

        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await tab.locator("section.evaluator input.title").evaluateAll((els) => els.map((e) => e.value))).includes("Clear goal"));
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("j and k, and the arrows, walk the tab top to bottom and back, through fields, choices and boxes", async () => {
      const { context, page, problems, tab } = await open(browser, true);
      try {
        const path = [
          "try",
          "button:New evaluator",
          "text:Name the evaluator",
          "box:Description of Kind or harsh",
          "checkbox:Ask question 1",
          "button:Remove",
          "radio:yesno",
          "box:Question 1",
          "select",
          "box:Yes means (optional)",
          "box:No means (optional)",
          "button:Add a question",
          "button:Delete evaluator",
        ];
        await tab.locator("a.try").focus();
        // Down with j, except out of the one-line field, where j is typed and the arrow moves.
        const seen = [await where(page)];
        for (let i = 1; i < path.length; i++) {
          await page.keyboard.press(seen.at(-1).startsWith("text:") ? "ArrowDown" : "j");
          seen.push(await where(page));
        }
        assert.deepEqual(seen, path);
        await page.keyboard.press("j");
        assert.equal(await where(page), path.at(-1), "past the end the keyboard stays");
        // And back up with k, every move undone in turn.
        const back = [await where(page)];
        for (let i = 1; i < path.length; i++) {
          await page.keyboard.press(back.at(-1).startsWith("text:") ? "ArrowUp" : "k");
          back.push(await where(page));
        }
        assert.deepEqual(back, [...path].reverse());
        // gg and G, and the arrows on a button and in a box.
        await page.keyboard.press("G");
        assert.equal(await where(page), path.at(-1));
        await page.keyboard.press("g");
        await page.keyboard.press("g");
        assert.equal(await where(page), "try");
        await page.keyboard.press("ArrowDown");
        assert.equal(await where(page), "button:New evaluator");
        // l on the kind changes it to Pick one, and h brings Yes / no back.
        for (const key of ["j", "ArrowDown", "j", "j", "j"]) await page.keyboard.press(key);
        assert.equal(await where(page), "radio:yesno");
        await page.keyboard.press("l");
        await until(async () => (await tab.locator('input[type=radio][value="pick"]').isChecked()) === true);
        await page.keyboard.press("h");
        await until(async () => (await tab.locator('input[type=radio][value="yesno"]').isChecked()) === true);
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}

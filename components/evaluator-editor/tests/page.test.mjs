import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// A press inside the editor that lands on nothing that takes focus, as every press on a
// button does in Safari, must not hand the focus to the evaluator's name: with the name
// scrolled away, that scrolled the editor to the top between mousedown and mouseup, and
// the click landed on whatever was then under the pointer, so "Add an option" did
// nothing. Playwright's WebKit focuses a pressed button, so the press beside the button
// stands in for Safari's press on it.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const JOURNAL = "00000000000000000000000JRN";
const settings = (vimKeys) => JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });
// Until the page has run what a press or a key set going: the desk's look a moment
// after a focusout (a timeout), the render that follows, and one frame painted.
const settle = (page) =>
  page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r))))));

const inEditor = (page, fn, arg) =>
  page.evaluate(
    ([fn, arg]) => new Function("root", "arg", `return (${fn})(root, arg)`)(document.querySelector("evaluator-editor").shadowRoot, arg),
    [fn.toString(), arg],
  );
// The second question's wording, as its box shows it.
const secondText = (page) => inEditor(page, (root) => root.querySelectorAll('.question [data-field="text"] .cm-content')[1]?.textContent);
const optionCount = (page) => inEditor(page, (root) => root.querySelectorAll(".option").length);
// Where the editor is scrolled: its own scroller and the document, whichever moves.
const scrolled = (page) => inEditor(page, (root) => [root.querySelector(".page").scrollTop, document.scrollingElement.scrollTop]);

// A press as a person presses: over, down, a frame for the page to react, up.
async function press(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await settle(page);
  await page.mouse.up();
}

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`evaluator-editor in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    test("a press beside Add an option leaves the scroll and the name alone, and the button adds one option", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/evaluators`, { waitUntil: "domcontentloaded" });
        await page.click(`book-shelf .tile[data-id="${JOURNAL}"]`);
        await page.click("evaluator-list .row.new .open");
        await page.fill("evaluator-editor input.title", "Goal or value");
        await page.locator("evaluator-editor").getByText("Pick one").click();
        // Options enough that the name scrolls out of view.
        for (let i = 0; i < 6; i++) await inEditor(page, (root) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add an option").click());
        await until(async () => (await optionCount(page)) === 8);
        await inEditor(page, (root) => {
          root.querySelector(".page").scrollTop = 1e6;
          document.scrollingElement.scrollTop = 1e6;
          [...root.querySelectorAll(".option input")].at(-1).focus();
        });
        const add = page.locator("evaluator-editor").getByRole("button", { name: "Add an option" });
        const box = await add.boundingBox();
        const before = await scrolled(page);
        assert.ok(before.some((top) => top > 0), "the editor is scrolled, so the name is out of view");

        await press(page, box.x + box.width + 40, box.y + box.height / 2);
        assert.deepEqual(await scrolled(page), before, "the editor did not jump");
        assert.equal(await inEditor(page, (root) => root.activeElement?.matches("input.title") ?? false), false, "the name did not take the keyboard");
        assert.equal(await optionCount(page), 8);

        const again = await add.boundingBox();
        await press(page, again.x + again.width / 2, again.y + again.height / 2);
        await until(async () => (await optionCount(page)) === 9);
        assert.equal(await inEditor(page, (root) => root.activeElement === [...root.querySelectorAll(".option input")].at(-1)), true, "the keyboard is in the new option");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Where the keyboard is: the question's number and the field. The boxes are named
    // by data-field, the one-line fields by their kind.
    const focused = (page) =>
      inEditor(page, (root) => {
        const a = root.activeElement;
        if (!a) return null;
        const question = a.closest(".question");
        const q = question ? [...root.querySelectorAll(".question")].indexOf(question) + 1 : 0;
        const field = a.matches("input.title")
          ? "name"
          : a.type === "radio"
            ? `kind:${a.value}`
            : a.matches(".option input")
              ? "option"
              : (a.closest("[data-field]")?.dataset.field ?? a.localName);
        return `${q}:${field}`;
      });

    const twoQuestions = async (vimKeys, cookie) => {
      const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
      context.setDefaultTimeout(4000);
      if (cookie) await signedIn(context, cookie);
      await context.addInitScript((v) => localStorage.setItem("settings", v), settings(vimKeys));
      const page = await context.newPage();
      const problems = watch(page);
      // Each save the editor makes, read off the trace's console transcript (10).
      const saves = { count: 0 };
      page.on("console", (msg) => / event evaluator\.saved /.test(msg.text()) && saves.count++);
      await page.goto(`${BASE_URL}/workshop/design/evaluators`, { waitUntil: "domcontentloaded" });
      await page.click(`book-shelf .tile[data-id="${JOURNAL}"]`);
      await page.click("evaluator-list .row.new .open");
      await page.fill("evaluator-editor input.title", "Goal or value");
      await page.locator("evaluator-editor").getByRole("button", { name: "Add a question" }).click();
      await until(async () => (await inEditor(page, (root) => root.querySelectorAll(".question").length)) === 2);
      return { context, page, problems, saves, second: page.locator("evaluator-editor .question").nth(1) };
    };
    const at = async (page, locator) => {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      await press(page, box.x + box.width / 2, box.y + box.height / 2);
      await settle(page);
    };

    // A press on a choice drops the focus on the page when the browser does not focus
    // what was pressed; with Vim keys on the desk puts it back in the panel, and that
    // used to mean the evaluator's name, far above the second question.
    test("with Vim keys on, switching the second question's kind keeps the keyboard in that question", async () => {
      const { context, page, problems, second } = await twoQuestions(true);
      try {
        // The second question as the user left it: Pick one, its first option named, the
        // keyboard in its second option. Only the presses after are what is tested.
        await inEditor(page, (root) => root.querySelectorAll(".question")[1].querySelector('input[value="pick"]').click());
        await until(async () => (await second.locator(".option input").count()) === 2);
        await inEditor(page, (root) => {
          const [first, next] = root.querySelectorAll(".question")[1].querySelectorAll(".option input");
          first.value = "Goal";
          first.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          next.focus();
        });
        assert.equal(await focused(page), "2:option");
        await at(page, second.getByText("Yes / no"));
        assert.notEqual(await focused(page), "1:name", "the name did not take the keyboard");
        assert.match((await focused(page)) ?? "", /^2:/, "the keyboard stays in the second question");
        const choice = await second.getByText("Yes / no").boundingBox();
        assert.ok(choice.y >= 0 && choice.y + choice.height <= 600, "the choice pressed is still in view");
        await at(page, second.getByText("Pick one"));
        assert.match((await focused(page)) ?? "", /^2:/);
        assert.equal(await inEditor(page, (root) => root.querySelectorAll(".question")[1].querySelector(".option input").value), "Goal");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // The boxes are editors drawn inside the form: neither the save a moment into typing
    // nor the save when a box loses focus may take the keyboard out of the box in use.
    test("with Vim keys on, typing in the second question's box keeps the keyboard there through both saves", async () => {
      const { context, page, problems, saves, second } = await twoQuestions(true);
      // The next save, and the render of the fact's answer to it.
      const saved = async () => {
        const seen = saves.count;
        await until(() => saves.count > seen);
        await settle(page);
      };
      try {
        // Add a question left the keyboard in its box, in Vim's insert mode; a press
        // inside the box keeps it so.
        await at(page, second.locator('[data-field="text"]'));
        let save = saved();
        await page.keyboard.type("Is it");
        await save;
        save = saved();
        await page.keyboard.type(" a goal?");
        await save;
        assert.equal(await focused(page), "2:text");
        await page.keyboard.press("Escape");
        assert.equal(await focused(page), "2:text", "Escape leaves insert mode and stays in the box");
        await page.keyboard.press("Tab");
        await settle(page);
        assert.equal(await focused(page), "2:yes");
        assert.equal(await secondText(page), "Is it a goal?");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // A box writes in paragraphs like every editor (10): Enter a gap, Shift+Enter a line.
    test("in a question's box Enter starts a paragraph and Shift+Enter breaks the line", async () => {
      const { context, page, problems } = await twoQuestions(false);
      try {
        // Add a question left the keyboard in its box.
        await page.keyboard.type("one");
        await page.keyboard.press("Enter");
        await page.keyboard.type("two");
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.type("three");
        const box = (root) => {
          const content = root.querySelectorAll('.question [data-field="text"] .cm-content')[1];
          return { text: content.cmView.rootView.view.state.doc.toString(), gaps: content.querySelectorAll(".cm-gap").length };
        };
        assert.deepEqual(await inEditor(page, box), { text: "one\n\ntwo\nthree", gaps: 1 });
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // What the box saved is what comes back: a test of its own, so each fits its budget.
    // Signed in, so the account's copy is the sign that the save is kept: the reload
    // waits for it rather than for a pause.
    test("a question typed in its box is there after a reload", async () => {
      const { context, page, problems } = await twoQuestions(true, forgeCookie("evaluator-editor"));
      try {
        // Add a question left the keyboard in its box; Tab saves what it holds.
        await page.keyboard.type("Is it a goal?");
        await page.keyboard.press("Escape");
        await page.keyboard.press("Tab");
        await until(async () => {
          await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
          const { evaluators } = await (await context.request.get(`${BASE_URL}/api/evaluators`)).json();
          return evaluators.some((e) => e.questions.some((q) => q.text === "Is it a goal?"));
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await secondText(page).catch(() => null)) === "Is it a goal?");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

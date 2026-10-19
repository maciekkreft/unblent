import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Evaluate box: its marks at line ends and the panel under it after a line-by-line
// run, the panel following a clicked line, a failed line, and that the box's keys stay in
// it. Which questions are asked, how answers become words, which line the panel tells
// about and Stop are decided by the machine and tested in Node; here Jev is answered by
// request routing, so no real request is spent.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const JOURNAL = "00000000000000000000000JRN";
const settings = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });
const Q = (n) => `01K7TEST0000000000000Q${String(n).padStart(4, "0")}`;
const yesno = (n, text, extra = {}) => ({ id: Q(n), kind: "yesno", text, yes: "", no: "", options: [], ...extra });
const EVALUATORS = [
  ["01K7TEST0000000000000E0001", "Recommendability", true, [yesno(1, "Says what the reader gets?", { expect: "yes" }), yesno(2, "Fits a need?"), yesno(3, "Easy to pass on?")]],
  ["01K7TEST0000000000000E0002", "Kind of promise", true, [
    { id: Q(4), kind: "pick", text: "What does it promise?", yes: "", no: "", expect: "01K7TEST0000000000000P0002", options: [
      { id: "01K7TEST0000000000000P0001", name: "Resolve a fear", description: "", icon: "heart" },
      { id: "01K7TEST0000000000000P0002", name: "Reach a goal", description: "", icon: "trophy" },
    ] },
  ]],
  ["01K7TEST0000000000000E0003", "Clarity", false, [yesno(5, "Is it clear?")]],
];
const P = { [Q(1)]: 0.93, [Q(2)]: 0.88, [Q(3)]: 0.44 };

const inList = (page, fn) =>
  page.evaluate((fn) => new Function("root", `return (${fn})(root)`)(document.querySelector("evaluator-list").shadowRoot), fn.toString());

// The box's text, read from the editor.
const textOf = (page) => page.locator("evaluator-list .cm-content").evaluate((el) => el.cmView.view.state.doc.toString());

// Each line of the box with its marks, as "<tone and sureness>|<title>".
const marks = (page) =>
  inList(page, (root) =>
    [...root.querySelectorAll(".cm-line")].map((l) => [l.textContent.trim(), [...l.querySelectorAll(".mark")].map((m) => `${m.className.replace("mark", "").trim()}|${m.title}`)]),
  );

// The panel's text, one entry per line shown, or null while it is hidden.
const panel = (page) => inList(page, (root) => root.querySelector(".focus")?.innerText.split("\n").map((t) => t.trim()).filter(Boolean) ?? null);

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`evaluator-list Evaluate box in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // A signed-in account with the evaluators above on the server, a Jev key, and Jev
    // answering each request from the table above, or as `fail` says for a line; `stored`
    // is this browser's kept text per book.
    const open = async (name, fail = () => null, stored = null) => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie(name));
      for (const [id, title, on, questions] of EVALUATORS) {
        const put = await context.request.put(`${BASE_URL}/api/evaluators/${id}`, { data: { book: JOURNAL, name: title, on, questions, baseVersion: null, deleted: false } });
        assert.ok(put.ok(), "an evaluator is on the server");
      }
      await context.route(/\/api\/llm$/, async (route) => {
        const response = await route.fetch();
        const picture = await response.json();
        await route.fulfill({ response, json: { ...picture, jev: { keySet: true } } });
      });
      const bodies = [];
      await context.route(/\/api\/llm\/decide$/, async (route) => {
        const body = route.request().postDataJSON();
        bodies.push(body);
        const answers = body.questions.map((q) =>
          q.kind === "pick"
            ? { id: q.id, p: 0.81, choice: q.options[0].id, probabilities: [{ id: q.options[0].id, p: 0.81 }, { id: q.options[1].id, p: 0.19 }] }
            : { id: q.id, p: P[q.id.split(":")[1]] },
        );
        await route.fulfill({ json: fail(body.state.text) ?? { answers, inputTokens: 10, ms: 5 } });
      });
      await context.addInitScript(([v, kept]) => {
        localStorage.setItem("settings", v);
        if (kept) localStorage.setItem("evaluator-list.drafts", kept);
      }, [settings, stored && JSON.stringify(stored)]);
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/workshop/design/evaluators`, { waitUntil: "domcontentloaded" });
      await page.click(`book-shelf .tile[data-id="${JOURNAL}"]`);
      return { context, page, problems, bodies };
    };

    // Browser: rendering and layout.
    test("each line gets its marks at its end and the panel tells one line; a click picks it; Clear removes them; keys stay in the box", async () => {
      const { context, page, problems, bodies } = await open("evaluator-run");
      try {
        const box = page.locator("evaluator-list .cm-content");
        const run = page.locator("evaluator-list button.go");
        const by = () => inList(page, (root) => root.querySelector(".fold")?.textContent.replace(/\s+/g, " ").trim());
        await until(async () => (await by()) === "Evaluated by Recommendability and Kind of promise");
        assert.equal((await run.textContent()).trim(), "Evaluate");
        assert.ok(await run.isDisabled(), "no text, no run");

        // With Vim keys on the box takes Vim's keys: i to insert, then letters are text and
        // Enter a new paragraph; none of them reaches the list.
        await box.click();
        await page.keyboard.press("i");
        await page.keyboard.type("jkG");
        await page.keyboard.press("Enter");
        await page.keyboard.type("A title");
        await page.keyboard.press("Escape");
        assert.equal(await textOf(page), "jkG\n\nA title");
        assert.ok(await inList(page, (root) => root.activeElement?.classList.contains("cm-content")), "the focus stays in the box");
        assert.equal(await inList(page, (root) => root.querySelector(".row.current")), null, "no row was opened");
        assert.equal((await run.textContent()).trim(), "Evaluate 2 lines", "the blank line is not counted");
        assert.equal(await panel(page), null, "nothing answered, no panel");

        await run.click();
        await until(async () => (await panel(page))?.[0] === "Line 2 of 2");
        // Green where the expected answer was given, red where not, faded where Jev is not sure.
        const lineMarks = ["right|Says what the reader gets? Yes", "|Fits a need? Yes", "unsure|Easy to pass on? Probably no", "wrong|Resolve a fear"];
        assert.deepEqual(await marks(page), [["jkG", lineMarks], ["", []], ["A title", lineMarks]]);
        const answers = [
          "Recommendability",
          "Says what the reader gets?", "Yes", "Yes, as expected",
          "Fits a need?", "Yes",
          "Easy to pass on?", "Probably no",
          "Kind of promise",
          "Resolve a fear", "Reach a goal is expected",
        ];
        assert.deepEqual(await panel(page), ["Line 2 of 2", "2 evaluated · 0 as expected", "“A title”", ...answers]);
        assert.deepEqual(bodies.map((b) => [b.state.text, b.questions.length]), [["jkG", 4], ["A title", 4]], "one request per line");
        assert.equal((await run.textContent()).trim(), "Evaluate 2 lines");

        // A click on another line puts it in the panel.
        await page.locator("evaluator-list .cm-line", { hasText: "jkG" }).click();
        await until(async () => (await panel(page))?.[0] === "Line 1 of 2");
        assert.equal((await panel(page))[2], "“jkG”");

        await page.locator("evaluator-list button.clear").click();
        await until(async () => (await inList(page, (root) => root.querySelectorAll(".mark, .focus, .clear").length)) === 0);
        assert.equal(await textOf(page), "jkG\n\nA title", "Clear keeps the text");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("a failed line keeps the marks before it, asks no more and says why in the panel", async () => {
      const { context, page, problems, bodies } = await open("evaluator-fail", (text) => (text === "Two" ? { error: "rate-limited" } : null));
      try {
        // As a paste would: one edit puts the three lines in the box.
        await page.locator("evaluator-list .cm-content").waitFor();
        await page.locator("evaluator-list .cm-content").evaluate((el) => el.cmView.view.dispatch({ changes: { from: 0, insert: "One\nTwo\nThree" }, userEvent: "input.paste" }));
        await page.locator("evaluator-list button.go", { hasText: "Evaluate 3 lines" }).click();
        await until(async () => (await panel(page))?.[0] === "Line 2 of 3");
        assert.deepEqual(await panel(page), ["Line 2 of 3", "1 evaluated · 0 as expected", "“Two”", "Jev is busy. Try again in a moment."]);
        assert.deepEqual((await marks(page)).map(([t, m]) => [t, m.length]), [["One", 4], ["Two", 0], ["Three", 0]]);
        assert.deepEqual(bodies.map((b) => b.state.text), ["One", "Two"]);
        assert.deepEqual(problems, [], problems.join("; "));

      } finally {
        await context.close();
      }
    });

    // Browser: a reload against real storage.
    test("the text is kept per book in this browser: shown again in the box, and an edit kept", async () => {
      const { context, page, problems } = await open("evaluator-kept", undefined, { [JOURNAL]: "One\nTwo" });
      try {
        await until(async () => (await page.locator("evaluator-list .cm-content").count()) === 1 && (await textOf(page)) === "One\nTwo");
        await page.locator("evaluator-list .cm-content").evaluate((el) => el.cmView.view.dispatch({ changes: { from: 7, insert: "\nThree" }, userEvent: "input.paste" }));
        assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem("evaluator-list.drafts"))), { [JOURNAL]: "One\nTwo\nThree" });
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Run box: what it shows before, during and after a line-by-line run, and that its
// keys stay in the box. Which questions are asked and how answers become scores is decided by the
// machine and tested in Node; here Jev is answered by request routing, so no real
// request is spent.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const JOURNAL = "00000000000000000000000JRN";
const settings = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });
const Q = (n) => `01K7TEST0000000000000Q${String(n).padStart(4, "0")}`;
const yesno = (n, text) => ({ id: Q(n), kind: "yesno", text, yes: "", no: "", options: [] });
const EVALUATORS = [
  ["01K7TEST0000000000000E0001", "Recommendability", true, [yesno(1, "Says what the reader gets?"), yesno(2, "Fits a need?"), yesno(3, "Easy to pass on?")]],
  ["01K7TEST0000000000000E0002", "Kind of promise", true, [
    { id: Q(4), kind: "pick", text: "What does it promise?", yes: "", no: "", options: [
      { id: "01K7TEST0000000000000P0001", name: "Resolve a fear", description: "" },
      { id: "01K7TEST0000000000000P0002", name: "Reach a goal", description: "" },
    ] },
  ]],
  ["01K7TEST0000000000000E0003", "Clarity", false, [yesno(5, "Is it clear?")]],
];
const P = { [Q(1)]: 0.93, [Q(2)]: 0.88, [Q(3)]: 0.44 };

const inList = (page, fn) =>
  page.evaluate((fn) => new Function("root", `return (${fn})(root)`)(document.querySelector("evaluator-list").shadowRoot), fn.toString());

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`evaluator-list Run box in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    test("Run asks once per line and groups the answers by line; a failed line says why; Clear removes them; keys stay in the box", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("evaluator-run"));
        for (const [id, name, on, questions] of EVALUATORS) {
          const put = await context.request.put(`${BASE_URL}/api/evaluators/${id}`, { data: { book: JOURNAL, name, on, questions, baseVersion: null, deleted: false } });
          assert.ok(put.ok(), "an evaluator is on the server");
        }
        // The account has a Jev key, and Jev answers each request from the table above.
        await context.route(/\/api\/llm$/, async (route) => {
          const response = await route.fetch();
          const picture = await response.json();
          await route.fulfill({ response, json: { ...picture, jev: { keySet: true } } });
        });
        const bodies = [];
        let fail = null;
        await context.route(/\/api\/llm\/decide$/, async (route) => {
          const body = route.request().postDataJSON();
          bodies.push(body);
          const answers = body.questions.map((q) =>
            q.kind === "pick" ? { id: q.id, p: 0.81, choice: q.options[0].id } : { id: q.id, p: P[q.id.split(":")[1]] },
          );
          await route.fulfill({ json: fail?.(body.state.text) ?? { answers, inputTokens: 10, ms: 5 } });
        });
        await context.addInitScript((v) => localStorage.setItem("settings", v), settings);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/evaluators`, { waitUntil: "domcontentloaded" });
        await page.click(`book-shelf .tile[data-id="${JOURNAL}"]`);

        const box = page.locator("evaluator-list textarea");
        const run = page.locator("evaluator-list button.go");
        const cost = () => inList(page, (root) => root.querySelector(".cost")?.textContent);
        await until(async () => (await cost()) === "Runs the 2 switched-on evaluators · one request per line");
        assert.ok(await run.isDisabled(), "no text, no run");

        // With Vim keys on, j, k, G and the arrows are typed text, and Enter a new line.
        await box.click();
        await page.keyboard.type("jkG");
        await page.keyboard.press("ArrowUp");
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
        await page.keyboard.type("A title");
        assert.equal(await box.inputValue(), "jkG\n\nA title");
        assert.ok(await inList(page, (root) => root.activeElement?.localName === "textarea"), "the focus stays in the box");
        assert.equal(await inList(page, (root) => root.querySelector(".row.current")), null, "no row was opened");
        assert.equal(await cost(), "Runs the 2 switched-on evaluators · 2 requests", "the blank line is not a request");

        const lines = () =>
          inList(page, (root) =>
            [...root.querySelectorAll(".line")].map((line) => ({
              said: line.querySelector(".said").textContent.trim(),
              status: line.className.replace("line", "").trim(),
              error: line.querySelector(".error")?.textContent ?? null,
              verdicts: [...line.querySelectorAll(".verdict")].map((v) => ({
                name: v.querySelector(".name").textContent.trim(),
                score: v.querySelector(".score")?.textContent ?? null,
                labels: [...v.querySelectorAll(".label")].map((l) => l.textContent),
                low: v.querySelectorAll(".fill.low").length,
              })),
            })),
          );
        const verdicts = [
          { name: "Recommendability", score: "0.71", labels: ["Yes 0.93", "Yes 0.88", "Yes 0.44"], low: 1 },
          { name: "Kind of promise", score: null, labels: ["Resolve a fear 0.81"], low: 0 },
        ];
        await run.click();
        await until(async () => (await lines()).filter((l) => l.status === "done").length === 2);
        assert.deepEqual(await lines(), [
          { said: "jkG", status: "done", error: null, verdicts },
          { said: "A title", status: "done", error: null, verdicts },
        ]);
        assert.deepEqual(bodies.map((b) => [b.state.text, b.questions.length]), [["jkG", 4], ["A title", 4]], "one request per line");
        assert.equal(await inList(page, (root) => root.querySelectorAll(".list .score, .list .answer").length), 0, "the rows show no answers");
        assert.equal((await run.textContent()).trim(), "Run");

        await page.locator("evaluator-list button.clear").click();
        await until(async () => (await inList(page, (root) => root.querySelectorAll(".line, .clear").length)) === 0);

        // The second line fails: the first keeps its answers, and the line after it is not asked.
        await box.fill("One\nTwo\nThree");
        fail = (text) => (text === "Two" ? { error: "rate-limited" } : null);
        bodies.length = 0;
        await run.click();
        await until(async () => (await lines()).some((l) => l.status === "failed"));
        assert.deepEqual(await lines(), [
          { said: "One", status: "done", error: null, verdicts },
          { said: "Two", status: "failed", error: "Jev is busy. Try again in a moment.", verdicts: [] },
        ]);
        assert.deepEqual(bodies.map((b) => b.state.text), ["One", "Two"]);
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}

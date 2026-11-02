import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The hashtag checks in a note (13, Hashtag check), on the product, whose Notes panel
// holds the editor with line-checks beside it: a hashtag naming an evaluator is drawn in
// the accent colour and one naming none muted, and a line under it the user finishes gets
// Jev's answer at its end as the option's icon and name. The decisions are tested in Node
// (checks.test.mjs). Jev is answered through page.route, so nothing is spent, and the
// account is told it has a key.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const id = (tail) => "01J" + "0".repeat(23 - tail.length) + tail;
const [EVALUATOR, QUESTION, IN, NOT, NOTE] = [id("E1"), id("Q1"), id("P1"), id("P3"), id("N1")];
const BODY = "Things on my mind tonight #in-my-control #nope\n- Whether I get the job\n- Calling her";

// The account with In my control and one note under it, and Jev answering by the line's text.
async function setUp(context, page) {
  const put = (path, data) => context.request.put(`${BASE_URL}/api/${path}`, { data });
  const options = [
    { id: IN, name: "In my control", description: "", icon: "check" },
    { id: NOT, name: "Not in my control", description: "", icon: "prohibit" },
  ];
  const evaluator = { book: id("B1"), name: "In my control", on: true, baseVersion: null, questions: [{ id: QUESTION, kind: "pick", text: "Is this in the writer's control?", yes: "", no: "", options }] };
  assert.equal((await put(`evaluators/${EVALUATOR}`, evaluator)).status(), 200);
  assert.equal((await put(`notes/${NOTE}`, { title: "Things on my mind tonight #in-my-control #nope", body: BODY, baseVersion: null, about: [] })).status(), 200);
  await page.route("**/api/llm", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    await route.fulfill({ response: res, json: { ...json, jev: { ...json.jev, keySet: true }, decider: { ...json.decider, ready: true } } });
  });
  await page.route("**/api/llm/decide", (route) => {
    const { state } = route.request().postDataJSON();
    route.fulfill({ json: { answers: [{ id: QUESTION, p: 0.9, choice: /job/.test(state.text) ? NOT : IN }], inputTokens: 1, ms: 1 } });
  });
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("note-list")?.shadowRoot?.querySelector(".row:not(.draft)"));
  await page.locator("note-list").evaluate((el) => el.shadowRoot.querySelector(".row:not(.draft)").click());
  await page.locator("#notes-editor .cm-content").waitFor();
}

const line = (page, text) => page.locator("#notes-editor .cm-line", { hasText: text });
const color = (locator) => locator.evaluate((el) => getComputedStyle(el).color);
// What a token resolves to here, read from an element styled with it.
const token = (page, name) =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);

for (const engine of ENGINES) {
  describe(`hashtag checks in the note editor in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: rendering and layout.
    test("a hashtag naming an evaluator is accent and one naming none is muted", async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("note-hashtags"));
        const page = await context.newPage();
        const problems = watch(page);
        await setUp(context, page);
        const known = page.locator("#notes-editor .cm-hashtag-known");
        await known.waitFor();
        assert.equal(await known.textContent(), "#in-my-control");
        assert.equal(await color(known), await token(page, "--color-accent"));
        const unknown = page.locator("#notes-editor .cm-hashtag-unknown");
        assert.equal(await unknown.textContent(), "#nope");
        assert.equal(await color(unknown), await token(page, "--color-mute"));
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("a line finished under #in-my-control shows the answer's icon and name at its end", async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("note-marks"));
        const page = await context.newPage();
        const problems = watch(page);
        await setUp(context, page);
        await line(page, "Calling her").click();
        await page.keyboard.press("End");
        await page.keyboard.press("ArrowUp");
        const marks = line(page, "Calling her").locator(".marks");
        await until(async () => ((await marks.count()) ? await marks.innerText() : "") === "In my control");
        assert.equal(await marks.locator("svg").count(), 1, "the option's icon before its name");
        assert.equal(await line(page, "Whether I get the job").locator(".marks").count(), 0, "a line not finished is not checked");
        await page.keyboard.press("ArrowDown");
        await until(async () => ((await line(page, "Whether I get the job").locator(".marks").count()) ? await line(page, "Whether I get the job").locator(".marks").innerText() : "") === "Not in my control");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

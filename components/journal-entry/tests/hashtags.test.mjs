import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The hashtag checks on the journal's page (13, Hashtag check): a hashtag naming an
// evaluator is drawn in the accent colour and one naming none muted, a finished line under
// it gets Jev's answer at its end as the option's icon and name, an earlier day shows the
// answers kept and asks nothing, and on a phone the marks stay inside the page. The
// decisions are tested in Node (checks.test.mjs). Jev is answered through page.route, so
// nothing is spent, and the account is told it has a key.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const STEM = `${BASE_URL}/workshop/design/journal`;

const id = (tail) => "01J" + "0".repeat(23 - tail.length) + tail;
const [EVALUATOR, QUESTION, IN, PARTLY, NOT] = [id("E1"), id("Q1"), id("P1"), id("P2"), id("P3")];
const IN_MY_CONTROL = {
  book: id("B1"),
  name: "In my control",
  on: true,
  baseVersion: null,
  questions: [
    {
      id: QUESTION,
      kind: "pick",
      text: "Is this in the writer's control?",
      yes: "",
      no: "",
      options: [
        { id: IN, name: "In my control", description: "", icon: "check" },
        { id: PARTLY, name: "Partly in my control", description: "", icon: "hand-palm" },
        { id: NOT, name: "Not in my control", description: "", icon: "prohibit" },
      ],
    },
  ],
};

const editor = (page) => page.locator("journal-entry .cm-content");
const line = (page, text) => page.locator("journal-entry .cm-line", { hasText: text });

// The account with In my control, and Jev answering by the line's text; returns how many
// times Jev was asked.
async function setUp(context, page) {
  assert.equal((await context.request.put(`${BASE_URL}/api/evaluators/${EVALUATOR}`, { data: IN_MY_CONTROL })).status(), 200);
  await page.route("**/api/llm", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    await route.fulfill({ response: res, json: { ...json, jev: { ...json.jev, keySet: true }, decider: { ...json.decider, ready: true } } });
  });
  const asked = { count: 0 };
  await page.route("**/api/llm/decide", (route) => {
    asked.count += 1;
    const { state } = route.request().postDataJSON();
    route.fulfill({ json: { answers: [{ id: QUESTION, p: 0.9, choice: /job|weather/.test(state.text) ? NOT : IN }], inputTokens: 1, ms: 1 } });
  });
  return asked;
}

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
  describe(`hashtag checks in the journal entry in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: rendering and layout.
    test("on today's page a known hashtag is accent, an unknown one muted, and a finished line shows its answer's icon and name", async () => {
      const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("hashtags-today"));
        const page = await context.newPage();
        const problems = watch(page);
        await setUp(context, page);
        await page.goto(STEM, { waitUntil: "domcontentloaded" });
        await editor(page).click();
        await page.keyboard.type("Things on my mind tonight #in-my-control #nope");
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.type("- Whether I get the job");
        await page.keyboard.press("Enter");
        await page.keyboard.type("Calling her");
        const known = page.locator("journal-entry .cm-hashtag-known");
        await until(async () => (await known.count()) === 1);
        assert.equal(await known.textContent(), "#in-my-control");
        assert.equal(await color(known), await token(page, "--color-accent"));
        assert.equal(await color(page.locator("journal-entry .cm-hashtag-unknown")), await token(page, "--color-mute"));
        const marks = line(page, "Whether I get the job").locator(".marks");
        await until(async () => ((await marks.count()) ? await marks.innerText() : "") === "Not in my control");
        assert.equal(await marks.locator("svg").count(), 1, "the option's icon before its name");
        assert.equal(await line(page, "Calling her").locator(".marks").count(), 0, "the line being typed is not checked");
        await page.keyboard.press("ArrowUp");
        // The answer, not the dot shown while Jev is asked, which is also a .marks.
        const calling = line(page, "Calling her").locator(".marks:not(.pending)");
        await until(async () => ((await calling.count()) ? await calling.innerText() : "") === "In my control");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("an earlier day shows the answers kept, read only, without asking Jev", async () => {
      const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("hashtags-earlier"));
        const text = "After the meeting #in-my-control\n- The weather on our trip";
        const then = Date.now() - 3 * 864e5;
        const d = new Date(then);
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const put = await context.request.put(`${BASE_URL}/api/journal/days`, { data: { record: { id: id("DAY"), day: date, text, editedAt: then }, baseVersion: null } });
        assert.equal(put.status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        const asked = await setUp(context, page);
        await page.goto(STEM, { waitUntil: "domcontentloaded" });
        // The same lines written today are checked once; the earlier day reuses the answer.
        await editor(page).click();
        await page.keyboard.type("After the meeting #in-my-control");
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.type("- The weather on our trip");
        await editor(page).blur();
        await line(page, "The weather on our trip").locator(".marks:not(.pending)").waitFor();
        const count = asked.count;
        await page.locator("journal-days .row", { hasText: "After the meeting" }).last().click();
        await until(async () => (await editor(page).getAttribute("contenteditable")) === "false");
        await until(async () => ((await line(page, "The weather").locator(".marks").count()) ? await line(page, "The weather").locator(".marks").innerText() : "") === "Not in my control");
        assert.equal(asked.count, count, "nothing is asked for an earlier day");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("in the phone preview a long checked line keeps its marks inside the page", async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("hashtags-phone"));
        await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
        const page = await context.newPage();
        const problems = watch(page);
        await setUp(context, page);
        await page.goto(STEM, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
        await editor(page).click();
        await page.keyboard.type("Tonight #in-my-control");
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.type("- Whether I get the job I interviewed for on Thursday afternoon");
        await page.keyboard.press("Enter");
        const marks = line(page, "Whether I get the job").locator(".marks:not(.pending)");
        await marks.waitFor();
        const [box, row] = await Promise.all([marks.boundingBox(), line(page, "Whether I get the job").boundingBox()]);
        assert.ok(box.x >= row.x && box.x + box.width <= row.x + row.width + 1, "the marks stay inside their line");
        assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), "the page does not scroll sideways");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

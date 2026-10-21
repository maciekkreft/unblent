import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The free-use bar on the Evaluators try page (try-links screens 1 and 2): what it and
// the message under Run say as a guest's free use runs out. The share comes from llm's
// own picture, here reshaped by request routing, and Jev is answered the same way, so
// nothing is spent; what a request costs is tested in llm's spending test.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, shortUndo } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory");

const JOURNAL = "00000000000000000000000JRN";
const EVALUATOR = "01K7TEST0000000000000F0001";
const QUESTION = "01K7TEST0000000000000F0Q01";

const bar = (page) => page.evaluate(() => document.querySelector("free-use").shadowRoot.querySelector(".use")?.textContent.replace(/\s+/g, " ").trim() ?? "");
const listText = (page) => page.evaluate(() => document.querySelector("evaluator-list").shadowRoot.textContent.replace(/\s+/g, " "));
const runBox = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("evaluator-list").shadowRoot;
    return { notice: root.querySelector(".notice")?.textContent.trim() ?? null };
  });

// A guest made the way a try page makes one (3.4), with one switched-on evaluator kept
// with the Journal, and llm's picture answered with the given free use.
async function guestPage(browser, freeUse, { undoMs = null } = {}) {
  const context = await browser.newContext();
  context.setDefaultTimeout(4000);
  if (undoMs != null) await shortUndo(context, undoMs);
  assert.ok((await context.request.post(`${BASE_URL}/api/session/guest`)).ok(), "the guest is made");
  const put = await context.request.put(`${BASE_URL}/api/evaluators/${EVALUATOR}`, {
    data: { book: JOURNAL, name: "Clear goal", on: true, questions: [{ id: QUESTION, kind: "yesno", text: "Is it a goal?", yes: "", no: "", options: [] }], baseVersion: null, deleted: false },
  });
  assert.ok(put.ok(), "the guest's evaluator is on the server");
  let reads = 0;
  await context.route(/\/api\/llm$/, async (route) => {
    const response = await route.fetch();
    const picture = await response.json();
    assert.ok(picture.freeUse, "the server gives a guest its free use");
    reads += 1;
    await route.fulfill({ response, json: { ...picture, jev: { keySet: true }, freeUse: freeUse(reads) } });
  });
  await context.route(/\/api\/llm\/decide$/, (route) =>
    route.fulfill({ json: { answers: [{ id: `${EVALUATOR}/${QUESTION}`, p: 0.8 }], inputTokens: 40, ms: 5 } }),
  );
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/try/evaluators`, { waitUntil: "domcontentloaded" });
  return { context, page, problems };
}

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`the free-use bar in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: rendering and layout.
    test("a guest's finished line is checked and the bar goes down", async () => {
      const { context, page, problems } = await guestPage(browser, (n) => ({ left: n === 1 ? 1 : 0.9, blocked: false, paused: [] }));
      try {
        await until(async () => (await bar(page)) === "Free use 100% left");
        await page.getByRole("textbox", { name: "Write one sentence per line" }).click();
        await page.keyboard.insertText("Walk for ten minutes after lunch.");
        // Enter finishes the line, which is checked at once.
        await page.keyboard.press("Enter");
        await until(async () => (await bar(page)) === "Free use 90% left");
        assert.deepEqual(await runBox(page), { notice: null });
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // A gesture: Start over waits out its notice, then the guest's own evaluator gives way
    // to the starters, and what was spent is left alone.
    test("Start over replaces the guest's evaluators with the starters once its notice ends", async () => {
      const { context, page, problems } = await guestPage(browser, () => ({ left: 0.5, blocked: false, paused: [] }), { undoMs: 600 });
      try {
        await context.route(/\/api\/evaluators\/starters\/evaluators$/, (route) =>
          route.fulfill({ json: { evaluators: [{ name: "Therapy Goal", questions: [{ id: QUESTION, on: true, kind: "yesno", text: "Is it a goal?", yes: "", no: "", options: [] }] }] } }),
        );
        await until(async () => (await listText(page)).includes("Evaluated by Clear goal"));
        await page.getByRole("button", { name: "Start over" }).click();
        await until(async () => (await page.evaluate(() => document.querySelector("notice-stack").shadowRoot.textContent)).includes("Starting over."));
        assert.ok((await listText(page)).includes("Evaluated by Clear goal"), "nothing changes while the notice is up");
        await until(async () => (await listText(page)).includes("Evaluated by Therapy Goal"));
        assert.ok(!(await listText(page)).includes("Clear goal"));
        assert.equal(await bar(page), "Free use 50% left");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    for (const [name, freeUse, said, notice] of [
      ["10% or less", { left: 0.08, blocked: false, paused: [] }, "Free use 8% left", null],
      ["used up", { left: 0, blocked: false, paused: [] }, "Free use used up", "You have used all your free use."],
      ["paused for every guest", { left: 0.4, blocked: false, paused: ["jev", "anthropic"] }, "Free use 40% left", "Free trials are paused for now."],
      ["blocked", { left: 0.4, blocked: true, paused: [] }, "Free use ended", "This trial has ended."],
    ]) {
      // Browser: rendering and layout.
      test(`${name}: the bar says "${said}"${notice ? " and the box says why" : ""}`, async () => {
        const { context, page, problems } = await guestPage(browser, () => freeUse);
        try {
          await until(async () => (await bar(page)) === said);
          await page.getByRole("textbox", { name: "Write one sentence per line" }).click();
          await page.keyboard.insertText("Walk.");
          await until(async () => (await runBox(page)).notice === notice);
          assert.deepEqual(problems, []);
        } finally {
          await context.close();
        }
      });
    }
  });
}

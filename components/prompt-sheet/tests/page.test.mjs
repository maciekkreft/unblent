import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// What only a browser shows: Journal prompts under + Add sheet opens the sets with the
// keyboard on the first, a pick puts it in the first prompt's box, Escape folds the sheet into
// a card a reload keeps; an answer judged off the question gets its mark at the end of its
// box; with Vim keys on j and k step through the sets and the boxes; an earlier day's sheet
// is read only and says when its set changed. The decisions are tested in Node.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/design/journal`;

// The workshop profile's preferences, with Vim keys on.
const VIM_ON = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

const FEATURES = ["choice-points", "journal-prompts"];

const SET = "01K7TEST0000000000000PSET1";
const SET_BODY = { name: "Three good things", occasion: "Evening", basedOn: "Flourish, Martin Seligman", prompts: ["What went well today?", "Why did it happen?"], position: "a" };

const inSheet = (page, fn) =>
  page.evaluate((fn) => new Function("root", `return (${fn})(root)`)(document.querySelector("prompt-sheet").shadowRoot), fn.toString());
const focused = (page) => inSheet(page, (root) => root.activeElement?.closest(".box")?.dataset.key?.split(":")[1] ?? root.activeElement?.className ?? null);

// One set of the test's own, so the list does not depend on the starter sets.
const withSet = (context) => context.request.put(`${BASE_URL}/api/prompt-sets/${SET}`, { data: { ...SET_BODY, baseVersion: null } });

// The way in: Journal prompts under + Add sheet.
const addSheet = async (page) => {
  await page.locator("sheet-picker .new").click();
  await page.locator('sheet-picker .pick[data-id="prompts"]').click();
};

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`prompt-sheet in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: a reload against real storage.
    test("a new sheet shows the sets, a pick opens the prompts, Escape folds it into a card a reload keeps", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("prompt-sheet"));
      try {
        assert.ok((await withSet(context)).ok());
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await page.locator("sheet-picker .new").waitFor();
        assert.equal(await page.locator("prompt-sheet").evaluate((el) => getComputedStyle(el).display), "none", "a day without one takes no room");
        await addSheet(page);
        const sheet = page.locator("prompt-sheet");
        await until(async () => (await focused(page)) === "set");
        const set = sheet.locator(".set", { hasText: "Three good things" });
        assert.match(await set.innerText(), /2 prompts · based on Flourish, Martin Seligman\s+Evening/);
        assert.equal(await sheet.locator(".note").innerText(), "Change your sets in Settings › Prompts.");
        await set.click();
        await until(async () => (await focused(page)) === "0");
        assert.match(await sheet.locator(".head").innerText(), /Three good things\s+Based on Flourish, Martin Seligman\s+Evening/);
        await page.keyboard.type("A walk in the sun");
        await page.keyboard.press("Escape");
        const card = () => inSheet(page, (root) => root.querySelector(".card")?.innerText.replace(/\s+/g, " ").trim() ?? null);
        await until(async () => (await card()) === "Three good things What went well today? A walk in the sun");
        assert.equal(await focused(page), "card", "the keyboard stays on the folded card");
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await card().catch(() => null)) === "Three good things What went well today? A walk in the sun");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("an answer judged off the question shows the mark at the end of its box and the prompt under it; one that fits shows none", async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("prompt-sheet"));
      try {
        assert.ok((await withSet(context)).ok());
        const page = await context.newPage();
        const problems = watch(page);
        await page.route("**/api/llm", async (route) => {
          const res = await route.fetch();
          const json = await res.json();
          await route.fulfill({ response: res, json: { ...json, jev: { ...json.jev, keySet: true }, decider: { ...json.decider, ready: true } } });
        });
        await page.route("**/api/llm/decide", (route) => {
          const off = /pizza/i.test(route.request().postDataJSON().state.answer);
          route.fulfill({ json: { answers: [{ id: "0000000000000000000000NSWR", p: off ? 0.05 : 0.95 }], inputTokens: 1, ms: 1 } });
        });
        // The check asks only while flags reports Journal prompts shown, so this runs on the
        // product page with the features answer replaced (the feature is held back until
        // released).
        await context.route(/\/api\/flags$/, (route) => route.fulfill({ json: { off: [], hidden: [], released: FEATURES, shown: FEATURES } }));
        await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
        await page.locator("book-shelf .tile", { hasText: "Journal" }).click();
        await addSheet(page);
        const sheet = page.locator("prompt-sheet");
        await sheet.locator(".set", { hasText: "Three good things" }).click();
        await until(async () => (await focused(page)) === "0");
        await page.keyboard.type("A walk in the sun");
        await sheet.locator(".box .cm-content").nth(1).click();
        await page.keyboard.type("Pizza is round");
        await page.keyboard.press("Tab");
        const mark = sheet.locator('.box[data-key$=":1"] .fit');
        await mark.waitFor();
        assert.equal(await mark.getAttribute("aria-label"), "This may answer something other than the question");
        assert.equal(await mark.getAttribute("title"), "This may answer something other than the question");
        assert.equal(await sheet.locator(".fit").count(), 1, "the answer that fits has no mark");
        assert.equal(await sheet.locator(".field").nth(1).locator("small").innerText(), "Why did it happen?");
        const at = await inSheet(page, (root) => {
          const box = root.querySelector('.box[data-key$=":1"]').getBoundingClientRect();
          const fit = root.querySelector(".fit").getBoundingClientRect();
          const text = root.querySelector('.box[data-key$=":1"] .cm-line').getBoundingClientRect();
          return { end: box.right - fit.right, clear: fit.left >= text.left };
        });
        assert.ok(at.end >= 0 && at.end < 16, "the mark stands at the end of the box");
        assert.ok(at.clear);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on, j and k step through the sets and the boxes, Escape folds onto the card, o adds a sheet", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 1000 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("prompt-sheet"));
      try {
        assert.ok((await withSet(context)).ok());
        await context.addInitScript((v) => localStorage.setItem("settings", v), VIM_ON);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await addSheet(page);
        await until(async () => (await focused(page)) === "set");
        const set = () => inSheet(page, (root) => root.activeElement?.dataset.set ?? null);
        const first = await set();
        await page.keyboard.press("j");
        assert.notEqual(await set(), first, "j moves to the next set");
        await page.keyboard.press("k");
        assert.equal(await set(), first, "k comes back");
        await page.keyboard.press("Enter");
        await until(async () => (await focused(page)) === "0");
        await page.keyboard.type("Walk");
        await page.keyboard.press("Escape");
        await page.keyboard.press("j");
        assert.equal(await focused(page), "1", "j on the last line goes to the next box");
        await page.keyboard.press("k");
        assert.equal(await focused(page), "0", "k on the first line comes back");
        await page.keyboard.press("Escape");
        await until(async () => (await focused(page)) === "card");
        await page.keyboard.press("o");
        await until(async () => (await focused(page)) === "set");
        await page.keyboard.press("Escape");
        await until(async () => (await page.locator("prompt-sheet .chooser").count()) === 0);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // An earlier day and its sheet arrive through the APIs under the test's own login.
    // Browser: rendering and layout.
    test("an earlier day's sheet opens to be read, with Close, and says when its set has changed", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("prompt-sheet"));
        assert.ok((await withSet(context)).ok());
        const then = Date.now() - 3 * 864e5;
        const at = new Date(then);
        const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
        const put = (path, data) => context.request.put(`${BASE_URL}/api/${path}`, { data });
        assert.equal((await put("journal/days", { record: { id: "01J00000000000000000000DAY", day, text: "Earlier", editedAt: then }, baseVersion: null })).status(), 200);
        const answers = [
          { prompt: "What went well?", answer: "A walk" },
          { prompt: "Why did it happen?", answer: "" },
        ];
        assert.ok((await put("prompt-sheets/01J0000000000000000000PSH1", { day, setId: SET, setName: "Three good things", basedOn: "", answers, baseVersion: null })).ok());
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await page.locator("journal-days .row", { hasText: "Earlier" }).click();
        const sheet = page.locator("prompt-sheet");
        const changed = "The set has changed since. This day keeps the prompts it was answered with.";
        await sheet.locator(".card", { hasText: changed }).waitFor();
        assert.doesNotMatch(await sheet.locator(".card").innerText(), /Why did it happen/, "an unanswered prompt is left out");
        await sheet.locator(".card").click();
        await sheet.locator(".close").waitFor();
        assert.equal(await sheet.locator(".done, .delete").count(), 0);
        assert.equal(await sheet.locator(".sheet .note").innerText(), changed);
        await sheet.locator(".box .cm-content").first().click();
        await page.keyboard.type("zzz");
        assert.equal(await sheet.locator(".box .cm-content").first().innerText(), "A walk", "the boxes cannot be typed in");
        await sheet.locator(".close").click();
        await sheet.locator(".card").waitFor();
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

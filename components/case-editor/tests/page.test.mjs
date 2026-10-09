import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Case tab on the Judge app page, walked as a user would. Jev is never called: the
// page's request to its own server is answered here from a table keyed by case text,
// with a deliberate miss.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn, shortUndo } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/apps/judge`;

// What the fake Jev picks, by case text; anything else is Other.
const PICKS = { "To have a big house.": "Goal", "To win the race.": "Value" };

const text = (page) => page.locator("case-editor textarea.text");
const menu = (page) => page.locator("case-editor select").first();
const row = (page, name) => page.locator("case-list .row[data-id]", { hasText: name });

async function open(page) {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await text(page).waitFor();
}

// A Jev key must be saved for llm to let a Judge through.
async function withKey(cookie) {
  const res = await fetch(`${BASE_URL}/api/llm`, {
    method: "PUT",
    headers: { "content-type": "application/json", Cookie: `unblent_session=${cookie}` },
    body: JSON.stringify({ jevKey: "not-a-real-key" }),
  });
  assert.equal(res.status, 200);
}

async function judgeable(context) {
  const cookie = forgeCookie("case-editor");
  await withKey(cookie);
  await signedIn(context, cookie);
  await context.route("**/api/llm/decide", (route) => {
    const body = route.request().postDataJSON();
    const name = PICKS[body.state.text] ?? "Other";
    const answers = body.questions.map((q) => {
      if (q.kind !== "pick") return { id: q.id, p: 0.72 };
      const o = q.options.find((x) => x.name === name);
      return { id: q.id, p: 0.58, choice: o.id, probabilities: q.options.map((x) => ({ id: x.id, p: x === o ? 0.58 : 0.21 })), confidence: 0.4 };
    });
    route.fulfill({ json: { answers, inputTokens: 40, ms: 5 } });
  });
}

for (const engine of ENGINES) {
  describe(`the Case tab in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    const run = (name, body, options = {}) =>
      test(name, async () => {
        const context = await browser.newContext(options);
        context.setDefaultTimeout(4000);
        try {
          const page = await context.newPage();
          const problems = watch(page);
          await body(page, context);
          assert.deepEqual(problems, []);
        } finally {
          await context.close();
        }
      });

    run("a picked case shows its text and its right answer, and signed out Judge says why", async (page) => {
      await open(page);
      await row(page, "To win the race.").click();
      await until(async () => (await text(page).inputValue()) === "To win the race.");
      assert.equal(await menu(page).locator("option:checked").textContent(), "Goal");
      assert.equal(await page.locator("case-editor .line").textContent(), "Sign in to judge.");
      assert.ok(await page.locator("case-editor .judge").isDisabled());
    });

    run("a new case with a right answer is kept across a reload", async (page) => {
      await open(page);
      await page.locator("case-list .row.new").click();
      await until(async () => (await text(page).inputValue()) === "");
      await text(page).fill("To travel the world.");
      await menu(page).selectOption({ label: "Goal" });
      await until(async () => (await row(page, "To travel the world.").count()) === 1);
      await page.reload();
      await text(page).waitFor();
      assert.equal(await text(page).inputValue(), "To travel the world.", "the new case is still the open one");
      assert.equal((await row(page, "To travel the world.").locator(".sub").textContent()).trim(), "Right answer: Goal");
    });

    run("Judge shows the pick, how sure Jev is, and a tick for the right answer", async (page, context) => {
      await judgeable(context);
      await open(page);
      await until(async () => (await page.locator("case-editor .line").textContent()) === "Judges this case with Goal or value.");
      await page.locator("case-editor .judge").click();
      const card = page.locator("case-editor .card");
      await card.waitFor();
      assert.equal(await card.locator("h3").textContent(), "Goal or value");
      assert.equal(await card.locator(".pick").textContent(), "Goal");
      assert.equal(await card.locator(".sure").textContent(), "58% sure");
      assert.equal((await card.locator(".verdict").textContent()).trim(), "Right");
      assert.deepEqual(await card.locator(".opts .pct").allTextContents(), ["21%", "21%"]);
    });

    run("a miss shows a cross and the right answer", async (page, context) => {
      await judgeable(context);
      await open(page);
      await row(page, "To win the race.").click();
      await until(async () => (await text(page).inputValue()) === "To win the race.");
      await until(async () => await page.locator("case-editor .judge").isEnabled());
      await page.locator("case-editor .judge").click();
      const verdict = page.locator("case-editor .card .verdict.wrong");
      await verdict.waitFor();
      assert.equal((await verdict.textContent()).trim(), "Right answer: Goal");
      assert.equal(await page.locator("case-editor .card .pick").textContent(), "Value");
      await until(async () => (await row(page, "To win the race.").locator(".mark").getAttribute("title")) === "Wrong");
    });

    test("Delete case goes at once, and Undo brings it back open", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await shortUndo(context, 2000);
        const page = await context.newPage();
        const problems = watch(page);
        await open(page);
        await row(page, "To win the match.").click();
        await until(async () => (await text(page).inputValue()) === "To win the match.");
        await page.locator("case-editor .delete").click();
        await until(async () => (await row(page, "To win the match.").count()) === 0);
        assert.equal(await text(page).inputValue(), "To have a big house.", "its neighbour opens");
        const notice = page.locator("notice-stack .notice.removal");
        await notice.getByRole("button", { name: "Undo" }).click();
        await until(async () => (await row(page, "To win the match.").count()) === 1);
        await until(async () => (await text(page).inputValue()) === "To win the match.");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    run("on the phone, a case picked in the Cases drawer closes it and shows the case", async (page, context) => {
      await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
      await open(page);
      const left = page.locator("dock-desk .dock.left");
      await page.locator('dock-desk .dock.left .rail button[aria-label="Unfold"]').click();
      await until(async () => !(await left.getAttribute("class")).includes("folded"));
      await row(page, "To win the race.").click();
      await until(async () => (await left.getAttribute("class")).includes("folded"));
      await until(async () => (await text(page).inputValue()) === "To win the race.");
      assert.ok(await text(page).isVisible());
    });
  });
}

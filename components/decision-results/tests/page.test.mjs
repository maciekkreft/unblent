import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Results tab on the Judge app page, walked as a user would. Jev is never called: the
// page's request to its own server is answered here from a table keyed by case text,
// with the two deliberate misses of the mockup.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/apps/judge`;

const GOALS = ["To have a big house.", "To win the match.", "To get good marks.", "To win friends.", "To lose five kilograms in weight.", "To win the race."];
const VALUES = ["Caring for and protecting your family.", "Playing fairly, enthusiastically and skilfully.", "Applying yourself fully to your studies, and exploring new ideas.", "To be warm, friendly, outgoing, supportive and genuine.", "Looking after, strengthening and maintaining your body.", "To run to the best of your ability."];
const WARM = "To be warm, friendly, outgoing, supportive and genuine.";
const PICKS = {
  ...Object.fromEntries(GOALS.map((t) => [t, "Goal"])),
  ...Object.fromEntries(VALUES.map((t) => [t, "Value"])),
  [WARM]: "Goal",
  "What time does the train leave?": "Value",
};

// A Jev key must be saved for llm to let a Judge through.
async function judgeable(context) {
  const cookie = forgeCookie("decision-results");
  const res = await fetch(`${BASE_URL}/api/llm`, {
    method: "PUT",
    headers: { "content-type": "application/json", Cookie: `unblent_session=${cookie}` },
    body: JSON.stringify({ jevKey: "not-a-real-key" }),
  });
  assert.equal(res.status, 200);
  await signedIn(context, cookie);
  // The yes / no questions follow the pick: "a goal?" is yes for a Goal pick.
  await context.route("**/api/llm/decide", (route) => {
    const body = route.request().postDataJSON();
    const name = PICKS[body.state.text] ?? "Other";
    const answers = body.questions.map((q) => {
      if (q.kind !== "pick") return { id: q.id, p: q.instructions.includes(name.toLowerCase()) ? 0.9 : 0.1 };
      const o = q.options.find((x) => x.name === name);
      const p = body.state.text === WARM ? 0.58 : 0.9;
      return { id: q.id, p, choice: o.id, probabilities: q.options.map((x) => ({ id: x.id, p: x === o ? p : 0.05 })), confidence: 0.5 };
    });
    route.fulfill({ json: { answers, inputTokens: 40, ms: 5 } });
  });
}

const results = (page) => page.locator("decision-results");
// The stage's tab in front: Case or Results.
const front = async (page) =>
  (await page.locator('dock-desk [role="tab"][aria-selected="true"]').allTextContents()).map((t) => t.trim()).find((t) => t === "Case" || t === "Results");

const table = (page) =>
  results(page)
    .locator(".block")
    .first()
    .evaluate((b) => [...b.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((td) => `${td.textContent}:${td.className}`)));

async function judgeAll(page) {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await until(async () => (await page.locator("case-list .judge").isEnabled().catch(() => false)));
  await page.locator("case-list .judge").click();
}

for (const engine of ENGINES) {
  describe(`the Results tab in ${engine.name}`, { timeout: 60000 }, () => {
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
          await body(page, context);
          assert.deepEqual(problems, []);
        } finally {
          await context.close();
        }
      });

    run("Judge all brings Results forward with 16 of 18 right and the table", async (page, context) => {
      await judgeable(context);
      await judgeAll(page);
      const summary = results(page).locator(".summary");
      await until(async () => (await summary.allTextContents()).join() === "16 of 18 right");
      assert.equal(await front(page), "Results");
      assert.ok(await summary.isVisible());
      assert.deepEqual(await results(page).locator(".groups .n").allTextContents(), ["6 of 6", "5 of 6", "5 of 6"]);
      assert.deepEqual(await table(page), [
        ["6:hit", "0:zero", "0:zero"],
        ["1:miss", "5:hit", "0:zero"],
        ["0:zero", "1:miss", "5:hit"],
      ]);
      assert.deepEqual(await results(page).locator(".miss-row .sub").allTextContents(), [
        "Right answer Value · Jev picked Goal, 58% sure",
        "Right answer Other · Jev picked Value, 90% sure",
      ]);
    });

    run("a clicked miss opens its case in the Case tab", async (page, context) => {
      await judgeable(context);
      await judgeAll(page);
      const miss = results(page).locator(".miss-row", { hasText: WARM });
      await miss.waitFor();
      await miss.click();
      await until(async () => (await front(page)) === "Case");
      await until(async () => (await page.locator("case-editor textarea.text").inputValue()) === WARM);
    });

    run("with the yes / no tool on, Judge all adds a block per question", async (page, context) => {
      await judgeable(context);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await page.locator('rubric-list input[aria-label="Use Goal or value (yes / no) when judging"]').check();
      await until(async () => (await page.locator("case-list .run .hint").textContent()) === "18 cases, 2 tools on");
      await page.locator("case-list .judge").click();
      await until(async () => (await results(page).locator(".summary").count()) === 3 && !(await results(page).locator(".progress").count()));
      assert.deepEqual(await results(page).locator(".summary").allTextContents(), ["16 of 18 right", "17 of 18 right", "16 of 18 right"]);
      assert.deepEqual(await results(page).locator(".block .qtext").allTextContents(), [
        "Goal or value · Is this a goal, a value, or neither?",
        "Goal or value (yes / no) · Is this a goal?",
        "Goal or value (yes / no) · Is this a value?",
      ]);
      assert.deepEqual(await results(page).locator(".block").nth(1).locator(".groups > span:first-child, .groups > span:nth-child(4)").allTextContents(), ["Yes", "No"]);
      assert.equal(await results(page).locator(".block").nth(1).locator(".miss-row .sub").textContent(), "Right answer No · Jev said 90% yes");
    });

    run("on the phone, Judge all from the Cases drawer closes it and shows Results", async (page, context) => {
      await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
      await judgeable(context);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      const left = page.locator("dock-desk .dock.left");
      await page.locator('dock-desk .dock.left .rail button[aria-label="Unfold"]').click();
      await until(async () => !(await left.getAttribute("class")).includes("folded"));
      await until(async () => await page.locator("case-list .judge").isEnabled());
      await page.locator("case-list .judge").click();
      await until(async () => (await left.getAttribute("class")).includes("folded"));
      const summary = results(page).locator(".summary");
      await until(async () => (await summary.allTextContents()).join() === "16 of 18 right");
      assert.ok(await summary.isVisible());
    });
  });
}

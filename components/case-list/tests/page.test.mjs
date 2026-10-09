import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Cases panel on the Judge app page, walked as a user would. Jev is never called:
// the page's request to its own server is answered here from a table keyed by case
// text, with two deliberate misses.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/apps/judge`;

// The right pick per seed case, and the two the fake Jev gets wrong.
const GOALS = ["To have a big house.", "To win the match.", "To get good marks.", "To win friends.", "To lose five kilograms in weight.", "To win the race."];
const VALUES = ["Caring for and protecting your family.", "Playing fairly, enthusiastically and skilfully.", "Applying yourself fully to your studies, and exploring new ideas.", "To be warm, friendly, outgoing, supportive and genuine.", "Looking after, strengthening and maintaining your body.", "To run to the best of your ability."];
const PICKS = {
  ...Object.fromEntries(GOALS.map((t) => [t, "Goal"])),
  ...Object.fromEntries(VALUES.map((t) => [t, "Value"])),
  "To be warm, friendly, outgoing, supportive and genuine.": "Goal",
  "What time does the train leave?": "Value",
};

// The list as the user reads it: each case's first line, the line under it, its mark,
// and whether it is the open one.
const cases = (page) =>
  page.evaluate(() =>
    [...document.querySelector("case-list").shadowRoot.querySelectorAll(".row[data-id]")].map((r) => ({
      name: r.querySelector(".name").textContent.trim(),
      sub: r.querySelector(".sub").textContent.trim(),
      mark: r.querySelector(".mark")?.getAttribute("title") ?? null,
      open: r.classList.contains("current"),
    })),
  );

async function open(page) {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await until(async () => (await cases(page).catch(() => [])).length > 0);
}

// A Jev key must be saved for llm to let a Judge through (no-key otherwise).
async function withKey(cookie) {
  const res = await fetch(`${BASE_URL}/api/llm`, {
    method: "PUT",
    headers: { "content-type": "application/json", Cookie: `unblent_session=${cookie}` },
    body: JSON.stringify({ jevKey: "not-a-real-key" }),
  });
  assert.equal(res.status, 200);
}

for (const engine of ENGINES) {
  describe(`the Cases panel in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    test("the panel lists the 18 example cases with their right answers", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await open(page);
        const list = await cases(page);
        assert.equal(list.length, 18);
        assert.deepEqual(list[0], { name: "To have a big house.", sub: "Right answer: Goal", mark: null, open: true });
        assert.equal(await page.locator("case-list .foot").textContent(), "Cases are kept on this device.");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    test("signed out, Judge all is greyed out and says to sign in", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await open(page);
        await until(async () => (await page.locator("case-list .run .hint").textContent()) === "Sign in to judge.");
        assert.ok(await page.locator("case-list .judge").isDisabled());
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    test("Judge all shows its progress, then a tick or a cross on every case", async () => {
      const cookie = forgeCookie("case-list");
      await withKey(cookie);
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, cookie);
        // Each answer waits a little, so the progress line is seen.
        await context.route("**/api/llm/decide", async (route) => {
          const body = route.request().postDataJSON();
          const name = PICKS[body.state.text] ?? "Other";
          await new Promise((r) => setTimeout(r, 30));
          const answers = body.questions.map((q) => {
            const o = q.options.find((x) => x.name === name);
            return { id: q.id, p: 0.9, choice: o.id, probabilities: q.options.map((x) => ({ id: x.id, p: x === o ? 0.9 : 0.05 })), confidence: 0.8 };
          });
          route.fulfill({ json: { answers, inputTokens: 40, ms: 30 } });
        });
        const page = await context.newPage();
        const problems = watch(page);
        await open(page);
        await until(async () => (await page.locator("case-list .run .hint").textContent()) === "18 cases, 1 tool on");
        await page.locator("case-list .judge").click();
        await page.locator("case-list .progress").waitFor();
        assert.match(await page.locator("case-list .progress span").textContent(), /^Judging \d+ of 18…$/);
        assert.ok(await page.locator("case-list .judge").isDisabled(), "Judge all is greyed out while it runs");
        await until(async () => (await cases(page)).every((c) => c.mark === "Right" || c.mark === "Wrong"), 4000);
        const list = await cases(page);
        assert.deepEqual(
          list.filter((c) => c.mark === "Wrong").map((c) => c.name),
          ["To be warm, friendly, outgoing, supportive and genuine.", "What time does the train leave?"],
        );
        assert.equal(await page.locator("case-list .progress").count(), 0);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    test("a clicked case becomes the open one", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await open(page);
        await page.locator("case-list .row[data-id]", { hasText: "To win the race." }).click();
        await until(async () => (await cases(page)).find((c) => c.open)?.name === "To win the race.");
        assert.equal((await cases(page)).filter((c) => c.open).length, 1);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Jev key row under Evaluating. The page's reads of its own llm server are answered
// here, so no key reaches Jev: first an account with no key, then the picture after one is saved.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const picture = (jev) => ({
  provider: "echo",
  providers: [
    { id: "anthropic", label: "Anthropic", keySet: false, needsKey: true },
    { id: "echo", label: "Echo", keySet: true, needsKey: false },
  ],
  model: "echo",
  models: [{ id: "echo", label: "Echo" }],
  effort: "default",
  efforts: ["default", "low", "medium", "high", "xhigh", "max"],
  ttl: "1h",
  jev,
});

const judging = (page) =>
  page.evaluate(() => {
    const group = document.querySelector("settings-sheet")?.shadowRoot?.querySelector(".judging");
    return group
      ? {
          text: group.textContent.replace(/\s+/g, " ").trim(),
          input: !!group.querySelector("input"),
          buttons: [...group.querySelectorAll("button")].map((b) => b.textContent.trim()),
        }
      : null;
  });

for (const engine of ENGINES) {
  describe(`Settings in ${engine.name}`, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    // Browser: a gesture.
    test("a new account has no Jev key until it saves its own", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("jev-key"));
        const saved = [];
        await context.route("**/api/llm", async (route) => {
          if (route.request().method() === "PUT") {
            saved.push(route.request().postDataJSON());
            return route.fulfill({ json: picture({ keySet: true }) });
          }
          return route.fulfill({ json: picture({ keySet: false }) });
        });
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/llm`, { waitUntil: "domcontentloaded" });

        await until(async () => (await judging(page))?.input);
        assert.deepEqual((await judging(page)).buttons, ["Save"], "no key to replace or remove");

        await page.locator('settings-sheet .key input[aria-label="Jev key"]').fill("jev-not-a-real-key");
        await page.locator("settings-sheet .judging button", { hasText: "Save" }).click();
        await until(async () => (await judging(page))?.text.includes("Key saved"));
        assert.deepEqual(saved, [{ jevKey: "jev-not-a-real-key" }]);
        assert.deepEqual((await judging(page)).buttons, ["Replace", "Remove"]);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("the Vim keys list is folded away until asked for, with the switch on or off", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/settings`, { waitUntil: "domcontentloaded" });
        const fold = page.locator("settings-sheet details.keys-fold");
        const list = fold.locator("dl.keys").first();

        await fold.waitFor();
        assert.equal(await fold.getAttribute("open"), null, "the fold starts closed");
        assert.equal(await list.isVisible(), false, "the keys are hidden while it is closed");

        await fold.locator("summary", { hasText: "Show the keys" }).click();
        await until(() => list.isVisible());
        assert.ok((await fold.textContent()).includes("Ctrl+h, Ctrl+l"));

        await page.locator("settings-sheet .switches label", { hasText: "Vim keys" }).locator("input").click();
        await until(async () =>
          page.evaluate(() => JSON.parse(localStorage.getItem("settings") || "null")?.vimKeys === true),
        );
        assert.notEqual(await fold.getAttribute("open"), null, "turning Vim keys on leaves the fold open");
        assert.equal(await list.isVisible(), true);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("the sheet ends with a feedback link that opens in a new tab", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/settings`, { waitUntil: "domcontentloaded" });
        const line = page.locator("settings-sheet p.feedback");
        await line.waitFor();
        const seen = await line.evaluate((p) => {
          const a = p.querySelector("a");
          return {
            last: p === [...p.parentNode.children].at(-1),
            text: p.textContent.replace(/\s+/g, " ").trim(),
            href: a.getAttribute("href"),
            target: a.getAttribute("target"),
            rel: a.getAttribute("rel"),
            icon: !!a.querySelector("svg"),
          };
        });
        assert.deepEqual(seen, {
          last: true,
          text: "Something not working, or an idea? Send feedback",
          href: "https://github.com/maciekkreft/unblent/issues/new/choose",
          target: "_blank",
          rel: "noopener",
          icon: true,
        });
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

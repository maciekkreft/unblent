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

    // Browser: a gesture.
    test("the Mac app's Ollama rows: running, a changed address that does not answer, no key box", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("ollama-rows"));
        const ollama = (address, running) => ({
          provider: "ollama",
          providers: [
            { id: "ollama", label: "Ollama", keySet: true, needsKey: false },
            { id: "anthropic", label: "Anthropic", keySet: false, needsKey: true },
          ],
          model: running ? "lfm3:latest" : "",
          models: running ? [{ id: "lfm3:latest", label: "lfm3" }] : [],
          effort: "on",
          efforts: ["on", "off"],
          ttl: "1h",
          ollama: { address, running },
        });
        const saved = [];
        await context.route("**/api/llm", async (route) => {
          if (route.request().method() === "PUT") {
            saved.push(route.request().postDataJSON());
            return route.fulfill({ json: ollama("http://localhost:9", false) });
          }
          return route.fulfill({ json: ollama("http://localhost:11434", true) });
        });
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/llm`, { waitUntil: "domcontentloaded" });
        const account = () =>
          page.evaluate(() => document.querySelector("settings-sheet")?.shadowRoot?.querySelector(".account")?.textContent.replace(/\s+/g, " ").trim() ?? "");

        await until(async () => (await account()).includes("Running at localhost:11434"));
        const text = await account();
        assert.ok(text.includes("Ollama (on this Mac)"), text);
        for (const gone of ["API key", "Cache lifetime", "Evaluating"]) assert.ok(!text.includes(gone), `${gone} is hidden: ${text}`);

        await page.locator("settings-sheet .ollama button", { hasText: "Change address" }).click();
        await page.locator('settings-sheet input[aria-label="Ollama address"]').fill("localhost:9");
        await page.keyboard.press("Enter");
        await until(async () => (await account()).includes("Ollama isn't running"));
        assert.deepEqual(saved, [{ address: "http://localhost:9" }]);
        assert.ok(!(await account()).includes("Model"), "no model to choose while it is not running");
        await page.locator("settings-sheet .ollama button", { hasText: "Try again" }).click();
        await until(() => saved.length === 2);
        assert.deepEqual(saved[1], { address: "http://localhost:9" });
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

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
  describe(`Settings in ${engine.name}`, { timeout: 30000 }, () => {
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
          model: running ? "gemma4:e4b-mlx" : "",
          models: running ? [{ id: "gemma4:e4b-mlx", label: "gemma4:e4b-mlx" }] : [],
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

    // Browser: a gesture.
    test("the Mac app's checks: Kev not downloaded shows the pull line, choosing Jev shows its key", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("decider-rows"));
        const mac = (decider) => ({
          ...picture({ keySet: false }),
          ollama: { address: "http://localhost:11434", running: true },
          decider,
          deciders: ["ollama", "jev"],
        });
        const saved = [];
        await context.route("**/api/llm", async (route) => {
          if (route.request().method() === "PUT") {
            saved.push(route.request().postDataJSON());
            return route.fulfill({ json: mac({ provider: "jev", model: "jev-latest", ready: false }) });
          }
          return route.fulfill({ json: mac({ provider: "ollama", model: "kev:0.8b-mlx-bf16", ready: false }) });
        });
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/llm`, { waitUntil: "domcontentloaded" });

        await until(async () => (await judging(page))?.text.includes("ollama pull kev:0.8b-mlx-bf16"));
        const before = await judging(page);
        assert.ok(before.text.includes("Ollama 0.40.4 or later"), before.text);
        assert.equal(before.input, false, "no Jev key box while Kev decides");
        assert.deepEqual(before.buttons, ["Change address", "Copy", "Try again"], "the Ollama row, as the chat has it, then the pull line");

        await page.locator("settings-sheet .judging select").selectOption("jev");
        await until(async () => (await judging(page))?.input);
        assert.deepEqual(saved, [{ decider: "jev" }]);
        assert.ok(!(await judging(page)).text.includes("ollama pull"), "the pull line goes with Kev");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("What the chat may read: j and k step through the group and tool switches and back, and a group's switch turns its tools off and on", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("tool-groups"));
        await context.addInitScript(() => localStorage.setItem("settings", JSON.stringify({ vimKeys: true })));
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/llm`, { waitUntil: "domcontentloaded" });
        const sheet = page.locator("settings-sheet");
        await sheet.locator(".tools summary").click();
        const boxes = sheet.locator(".tool-groups input[type=checkbox]");
        await sheet.locator(".tool-head").first().waitFor();
        const at = () => boxes.evaluateAll((els) => els.findIndex((e) => e.getRootNode().activeElement === e));
        const last = (await boxes.count()) - 1;

        await boxes.first().focus();
        await page.keyboard.press("k");
        assert.equal(await at(), 0, "k at the top stays on the first switch");
        await page.keyboard.press("j");
        await page.keyboard.press("ArrowDown");
        assert.equal(await at(), 2, "j and the down arrow each step one switch down");
        await page.keyboard.press("k");
        await page.keyboard.press("ArrowUp");
        assert.equal(await at(), 0, "k and the up arrow step back");
        await boxes.nth(last).focus();
        await page.keyboard.press("j");
        assert.equal(await at(), last, "j at the bottom stays on the last switch");

        // The second group's heading: Space turns all of its tools off, and again on.
        const group = sheet.locator(".tool-group").nth(1);
        const states = () => group.locator(".field:not(.tool-head) input").evaluateAll((els) => els.map((e) => e.checked));
        await group.locator(".tool-head input").focus();
        await page.keyboard.press("Space");
        await until(async () => (await states()).every((on) => !on));
        assert.equal(await group.locator(".tool-head input").isChecked(), false, "the heading is off with every tool off");
        await page.keyboard.press("Space");
        await until(async () => (await states()).every((on) => on));
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("Show the keys is there only while Vim keys is on, and starts folded", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/settings`, { waitUntil: "domcontentloaded" });
        const vim = page.locator("settings-sheet .switches label", { hasText: "Vim keys" }).locator("input");
        const summary = page.locator("settings-sheet .switches summary", { hasText: "Show the keys" });
        await vim.waitFor();
        assert.equal(await summary.count(), 0, "no keys to show while Vim keys is off");

        await vim.click();
        await summary.waitFor();
        const fold = page.locator("settings-sheet .switches details.keys-fold");
        const list = fold.locator("dl.keys").first();
        assert.equal(await fold.getAttribute("open"), null, "the fold starts closed");
        assert.equal(await list.isVisible(), false, "the keys are hidden while it is closed");
        await summary.click();
        await until(() => list.isVisible());
        assert.ok((await fold.textContent()).includes("Ctrl+h, Ctrl+l"));

        // The way back: Vim keys off takes the fold away again.
        await vim.click();
        await until(async () => (await summary.count()) === 0);
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

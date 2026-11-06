import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Reading aloud rows of Settings on the product page. /api/flags is routed, because
// data/flags.db is shared by every test (feature-flags' test says why). The Mac's rows are
// drawn from a routed /api/voice, since only a Mac's server answers here:"mac" and nothing
// may download; the website's rows use the throwaway server's own voice with the test voice.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const SIZE = 353746785;
const MAC_VOICES = [
  { id: "af_heart", label: "Heart" },
  { id: "af_bella", label: "Bella" },
  { id: "test", label: "Test voice" },
];
const mac = (state, done = 0) => ({ here: "mac", kokoro: { state, done, size: SIZE }, voice: "af_heart", voices: MAC_VOICES });

// The Reading aloud part as the user sees it: its rows' text, and the buttons and voices.
const reading = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("settings-sheet")?.shadowRoot;
    if (!root?.querySelector(".switches")) return null;
    const head = [...root.querySelectorAll(".group")].find((g) => g.textContent.trim() === "Reading aloud");
    if (!head) return { shown: false };
    const rows = [];
    for (let el = head.nextElementSibling; el && el.classList.contains("field"); el = el.nextElementSibling) rows.push(el);
    return {
      shown: true,
      text: rows.map((r) => r.textContent.replace(/\s+/g, " ").trim()).join(" | "),
      buttons: rows.flatMap((r) => [...r.querySelectorAll("button")].map((b) => b.textContent.trim())),
      voices: rows.flatMap((r) => [...r.querySelectorAll('select[aria-label="Voice"] option')].map((o) => o.textContent.trim())),
      bar: rows.some((r) => r.querySelector('[role="progressbar"]')),
    };
  });

async function open(browser, { hidden = [] } = {}) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  context.setDefaultTimeout(4000);
  const cookie = forgeCookie("reading");
  await signedIn(context, cookie);
  await context.route(/\/api\/flags$/, (route) =>
    route.fulfill({ json: { off: [], hidden, released: ["reading-aloud"], shown: ["reading-aloud"].filter((f) => !hidden.includes(f)) } }),
  );
  return { context, cookie };
}

async function gear(context) {
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.locator("dock-desk .controls button.pill").click();
  await until(async () => (await reading(page)) !== null);
  return { page, problems };
}

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`Reading aloud in Settings in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: rendering and layout.
    test("the Mac shows Download voice with its size, a bar with Cancel while it runs, and the voices once ready", async () => {
      const { context } = await open(browser);
      try {
        let picture = mac("missing");
        const puts = [];
        await context.route(/\/api\/voice$/, async (route) => {
          const request = route.request();
          assert.equal(request.headers()["x-unblent-local"], "1", "a connected Mac reads with its own voice");
          if (request.method() === "PUT") {
            const body = request.postDataJSON();
            puts.push(body);
            picture = body.download === "start" ? mac("downloading", 120e6) : mac("missing");
          }
          return route.fulfill({ json: picture });
        });
        const { page, problems } = await gear(context);
        await until(async () => (await reading(page))?.shown);
        let seen = await reading(page);
        assert.ok(seen.text.startsWith("Voice model Kokoro · not downloaded Download voice · 354 MB"), seen.text);
        assert.deepEqual(seen.voices, [], "no voice to choose before the download");

        await page.locator("settings-sheet button", { hasText: "Download voice" }).click();
        await until(async () => (await reading(page))?.bar);
        seen = await reading(page);
        assert.ok(seen.text.includes("120 of 354 MB"), seen.text);
        assert.deepEqual(seen.buttons, ["Cancel"]);

        await page.locator("settings-sheet button", { hasText: "Cancel" }).click();
        await until(async () => (await reading(page))?.buttons.some((b) => b.startsWith("Download voice")));
        assert.deepEqual(puts, [{ download: "start" }, { download: "cancel" }]);

        picture = mac("ready", SIZE);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.locator("dock-desk .controls button.pill").click();
        await until(async () => (await reading(page))?.voices?.length);
        seen = await reading(page);
        assert.ok(seen.text.includes("Kokoro · ready on this Mac"), seen.text);
        assert.deepEqual(seen.voices, ["Heart", "Bella"], "the test voice is listed only in the workshop");
        assert.deepEqual(seen.buttons, ["Play a sample"]);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("the rows are hidden while Reading aloud is hidden", async () => {
      const { context } = await open(browser, { hidden: ["reading-aloud"] });
      try {
        await context.route(/\/api\/voice$/, (route) => route.fulfill({ json: mac("ready", SIZE) }));
        const { page, problems } = await gear(context);
        // The tools fold is drawn last of what the starting asks bring, after voice's answer.
        await page.locator("settings-sheet summary", { hasText: "What the chat may read" }).waitFor();
        assert.deepEqual(await reading(page), { shown: false });
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("the website saves an Inworld key, then offers the voices", async () => {
      const { context } = await open(browser);
      try {
        const { page, problems } = await gear(context);
        await until(async () => (await reading(page))?.shown);
        let seen = await reading(page);
        assert.ok(seen.text.startsWith("Inworld key Save"), seen.text);
        assert.deepEqual(seen.voices, [], "no voice to choose before a key is saved");

        await page.locator('settings-sheet input[aria-label="Inworld key"]').fill("iw-not-a-real-key");
        await page.locator("settings-sheet .field", { hasText: "Inworld key" }).locator("button", { hasText: "Save" }).click();
        await until(async () => (await reading(page))?.voices?.length);
        seen = await reading(page);
        assert.ok(seen.text.startsWith("Inworld key Key saved"), seen.text);
        assert.deepEqual(seen.voices, ["Ashley", "Dennis", "Olivia", "Timothy"], "the test voice is listed only in the workshop");

        await page.locator('settings-sheet select[aria-label="Voice"]').selectOption("Dennis");
        await until(() => page.locator('settings-sheet select[aria-label="Voice"]').evaluate((s) => s.selectedOptions[0].textContent === "Dennis"));
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("Play a sample reads a sentence in the voice picked, and reads as playing until it ends", async () => {
      const { context } = await open(browser);
      try {
        // The test voice reads silence for free; picked before the page loads so the
        // sample costs nothing. The key only makes the website show the voices.
        for (const data of [{ key: "iw-not-a-real-key" }, { voice: "test" }]) {
          const put = await context.request.put(`${BASE_URL}/api/voice`, { data, headers: { "X-Unblent-Local": "1" } });
          assert.equal(put.status(), 200);
        }
        const spoken = [];
        await context.route(/\/api\/voice\/speak$/, async (route) => {
          spoken.push(route.request().postDataJSON().text);
          return route.continue();
        });
        const { page, problems } = await gear(context);
        await until(async () => (await reading(page))?.voices?.includes("Test voice"));
        await page.locator("settings-sheet button", { hasText: "Play a sample" }).click();
        await until(async () => (await reading(page))?.buttons.includes("Playing Test voice…"));
        assert.equal(spoken.length, 1);
        assert.match(spoken[0], /read aloud/);
        await until(async () => (await reading(page))?.buttons.includes("Play a sample"));
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

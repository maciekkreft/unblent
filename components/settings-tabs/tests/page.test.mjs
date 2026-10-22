import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The gear's sheet on the product page (12): everyone sees Settings and Generators, and
// the admin sees Administration last, which shows People, Limits and Guest keys;
// Administration never asks the server for anyone else.
// Who is the admin, who came and what they spent are answered by request routing, so
// nothing here makes an admin in the throwaway registry or spends anything; what the
// server answers is tested in session's and llm's own tests.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const NOW = Date.now();
const PEOPLE = [
  { userId: "admin", name: "Admin", guest: false, admin: true, firstSeen: NOW - 9e9, lastSeen: NOW, country: "PL", city: "Warsaw", browser: "Safari", system: "macOS", device: "desk", space: 43e6 },
  { userId: "g2", name: "Guest 2", guest: true, admin: false, firstSeen: NOW - 6e5, lastSeen: NOW - 6e4, country: "DE", city: "Berlin", browser: "Chrome", system: "Android", device: "phone", space: 12288 },
  { userId: "g1", name: "Guest 1", guest: true, admin: false, firstSeen: NOW - 2e8, lastSeen: NOW - 2e8, country: "US", city: "Austin", browser: "Firefox", system: "Windows", device: "desk", space: 4096 },
];
const spending = (guest) => ({
  allGuests: { spent: 1.32, limit: 10 },
  guest,
  providers: [
    { id: "jev", label: "Jev by typesafe.ai", spent: 0.32, limit: null, guestKeySet: true, price: "$42 per billion tokens read" },
    { id: "anthropic", label: "Anthropic", spent: 1, limit: null, guestKeySet: false, price: "Each model's published price per million tokens" },
  ],
  guests: [
    { userId: "g1", spent: 1, blocked: true },
    { userId: "g2", spent: 0.32, blocked: false },
  ],
});

const tabs = (page) =>
  page.evaluate(() => [...document.querySelector("settings-tabs").shadowRoot.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim()));
const slotted = (page) =>
  page.evaluate(() => document.querySelector("settings-tabs").shadowRoot.querySelector("slot").assignedElements().map((e) => e.localName));
const text = (page, tag) =>
  page.evaluate((tag) => document.querySelector(tag).shadowRoot.textContent.replace(/\s+/g, " ").trim(), tag);
const openGear = (page) => page.locator("dock-desk .controls button.pill").click();

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`the gear's sheet in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: rendering and layout.
    test(`the admin sees Administration beside Settings in ${engine.name}`, async () => {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, forgeCookie("admin"));
        await context.route(/\/api\/session\/me$/, async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, json: { ...(await response.json()), admin: true, name: "Admin" } });
        });
        await context.route(/\/api\/session\/people$/, (route) => route.fulfill({ json: { people: PEOPLE } }));
        let picture = spending(1);
        const edits = [];
        await context.route(/\/api\/llm\/spending$/, (route) => route.fulfill({ json: picture }));
        await context.route(/\/api\/llm\/limits$/, (route) => {
          const body = route.request().postDataJSON();
          edits.push(body);
          picture = spending(body.guest ?? picture.guest);
          return route.fulfill({ json: picture });
        });
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await openGear(page);
        await until(async () => (await tabs(page)).length === 3);
        assert.deepEqual(await tabs(page), ["Settings", "Generators", "Administration"]);
        assert.deepEqual(await slotted(page), ["settings-sheet"], "Settings is shown first");

        await page.locator('settings-tabs [role="tab"]', { hasText: "Administration" }).click();
        assert.deepEqual(await slotted(page), ["people-list", "guest-limits", "evaluator-starters"]);
        await until(async () => (await page.locator("people-list tbody tr").count()) === 3);
        const people = await text(page, "people-list");
        for (const said of ["$1.32 of $10.00", "Jev by typesafe.ai", "no guest key", "1 today · 1 blocked", "You · admin", "own keys", "Guest 1 · blocked", "Berlin, DE", "Chrome · Android · phone", "$0.32", "12 KB"]) {
          assert.ok(people.includes(said), `People says "${said}": ${people}`);
        }

        await until(async () => (await page.locator("guest-limits .key").count()) === 2);
        const limits = await text(page, "guest-limits");
        for (const said of ["Each guest, in total", "Jev, all guests", "Key saved", "Without a guest key, guests are not offered Anthropic."]) {
          assert.ok(limits.includes(said), `Limits says "${said}": ${limits}`);
        }
        assert.equal(await page.locator('guest-limits input[aria-label="Anthropic, all guests"]').getAttribute("placeholder"), "no own limit");
        assert.equal(await page.locator('guest-limits input[aria-label="Anthropic key"]').getAttribute("placeholder"), "Paste your Anthropic key");

        // A limit applies at once and the box shows the server's answer.
        const each = page.locator('guest-limits input[aria-label="Each guest, in total"]');
        assert.equal(await each.inputValue(), "$1.00");
        await each.fill("2");
        await each.press("Enter");
        await until(async () => (await each.inputValue()) === "$2.00");
        assert.deepEqual(edits, [{ guest: 2 }]);

        // Remove on a guest key waits out the undo window; Undo keeps the key (12).
        const keys = [];
        context.on("request", (req) => /\/api\/llm\/guestkeys$/.test(req.url()) && keys.push(req.postData()));
        const jev = page.locator('guest-limits .key[data-key="jev"]');
        await jev.getByRole("button", { name: "Remove" }).click();
        await until(async () => (await jev.innerText()).replace(/\s+/g, " ").trim() === "Key removed Undo");
        await jev.getByRole("button", { name: "Undo remove Jev key" }).click();
        await until(async () => (await jev.innerText()).replace(/\s+/g, " ").trim() === "Key saved Replace Remove");
        assert.deepEqual(keys, [], "nothing is removed inside the window");

        // The Who column stays in view while People scrolls sideways.
        const who = await page.evaluate(() => {
          const frame = document.querySelector("people-list").shadowRoot.querySelector(".table");
          frame.scrollLeft = frame.scrollWidth;
          const cell = frame.querySelector("tbody td:first-child");
          return { scrolled: frame.scrollLeft > 0, offset: cell.getBoundingClientRect().left - frame.getBoundingClientRect().left };
        });
        assert.ok(who.scrolled, "the table scrolls sideways in the sheet");
        assert.ok(who.offset >= 0 && who.offset <= 2, `Who stays at the frame's left edge: ${who.offset}`);

        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });

    // Browser: a reload against real storage.
    test(`the tab picked is still shown after a reload in ${engine.name}`, async () => {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, forgeCookie("admin"));
        await context.route(/\/api\/session\/me$/, async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, json: { ...(await response.json()), admin: true, name: "Admin" } });
        });
        await context.route(/\/api\/session\/people$/, (route) => route.fulfill({ json: { people: PEOPLE } }));
        await context.route(/\/api\/llm\/spending$/, (route) => route.fulfill({ json: spending(1) }));
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await openGear(page);
        await page.locator('settings-tabs [role="tab"]', { hasText: "Administration" }).click();
        // A reload cancels what is still loading, which the watch reports as a failure.
        await page.locator("people-list tbody tr").first().waitFor();
        await page.waitForLoadState("networkidle");
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await slotted(page)).join() === "people-list,guest-limits,evaluator-starters");
        await page.locator("people-list tbody tr").first().waitFor();
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test(`everyone else sees Settings and Generators, and Administration asks nothing, in ${engine.name}`, async () => {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, forgeCookie("account"));
        const asked = [];
        context.on("request", (req) => /\/api\/(session\/people|llm\/spending)$/.test(req.url()) && asked.push(req.url()));
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await openGear(page);
        await page.locator("settings-sheet h3").first().waitFor();
        await until(async () => (await tabs(page)).length === 2);
        assert.deepEqual(await tabs(page), ["Settings", "Generators"], "no Administration");
        assert.deepEqual(await slotted(page), ["settings-sheet"]);
        assert.deepEqual(asked, [], "Administration never asks for anyone but the admin");
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });
  });
}

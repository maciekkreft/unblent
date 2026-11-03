import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Usage tab of the gear's sheet on the product page. The summary is answered by
// request routing with a fixed picture, so the drawing does not depend on what was
// counted; what usage counts and answers is its own test. /api/flags is routed too,
// because data/flags.db is shared by every test (feature-flags' test says why).
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const MIN = 60000;
const pad = (n) => String(n).padStart(2, "0");
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// Two days this week and one long ago: Journal leads the week, Reading all of it.
const SUMMARY = {
  accounts: 1,
  days: [
    { day: daysAgo(0), feature: "journal", ms: 40 * MIN },
    { day: daysAgo(0), feature: "notes", ms: 10 * MIN },
    { day: daysAgo(1), feature: "reading", ms: 30 * MIN },
    { day: daysAgo(1), feature: "chats", ms: 20 * MIN },
    { day: daysAgo(100), feature: "reading", ms: 200 * MIN },
  ],
};
const ALL = { accounts: 4, days: SUMMARY.days.map((d) => ({ ...d, ms: d.ms * 3 })) };

const text = (tab) => tab.evaluate((el) => el.shadowRoot.textContent.replace(/\s+/g, " ").trim());

// One account on the product page with the Usage tab open. `me` is added to what the
// server says about the account; `settings` is this device's starting preferences.
async function open(browser, { me = {}, hidden = [], settings = null } = {}) {
  // Reduced motion: the charts draw at once, with nothing still moving under a click.
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, reducedMotion: "reduce" });
  context.setDefaultTimeout(4000);
  await signedIn(context, forgeCookie(me.admin ? "admin" : "user"));
  await context.route(/\/api\/session\/me$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), ...me } });
  });
  await context.route(/\/api\/flags$/, (route) =>
    route.fulfill({ json: { off: [], hidden, released: ["choice-points", "usage"], shown: ["choice-points", "usage"].filter((f) => !hidden.includes(f)) } }),
  );
  const asked = [];
  await context.route(/\/api\/usage\/summary/, (route) => {
    const who = new URL(route.request().url()).searchParams.get("who");
    asked.push(who);
    return route.fulfill({ json: who === "all" ? ALL : SUMMARY });
  });
  if (settings) await context.addInitScript((s) => localStorage.setItem("settings:product", JSON.stringify(s)), settings);
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.locator("dock-desk .controls button.pill").click();
  return { context, page, problems, asked, tab: page.locator("usage-tab") };
}

const showUsage = (page) => page.locator('settings-tabs [role="tab"]', { hasText: "Usage" }).click();
const COUNTING = { nav: [], usageCounting: true };

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`the Usage tab in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: rendering and layout.
    test(`the tiles, the flowing chart and the calendar draw the summary, and a feature is followed in all three, in ${engine.name}`, async () => {
      const { context, page, problems, tab } = await open(browser, { settings: COUNTING });
      try {
        await showUsage(page);
        const tree = tab.locator(".chart.tree svg");
        await tree.getByText("Journal").first().waitFor();
        const said = await text(tab);
        assert.ok(said.includes("1 h 40 min"), `the week's total: ${said}`);
        assert.ok(said.includes("This week you spent this long in Unblent, most of it in Journal (40%)."), said);
        assert.ok(said.includes("2 of 7 days in range active"), said);
        assert.equal(await tab.locator(".cal i[data-i]").count(), 182);
        assert.equal(await tab.locator(".cal i.out").count(), 175);
        assert.ok((await tab.locator(".chart.stream svg path").count()) >= 4, "the flowing chart has bands");
        assert.deepEqual((await tab.locator(".chip").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()), ["Journal 40 min", "Reading 30 min", "Chats 20 min", "Notes 10 min"]);

        // Following Reading: its chip is pressed, the others dim, the calendar takes its colour.
        const reading = tab.locator(".chip", { hasText: "Reading" });
        await reading.click();
        assert.equal(await reading.getAttribute("aria-pressed"), "true");
        assert.equal(await tab.locator(".chip.dim").count(), 3);
        assert.ok(((await tab.locator(".cal-wrap").getAttribute("style")) ?? "").includes("--color-feature-reading"));
        const fills = () => tree.locator("path").evaluateAll((ps) => [...new Set(ps.map((p) => p.getAttribute("fill")).filter(Boolean))]);
        await until(async () => (await fills()).length <= 3, 2000);
        // A tile is the same switch: Journal's tile follows Journal instead, a second click shows all.
        // Journal, the largest tile, takes the top left corner.
        await tab.locator(".chart.tree").click({ position: { x: 12, y: 12 } });
        await until(async () => (await tab.locator(".chip", { hasText: "Journal" }).getAttribute("aria-pressed")) === "true");
        await tab.locator(".chart.tree").click({ position: { x: 12, y: 12 } });
        await until(async () => (await tab.locator(".chip.dim").count()) === 0);

        await tab.getByRole("button", { name: "All", exact: true }).click();
        assert.ok((await text(tab)).includes("Since"), "All reads since the first month");
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test(`the admin sees You and All accounts, and All accounts asks for every account, in ${engine.name}`, async () => {
      const admin = await open(browser, { me: { admin: true, name: "Admin" }, settings: COUNTING });
      try {
        await showUsage(admin.page);
        const all = admin.tab.getByRole("button", { name: "All accounts" });
        await all.click();
        await until(async () => (await text(admin.tab)).includes("all 4 accounts spent"));
        assert.deepEqual(admin.asked, ["you", "all"]);
        await admin.tab.getByRole("button", { name: "You", exact: true }).click();
        await until(async () => (await text(admin.tab)).includes("you spent"));
        assert.deepEqual(admin.problems, [], `reported: ${admin.problems.join("; ")}`);
      } finally {
        await admin.context.close();
      }
    });

    // Browser: rendering and layout.
    test(`someone else sees only their own usage, in ${engine.name}`, async () => {
      const other = await open(browser, { me: { admin: false, name: "Sam" }, settings: COUNTING });
      try {
        await showUsage(other.page);
        await other.tab.locator(".chip").first().waitFor();
        assert.equal(await other.tab.getByRole("button", { name: "All accounts" }).count(), 0);
        assert.deepEqual(other.asked, ["you"]);
      } finally {
        await other.context.close();
      }
    });

    // Browser: a reload against real storage.
    test(`the switch is off at first, turns on, and is still on after a reload, in ${engine.name}`, async () => {
      const { context, page, problems, tab } = await open(browser);
      try {
        await showUsage(page);
        const share = tab.getByRole("switch", { name: "Share usage statistics from this device" });
        await share.waitFor();
        assert.equal(await share.isChecked(), false);
        assert.ok((await text(tab)).includes("Sharing is off. Turn it on to see your features here."));
        assert.equal(await tab.getByRole("button", { name: "Week" }).count(), 0, "no range while off");
        await share.click();
        await tab.locator(".chip").first().waitFor();
        assert.equal(await share.isChecked(), true);
        // The desk keeps the sheet open and the sheet keeps its tab across the reload.
        await page.reload({ waitUntil: "domcontentloaded" });
        await tab.locator(".chip").first().waitFor();
        assert.equal(await tab.getByRole("switch").isChecked(), true);
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });

    // Browser: a page's composition.
    test(`the tab is not offered while Usage is hidden, in ${engine.name}`, async () => {
      const { context, page, problems } = await open(browser, { hidden: ["usage"], settings: COUNTING });
      try {
        await page.locator('settings-tabs [role="tab"]', { hasText: "Features" }).waitFor();
        assert.equal(await page.locator('settings-tabs [role="tab"]', { hasText: "Usage" }).count(), 0);
        assert.equal(await page.locator("usage-tab").isVisible(), false);
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test(`the arrows, and h and l with Vim keys on, move along a row and back; Space follows a feature and Escape lets it go, in ${engine.name}`, async () => {
      const { context, page, problems, tab } = await open(browser, { settings: { ...COUNTING, vimKeys: true } });
      try {
        await showUsage(page);
        await tab.locator(".chip").first().waitFor();
        const focused = () => tab.evaluate((el) => el.shadowRoot.activeElement?.textContent.replace(/\s+/g, " ").trim() ?? null);
        await tab.getByRole("button", { name: "Week" }).focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(await focused(), "Month");
        await page.keyboard.press("l");
        assert.equal(await focused(), "All");
        await page.keyboard.press("l");
        assert.equal(await focused(), "All", "the end of the row stays put");
        await page.keyboard.press("h");
        await page.keyboard.press("ArrowLeft");
        assert.equal(await focused(), "Week");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Enter");
        assert.equal(await tab.getByRole("button", { name: "Month" }).getAttribute("aria-pressed"), "true");

        // Tab reaches the switch, then the chips.
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        assert.equal(await tab.evaluate((el) => el.shadowRoot.activeElement?.id), "share");
        await page.keyboard.press("Tab");
        assert.equal(await focused(), "Journal 40 min");
        await page.keyboard.press("l");
        assert.equal(await focused(), "Reading 30 min");
        await page.keyboard.press("Space");
        assert.equal(await tab.locator(".chip", { hasText: "Reading" }).getAttribute("aria-pressed"), "true");
        await page.keyboard.press("Escape");
        assert.equal(await tab.locator(".chip.dim").count(), 0, "Escape shows every feature again");
        assert.equal(await focused(), "Reading 30 min", "the keyboard stays where it was");
        await page.keyboard.press("h");
        assert.equal(await focused(), "Journal 40 min");
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });
  });
}

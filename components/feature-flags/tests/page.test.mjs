import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Features tab of the gear's sheet on the product page (12). Who the account is is
// answered by request routing, and /api/flags is answered by the routes too, because
// data/flags.db is shared: releasing a feature on the check's server would change what
// every other test sees. What the server answers is flags' own test.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const FEATURES = ["choice-points"];

const text = (page) => page.evaluate(() => document.querySelector("feature-flags").shadowRoot.textContent.replace(/\s+/g, " ").trim());

// One account on the product page with the Features tab open; `me` is added to what the
// server says about the account, and every Release and Show is kept by the route.
async function open(browser, me) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  context.setDefaultTimeout(4000);
  await signedIn(context, forgeCookie(me.admin ? "admin" : "guest"));
  await context.route(/\/api\/session\/me$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), ...me } });
  });
  const state = { released: ["choice-points"], shown: [...FEATURES], offline: false, puts: [] };
  await context.route(/\/api\/flags$/, async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      state.puts.push(body);
      if (state.offline) return route.abort();
      const list = body.column === "show" ? "shown" : "released";
      state[list] = body.on ? [...state[list], body.feature] : state[list].filter((f) => f !== body.feature);
    }
    const off = FEATURES.filter((f) => !state.released.includes(f));
    const hidden = FEATURES.filter((f) => (!me.admin && off.includes(f)) || !state.shown.includes(f));
    return route.fulfill({ json: { off, hidden, released: state.released, shown: state.shown } });
  });
  const page = await context.newPage();
  const problems = watch(page, [], { ignore: [/api\/flags/] });
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.locator("dock-desk .controls button.pill").click();
  await page.locator('settings-tabs [role="tab"]', { hasText: "Features" }).click();
  await page.locator("feature-flags").getByRole("switch").first().waitFor();
  return { context, page, problems, state, tab: page.locator("feature-flags") };
}

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`the Features tab in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: rendering and layout.
    test(`the admin holds back a feature and releases it again, and a refused switch goes back, in ${engine.name}`, async () => {
      const { context, page, problems, state, tab } = await open(browser, { admin: true, name: "Admin" });
      try {
        await until(async () => (await tab.getByRole("switch").count()) === 2);
        const said = await text(page);
        for (const line of ["Features", "Release", "Show", "Values and Choice Points"]) {
          assert.ok(said.includes(line), `the tab says "${line}": ${said}`);
        }
        assert.ok(!said.includes("Undo"), `Undo has no row: ${said}`);
        const release = tab.getByRole("switch", { name: "Release Values and Choice Points" });
        assert.equal(await release.isChecked(), true, "released at first");
        await release.click();
        await until(async () => state.puts.length === 1 && !(await release.isChecked()));
        assert.deepEqual(state.puts, [{ feature: "choice-points", on: false, column: "release" }]);
        assert.ok((await text(page)).includes("hidden from everyone but you"), "a feature held back says who still sees it");
        // Switching back is the undo.
        await release.click();
        await until(async () => state.puts.length === 2 && (await release.isChecked()));

        state.offline = true;
        const show = tab.getByRole("switch", { name: "Show Values and Choice Points" });
        await show.click();
        await page.getByText("Values and Choice Points could not be changed").waitFor();
        await until(async () => await show.isChecked());
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test(`a guest sees only Show, and only for what is released, in ${engine.name}`, async () => {
      const { context, page, problems, state, tab } = await open(browser, { guest: true, admin: false, name: "Guest 1" });
      try {
        await until(async () => (await tab.getByRole("switch").count()) === 1);
        const said = await text(page);
        assert.ok(!said.includes("Release") && !said.includes("Undo"), `no Release and no row for Undo: ${said}`);
        const show = tab.getByRole("switch", { name: "Show Values and Choice Points" });
        await show.click();
        await until(async () => state.puts.length === 1 && !(await show.isChecked()));
        assert.deepEqual(state.puts, [{ feature: "choice-points", on: false, column: "show" }]);
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });
  });
}

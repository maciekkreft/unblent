import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Feature flags tab of the gear's sheet on the product page (12), for the admin.
// Who is the admin is answered by request routing, and /api/flags is answered by the
// routes too, because data/flags.db is shared: switching a feature on the check's server
// would change what every other test sees. That everyone else sees no such tab is
// settings-tabs' own test; what the server answers is flags' own test.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const text = (page) => page.evaluate(() => document.querySelector("feature-flags").shadowRoot.textContent.replace(/\s+/g, " ").trim());

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`the Feature flags tab in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: rendering and layout.
    test(`the admin switches a feature off and back, and a refused switch goes back, in ${engine.name}`, async () => {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, forgeCookie("admin"));
        await context.route(/\/api\/session\/me$/, async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, json: { ...(await response.json()), admin: true, name: "Admin" } });
        });
        let off = [];
        let offline = false;
        const puts = [];
        await context.route(/\/api\/flags$/, async (route) => {
          if (route.request().method() === "PUT") {
            const body = route.request().postDataJSON();
            puts.push(body);
            if (offline) return route.abort();
            off = body.on ? off.filter((f) => f !== body.feature) : [...off, body.feature];
          }
          return route.fulfill({ json: { off, hidden: off } });
        });
        const page = await context.newPage();
        const problems = watch(page, [], { ignore: [/api\/flags/] });
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await page.locator("dock-desk .controls button.pill").click();
        await page.locator('settings-tabs [role="tab"]', { hasText: "Feature flags" }).click();
        const chats = page.locator("feature-flags").getByRole("switch", { name: "Chats" });
        await until(async () => (await page.locator("feature-flags").getByRole("switch").count()) === 4);
        const said = await text(page);
        for (const line of ["Feature flags", "hidden from everyone, you included", "Chats", "Evaluators", "Choice points", "Highlights", "The Highlights row"]) {
          assert.ok(said.includes(line), `the tab says "${line}": ${said}`);
        }
        assert.equal(await chats.isChecked(), true, "every feature is on");

        await chats.click();
        await until(async () => puts.length === 1 && !(await chats.isChecked()));
        assert.deepEqual(puts, [{ feature: "chats", on: false }]);
        // Switching back is the undo.
        await chats.click();
        await until(async () => puts.length === 2 && (await chats.isChecked()));

        offline = true;
        await chats.click();
        await page.getByText("Chats could not be changed").waitFor();
        await until(async () => await chats.isChecked());
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });
  });
}

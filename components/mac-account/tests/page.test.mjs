import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Account tab on the Mac page (3.4). The throwaway server is the web edition, so
// the Mac's answers — connect off, then a sign-in ready — are given by request routing;
// what the Mac's server answers is tested in session's own tests. A forged cookie lets
// the page's facts sync with the throwaway server meanwhile.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const LOCAL = { userId: "d".repeat(32), registrationOpen: false, admin: true, name: "Unblent" };
const CONNECT_PAGE = "https://app.example/workshop/apps/connect?state=st4te";

const text = (page) =>
  page.evaluate(() => document.querySelector("mac-account").shadowRoot.textContent.replace(/\s+/g, " ").trim());

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`mac-account in ${engine.name}`, { timeout: 15000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 15000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 10000 });

    // Browser: rendering and layout.
    test("not connected, waiting for Safari, then one question with Connect and Cancel", async () => {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        // A real sign-in, so the facts on the page sync as they would on the Mac.
        await signedIn(context, forgeCookie("mac"));
        let me = { ...LOCAL, connect: "off" };
        await context.route(/\/api\/session\/me$/, (route) => route.fulfill({ json: me }));
        await context.route(/\/api\/session\/connect\/begin$/, (route) => route.fulfill({ json: { url: CONNECT_PAGE } }));
        await context.route(/^https:\/\/app\.example\//, (route) =>
          route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Connect</title>" }),
        );
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/apps/macapp`, { waitUntil: "domcontentloaded" });
        await page.locator("dock-desk .controls button.pill").click();
        await page.locator('settings-tabs [role="tab"]', { hasText: "Account" }).click();
        const tab = page.locator("mac-account");
        await tab.getByText("Everything is kept on this Mac only.").waitFor();
        assert.ok((await text(page)).includes("Opens Safari, where you sign in with your passkey."));

        const safari = context.waitForEvent("page");
        await tab.getByRole("button", { name: "Connect account" }).click();
        assert.equal((await safari).url(), CONNECT_PAGE, "the connect page the Mac's server named");
        await tab.getByText("Waiting for you to finish in Safari…").waitFor();
        assert.ok(await tab.getByRole("button", { name: "Open Safari again" }).isVisible());
        assert.ok(await tab.getByRole("button", { name: "Cancel" }).isVisible());

        // Back in the window: session looks again and finds the sign-in ready.
        me = { ...LOCAL, connect: "ready", remote: "Maciek" };
        await page.bringToFront();
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await tab.getByText("Connect this Mac to Maciek?").waitFor();
        assert.ok(
          (await text(page)).includes(
            "If your account already has notes, journal days or books, this Mac will show them. If it is empty, this Mac's are added to it.",
          ),
        );
        assert.equal(await tab.getByRole("radio").count(), 0, "no choice to make");
        assert.ok(await tab.getByRole("button", { name: "Connect", exact: true }).isEnabled());
        assert.ok(await tab.getByRole("button", { name: "Cancel" }).isEnabled());
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}

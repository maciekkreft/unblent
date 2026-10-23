import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The connect page (3.4) in a real page: the Mac's details in the address, the account
// and its Can sync answered by request routing, and the Mac's own server stood in for
// by a route on the loopback address, so nothing is signed in for real.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`device-connect in ${engine.name}`, { timeout: 15000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 15000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 10000 });

    // Browser: a gesture.
    test("Connect sends a code bound to the Mac's challenge back to the Mac on the loopback address", async () => {
      const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
      try {
        context.setDefaultTimeout(4000);
        await context.route(/\/api\/session\/me$/, (route) =>
          route.fulfill({ json: { userId: "u1", registrationOpen: false, admin: true, name: "Admin" } }),
        );
        await context.route(/\/api\/session\/connect$/, (route) => route.fulfill({ json: { allowed: true } }));
        let asked;
        await context.route(/\/api\/session\/connect\/code$/, (route) => {
          asked = route.request().postDataJSON();
          route.fulfill({ json: { code: "c0de" } });
        });
        let reached;
        await context.route(/^http:\/\/127\.0\.0\.1:47321\//, (route) => {
          reached = route.request().url();
          route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Mac</title>" });
        });
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/apps/connect?challenge=${CHALLENGE}&state=st4te-123&port=47321`, {
          waitUntil: "domcontentloaded",
        });
        const card = page.locator("device-connect");
        await card.locator("h1", { hasText: "Connect this Mac to Admin?" }).waitFor();
        assert.ok(await card.getByRole("button", { name: "Cancel" }).isVisible());
        assert.deepEqual(problems, [], problems.join("; "));
        await card.getByRole("button", { name: "Connect", exact: true }).click();
        await page.waitForURL(/^http:\/\/127\.0\.0\.1:47321\//);
        assert.deepEqual(asked, { challenge: CHALLENGE });
        assert.equal(reached, "http://127.0.0.1:47321/api/session/connect/finish?code=c0de&state=st4te-123");
      } finally {
        await context.close();
      }
    });
  });
}

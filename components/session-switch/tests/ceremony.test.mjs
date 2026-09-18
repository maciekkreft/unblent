import { test } from "node:test";
import assert from "node:assert/strict";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The check server binds an IP, but WebAuthn refuses an IP as the RP id (3.4), so
// the ceremony runs against the localhost alias of the same port.
const LOCAL_URL = `http://localhost:${new URL(BASE_URL).port}`;

const switchState = (page) =>
  page.evaluate(() => {
    const button = document.querySelector("session-switch")?.shadowRoot?.querySelector("button");
    return button ? { title: button.getAttribute("title"), cls: button.className } : null;
  });
const clickSwitch = (page) =>
  page.evaluate(() => document.querySelector("session-switch").shadowRoot.querySelector("button").click());
const ready = (page) =>
  page.waitForFunction(() => document.querySelector("session-switch")?.shadowRoot?.querySelector("button"));

async function until(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("timed out");
}

// The passkey round trip, Chromium only (11.2): register, sign out, and a refusal
// once the authenticator is gone. The login path is covered by api.test.mjs
// (login/begin) and machine.test.mjs; keeping this flow short holds the file
// inside its time budget (11) even on a loaded host.
test("signs in, signs out, and refuses a ceremony with no authenticator (chromium)", async () => {
  const browser = await chromium.launch({ chromiumSandbox: false });
  try {
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
    page.on("response", (res) => res.status() >= 400 && problems.push(`HTTP ${res.status()}: ${res.url()}`));
    const logs = [];
    page.on("console", (msg) => logs.push(msg.text()));

    const client = await context.newCDPSession(page);
    await client.send("WebAuthn.enable");
    const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    await page.goto(`${LOCAL_URL}/workshop/design/session`, { waitUntil: "domcontentloaded" });
    await ready(page);
    assert.equal((await switchState(page)).title, "Create account");

    // A free slot admits the first user: with no known passkey, sign-in resolves
    // to a fresh account. The solid accent glyph appears and session.changed
    // reaches the switch (the trace records the delivery).
    await clickSwitch(page);
    await until(async () => (await switchState(page))?.cls === "here");
    assert.equal((await switchState(page)).title, "Sign out");
    await until(async () =>
      logs.some((l) => l.includes("session.changed") && l.includes("session → session-switch") && l.includes("delivered")),
    );

    // Sign out flips back to the dashed anonymous control at once (local-first).
    await clickSwitch(page);
    await until(async () => (await switchState(page))?.cls === "anon");
    assert.deepEqual(problems, [], `chromium reported: ${problems.join("; ")}`);

    // A fresh context with no authenticator at all: navigator.credentials rejects
    // promptly with NotAllowedError, which the fact maps to a refusal (12), not an
    // exception. (Removing the virtual authenticator instead leaves the ceremony
    // waiting for one, so a bare context is the deterministic refusal.)
    const bare = await browser.newContext();
    bare.setDefaultTimeout(4000);
    const barePage = await bare.newPage();
    const pageErrors = [];
    const bareLogs = [];
    barePage.on("pageerror", (err) => pageErrors.push(err.message));
    barePage.on("console", (msg) => bareLogs.push(msg.text()));
    await barePage.goto(`${LOCAL_URL}/workshop/design/session`, { waitUntil: "domcontentloaded" });
    await ready(barePage);
    await clickSwitch(barePage);
    await until(() => bareLogs.some((l) => l.includes("session.refused") && l.includes("session → session-switch")));
    assert.equal((await switchState(barePage)).cls, "anon");
    assert.deepEqual(pageErrors, [], `chromium page errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
  }
});

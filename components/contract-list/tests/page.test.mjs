import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const SCREENSHOTS = resolve(REPO, ".screenshots");

// A card as rendered (innerText keeps the breaks between grid cells), read from
// the shadow root so the assertion sees what the user sees.
const cardText = (page, heading) =>
  page.evaluate((heading) => {
    const root = document.querySelector("contract-list").shadowRoot;
    for (const card of root.querySelectorAll(".card")) {
      if (card.querySelector("h3")?.textContent === heading) return card.innerText.replace(/\s+/g, " ");
    }
    return null;
  }, heading);

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  test(`the contracts page lists the vocabulary in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(4000);
    const problems = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
    });
    page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
    page.on("requestfailed", (req) =>
      problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`),
    );
    page.on("response", (res) => {
      if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
    });

    try {
      await page.goto(`${BASE_URL}/workshop/design/contracts`);
      await page.waitForFunction(
        () => document.querySelector("contract-list")?.shadowRoot?.querySelectorAll(".card").length > 0,
      );

      const event = await cardText(page, "color-scheme.changed");
      assert.ok(event, "the one event is shown");
      assert.match(event, /owner color-scheme/);
      assert.match(event, /consumers token-sheet/);

      const list = await cardText(page, "catalog: list");
      assert.match(list, /askers component-list/);

      const pagesList = await cardText(page, "pages: list");
      assert.match(pagesList, /askers [a-z, -]*\bpage-nav\b/);

      // A field a schema marks x-secret (7.2) wears a "secret" badge, and only that
      // field does, so a reviewer sees which values the bus keeps out of the trace.
      const edited = await page.evaluate(() => {
        const root = document.querySelector("contract-list").shadowRoot;
        for (const card of root.querySelectorAll(".card")) {
          if (card.querySelector("h3")?.textContent !== "llm.edited") continue;
          const rows = [...card.querySelectorAll("tbody tr")];
          const badged = (name) => !!rows.find((r) => r.querySelector("td.field")?.textContent.trim() === name)?.querySelector(".secret");
          return { keyBadged: badged("key") && badged("jevKey"), badges: card.querySelectorAll(".secret").length };
        }
        return null;
      });
      assert.ok(edited, "the llm.edited card is shown");
      assert.ok(edited.keyBadged, "the two secret key fields wear the badge");
      assert.equal(edited.badges, 2, "only the secret fields are badged");

      // The label is upper-cased by CSS, which innerText reflects.
      const contracts = await cardText(page, "catalog: contracts");
      assert.match(contracts, /payload/i);
      assert.match(contracts, /reply/i);
      assert.match(contracts, /askers contract-list/);

      // One geometry for every card (section 8, kind 2): fixed table layout lands the
      // first column at the same x and width in every card, so the eye compares across
      // cards instead of chasing the columns.
      const firstCols = await page.evaluate(() =>
        [...document.querySelector("contract-list").shadowRoot.querySelectorAll(".card")]
          .map((c) => c.querySelector("tbody td"))
          .filter(Boolean)
          .slice(0, 2)
          .map((td) => {
            const r = td.getBoundingClientRect();
            return { x: Math.round(r.x), w: Math.round(r.width) };
          }),
      );
      assert.equal(firstCols.length, 2, "two cards with a table to compare");
      assert.deepEqual(firstCols[1], firstCols[0], "every card's first column shares one x and width");

      // page-nav picks the new page up through pages: list.
      const nav = await page.evaluate(() =>
        [...document.querySelector("page-nav").shadowRoot.querySelectorAll("a")].map((a) => a.textContent),
      );
      assert.ok(nav.includes("Contracts"), `page-nav lists Contracts, got ${nav.join(", ")}`);

      mkdirSync(SCREENSHOTS, { recursive: true });
      // The first screen only: the whole vocabulary is taller than an engine can capture.
      await page.screenshot({ path: resolve(SCREENSHOTS, `contracts-${engine.name}.png`) });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}

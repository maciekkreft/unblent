import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The kit (10): a forged sign-in, for the product, which hides the notes signed out.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const SCREENSHOTS = resolve(REPO, ".screenshots");

// Read the phone breakpoint's driving widths from tokens.css rather than hardcode
// them, so the test tracks the tokens the view uses.
function tokenPx(name) {
  const css = readFileSync(resolve(REPO, "tokens", "tokens.css"), "utf8");
  const match = css.match(new RegExp(`${name}\\s*:\\s*(\\d+)px`));
  assert.ok(match, `${name} is not a px token in tokens.css`);
  return Number(match[1]);
}

// A token given in rem (--text-subtitle) resolves to px only against the live root
// font-size, so it is measured in the page rather than read from the file.
const tokenResolved = (page, name) =>
  page.evaluate((n) => {
    const probe = document.createElement("div");
    probe.style.position = "absolute";
    probe.style.width = `var(${n})`;
    document.body.appendChild(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    return w;
  }, name);

// The dock stem seeds one view docked on the right (pages/design/dock), so the
// side is `right` here; the phone drawer is symmetric across left and right.
const state = (page) =>
  page.locator("dock-desk").evaluate((el) => {
    const root = el.shadowRoot;
    const dock = root.querySelector(".dock.right");
    const stage = root.querySelector(".stage");
    const strip = stage.querySelector(".strip");
    const rail = dock.querySelector(".rail");
    const scrim = root.querySelector(".scrim");
    const box = (n) => (n ? n.getBoundingClientRect() : null);
    const within = (a, b) =>
      a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    return {
      host: box(el).width,
      dockPos: getComputedStyle(dock).position,
      dockWidth: Math.round(box(dock).width),
      dockHeight: Math.round(box(dock).height),
      folded: dock.classList.contains("folded"),
      stageWidth: Math.round(box(stage).width),
      stageRight: Math.round(box(stage).right),
      hostRight: Math.round(box(el).right),
      railInStrip: within(box(rail), box(strip)),
      railTablistShown: getComputedStyle(rail.querySelector('[role="tablist"]')).display !== "none",
      scrimOn: scrim.classList.contains("on"),
      scrimVisible: getComputedStyle(scrim).visibility === "visible",
    };
  });

const clickInDesk = (page, selector) =>
  page.locator("dock-desk").evaluate((el, sel) => el.shadowRoot.querySelector(sel).click(), selector);

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// The active tab label in the right dock, whichever tab the desk shows there.
const rightActive = (page) =>
  page.locator("dock-desk").evaluate((el) =>
    el.shadowRoot.querySelector('.dock.right [role="tab"][aria-selected="true"]')?.textContent.trim(),
  );

// The right dock's tab labels, in strip order.
const rightTabs = (page) =>
  page.locator("dock-desk").evaluate((el) =>
    [...el.shadowRoot.querySelectorAll('.dock.right .panel [role="tab"]')].map((t) => t.textContent.trim()),
  );

// Click a strip button by its accessible name, inside the desk's shadow root.
const clickAction = (page, label) =>
  page.locator("dock-desk").evaluate((el, label) => {
    el.shadowRoot.querySelector(`.dock.right .panel [aria-label="${label}"]`).click();
  }, label);

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  // The dock stem seeds Trace on the right with arranging on (no settings fact, so
  // the desk stays arrangeable). Docking a stage tab beside it gives two tabs, and
  // the reorder arrows (6.4) move the shown one; the
  // order survives a reload because `dock` stores it.
  // Browser: a gesture.
  test(`reorder arrows move a docked tab and the order persists in ${engine.name}`, async () => {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      context.setDefaultTimeout(4000);
      const page = await context.newPage();
      const problems = [];
      page.on("console", (msg) => msg.type() === "error" && problems.push(`console error: ${msg.text()}`));
      page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
      page.on("requestfailed", (req) =>
        problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`),
      );
      page.on("response", (res) => res.status() >= 400 && problems.push(`HTTP ${res.status()}: ${res.url()}`));

      await page.goto(`${BASE_URL}/workshop/design/dock`);
      await page.locator("dock-desk").waitFor();
      await page.waitForFunction(
        () => document.querySelector("dock-desk").shadowRoot.querySelector('.dock.right .panel [role="tab"]'),
      );

      // One tab on the right shows no reorder arrows.
      assert.deepEqual(await rightTabs(page), ["Trace"]);
      const reorderCount = await page
        .locator("dock-desk")
        .evaluate(
          (el) =>
            el.shadowRoot.querySelectorAll(
              '.dock.right [aria-label$="earlier"], .dock.right [aria-label$="later"]',
            ).length,
        );
      assert.equal(reorderCount, 0, "a lone tab shows no reorder arrows");

      // Dock the active stage tab (Tokens) to the right: now two tabs, Tokens shown.
      await clickInDesk(page, '.stage [aria-label="Dock Tokens right"]');
      await page.waitForFunction(
        () =>
          document.querySelector("dock-desk").shadowRoot.querySelectorAll('.dock.right .panel [role="tab"]').length === 2,
      );
      assert.deepEqual(await rightTabs(page), ["Trace", "Tokens"]);

      // Tokens is last, so "earlier" is enabled and "later" is disabled.
      await clickAction(page, "Move Tokens earlier");
      await page.waitForFunction(
        () =>
          document
            .querySelector("dock-desk")
            .shadowRoot.querySelector('.dock.right .panel [role="tab"]')
            .textContent.trim() === "Tokens",
      );
      assert.deepEqual(await rightTabs(page), ["Tokens", "Trace"], "the shown tab moved one place earlier");

      // The order is a stored fact: a reload keeps it.
      await page.reload();
      await page.locator("dock-desk").waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector("dock-desk").shadowRoot.querySelectorAll('.dock.right .panel [role="tab"]').length === 2,
      );
      assert.deepEqual(await rightTabs(page), ["Tokens", "Trace"], "the reordered layout survives a reload");

      // Move it back: the opposite arrow undoes it, one step (Norman, forgiving).
      await clickAction(page, "Move Tokens later");
      await page.waitForFunction(
        () =>
          [...document.querySelector("dock-desk").shadowRoot.querySelectorAll('.dock.right .panel [role="tab"]')]
            .map((t) => t.textContent.trim())
            .join() === "Trace,Tokens",
      );
      assert.deepEqual(await rightTabs(page), ["Trace", "Tokens"], "the opposite arrow undoes the move");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  // The product page docks Notes and Editor on the right; the Editor follows
  // note.selected with `shows-on` (6.4), so picking a note brings its tab forward.
  // Browser: a page's composition.
  test(`picking a note brings the Notes tab forward on / in ${engine.name}`, async () => {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      context.setDefaultTimeout(4000);
      // Signed out the product hides the notes and offers no New note.
      await signedIn(context, forgeCookie("dock-notes"));
      const page = await context.newPage();
      const problems = [];
      page.on("console", (msg) => msg.type() === "error" && problems.push(`console error: ${msg.text()}`));
      page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
      page.on("requestfailed", (req) =>
        problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`),
      );
      page.on("response", (res) => res.status() >= 400 && problems.push(`HTTP ${res.status()}: ${res.url()}`));

      await page.goto(`${BASE_URL}/`);
      await page.locator("dock-desk").waitFor();
      // The right dock seeds on its first tab, the Notes pair.
      await page.waitForFunction(() => {
        const t = document.querySelector("dock-desk").shadowRoot.querySelector('.dock.right [role="tab"][aria-selected="true"]');
        return t && t.textContent.trim() === "Notes";
      });

      // Settings left the right dock for the header gear (settings-gear plan): it is no
      // right-dock tab, whatever else the product docks there, and the gear sits directly before the account
      // button (session-switch), the last control in page order (6.4, Decision 8).
      await page.waitForFunction(() =>
        document.querySelector("dock-desk")?.shadowRoot?.querySelector(".controls .pill"),
      );
      const right = await rightTabs(page);
      assert.ok(!right.includes("Settings"), "Settings is not a right-dock tab");
      const other = right.find((t) => t !== "Notes");
      assert.ok(other, "the right dock holds a tab besides Notes");
      assert.deepEqual(
        await page.locator("dock-desk").evaluate((el) =>
          [...el.shadowRoot.querySelector(".controls").children].map((c) =>
            c.localName === "slot" ? c.name : c.localName + (c.classList.contains("pill") ? ".pill" : ""),
          ),
        ),
        ["profile-switch", "layout-switch", "undo-bar", "button.pill", "session-switch"],
        "the gear sits directly before the account button",
      );

      // Show another right tab, so the Notes pair sits behind it.
      await page.evaluate((other) =>
        [...document.querySelector("dock-desk").shadowRoot.querySelectorAll('.dock.right .panel [role="tab"]')]
          .find((t) => t.textContent.trim() === other)
          ?.click(),
      other);
      await page.waitForFunction((other) => {
        const t = document.querySelector("dock-desk").shadowRoot.querySelector('.dock.right [role="tab"][aria-selected="true"]');
        return t && t.textContent.trim() === other;
      }, other);

      // Pick the next-note row in the Notes list: note-list emits note.selected, which
      // the Notes pair follows with shows-on (6.4), so the desk brings its tab forward.
      await page.locator("note-list").evaluate((el) => el.shadowRoot.querySelector(".row.draft").click());
      await page.waitForFunction(() => {
        const t = document.querySelector("dock-desk").shadowRoot.querySelector('.dock.right [role="tab"][aria-selected="true"]');
        return t && t.textContent.trim() === "Notes";
      });
      assert.equal(await rightActive(page), "Notes", "picking a note brings the Notes tab forward");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  // Browser: rendering and layout.
  test(`a side dock is a scrim drawer on the phone in ${engine.name}`, async () => {
    const rail = tokenPx("--space-xl");
    const peek = tokenPx("--space-2xl");
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      context.setDefaultTimeout(4000);
      // The phone frame narrows the body (7.5), which is the honest signal the
      // desk's `@container (width < 45rem)` reads; a wide window with a coarse
      // pointer still draws the frame (base.css needs `pointer: fine`).
      await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
      const page = await context.newPage();
      const problems = [];
      page.on("console", (msg) => msg.type() === "error" && problems.push(`console error: ${msg.text()}`));
      page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
      page.on("requestfailed", (req) =>
        problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`),
      );
      page.on("response", (res) => res.status() >= 400 && problems.push(`HTTP ${res.status()}: ${res.url()}`));

      await page.goto(`${BASE_URL}/workshop/design/dock`);
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      await page.locator("dock-desk").waitFor();

      // On the phone a fresh desk seeds a side dock folded (6.4), so the stage and
      // its header are never hidden behind a drawer at first sight: it is a button
      // in the header corner, out of the flow, with no scrim, leaving the whole
      // stage width for the body below.
      const seeded = await state(page);
      assert.equal(seeded.dockPos, "absolute", "a folded side dock stays out of the flow, on its gutter");
      assert.ok(Math.abs(seeded.dockWidth - rail) <= 1, "the folded side dock is one token wide");
      assert.ok(Math.abs(seeded.dockHeight - rail) <= 1, "the folded side dock is a square, not a full-height rail");
      assert.ok(seeded.railInStrip, "the folded button sits within the stage header");
      assert.ok(!seeded.railTablistShown, "the folded button hides its tabs; its title names what it holds");
      assert.ok(
        Math.abs(seeded.stageWidth - seeded.host) <= 1,
        "the stage spans the full width; the button costs only header padding",
      );
      assert.ok(!seeded.scrimOn, "no scrim while the drawer is folded");

      // A tap on the rail floats the drawer over the stage (absolute, leaving only a
      // peek), with the scrim dimming it. Wait for the slide to settle, not just for
      // the width to pass the rail, so the peek is measured open and not mid-slide.
      await clickInDesk(page, ".dock.right .rail");
      await page.waitForFunction((peek) => {
        const d = document.querySelector("dock-desk").shadowRoot.querySelector(".dock.right");
        const host = document.querySelector("dock-desk").getBoundingClientRect().width;
        return !d.classList.contains("folded") && Math.abs(host - d.getBoundingClientRect().width - peek) <= 1;
      }, peek);
      const open = await state(page);
      assert.equal(open.dockPos, "absolute", "an open side dock overlays the stage as a drawer");
      // Within a pixel: the drawer's edge border rounds the border-box width.
      assert.ok(Math.abs(open.host - open.dockWidth - peek) <= 1, "the drawer leaves a token-wide peek of the stage");
      assert.ok(open.scrimOn && open.scrimVisible, "the scrim dims the peeking stage while the drawer is open");

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `dock-desk-phone-drawer-${engine.name}.png`) });

      // A tap on the scrim folds the drawer back to its header button: the forgiving
      // close, one step (Norman). The dock stays out of the flow, so the full-width
      // stage holds one width through every frame of the slide.
      await clickInDesk(page, ".scrim");
      const slide = await page.locator("dock-desk").evaluate(async (el, rail) => {
        const dock = el.shadowRoot.querySelector(".dock.right");
        const stage = el.shadowRoot.querySelector(".stage");
        const widths = new Set();
        const start = performance.now();
        while (dock.getBoundingClientRect().width > rail + 1 && performance.now() - start < 2000) {
          widths.add(Math.round(stage.getBoundingClientRect().width));
          await new Promise((next) => requestAnimationFrame(next));
        }
        return [...widths];
      }, rail);
      assert.deepEqual(slide, [open.stageWidth], "the stage is never squeezed while the drawer folds");
      // The dock slides to the rail width; wait for it to settle, not just for the
      // class, so the measurement is the folded size and not a mid-slide frame.
      // Height steps to the button only at the slide's end, after the width reaches the
      // edge; wait for both so the folded square is measured settled, not mid-slide.
      await page.waitForFunction((rail) => {
        const r = document.querySelector("dock-desk").shadowRoot.querySelector(".dock.right");
        const b = r.getBoundingClientRect();
        return r.classList.contains("folded") && b.width <= rail + 1 && b.height <= rail + 1;
      }, rail);
      const folded = await state(page);
      assert.equal(folded.dockPos, "absolute", "a folded side dock stays out of the flow, on its gutter");
      assert.equal(folded.stageWidth, open.stageWidth, "folding the drawer does not resize the stage");
      // Within a pixel: the button's edge border rounds the border-box width.
      assert.ok(Math.abs(folded.dockWidth - rail) <= 1, "a folded side dock is a button one token wide");
      assert.ok(Math.abs(folded.dockHeight - rail) <= 1, "a folded side dock returns to a header-corner square");
      assert.ok(Math.abs(folded.stageWidth - folded.host) <= 1, "the stage spans the full width beside the button");
      assert.ok(!folded.scrimOn, "the scrim clears once no drawer is open");

      // A tap on the button reopens the drawer.
      await clickInDesk(page, ".dock.right .rail");
      await page.waitForFunction((rail) => {
        const d = document.querySelector("dock-desk").shadowRoot.querySelector(".dock.right");
        return !d.classList.contains("folded") && d.getBoundingClientRect().width > rail * 3;
      }, rail);
      const reopened = await state(page);
      assert.equal(reopened.dockPos, "absolute", "tapping the button floats the drawer back over the stage");
      assert.ok(reopened.scrimOn, "the scrim returns with the drawer");
      assert.equal(reopened.stageWidth, open.stageWidth, "opening the drawer does not resize the stage");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  // The gear (6.4) shows the Settings sheet on the stage in place of a stage tab, lit
  // while pressed, and leaves it by every route: the gear again, a stage tab, Escape,
  // and (a reload) not at all, since pressed rides no fact. Every header button is one
  // size, 36px (--text-subtitle in --space-sm padding).
  // Browser: a gesture.
  test(`the gear shows Settings on the stage and every route leaves it in ${engine.name}`, async () => {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      context.setDefaultTimeout(4000);
      const page = await context.newPage();
      const problems = [];
      page.on("console", (msg) => msg.type() === "error" && problems.push(`console error: ${msg.text()}`));
      page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
      page.on("requestfailed", (req) =>
        problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`),
      );
      page.on("response", (res) => res.status() >= 400 && problems.push(`HTTP ${res.status()}: ${res.url()}`));

      await page.goto(`${BASE_URL}/workshop/design/dock`);
      await page.locator("dock-desk").waitFor();
      await page.waitForFunction(() =>
        document.querySelector("dock-desk")?.shadowRoot?.querySelector(".controls .pill"),
      );

      const pillAttr = (attr) =>
        page
          .locator("dock-desk")
          .evaluate((el, a) => el.shadowRoot.querySelector(".controls .pill").getAttribute(a), attr);
      const clickPill = () =>
        page.locator("dock-desk").evaluate((el) => el.shadowRoot.querySelector(".controls .pill").click());
      const pressed = () =>
        page.waitForFunction(
          () =>
            document.querySelector("dock-desk").shadowRoot.querySelector(".controls .pill").getAttribute("aria-pressed") === "true",
        );
      const staged = () =>
        page.waitForFunction(() => {
          const root = document.querySelector("dock-desk").shadowRoot;
          return (
            root.querySelector(".controls .pill").getAttribute("aria-pressed") === "false" &&
            root.querySelector('.stage [role="tab"][aria-selected="true"]')
          );
        });

      // The gear renders unpressed, named Settings, after the page's one control.
      assert.equal(await pillAttr("aria-pressed"), "false");
      assert.equal(await pillAttr("title"), "Settings");
      assert.deepEqual(
        await page
          .locator("dock-desk")
          .evaluate((el) =>
            [...el.shadowRoot.querySelector(".controls").children].map(
              (c) => c.localName + (c.classList.contains("pill") ? ".pill" : ""),
            ),
          ),
        ["slot", "button.pill"],
        "the gear follows the slotted controls in page order",
      );

      // Every header button is one size: 36px = --text-subtitle + 2 * --space-sm.
      const expected = (await tokenResolved(page, "--text-subtitle")) + 2 * (await tokenResolved(page, "--space-sm"));
      const sizes = await page.locator("dock-desk").evaluate((el) => {
        const nodes = [...el.shadowRoot.querySelectorAll(".pill, .action")];
        const ctrl = document.querySelector("layout-switch")?.shadowRoot?.querySelector("button");
        if (ctrl) nodes.push(ctrl);
        return nodes.map((n) => {
          const b = n.getBoundingClientRect();
          return [b.width, b.height];
        });
      });
      assert.ok(sizes.length >= 2, "the desk drew header buttons to measure");
      for (const [w, h] of sizes) {
        assert.ok(Math.abs(w - expected) <= 0.5, `a header button is ${w}px wide, not ${expected}px`);
        assert.ok(Math.abs(h - expected) <= 0.5, `a header button is ${h}px tall, not ${expected}px`);
      }

      // Press: Settings takes the stage, the staged tab hides, no tab is selected and
      // the stage's arranging actions are gone.
      await clickPill();
      await pressed();
      const on = await page.evaluate(() => {
        const root = document.querySelector("dock-desk").shadowRoot;
        const sheet = document.querySelector("settings-sheet").getBoundingClientRect();
        return {
          sheetShown: sheet.width > 0 && sheet.height > 0,
          tabHidden: root.querySelector('.body[data-side="stage"] slot[name="token-sheet"]').hidden,
          anySelected: Boolean(root.querySelector('.stage [role="tab"][aria-selected="true"]')),
          stageActions: Boolean(root.querySelector(".stage .strip .actions")),
        };
      });
      assert.ok(on.sheetShown, "Settings takes the stage");
      assert.ok(on.tabHidden, "the staged view hides behind Settings");
      assert.ok(!on.anySelected, "no stage tab is selected while pressed");
      assert.ok(!on.stageActions, "no stage arranging actions while pressed");

      // The gear again shows the stage.
      await clickPill();
      await staged();

      // A stage tab click leaves Settings and selects that tab.
      await clickPill();
      await pressed();
      await page.locator("dock-desk").evaluate((el) => {
        [...el.shadowRoot.querySelectorAll('.stage [role="tab"]')]
          .find((t) => t.textContent.trim() === "Contracts")
          .click();
      });
      await page.waitForFunction(() => {
        const root = document.querySelector("dock-desk").shadowRoot;
        const t = root.querySelector('.stage [role="tab"][aria-selected="true"]');
        return root.querySelector(".controls .pill").getAttribute("aria-pressed") === "false" && t && t.textContent.trim() === "Contracts";
      });

      // Escape leaves Settings and returns focus to the gear. Focus the gear first so
      // the keydown bubbles through the desk (WebKit does not focus a button on click).
      await clickPill();
      await pressed();
      await page.locator("dock-desk").evaluate((el) => el.shadowRoot.querySelector(".controls .pill").focus());
      await page.keyboard.press("Escape");
      await staged();
      assert.ok(
        await page.locator("dock-desk").evaluate((el) => el.shadowRoot.activeElement?.classList.contains("pill")),
        "Escape returns focus to the gear",
      );

      // A reload keeps Settings on the stage, kept in this browser (3.1); once the gear
      // is pressed again, a reload shows the stage.
      const reloaded = async () => {
        await page.reload();
        await page.waitForFunction(() =>
          document.querySelector("dock-desk")?.shadowRoot?.querySelector(".controls .pill"),
        );
      };
      await clickPill();
      await pressed();
      await reloaded();
      assert.equal(await pillAttr("aria-pressed"), "true", "a reload keeps Settings on the stage");
      await clickPill();
      await staged();
      await reloaded();
      assert.equal(await pillAttr("aria-pressed"), "false", "once closed, a reload shows the stage");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  // Browser: rendering and layout.
  test(`the gear fills the stage on the phone in ${engine.name}`, async () => {
    const rail = tokenPx("--space-xl");
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      context.setDefaultTimeout(4000);
      await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
      const page = await context.newPage();
      const problems = [];
      page.on("console", (msg) => msg.type() === "error" && problems.push(`console error: ${msg.text()}`));
      page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
      page.on("requestfailed", (req) =>
        problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`),
      );
      page.on("response", (res) => res.status() >= 400 && problems.push(`HTTP ${res.status()}: ${res.url()}`));

      await page.goto(`${BASE_URL}/workshop/design/dock`);
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      await page.locator("dock-desk").waitFor();
      await page.waitForFunction(() =>
        document.querySelector("dock-desk")?.shadowRoot?.querySelector(".controls .pill"),
      );

      await page.locator("dock-desk").evaluate((el) => el.shadowRoot.querySelector(".controls .pill").click());
      await page.waitForFunction(
        () =>
          document.querySelector("dock-desk").shadowRoot.querySelector(".controls .pill").getAttribute("aria-pressed") === "true",
      );

      const m = await page.evaluate(() => {
        const el = document.querySelector("dock-desk");
        const body = el.shadowRoot.querySelector('.body[data-side="stage"]').getBoundingClientRect();
        const sheet = document.querySelector("settings-sheet").getBoundingClientRect();
        const corner = el.shadowRoot.querySelector(".dock.right");
        const cb = corner.getBoundingClientRect();
        const btn = corner.querySelector(".rail .action").getBoundingClientRect();
        return { bodyW: body.width, sheetW: sheet.width, cornerW: cb.width, cornerH: cb.height, btnW: btn.width, btnH: btn.height };
      });
      assert.ok(Math.abs(m.sheetW - m.bodyW) <= 1, "Settings fills the stage width on the phone");
      assert.ok(
        Math.abs(m.cornerW - rail) <= 1 && Math.abs(m.cornerH - rail) <= 1,
        "the folded side dock stays a header-corner square while Settings shows",
      );
      assert.ok(m.btnW <= rail + 0.5 && m.btnH <= rail + 0.5, "the corner button fits inside its square");

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `dock-desk-gear-phone-${engine.name}.png`) });

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}

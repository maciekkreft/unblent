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

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// The dock's layout is stored under a page-scoped key (dock/store.js), so the stem's
// arrangement never clobbers an app desk's.
const DOCK_KEY = "dock:/design/dock";

// The desk's own picture, read from its shadow root. A group's strip is
// `.stage` or `.dock.<side> .panel`; a folded side's rail is `.dock.<side> .rail`.
const tabsOf = (page, group) =>
  page.evaluate((group) => {
    const root = document.querySelector("dock-desk").shadowRoot;
    return [...root.querySelectorAll(`${group} [role="tab"]`)].map((b) => ({
      label: b.textContent.trim(),
      selected: b.getAttribute("aria-selected") === "true",
    }));
  }, group);
const labels = async (page, group) => (await tabsOf(page, group)).map((t) => t.label);
const selected = async (page, group) => (await tabsOf(page, group)).find((t) => t.selected)?.label;
// Which child each group shows: the slots not hidden, by name.
const shown = (page, group) =>
  page.evaluate(
    (group) =>
      [...document.querySelector("dock-desk").shadowRoot.querySelectorAll(`${group} .body slot:not([hidden])`)].map(
        (s) => s.name,
      ),
    group,
  );
const clickTab = (page, group, label) =>
  page.evaluate(
    ({ group, label }) => {
      [...document.querySelector("dock-desk").shadowRoot.querySelectorAll(`${group} [role="tab"]`)]
        .find((b) => b.textContent.trim() === label)
        ?.click();
    },
    { group, label },
  );
// Three docks now share the "Fold"/"Unfold" labels, so an action is found within
// a scope: a group's strip is `.stage` or `.dock.<side> .panel`, a rail `.dock.<side> .rail`.
const clickAction = (page, scope, label) =>
  page.evaluate(
    ({ scope, label }) => {
      const b = document.querySelector("dock-desk").shadowRoot.querySelector(`${scope} .action[aria-label="${label}"]`);
      if (!b) throw new Error(`no action "${label}" in ${scope}`);
      b.click();
    },
    { scope, label },
  );
// The computed transform of a group's fold glyph, to check its orientation.
const foldTransform = (page, scope) =>
  page.evaluate((scope) => {
    const svg = document.querySelector("dock-desk").shadowRoot.querySelector(`${scope} .fold svg`);
    return svg ? getComputedStyle(svg).transform : null;
  }, scope);
const actionLabels = (page, group) =>
  page.evaluate(
    (group) =>
      [...document.querySelector("dock-desk").shadowRoot.querySelectorAll(`${group} .action`)].map((b) =>
        b.getAttribute("aria-label"),
      ),
    group,
  );
const rect = (page, sel) =>
  page.evaluate((sel) => {
    const el = document.querySelector("dock-desk").shadowRoot.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  }, sel);
// Whether a strip's selected tab lies inside its tablist, rather than scrolled
// out behind the actions.
const selectedInView = (page, group) =>
  page.evaluate((group) => {
    const tab = document.querySelector("dock-desk").shadowRoot.querySelector(`${group} .strip [role="tab"][aria-selected="true"]`);
    const t = tab.getBoundingClientRect();
    const l = tab.parentElement.getBoundingClientRect();
    return t.left >= l.left - 1 && t.right <= l.right + 1;
  }, group);
// The narrowest a dock gets over the next frames: an untouched dock must not
// shrink, so a move never replays a neighbour's slide.
async function leastWidth(page, sel, frames = 8) {
  let least = Infinity;
  for (let i = 0; i < frames; i++) {
    least = Math.min(least, (await rect(page, sel)).width);
    await new Promise((r) => setTimeout(r, 20));
  }
  return least;
}
const shadowHas = (page, sel) =>
  page.evaluate((sel) => Boolean(document.querySelector("dock-desk").shadowRoot.querySelector(sel)), sel);
// Playwright's visibility: a box, and no visibility:hidden, so a folded panel's
// child counts as hidden and a hidden slot's child too.
const visible = (page, name) => page.locator(name).isVisible();
// The staged trace table's scroll container, null until it has rendered.
const traceOverflow = (page) =>
  page.evaluate(() => {
    const s = document.querySelector("trace-list")?.shadowRoot?.querySelector(".scroll");
    return s ? { scrollWidth: s.scrollWidth, clientWidth: s.clientWidth } : null;
  });
// How much the window itself can scroll: it must not (the desk fills the viewport
// and scrolls inside itself, not the page).
const windowOverflow = (page) =>
  page.evaluate(() => document.scrollingElement.scrollHeight - window.innerHeight);
// A dock's own scroll container and how far it can scroll.
const dockScroll = (page, side) =>
  page.evaluate((side) => {
    const d = document.querySelector("dock-desk").shadowRoot.querySelector(`.body[data-side="${side}"]`);
    return { top: Math.round(d.scrollTop), max: Math.round(d.scrollHeight - d.clientHeight) };
  }, side);
const setDockScroll = (page, side, v) =>
  page.evaluate(
    ({ side, v }) =>
      (document.querySelector("dock-desk").shadowRoot.querySelector(`.body[data-side="${side}"]`).scrollTop = v),
    { side, v },
  );
// Whether the viewport switch is the topmost element at its own centre: proof the
// dock does not paint over it.
const switchOnTop = (page) =>
  page.evaluate(() => {
    const sw = document.querySelector("viewport-switch");
    const r = sw.getBoundingClientRect();
    if (getComputedStyle(sw).display === "none" || r.width === 0) return "hidden";
    const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return el === sw || sw.contains(el) ? "top" : "covered";
  });
// The mirror of switchOnTop for the layout switch, fixed at the bottom-left.
const layoutSwitchOnTop = (page) =>
  page.evaluate(() => {
    const sw = document.querySelector("layout-switch");
    const r = sw.getBoundingClientRect();
    if (getComputedStyle(sw).display === "none" || r.width === 0) return "hidden";
    const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return el === sw || sw.contains(el) ? "top" : "covered";
  });
// A corner pill's box in the window, with the window size: the pills are lifted
// clear of the folded-rail band rather than padding the rails aside (fix 3).
const pillBox = (page, name) =>
  page.evaluate((name) => {
    const r = document.querySelector(name).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, ih: innerHeight, iw: innerWidth };
  }, name);
// Whether a folded rail's first tab is clear of the corner pills: elementFromPoint
// at its centre resolves to the desk (the light-DOM host), not a pill over it.
const railTabUncovered = (page, side) =>
  page.evaluate((side) => {
    const desk = document.querySelector("dock-desk");
    const tab = desk.shadowRoot.querySelector(`.dock.${side} .rail [role="tab"]`);
    const r = tab.getBoundingClientRect();
    const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return el === desk || desk.contains(el);
  }, side);
// The rendered width of a strip action's glyph and the layout pill's glyph: the
// pill's icon must read at the same size as every other icon (fix 1).
const glyphWidths = (page) =>
  page.evaluate(() => {
    const strip = document.querySelector("dock-desk").shadowRoot.querySelector(".stage .action svg");
    const pill = document.querySelector("layout-switch").shadowRoot.querySelector("svg");
    return { strip: strip.getBoundingClientRect().width, pill: pill.getBoundingClientRect().width };
  });
// The layout switch, a light-DOM toggle beside the desk (task "Layout switch"). Its
// button lives in its own shadow root; when settings hides it the host is display:none.
// Pressed = arranging.
const clickSwitch = (page) =>
  page.evaluate(() => document.querySelector("layout-switch").shadowRoot.querySelector("button").click());
const switchPressed = (page) =>
  page.evaluate(() => document.querySelector("layout-switch").shadowRoot.querySelector("button")?.getAttribute("aria-pressed"));
const switchGone = (page) =>
  page.evaluate(() => getComputedStyle(document.querySelector("layout-switch")).display === "none");
const hideSwitchOnSettings = (page) =>
  page.evaluate(() => {
    const labels = [...document.querySelector("settings-sheet").shadowRoot.querySelectorAll(".switches label")];
    labels.find((l) => l.textContent.includes("Layout switch")).querySelector("input").click();
  });
const railWidth = (page) =>
  page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector("dock-desk").shadowRoot.querySelector(".strip")).height),
  );

async function until(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("timed out");
}

function watch(page) {
  const problems = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
  return problems;
}

const ready = (page) =>
  page.waitForFunction(() => document.querySelector("dock-desk")?.shadowRoot?.querySelector(".stage .body"));

// A page on the dock stem, optionally starting from a stored layout (3.1,
// local-only: the fact reads localStorage), on the phone or the desk.
async function open(engine, { layout, phone = false } = {}) {
  const browser = await engine.launch();
  const context = await browser.newContext();
  await context.addInitScript(
    ({ layout, phone, key }) => {
      if (phone) localStorage.setItem("viewport", "phone");
      if (layout) localStorage.setItem(key, JSON.stringify(layout));
    },
    { layout, phone, key: DOCK_KEY },
  );
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/design/dock`, { waitUntil: "networkidle" });
  if (phone) await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
  await ready(page);
  return { browser, page, problems };
}

const clean = (page) =>
  page.evaluate((key) => {
    localStorage.removeItem(key);
    localStorage.removeItem("viewport");
  }, DOCK_KEY);

// WebKit first, then Chromium: a Safari-class engine is the stricter check. The
// stem's story is told in four tests so each fits its own budget (11).
for (const engine of ENGINES) {
  test(`the desk is four tab groups: dock a view and switch its tabs in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine);
    try {
      const debug = [];
      page.on("console", (msg) => {
        if (msg.type() === "debug") debug.push(msg.text());
      });

      // Starting picture: every view a stage tab, Tokens shown, nothing docked,
      // and the stage's actions are the three edges (one strip anatomy, 7.6 icons).
      assert.deepEqual(await labels(page, ".stage"), ["Tokens", "Contracts", "Components", "Trace"]);
      assert.equal(await selected(page, ".stage"), "Tokens");
      assert.deepEqual(await shown(page, ".stage"), ["token-sheet"]);
      assert.equal(await shadowHas(page, ".dock"), false, "no dock band before anything is docked");
      assert.deepEqual(await actionLabels(page, ".stage"), ["Dock Tokens left", "Dock Tokens right", "Dock Tokens bottom"]);
      assert.ok(await shadowHas(page, ".stage .action svg path"), "actions are icons");
      assert.ok((await windowOverflow(page)) <= 1, "the page does not scroll with nothing docked");

      // The layout pill's glyph reads at the same size as a strip icon (fix 1): a
      // tight pill around one 1em mark, not a big ring around a small one.
      const glyphs = await glyphWidths(page);
      assert.ok(
        Math.abs(glyphs.pill - glyphs.strip) <= 0.5,
        `the layout glyph matches a strip icon, saw ${glyphs.pill} vs ${glyphs.strip}`,
      );

      // Both corner pills are lifted a rail's height (--space-xl, 40px) off the
      // bottom, so a folded dock's rail — that tall, along an edge — never passes
      // under them and no rail has to pad its tabs aside (fix 3).
      for (const pill of ["layout-switch", "viewport-switch"]) {
        const b = await pillBox(page, pill);
        assert.ok(b.ih - b.bottom >= 40 - 1, `${pill} clears the folded-rail band, saw ${(b.ih - b.bottom).toFixed(1)}px`);
      }

      // Open Trace; at a mid width the staged trace table must fit the stage.
      await clickTab(page, ".stage", "Trace");
      await until(async () => (await selected(page, ".stage")) === "Trace");
      await page.setViewportSize({ width: 900, height: 800 });
      await until(async () => (await traceOverflow(page)) !== null);
      const mid = await traceOverflow(page);
      assert.ok(mid.scrollWidth <= mid.clientWidth + 1, `the staged trace fits at 900px, saw ${JSON.stringify(mid)}`);
      await page.setViewportSize({ width: 1280, height: 720 });

      // Dock Trace right: the right strip shows Trace as its one, selected tab;
      // Trace leaves the stage, which moves on to Tokens.
      await clickAction(page, ".stage", "Dock Trace right");
      await until(async () => (await shadowHas(page, ".dock.right")));
      assert.deepEqual(await tabsOf(page, ".dock.right .panel"), [{ label: "Trace", selected: true }]);
      assert.deepEqual(await labels(page, ".stage"), ["Tokens", "Contracts", "Components"]);
      assert.equal(await selected(page, ".stage"), "Tokens");
      assert.ok(await visible(page, "trace-list"), "the docked trace is visible");
      assert.deepEqual(await actionLabels(page, ".dock.right .panel"), [
        "Move Trace left",
        "Move Trace bottom",
        "Return Trace to the stage",
        "Fold",
      ]);
      // The right dock's fold glyph is mirrored so its thin bar sits on the edge.
      assert.equal(await foldTransform(page, ".dock.right .panel"), "matrix(-1, 0, 0, 1, 0, 0)", "the right fold glyph is mirrored");
      assert.ok((await windowOverflow(page)) <= 1, "the page does not scroll once docked");
      assert.equal(await switchOnTop(page), "top", "the viewport switch is not covered by the dock");

      // The traffic is on the bus, both ways (trace format at trace/machine.js).
      assert.ok(
        debug.some((l) => l.includes("event dock.arranged dock-desk → dock delivered")),
        "dock-desk announced the arrangement",
      );
      assert.ok(
        debug.some((l) => l.includes("event dock.changed dock → dock-desk delivered")),
        "dock announced the change back",
      );

      // Dock Contracts too: two tabs on the right, the newcomer shown, one body.
      await clickTab(page, ".stage", "Contracts");
      await until(async () => (await selected(page, ".stage")) === "Contracts");
      await clickAction(page, ".stage", "Dock Contracts right");
      await until(async () => (await labels(page, ".dock.right .panel")).length === 2);
      assert.equal(await selected(page, ".dock.right .panel"), "Contracts");
      assert.deepEqual(await shown(page, ".dock.right"), ["contract-list"]);
      assert.ok(await visible(page, "contract-list"));
      assert.equal(await visible(page, "trace-list"), false, "the other tab's body is hidden");

      // The other tab: the bodies swap.
      await clickTab(page, ".dock.right .panel", "Trace");
      await until(async () => (await selected(page, ".dock.right .panel")) === "Trace");
      assert.deepEqual(await shown(page, ".dock.right"), ["trace-list"]);
      assert.ok(await visible(page, "trace-list"));
      assert.equal(await visible(page, "contract-list"), false);

      await clean(page);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  test(`a dock keeps its scroll, folds to its rail and unfolds on a tab in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, {
      layout: {
        stage: "token-sheet",
        docks: { right: { open: true, views: ["trace-list", "contract-list"], active: "trace-list" } },
      },
    });
    try {
      await until(async () => (await selected(page, ".dock.right .panel")) === "Trace");
      // The stage changes; the dock keeps its own scroll position rather than
      // jumping to the top.
      const room = (await dockScroll(page, "right")).max;
      if (room > 10) {
        await setDockScroll(page, "right", room);
        await until(async () => (await dockScroll(page, "right")).top > 0);
        const parked = (await dockScroll(page, "right")).top;
        await clickTab(page, ".stage", "Components");
        await until(async () => (await selected(page, ".stage")) === "Components");
        assert.ok(Math.abs((await dockScroll(page, "right")).top - parked) <= 2, "the dock keeps its scroll position");
      }

      // Fold: the band slides down to its rail, the stage widens by the same
      // amount, and the rail names the tabs.
      const open = await rect(page, ".dock.right");
      const stageOpen = await rect(page, ".stage");
      await clickAction(page, ".dock.right .panel", "Fold");
      const rail = await railWidth(page);
      await until(async () => (await rect(page, ".dock.right")).width <= rail + 1.01);
      assert.ok(open.width > rail * 5, "the open dock is far wider than its rail");
      const stageFolded = await rect(page, ".stage");
      assert.ok(
        Math.abs(stageFolded.width - stageOpen.width - (open.width - rail)) <= 2,
        "the stage takes the width the dock gave up",
      );
      assert.deepEqual(await labels(page, ".dock.right .rail"), ["Trace", "Contracts"]);
      await until(async () => !(await visible(page, "trace-list")), 1000).catch(() =>
        assert.fail("a folded dock hides its body"),
      );

      // A rail label unfolds the dock on that tab.
      await clickTab(page, ".dock.right .rail", "Contracts");
      await until(async () => Math.abs((await rect(page, ".dock.right")).width - open.width) < 1);
      assert.equal(await selected(page, ".dock.right .panel"), "Contracts");
      assert.ok(await visible(page, "contract-list"));

      await clean(page);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  test(`a docked view is kept across a reload, moves between edges and returns in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, {
      layout: {
        stage: "components",
        docks: { right: { open: true, views: ["trace-list", "contract-list"], active: "contract-list" } },
      },
    });
    try {
      // The layout follows the page (3.1, local-only): the dock, its shown tab
      // and the stage are as stored.
      await until(async () => (await shadowHas(page, ".dock.right")));
      assert.equal(await selected(page, ".dock.right .panel"), "Contracts", "the shown tab is as stored");
      assert.equal(await selected(page, ".stage"), "Tokens", "an unknown stage falls back to the first tab");

      // Move Contracts to the bottom: a bottom dock opens showing it; the right
      // dock is left with Trace shown, and stays put while the bottom one enters.
      const rightWidth = (await rect(page, ".dock.right")).width;
      await clickAction(page, ".dock.right .panel", "Move Contracts bottom");
      await until(async () => (await shadowHas(page, ".dock.bottom")));
      // The bottom dock's fold glyph is turned down, unlike a side dock's.
      assert.notEqual(await foldTransform(page, ".dock.bottom .panel"), "none", "the bottom fold glyph is turned");
      assert.notEqual(
        await foldTransform(page, ".dock.bottom .panel"),
        "matrix(-1, 0, 0, 1, 0, 0)",
        "the bottom glyph is rotated, not mirrored",
      );
      assert.ok(
        (await leastWidth(page, ".dock.right")) >= rightWidth - 1,
        "the right dock does not replay its slide when a view moves out of it",
      );
      assert.deepEqual(await tabsOf(page, ".dock.bottom .panel"), [{ label: "Contracts", selected: true }]);
      assert.deepEqual(await tabsOf(page, ".dock.right .panel"), [{ label: "Trace", selected: true }]);
      assert.ok(await visible(page, "contract-list"));
      assert.ok(await visible(page, "trace-list"));
      const bottom = await rect(page, ".dock.bottom");
      const right = await rect(page, ".dock.right");
      assert.ok(bottom.top >= right.bottom - 1, "the bottom dock spans below the side docks");
      assert.ok((await windowOverflow(page)) <= 1, "the page still does not scroll");

      // Return Contracts to the stage: it is a stage tab again, and the one shown.
      await clickAction(page, ".dock.bottom .panel", "Return Contracts to the stage");
      await until(async () => !(await shadowHas(page, ".dock.bottom")));
      assert.equal(await selected(page, ".stage"), "Contracts");
      assert.deepEqual(await shown(page, ".stage"), ["contract-list"]);

      // Everything docked: the stage says so and how to bring a view back.
      for (const label of ["Contracts", "Tokens", "Components"]) {
        await clickTab(page, ".stage", label);
        await until(async () => (await selected(page, ".stage")) === label);
        await clickAction(page, ".stage", `Dock ${label} left`);
        await until(async () => !(await labels(page, ".stage")).includes(label));
      }
      assert.ok(await shadowHas(page, ".stage .empty svg"), "the empty stage names the return icon");
      assert.deepEqual(await labels(page, ".dock.left .panel"), ["Contracts", "Tokens", "Components"]);
      assert.equal(await selected(page, ".dock.left .panel"), "Components");

      // Every view on one side: the strip is narrower than its tabs, and the
      // selected one, the newcomer, is scrolled into the strip rather than left
      // behind the actions.
      await clickAction(page, ".dock.right .panel", "Move Trace left");
      await until(async () => (await labels(page, ".dock.left .panel")).length === 4);
      assert.equal(await selected(page, ".dock.left .panel"), "Trace");
      await until(async () => selectedInView(page, ".dock.left"), 1500).catch(() =>
        assert.fail("the selected tab is scrolled into its strip"),
      );
      await clickTab(page, ".dock.left .panel", "Contracts");
      await until(async () => (await selected(page, ".dock.left .panel")) === "Contracts");
      await until(async () => selectedInView(page, ".dock.left"), 1500).catch(() =>
        assert.fail("selecting the first tab scrolls the strip back"),
      );

      // Fold the left dock: its rail reads bottom-up, so its first tab lands at the
      // bottom-left, where the layout pill floats. The lifted pill leaves it clear
      // (fix 3).
      await clickAction(page, ".dock.left .panel", "Fold");
      await until(async () => (await rect(page, ".dock.left")).width <= (await railWidth(page)) + 1.01);
      assert.equal(await layoutSwitchOnTop(page), "top", "the layout switch stays clickable beside the left rail");
      assert.ok(await railTabUncovered(page, "left"), "the left rail's first tab is not under the layout pill");

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `dock-${engine.name}.png`), fullPage: true });

      await clean(page);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  test(`the docks are bottom sheets on the phone in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, {
      phone: true,
      layout: {
        stage: "token-sheet",
        docks: { left: { open: true, views: ["trace-list"] }, bottom: { open: false, views: ["contract-list"] } },
      },
    });
    try {
      await until(async () => (await shadowHas(page, ".dock.bottom")));
      // Both sheets enter with a slide; wait until each has settled before
      // measuring, so a mid-slide height never fails an assertion under load.
      const settled = await railWidth(page);
      await until(async () => (await rect(page, ".dock.left")).height > settled * 3);
      await until(async () => Math.abs((await rect(page, ".dock.bottom")).height - settled) <= 2);

      // No sideways scroll inside the phone screen; every dock, whatever its side,
      // is a sheet under the stage, inside the frame; a folded one is just its strip.
      const overflow = await page.evaluate(() => document.body.scrollWidth - document.body.clientWidth);
      assert.ok(overflow <= 1, `no horizontal overflow, saw ${overflow}px`);
      const body = await page.evaluate(() => {
        const r = document.body.getBoundingClientRect();
        return { left: r.left, right: r.right, bottom: r.bottom };
      });
      const stage = await rect(page, ".stage");
      const left = await rect(page, ".dock.left");
      const bottom = await rect(page, ".dock.bottom");
      for (const d of [left, bottom]) {
        assert.ok(d.left >= body.left - 1 && d.right <= body.right + 1 && d.bottom <= body.bottom + 1, "inside the frame");
        assert.ok(d.top >= stage.bottom - 1, "under the stage");
        assert.ok(Math.abs(d.width - stage.width) <= 1, "full width");
      }
      assert.ok(Math.abs(bottom.height - (await railWidth(page))) <= 2, "a folded sheet is its strip");
      assert.ok(left.height > bottom.height * 3, "an open sheet shows its body");
      assert.ok(await visible(page, "trace-list"), "the docked trace reads on the phone");
      assert.ok(stage.height > left.height / 3, "the stage keeps a readable height");

      // The reported case: a left dock is a bottom sheet here, so its fold glyph is
      // turned down like every other sheet, not left as it would be on the desk.
      assert.notEqual(await foldTransform(page, ".dock.left .panel"), "none", "the fold glyph is turned on a phone side sheet");

      // Fold the left sheet from its strip: it collapses to just its strip.
      const strip = await railWidth(page);
      await clickAction(page, ".dock.left .panel", "Fold");
      await until(async () => (await rect(page, ".dock.left")).height <= strip + 2);
      assert.ok(Math.abs((await rect(page, ".dock.left")).height - strip) <= 2, "a folded left sheet is its strip");
      // The panel hides once the slide ends (its visibility is delayed to the still
      // end), so wait for it rather than reading at the height boundary.
      await until(async () => !(await visible(page, "trace-list")), 1000).catch(() =>
        assert.fail("the folded sheet hides its body"),
      );
      // Unfold it from the rail: it reopens on its tab.
      await clickAction(page, ".dock.left .rail", "Unfold");
      await until(async () => (await rect(page, ".dock.left")).height > strip * 3);
      assert.ok(await visible(page, "trace-list"), "the left sheet reopens");

      // Unfold the bottom sheet from its strip tab too.
      await clickTab(page, ".dock.bottom .rail", "Contracts");
      await until(async () => (await rect(page, ".dock.bottom")).height > bottom.height * 3);
      assert.ok(await visible(page, "contract-list"));

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `dock-phone-${engine.name}.png`), fullPage: true });

      await clean(page);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  test(`the layout switch bars arranging but never folding, and a hidden switch keeps arranging off in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, {
      layout: {
        stage: "token-sheet",
        docks: { right: { open: true, views: ["trace-list", "contract-list"], active: "trace-list" } },
      },
    });
    try {
      await until(async () => await shadowHas(page, ".dock.right"));
      // Arranging on: the arrange controls are there, the switch reads pressed.
      assert.ok(await shadowHas(page, ".stage .action:not(.fold)"), "the stage has arrange actions when arranging");
      assert.ok(await shadowHas(page, ".dock.right .panel .action:not(.fold)"), "the dock has arrange actions when arranging");
      assert.equal(await switchPressed(page), "true");

      // Turn arranging off: every arrange action disappears (stage and docks), the
      // switch reads unpressed, the desk keeps its tabs, and the fold stays.
      await clickSwitch(page);
      await until(async () => (await switchPressed(page)) === "false");
      await until(async () => !(await shadowHas(page, ".action:not(.fold)")));
      assert.deepEqual(await labels(page, ".stage"), ["Tokens", "Components"], "stage tabs remain while not arranging");
      assert.deepEqual(await labels(page, ".dock.right .panel"), ["Trace", "Contracts"], "dock tabs remain");
      assert.deepEqual(await actionLabels(page, ".dock.right .panel"), ["Fold"], "only the fold control remains");
      // A rail tab still unfolds (via _activate): switch the dock's shown tab.
      await clickTab(page, ".dock.right .panel", "Contracts");
      await until(async () => (await selected(page, ".dock.right .panel")) === "Contracts");

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `dock-locked-${engine.name}.png`), fullPage: true });

      // Folding is daily use, not arranging: fold to the rail and unfold back while
      // arranging is off.
      const open = await rect(page, ".dock.right");
      await clickAction(page, ".dock.right .panel", "Fold");
      const rail = await railWidth(page);
      await until(async () => (await rect(page, ".dock.right")).width <= rail + 1.01);
      await clickAction(page, ".dock.right .rail", "Unfold");
      await until(async () => Math.abs((await rect(page, ".dock.right")).width - open.width) < 1);

      // Turn arranging back on: the controls come back.
      await clickSwitch(page);
      await until(async () => (await switchPressed(page)) === "true");
      await until(async () => await shadowHas(page, ".dock.right .panel .action:not(.fold)"));

      // Hide the switch on /design/settings: the desk is not arrangeable, and the
      // switch leaves the page.
      await page.goto(`${BASE_URL}/design/settings`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelector("settings-sheet")?.shadowRoot?.querySelector(".row"));
      await hideSwitchOnSettings(page);
      await until(async () =>
        page.evaluate(() => JSON.parse(localStorage.getItem("settings") || "{}").layoutSwitchHidden === true),
      );

      await page.goto(`${BASE_URL}/design/dock`, { waitUntil: "networkidle" });
      await ready(page);
      await until(async () => await shadowHas(page, ".dock.right"));
      assert.ok(await switchGone(page), "the layout switch is hidden");
      await until(async () => !(await shadowHas(page, ".action:not(.fold)")), 2000);
      // Folding still works with the switch hidden.
      await clickAction(page, ".dock.right .panel", "Fold");
      await until(async () => (await rect(page, ".dock.right")).width <= (await railWidth(page)) + 1.01);

      await page.evaluate(() => localStorage.clear());
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}

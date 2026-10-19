import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Arranging the desk on the dock stem: one journey (9), approved in checks/journeys.json.
// The page loads once on a fresh desk, which seeds Trace on the right; the steps then dock,
// switch, fold and unfold, turn arranging off and on, reload a stored layout, dock every
// view and fold the left rail, each from where the step before it left the desk. The phone
// layout needs its own start and stays in page.test.mjs.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, journey, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const SCREENSHOTS = resolve(REPO, ".screenshots");

// The dock's layout is stored under a page-scoped key (dock/store.js), so the stem's
// arrangement never clobbers an app desk's.
const DOCK_KEY = "dock:/workshop/design/dock";

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
// Three docks share the "Fold"/"Unfold" labels, so an action is found within a scope.
const clickAction = (page, scope, label) =>
  page.evaluate(
    ({ scope, label }) => {
      const b = document.querySelector("dock-desk").shadowRoot.querySelector(`${scope} .action[aria-label="${label}"]`);
      if (!b) throw new Error(`no action "${label}" in ${scope}`);
      b.click();
    },
    { scope, label },
  );
// The bar is the panel's handle: clicking the container element itself makes its own
// click the target, clear of any tab or action button inside it.
const clickBar = (page, scope) =>
  page.evaluate((scope) => {
    const el = document.querySelector("dock-desk").shadowRoot.querySelector(scope);
    if (!el) throw new Error(`no bar ${scope}`);
    el.click();
  }, scope);
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
// Whether a fixed pill is the topmost element at its own centre: proof the dock does
// not paint over it.
const onTop = (page, tag) =>
  page.evaluate((tag) => {
    const sw = document.querySelector(tag);
    const r = sw.getBoundingClientRect();
    if (getComputedStyle(sw).display === "none" || r.width === 0) return "hidden";
    const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return el === sw || sw.contains(el) ? "top" : "covered";
  }, tag);
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
// The layout switch, a light-DOM toggle beside the desk. Pressed = arranging.
const clickSwitch = (page) =>
  page.evaluate(() => document.querySelector("layout-switch").shadowRoot.querySelector("button").click());
const switchPressed = (page) =>
  page.evaluate(() => document.querySelector("layout-switch").shadowRoot.querySelector("button")?.getAttribute("aria-pressed"));
const railWidth = (page) =>
  page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector("dock-desk").shadowRoot.querySelector(".strip")).height),
  );

const ready = (page) =>
  page.waitForFunction(() => document.querySelector("dock-desk")?.shadowRoot?.querySelector(".stage .body"));

// What the user sees of the desk, read in one go: each group's tabs (the shown one
// starred), whether a side dock is folded to its rail, and whether arranging is on.
const look = ({ page }) =>
  page.evaluate(() => {
    const root = document.querySelector("dock-desk")?.shadowRoot;
    const tabs = (sel) =>
      [...(root?.querySelectorAll(`${sel} [role="tab"]`) ?? [])].map(
        (b) => b.textContent.trim() + (b.getAttribute("aria-selected") === "true" ? "*" : ""),
      );
    const docks = {};
    for (const side of ["left", "right", "bottom"]) {
      const dock = root?.querySelector(`.dock.${side}`);
      if (!dock) continue;
      docks[side] = dock.classList.contains("folded") ? { folded: tabs(`.dock.${side} .rail`) } : { open: tabs(`.dock.${side} .panel`) };
    }
    return {
      stage: tabs(".stage"),
      docks,
      arranging: document.querySelector("layout-switch")?.shadowRoot?.querySelector("button")?.getAttribute("aria-pressed") ?? null,
    };
  });

const want = (cond, msg) => (cond ? null : msg);
const all = (...checks) => checks.find(Boolean) ?? null;
const plain = (tabs) => (tabs ?? []).map((t) => t.replace(/\*$/, ""));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Under --isolate a step reaches its start the way a returning user would: the layout
// stored for this page, then a reload.
const arrange = async (v, layout) => {
  await v.page.evaluate(({ key, layout }) => localStorage.setItem(key, JSON.stringify(layout)), { key: DOCK_KEY, layout });
  await v.page.reload();
  await ready(v.page);
};

// Trace and Contracts docked on the right, open, the stage holding Tokens and Components.
const rightPair = (active) => ({
  state: `Trace and Contracts open on the right with ${active} shown`,
  check: (s) =>
    all(
      want(same(plain(s.stage), ["Tokens", "Components"]), `the stage holds ${s.stage}`),
      want(same(s.docks.right?.open, ["Trace", "Contracts"].map((l) => (l === active ? `${l}*` : l))), `the right dock is ${JSON.stringify(s.docks.right)}`),
      want(!s.docks.left && !s.docks.bottom, `other docks are open: ${JSON.stringify(s.docks)}`),
      want(s.arranging === "true", "arranging is off"),
    ),
  reach: (v) =>
    arrange(v, {
      stage: "token-sheet",
      docks: { right: { open: true, views: ["trace-list", "contract-list"], active: active === "Trace" ? "trace-list" : "contract-list" } },
    }),
});

for (const engine of ENGINES) {
  // Browser: a gesture.
  test(`arranging the dock stem's desk in ${engine.name}`, ...journey({
    launch: () => engine.launch(),
    open: async (browser) => {
      const context = await browser.newContext();
      try {
        context.setDefaultTimeout(4000);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/dock`);
        await ready(page);
        return { page, problems, close: () => context.close() };
      } catch (error) {
        await context.close();
        throw error;
      }
    },
    look,
  }, [
    {
      // dock.html declares side="right" on Trace and the desk has no stored arrangement,
      // so it seeds Trace into the right dock while the rest stay stage tabs (6.4). The
      // first user gesture stores a layout and wins thereafter.
      name: "a fresh desk seeds the side a page declares",
      from: {
        state: "a fresh desk",
        check: (s) => want(s.stage.length > 0, "the stage shows no tabs"),
        reach: () => {},
      },
      run: async (v) => {
        const { page } = v;
        await until(async () => await shadowHas(page, ".dock.right"));
        assert.deepEqual(await labels(page, ".stage"), ["Tokens", "Contracts", "Components"]);
        assert.deepEqual(await labels(page, ".dock.right .panel"), ["Trace"], "Trace seeds docked on the right");
      },
    },
    {
      // Trace returned to the stage gives the all-staged picture; from there a view is
      // docked, a second joins it, and the dock's tabs switch its bodies.
      name: "the desk is four tab groups: dock a view and switch its tabs",
      from: {
        state: "a fresh desk with Trace seeded on the right",
        check: (s) =>
          all(
            want(same(plain(s.stage), ["Tokens", "Contracts", "Components"]), `the stage holds ${s.stage}`),
            want(same(s.docks.right?.open, ["Trace*"]), `the right dock is ${JSON.stringify(s.docks.right)}`),
          ),
        reach: () => {},
      },
      run: async (v) => {
        const { page } = v;
        await clickAction(page, ".dock.right .panel", "Return Trace to the stage");
        await v.see((s) => want(!s.docks.right && s.stage.length === 4, "Trace is not back on the stage"));
        await clickTab(page, ".stage", "Tokens");
        await v.see((s) => want(s.stage[0] === "Tokens*", "Tokens is not shown"));

        // Starting picture: every view a stage tab, Tokens shown, nothing docked,
        // and the stage's actions are the three edges (one strip anatomy, 7.6 icons).
        assert.deepEqual(await labels(page, ".stage"), ["Tokens", "Contracts", "Components", "Trace"]);
        assert.equal(await selected(page, ".stage"), "Tokens");
        assert.deepEqual(await shown(page, ".stage"), ["token-sheet"]);
        assert.equal(await shadowHas(page, ".dock"), false, "no dock band before anything is docked");
        assert.deepEqual(await actionLabels(page, ".stage"), ["Dock Tokens left", "Dock Tokens right", "Dock Tokens bottom"]);
        assert.ok(await shadowHas(page, ".stage .action svg path"), "actions are icons");
        assert.ok((await windowOverflow(page)) <= 1, "the page does not scroll with nothing docked");

        // The layout pill's glyph reads at the same size as a strip icon (fix 1).
        const glyphs = await glyphWidths(page);
        assert.ok(
          Math.abs(glyphs.pill - glyphs.strip) <= 0.5,
          `the layout glyph matches a strip icon, saw ${glyphs.pill} vs ${glyphs.strip}`,
        );

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
        assert.equal(await onTop(page, "viewport-switch"), "top", "the viewport switch is not covered by the dock");

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
      },
    },
    {
      name: "a dock keeps its scroll, folds to its rail and unfolds on a tab",
      from: rightPair("Trace"),
      run: async (v) => {
        const { page } = v;
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
      },
    },
    {
      name: "the bar folds and unfolds on the same tab, and a tab click only switches",
      from: rightPair("Contracts"),
      run: async (v) => {
        const { page } = v;
        const open = await rect(page, ".dock.right");
        const rail = await railWidth(page);

        // The bar itself is the handle: bare strip space folds, bare rail space
        // unfolds on the same tab, and a tab click only switches.
        await clickBar(page, ".dock.right .panel .strip");
        await until(async () => (await rect(page, ".dock.right")).width <= rail + 1.01);
        await until(async () => !(await visible(page, "contract-list")), 1000).catch(() =>
          assert.fail("clicking bare strip space folds the dock"),
        );
        await clickBar(page, ".dock.right .rail");
        await until(async () => Math.abs((await rect(page, ".dock.right")).width - open.width) < 1);
        assert.equal(await selected(page, ".dock.right .panel"), "Contracts", "the bar unfolds on the same tab");
        assert.ok(await visible(page, "contract-list"), "clicking bare rail space unfolds the dock");
        await clickTab(page, ".dock.right .panel", "Trace");
        await until(async () => (await selected(page, ".dock.right .panel")) === "Trace");
        assert.ok((await rect(page, ".dock.right")).width > rail * 5, "a tab switch does not fold the dock");
        assert.ok(await visible(page, "trace-list"), "the panel stays open on a tab switch");
      },
    },
    {
      name: "the layout switch bars arranging but never folding",
      from: rightPair("Trace"),
      run: async (v) => {
        const { page } = v;
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
        // A tab still switches the dock's shown tab while not arranging.
        await clickTab(page, ".dock.right .panel", "Contracts");
        await until(async () => (await selected(page, ".dock.right .panel")) === "Contracts");

        mkdirSync(SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: resolve(SCREENSHOTS, `dock-locked-${engine.name}.png`), fullPage: true });

        // Turn arranging back on: the controls come back.
        await clickSwitch(page);
        await until(async () => (await switchPressed(page)) === "true");
        await until(async () => await shadowHas(page, ".dock.right .panel .action:not(.fold)"));
      },
    },
    {
      // The test is about a load: the layout stored before it is the one the desk shows.
      name: "a stored layout is kept across a load, and a docked view moves between edges and returns",
      from: {
        state: "arranging on",
        check: (s) => want(s.arranging === "true", "arranging is off"),
        reach: () => {},
      },
      run: async (v) => {
        const { page } = v;
        await arrange(v, {
          stage: "components",
          docks: { right: { open: true, views: ["trace-list", "contract-list"], active: "contract-list" } },
        });
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
      },
    },
    {
      name: "with every view docked the stage says so, and a full strip keeps its shown tab in view",
      from: {
        state: "Trace alone on the right and the other three on the stage",
        check: (s) =>
          all(
            want(same(plain(s.stage).sort(), ["Components", "Contracts", "Tokens"]), `the stage holds ${s.stage}`),
            want(same(plain(s.docks.right?.open), ["Trace"]), `the right dock is ${JSON.stringify(s.docks.right)}`),
            want(!s.docks.left && !s.docks.bottom, `other docks are open: ${JSON.stringify(s.docks)}`),
          ),
        reach: (v) => arrange(v, { stage: "contract-list", docks: { right: { open: true, views: ["trace-list"], active: "trace-list" } } }),
      },
      run: async (v) => {
        const { page } = v;
        // Contracts, then Tokens, docked left, so only Components is left on the stage.
        for (const label of ["Contracts", "Tokens"]) {
          await clickTab(page, ".stage", label);
          await until(async () => (await selected(page, ".stage")) === label);
          await clickAction(page, ".stage", `Dock ${label} left`);
          await until(async () => (await labels(page, ".dock.left .panel")).includes(label));
        }

        // Everything docked: the stage says so and how to bring a view back.
        await until(async () => (await labels(page, ".stage")).join() === "Components");
        await clickAction(page, ".stage", "Dock Components left");
        await until(async () => (await labels(page, ".stage")).length === 0);
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
      },
    },
    {
      name: "a folded left rail clears the layout pill",
      from: {
        state: "every view open in the left dock",
        check: (s) =>
          all(
            want(s.stage.length === 0, `the stage holds ${s.stage}`),
            want(same(plain(s.docks.left?.open).sort(), ["Components", "Contracts", "Tokens", "Trace"]), `the left dock is ${JSON.stringify(s.docks.left)}`),
          ),
        reach: (v) =>
          arrange(v, {
            stage: null,
            docks: { left: { open: true, views: ["contract-list", "token-sheet", "component-list", "trace-list"], active: "contract-list" } },
          }),
      },
      run: async (v) => {
        const { page } = v;
        await clickAction(page, ".dock.left .panel", "Fold");
        // The left rail reads bottom-up, so its first tab lands at the bottom-left, where
        // the layout pill floats. The lifted pill leaves it clear (fix 3).
        await until(async () => (await labels(page, ".dock.left .rail")).length === 4);
        const rail = await railWidth(page);
        await until(async () => (await rect(page, ".dock.left")).width <= rail + 1.01);
        assert.equal(await onTop(page, "layout-switch"), "top", "the layout switch stays clickable beside the left rail");
        assert.ok(await railTabUncovered(page, "left"), "the left rail's first tab is not under the layout pill");

        mkdirSync(SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: resolve(SCREENSHOTS, `dock-${engine.name}.png`), fullPage: true });
      },
    },
  ]));
}

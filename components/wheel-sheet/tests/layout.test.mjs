import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// How the sheet stands at each width: wide, normal, narrow and in the phone preview. Only a
// browser lays it out; a wheel is seeded through the API under the test's own login.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/design/journal`;

// The workshop profile's preferences, with Vim keys on.
const VIM_ON = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

const ID = "01K7TEST00000000000000WHM2";
const ACTUAL = [6, 5, 4, 7, 3, 6, 5, 2];
const WANTED = [9, 7, 6, 8, 7, 6, 7, 6];

const dayOf = (ms) => {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
};
// Today's journal day: it ends at 2:00 the next night (13, Journal).
const today = () => dayOf(Date.now() - 2 * 3600e3);

const inSheet = (page, fn) =>
  page.evaluate((fn) => new Function("root", `return (${fn})(root)`)(document.querySelector("wheel-sheet").shadowRoot), fn.toString());

// The area the keyboard is on, or the class of what else has it inside the view.
const at = (page) => inSheet(page, (root) => root.activeElement?.dataset?.i ?? root.activeElement?.className ?? null);

// Whether an element stands inside what the scrolling part of the page around it shows.
const inView = (locator) =>
  locator.evaluate((el) => {
    let up = el;
    // Through the slot, because the page that scrolls stands in the shadow of the view around.
    do up = up.assignedSlot ?? up.parentElement ?? up.getRootNode().host;
    while (up && !(up.scrollHeight > up.clientHeight && /auto|scroll/.test(getComputedStyle(up).overflowY)));
    const box = el.getBoundingClientRect();
    const frame = up?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
    return box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1;
  });

async function open(browser, { viewport, vim = false, phone = false }) {
  const context = await browser.newContext({ viewport });
  context.setDefaultTimeout(4000);
  await signedIn(context, forgeCookie("wheellayout"));
  const put = await context.request.put(`${BASE_URL}/api/wheels/${ID}`, { data: { day: today(), actual: ACTUAL, wanted: WANTED, baseVersion: null } });
  assert.equal(put.status(), 200);
  if (vim) await context.addInitScript((v) => localStorage.setItem("settings", v), VIM_ON);
  if (phone) await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  return { context, page, problems, sheet: page.locator("wheel-sheet") };
}

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`wheel-sheet's layouts in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Sets the view's own width, which is what the layouts choose by, and shows it open.
    const atWidth = async (width) => {
      const { context, page, problems, sheet } = await open(browser, { viewport: { width: 1600, height: 900 } });
      await sheet.evaluate((el, w) => (el.style.width = w), `${width}px`);
      await sheet.locator(".card").waitFor();
      const box = (sel) => sheet.locator(sel).first().boundingBox();
      const columns = () => inSheet(page, (root) => getComputedStyle(root.querySelector(".sum")).gridTemplateColumns.split(" ").length);
      const cardColumns = await columns();
      await sheet.locator(".card").click();
      await sheet.locator(".sheet").waitFor();
      return { context, page, problems, sheet, box, cardColumns };
    };

    // Browser: rendering and layout.
    test("wide: the sheet fills the page, the wheel and rows keep their size on the left, and the panel stands on the right with its groups side by side", async () => {
      const { context, problems, sheet, box, cardColumns } = await atWidth(1150);
      try {
        assert.equal((await box(".sheet")).width, 1150, "no form's width any more");
        assert.equal(cardColumns, 4);
        const wheel = await box(".wheel");
        const first = await box('.area[data-i="0"]');
        const second = await box('.area[data-i="1"]');
        const square = await box(".sq");
        assert.equal(wheel.width, 172);
        assert.ok(wheel.x + wheel.width <= first.x, "the wheel beside the rows");
        assert.ok(square.width <= 2 * square.height, "a square stays near square");
        const hint = sheet.locator(".q-hint");
        assert.equal(await hint.innerText(), "Press an area’s arrow to write about it.");
        const hintAt = await box(".q-hint");
        assert.ok(hintAt.x >= first.x + first.width, "the line stands where the panel will");

        await sheet.locator('.area[data-i="4"] .opener').click();
        assert.equal(await hint.count(), 0);
        const panel = await box(".qs");
        assert.ok(panel.x >= first.x + first.width, "the panel on the right");
        assert.ok(panel.y <= first.y, "from the top of the sheet");
        const groups = sheet.locator(".q-group");
        const [one, two] = [await groups.nth(0).boundingBox(), await groups.nth(1).boundingBox()];
        assert.equal(one.y, two.y, "side by side");
        assert.ok(one.x + one.width <= two.x);
        assert.equal((await box('.area[data-i="1"]')).y - (await box('.area[data-i="0"]')).y, second.y - first.y, "a tall panel does not spread the rows");
        assert.equal((await box(".sq")).width, square.width);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("the panel goes beside the rows only where each box still holds a sentence on two lines, and the card takes four columns where they fit", async () => {
      const { context, problems, sheet } = await open(browser, { viewport: { width: 1600, height: 900 } });
      try {
        const width = (w) => sheet.evaluate((el, v) => (el.style.width = v), `${w}px`);
        const columns = () => sheet.evaluate((el) => getComputedStyle(el.shadowRoot.querySelector(".sum")).gridTemplateColumns.split(" ").length);
        await sheet.locator(".card").waitFor();
        await width(832);
        assert.equal(await columns(), 4);
        await width(831);
        assert.equal(await columns(), 2);
        await sheet.locator(".card").click();
        await sheet.locator('.area[data-i="0"] .opener').click();
        const box = (sel) => sheet.locator(sel).first().boundingBox();
        await width(1056);
        const area = await box(".area");
        assert.ok((await box(".qs")).x >= area.x + area.width, "wide: beside the rows");
        assert.ok((await box(".box")).width >= 200, "a box holds about five words a line");
        await width(1055);
        assert.ok((await box(".qs")).y >= (await box('.area[data-i="7"]')).y, "one pixel less: below them");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("normal: the panel stands below the wheel and the rows, and no line says to press an arrow", async () => {
      const { context, problems, sheet, box, cardColumns } = await atWidth(462);
      try {
        assert.equal(cardColumns, 2);
        assert.equal((await box(".sheet")).width, 462);
        assert.equal(await sheet.locator(".q-hint").isVisible(), false);
        assert.ok((await box(".wheel")).x + (await box(".wheel")).width <= (await box('.area[data-i="7"]')).x, "the wheel beside the rows");
        assert.equal((await box(".sq")).height, 16);
        await sheet.locator('.area[data-i="2"] .opener').click();
        // Measured after the press: opening scrolls the panel into view.
        const wheel = await box(".wheel");
        const last = await box('.area[data-i="7"]');
        const panel = await box(".qs");
        assert.ok(panel.y >= last.y + last.height, "below every row");
        assert.ok(panel.y >= wheel.y + wheel.height, "and below the wheel");
        assert.ok(panel.x <= wheel.x + 1, "from the sheet's left");
        const groups = sheet.locator(".q-group");
        assert.ok((await groups.nth(1).boundingBox()).y > (await groups.nth(0).boundingBox()).y, "one group above the other");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("between normal and wide the wheel and rows keep their size and the panel below has its groups side by side", async () => {
      const { context, problems, sheet, box } = await atWidth(806);
      try {
        const square = await box(".sq");
        assert.ok(square.width <= 2 * square.height, "a square stays near square");
        await sheet.locator('.area[data-i="2"] .opener').click();
        assert.ok((await box(".qs")).y >= (await box('.area[data-i="7"]')).y);
        const groups = sheet.locator(".q-group");
        assert.equal((await groups.nth(0).boundingBox()).y, (await groups.nth(1).boundingBox()).y);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    const layout = async (phone) => {
      const { context, page, problems, sheet } = await open(browser, { phone, viewport: { width: 1280, height: 900 } });
      try {
        if (phone) await until(() => page.evaluate(() => document.documentElement.dataset.viewport === "phone"));
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        const box = (sel) => sheet.locator(sel).first().boundingBox();
        const out = { wheel: await box(".wheel"), rows: await box(".area"), sq: await box(".sq"), host: await sheet.boundingBox() };
        out.overflow = await inSheet(page, (root) => root.querySelector(".sheet").scrollWidth > root.querySelector(".sheet").clientWidth);
        await sheet.locator(".done").click();
        await sheet.locator(".card").waitFor();
        out.columns = await inSheet(page, (root) => getComputedStyle(root.querySelector(".sum")).gridTemplateColumns.split(" ").length);
        assert.deepEqual(problems, []);
        return out;
      } finally {
        await context.close();
      }
    };

    // Browser: rendering and layout.
    test("a very narrow page keeps the wheel inside and the squares pressable", async () => {
      const { context, problems, sheet } = await open(browser, { viewport: { width: 1600, height: 900 } });
      try {
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        const box = (sel) => sheet.locator(sel).first().boundingBox();

        await sheet.evaluate((el) => (el.style.width = "230px"));
        const sheetAt = await box(".sheet");
        const wheelAt = await box(".wheel");
        assert.ok(wheelAt.x >= sheetAt.x && wheelAt.x + wheelAt.width <= sheetAt.x + sheetAt.width, "the wheel stays inside the sheet");
        assert.ok((await box(".sq")).width >= 10, "a square can be pressed");
        assert.ok((await box(".scale")).y > (await box(".score")).y, "the squares stand under the name and score");
        const buttonsAt = await box(".buttons");
        assert.ok(buttonsAt.x + buttonsAt.width <= sheetAt.x + sheetAt.width, "Delete and Done stay inside");

        await sheet.locator(".done").click();
        await sheet.locator(".card").waitFor();
        assert.ok((await box(".mini")).y + (await box(".mini")).height <= (await box(".sum")).y, "the small wheel stands above the lines");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("in the phone preview the wheel stands above the rows, with larger targets, and nothing runs off the page", async () => {
      const phone = await layout(true);
      assert.ok(phone.wheel.y + phone.wheel.height <= phone.rows.y, "above the rows");
      assert.equal(phone.wheel.width, 240);
      assert.equal(phone.sq.height, 32);
      assert.equal(phone.columns, 1);
      assert.equal(phone.overflow, false);
      assert.ok(phone.host.width <= 390);
    });

    // Browser: rendering and layout.
    test("in the phone preview the panel opens directly under its row, follows the keys, and the row stays in view", async () => {
      const { context, page, problems, sheet } = await open(browser, { phone: true, vim: true, viewport: { width: 1280, height: 900 } });
      try {
        await until(() => page.evaluate(() => document.documentElement.dataset.viewport === "phone"));
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        const box = (sel) => sheet.locator(sel).first().boundingBox();
        const under = async (i) => {
          const row = await box(`.area[data-i="${i}"]`);
          const panel = await box(".qs");
          const next = await box(`.area[data-i="${i + 1}"]`);
          assert.ok(Math.abs(panel.y - (row.y + row.height)) <= 1, `the panel directly under row ${i}`);
          assert.ok(Math.abs(next.y - (panel.y + panel.height)) <= 1, "and the next row directly under it");
          assert.equal(await inView(sheet.locator(`.area[data-i="${i}"]`)), true, `row ${i} in view`);
        };
        await sheet.locator('.area[data-i="0"] .opener').click();
        await under(0);
        assert.equal(await sheet.locator(".q-title").isVisible(), false, "the row names it already");
        for (const [key, i] of [["j", 1], ["j", 2], ["j", 3], ["k", 2], ["k", 1]]) {
          await page.keyboard.press(key);
          await until(async () => (await at(page)) === String(i));
          await under(i);
        }
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

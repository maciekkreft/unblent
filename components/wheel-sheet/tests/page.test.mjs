import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// What only a browser shows: the wheel and the rows drawn from one set of scores, the
// keyboard's way in, through and out of the sheet, and a reload against real storage. The
// layouts are in layout.test.mjs and the boxes in boxes.test.mjs; the decisions are tested in Node. A wheel is
// seeded through the API under the test's own login: nothing can add one until + Add sheet.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/design/journal`;

// The workshop profile's preferences, with Vim keys on.
const VIM_ON = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

const ID = "01K7TEST00000000000000WHK1";
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

// The area the keyboard is on, the tab, or the class of what else has it inside the view.
const at = (page) => inSheet(page, (root) => root.activeElement?.dataset?.i ?? root.activeElement?.dataset?.mode ?? root.activeElement?.className ?? null);

async function open(browser, { viewport = { width: 900, height: 900 }, vim = false, phone = false, wheels = [{ id: ID, day: today(), actual: ACTUAL, wanted: WANTED }], days = [] } = {}) {
  const context = await browser.newContext({ viewport });
  context.setDefaultTimeout(4000);
  await signedIn(context, forgeCookie("wheel"));
  for (const w of wheels) {
    const put = await context.request.put(`${BASE_URL}/api/wheels/${w.id}`, { data: { day: w.day, actual: w.actual, wanted: w.wanted, answers: w.answers, baseVersion: null } });
    assert.equal(put.status(), 200);
  }
  for (const record of days) {
    const put = await context.request.put(`${BASE_URL}/api/journal/days`, { data: { record, baseVersion: null } });
    assert.equal(put.status(), 200);
  }
  if (vim) await context.addInitScript((v) => localStorage.setItem("settings", v), VIM_ON);
  if (phone) await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  return { context, page, problems, sheet: page.locator("wheel-sheet") };
}

// How many cells each area has filled on the wheel, and how many squares each row has filled.
const drawn = (page) =>
  inSheet(page, (root) => {
    const cells = [...root.querySelectorAll(".wheel .w-cell")];
    const wheel = Array.from({ length: 8 }, (_, i) => cells.slice(i * 10, i * 10 + 10).filter((c) => c.classList.contains("on")).length);
    const rows = [...root.querySelectorAll(".area")].map((a) => a.querySelectorAll(".sq.on").length);
    const wanted = [...root.querySelectorAll(".area")].map((a) => [...a.querySelectorAll(".sq")].findIndex((q) => q.classList.contains("was")) + 1);
    const lines = root.querySelectorAll(".wheel .w-last").length;
    const scores = [...root.querySelectorAll(".score")].map((s) => s.textContent.trim());
    return { wheel, rows, wanted, lines, scores };
  });

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`wheel-sheet in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: rendering and layout.
    test("the wheel and the rows stay in step, a click on either sets the chosen score, and the current score clears", async () => {
      const { context, page, problems, sheet } = await open(browser);
      try {
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        assert.deepEqual(await at(page), "0", "the keyboard lands on the first area");
        const start = await drawn(page);
        assert.deepEqual(start.wheel, ACTUAL);
        assert.deepEqual(start.rows, ACTUAL);
        assert.deepEqual(start.wanted, WANTED);
        assert.equal(start.lines, 8);
        assert.equal(start.scores[0], "6/9");

        await sheet.getByRole("button", { name: "Work 8", exact: true }).click();
        let now = await drawn(page);
        assert.equal(now.rows[1], 8);
        assert.equal(now.wheel[1], 8, "a click on a square fills the wheel");
        assert.equal(await at(page), "1", "the keyboard stays on that area");

        // The third area's ninth ring. A cell's box mostly covers its neighbors, so the click
        // is sent to it rather than to a point on the screen.
        await inSheet(page, (root) => root.querySelectorAll(".wheel .w-cell")[2 * 10 + 8].dispatchEvent(new MouseEvent("click", { bubbles: true })));
        now = await drawn(page);
        assert.equal(now.wheel[2], 9);
        assert.equal(now.rows[2], 9, "a click on the wheel fills the row");

        await sheet.getByRole("button", { name: "Wanted", exact: true }).click();
        assert.equal(await sheet.getByRole("button", { name: "Wanted", exact: true }).getAttribute("aria-pressed"), "true");
        await sheet.getByRole("button", { name: "Fun 3", exact: true }).click();
        now = await drawn(page);
        assert.equal(now.wanted[7], 3);
        assert.equal(now.rows[7], 2, "Actual is left alone");
        await sheet.getByRole("button", { name: "Fun 3", exact: true }).click();
        now = await drawn(page);
        assert.equal(now.wanted[7], 0, "the current score clears");
        assert.equal(now.lines, 7, "and its line goes from the wheel");
        assert.equal(now.scores[7], "2/–");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a reload against real storage.
    test("Done folds it into a card that says each area's scores and gap, and a reload keeps what was set", async () => {
      const { context, page, problems, sheet } = await open(browser);
      try {
        await sheet.locator(".card").click();
        await sheet.getByRole("button", { name: "Health 9", exact: true }).click();
        await sheet.locator(".done").click();
        const card = sheet.locator(`.card[data-id="${ID}"]`);
        await card.waitFor();
        assert.equal(await inSheet(page, (root) => root.activeElement?.className), "card", "the keyboard stays on the card");
        const said = async () => (await card.innerText()).replace(/\s+/g, " ").trim();
        assert.match(await said(), /^Health 9\/9 Work 5\/7−2 Money 4\/6−2/);
        await page.reload({ waitUntil: "domcontentloaded" });
        await card.waitFor();
        assert.match(await said(), /^Health 9\/9 Work 5\/7−2/);
        assert.equal(await sheet.locator(".mini .w-cell.on").count(), 9 + 5 + 4 + 7 + 3 + 6 + 5 + 2);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("without Vim keys the arrows move, set the chosen tab's score and reach the tabs, Shift chooses the tab, and Tab goes through the sheet", async () => {
      const { context, page, problems, sheet } = await open(browser);
      try {
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        const chosen = () => sheet.locator('.modes button[aria-pressed="true"]').innerText();
        await page.keyboard.press("ArrowDown");
        assert.equal(await at(page), "1");
        await page.keyboard.press("ArrowRight");
        assert.equal((await drawn(page)).rows[1], 6);
        assert.equal(await chosen(), "Actual");

        await page.keyboard.press("Shift+ArrowRight");
        assert.equal(await chosen(), "Wanted");
        assert.equal(await at(page), "1", "the keyboard stays on the area");
        assert.equal((await drawn(page)).wanted[1], 7, "choosing changes no score");
        await page.keyboard.press("ArrowLeft");
        assert.equal((await drawn(page)).wanted[1], 6, "left changes the chosen tab's score");
        assert.equal((await drawn(page)).rows[1], 6, "and leaves the other alone");
        assert.equal(await chosen(), "Wanted", "the choice stays");
        await page.keyboard.press("Shift+ArrowLeft");
        assert.equal(await chosen(), "Actual");
        await page.keyboard.press("ArrowLeft");
        assert.equal((await drawn(page)).rows[1], 5);
        await page.keyboard.press("j");
        assert.equal(await at(page), "1", "letters are not keys without Vim keys");

        // Tab: the area the keys act on, then the buttons, and back the same way.
        await page.keyboard.press("Tab");
        assert.equal(await at(page), "delete");
        await page.keyboard.press("Tab");
        assert.equal(await at(page), "done");
        await page.keyboard.press("ArrowUp");
        assert.equal(await at(page), "1", "from a button, up or down first goes to the area the keys act on");
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await at(page), "1");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await at(page), "wanted");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await at(page), "actual");

        // The tabs as a row: left and right switch them with the keyboard going along, down
        // goes to the first area and up comes back.
        await page.keyboard.press("ArrowRight");
        assert.equal(await at(page), "wanted");
        assert.equal(await chosen(), "Wanted");
        await page.keyboard.press("ArrowLeft");
        assert.equal(await at(page), "actual");
        assert.equal(await chosen(), "Actual");
        await page.keyboard.press("ArrowDown");
        assert.equal(await at(page), "0");
        await page.keyboard.press("ArrowUp");
        assert.equal(await at(page), "actual");
        await page.keyboard.press("ArrowDown");

        // Enter opens the panel; Escape closes it, then folds.
        const panel = sheet.locator(".qs");
        await page.keyboard.press("Enter");
        await panel.waitFor();
        assert.equal(await at(page), "0");
        await page.keyboard.press("ArrowDown");
        assert.equal(await sheet.locator(".q-title span").first().innerText(), "Work", "the panel follows the area");
        await page.keyboard.press("Escape");
        await until(async () => (await panel.count()) === 0);
        assert.equal(await at(page), "1", "the keyboard stays on the area");
        await page.keyboard.press("Escape");
        await sheet.locator(".card").waitFor();
        assert.equal(await at(page), "card");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on, j and k go from the page into the card and the sheet and back, at both ends", async () => {
      const { context, page, problems, sheet } = await open(browser, { vim: true });
      try {
        await sheet.locator(".card").waitFor();
        const row = page.locator("sheet-picker .new");
        await row.waitFor();
        await row.focus();
        const onRow = () => page.evaluate(() => document.querySelector("sheet-picker").shadowRoot.activeElement?.className === "new");
        const onText = () => page.evaluate(() => document.querySelector("journal-entry").shadowRoot.activeElement?.classList.contains("cm-content") === true);
        const press = async (key, want) => {
          await page.keyboard.press(key);
          await until(async () => (await at(page)) === want);
        };

        // Up from + Add sheet below, onto the card, and back down.
        await press("k", "card");
        await page.keyboard.press("j");
        await until(onRow);
        await press("k", "card");

        // Into the sheet, and through it.
        await press("Enter", "0");
        await press("j", "1");
        await press("k", "0");
        await press("G", "7");
        await page.keyboard.press("g");
        await press("g", "0");

        // h and l change the chosen tab's score; Shift+L and Shift+H choose the tab and no more.
        const chosen = () => sheet.locator('.modes button[aria-pressed="true"]').innerText();
        await page.keyboard.press("l");
        assert.equal((await drawn(page)).rows[0], 7);
        await page.keyboard.press("h");
        assert.equal((await drawn(page)).rows[0], 6);
        await page.keyboard.press("L");
        assert.equal(await chosen(), "Wanted");
        assert.equal((await drawn(page)).wanted[0], 9, "choosing changes no score");
        await page.keyboard.press("l");
        assert.equal((await drawn(page)).wanted[0], 10);
        assert.equal((await drawn(page)).rows[0], 6);
        await page.keyboard.press("h");
        assert.equal((await drawn(page)).wanted[0], 9);
        await page.keyboard.press("H");
        assert.equal(await chosen(), "Actual");
        assert.equal(await at(page), "0");

        // The tabs are the row above the first area: h and l switch them, j goes back.
        await press("k", "actual");
        await press("l", "wanted");
        await press("h", "actual");
        await press("j", "0");
        await press("k", "actual");

        // Past the tabs the key leaves upward, and j comes back to the tabs and then the area.
        await page.keyboard.press("k");
        await until(onText);
        await press("j", "actual");
        await press("j", "0");

        // Past the last area the key goes on to + Add sheet, and k comes back to the same area.
        await press("G", "7");
        await page.keyboard.press("j");
        await until(onRow);
        await press("k", "7");
        await press("k", "6");
        await press("j", "7");

        await press("Escape", "card");
        await page.keyboard.press("k");
        await until(onText);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("two wheels on one day are two cards, and j and k step between them and an open sheet", async () => {
      const second = "01K7TEST00000000000000WHK2";
      const wheels = [
        { id: ID, day: today(), actual: ACTUAL, wanted: WANTED },
        { id: second, day: today(), actual: WANTED, wanted: WANTED },
      ];
      const { context, page, problems, sheet } = await open(browser, { vim: true, wheels, viewport: { width: 900, height: 1200 } });
      try {
        await sheet.locator(".card").nth(1).waitFor();
        assert.equal(await sheet.locator("h3").count(), 1, "one heading over both");
        await sheet.locator(`.card[data-id="${ID}"]`).focus();
        const press = async (key, want) => {
          await page.keyboard.press(key);
          await until(async () => (await at(page)) === want);
        };
        await press("Enter", "0");
        await press("G", "7");
        await press("j", "card");
        assert.equal(await inSheet(page, (root) => root.activeElement.dataset.id), second);
        // Coming back from below lands on the sheet's last area.
        await press("k", "7");
        await press("Escape", "card");
        assert.equal(await inSheet(page, (root) => root.activeElement.dataset.id), ID);

        // With the sheet below a card, k past its tabs lands on the card and j comes back to them.
        await press("j", "card");
        await press("Enter", "0");
        await press("k", "actual");
        await press("k", "card");
        assert.equal(await inSheet(page, (root) => root.activeElement.dataset.id), ID);
        await press("j", "actual");
        await press("j", "0");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("Delete shows the notice, the keyboard goes to + Add sheet, and Undo shows the card again", async () => {
      const { context, page, problems, sheet } = await open(browser);
      try {
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        await page.keyboard.press("Tab");
        assert.equal(await at(page), "delete");
        await page.keyboard.press("Enter");
        await until(async () => (await sheet.locator("section").count()) === 0);
        assert.equal(await sheet.evaluate((el) => getComputedStyle(el).display), "none", "the day looks as it did without a wheel");
        await until(() => page.evaluate(() => document.querySelector("sheet-picker").shadowRoot.activeElement?.className === "new"));
        await page.locator("notice-stack .undo").click();
        await sheet.locator(`.card[data-id="${ID}"]`).waitFor();
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("a day without a wheel takes no room, and an earlier day's wheel opens to be read, with j, k and Enter on its areas and Close at the end", async () => {
      const then = Date.now() - 3 * 864e5;
      const day = dayOf(then);
      const record = { id: "01J00000000000000000000DAY", day, text: "Earlier", editedAt: then };
      const answers = [{ lower: "I walked to work most of the month.", closer: "Hidden, Actual has reached Wanted" }, ...Array(7).fill({})];
      const wheels = [{ id: ID, day, actual: [9, ...ACTUAL.slice(1)], wanted: WANTED, answers }];
      const { context, page, problems, sheet } = await open(browser, { vim: true, wheels, days: [record] });
      try {
        await page.locator("journal-days .row", { hasText: "Earlier" }).waitFor();
        await until(async () => (await sheet.evaluate((el) => getComputedStyle(el).display)) === "none");
        await page.locator("journal-days .row", { hasText: "Earlier" }).click();
        await sheet.locator(".card").click();
        await sheet.locator(".close").waitFor();
        const press = async (key, want) => {
          await page.keyboard.press(key);
          await until(async () => (await at(page)) === want);
        };
        assert.equal(await at(page), "0");
        assert.equal(await sheet.locator(".modes").count(), 0);
        assert.equal(await sheet.locator(".delete").count(), 0);
        assert.equal(await sheet.locator(".sq:not([disabled])").count(), 0);
        assert.equal(await sheet.locator(".say").innerText(), "Your scores on this day.");
        assert.equal(await sheet.locator(".area.cur").count(), 1);

        await page.keyboard.press("Enter");
        assert.deepEqual(await sheet.locator(".q-group h4").allTextContents(), ["Your score"], "only what was written");
        assert.deepEqual(await sheet.locator(".q-read").allTextContents(), ["I walked to work most of the month."]);
        assert.equal(await sheet.locator(".q-group .caption").count(), 0, "the notes are about writing");
        await press("j", "1");
        assert.equal(await sheet.locator(".qs .caption").innerText(), "Nothing written about Work on this day.");
        await press("k", "0");
        await page.keyboard.press("l");
        assert.equal((await drawn(page)).rows[0], 9, "no score changes");

        // Close stands after the last area, and Tab reaches it from any area.
        await press("Tab", "close");
        await press("k", "0");
        await press("G", "7");
        await press("j", "close");
        await press("k", "7");
        await press("j", "close");
        await page.keyboard.press("Escape");
        await until(async () => (await sheet.locator(".qs").count()) === 0);
        await press("Escape", "card");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("an area with an answer to a question that applies shows the mark, and the panel shows its answers", async () => {
      const answers = [{ one: "Too tired" }, { lower: "Holds on" }, { closer: "Hidden, no Wanted" }, ...Array(5).fill({})];
      const wheels = [{ id: ID, day: today(), actual: [6, 1, 4, 7, 3, 6, 5, 2], wanted: [9, 7, null, 8, 7, 6, 7, 6], answers }];
      const { context, page, problems, sheet } = await open(browser, { wheels });
      try {
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        const marks = await inSheet(page, (root) => [...root.querySelectorAll(".area .arrow")].map((a) => a.classList.contains("marked")));
        assert.deepEqual(marks, [true, false, false, false, false, false, false, false], "at 1 not lower is hidden, and with no Wanted closer is");
        const opener = sheet.locator('.area[data-i="0"] .opener');
        assert.equal(await opener.getAttribute("aria-label"), "Health questions, answered");
        const paint = await opener.locator(".arrow").evaluate((a) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--color-accent)";
          document.body.append(probe);
          const accent = getComputedStyle(probe).color;
          probe.remove();
          return { filled: getComputedStyle(a).backgroundColor === accent, color: getComputedStyle(a).color };
        });
        assert.equal(paint.filled, true, "a filled accent circle");
        assert.equal(paint.color, "rgb(255, 255, 255)", "a white arrow");

        assert.equal(await sheet.locator(".qs").count(), 0, "the panel starts closed");
        await opener.click();
        assert.equal(await opener.getAttribute("aria-expanded"), "true");
        assert.equal(await at(page), "0", "the keyboard stays on the area");
        assert.deepEqual(await sheet.locator(".q-text").allTextContents(), [
          "What does a 1 look like for you?",
          "What does a 10 look like for you?",
          "What makes it a 6, and not lower?",
          "What keeps it from being higher?",
          "What would move it one point closer to Wanted?",
        ]);
        assert.deepEqual(await sheet.locator(".box .cm-content").allTextContents(), ["Too tired", "I have energy for everything I want to do.", "", "", ""], "an answer, and an example where there is none");
        await sheet.locator('.area[data-i="2"] .opener').click();
        assert.equal(await sheet.locator(".q-title span").first().innerText(), "Money", "pressing another area moves the panel");
        assert.equal(await sheet.locator(".q-text", { hasText: "closer" }).count(), 0, "with no Wanted the closer question is hidden");
        await sheet.locator('.area[data-i="2"] .opener').click();
        assert.equal(await sheet.locator(".qs").count(), 0, "pressing the open area closes it");

        await sheet.locator('.area[data-i="1"] .opener').click();
        await sheet.locator(".done").click();
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        assert.equal(await sheet.locator(".qs").count(), 0, "opened again, it starts closed");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("the area the keys act on darkens on the wheel, filled or not", async () => {
      const { context, page, problems, sheet } = await open(browser);
      try {
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        const fills = () =>
          inSheet(page, (root) => {
            const cells = [...root.querySelectorAll(".wheel .w-cell")];
            const fill = (c) => getComputedStyle(c).fill;
            return { lit: fill(cells[0]), other: fill(cells[10]), emptyLit: fill(cells[9]), emptyOther: fill(cells[19]) };
          });
        const { lit, other, emptyLit, emptyOther } = await fills();
        assert.notEqual(lit, other);
        assert.notEqual(emptyLit, emptyOther);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

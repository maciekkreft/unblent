import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// What only a browser shows: the places drawn from one matrix and the delete button that removes
// a task, pulling a task by its handle, the layout on a wide and a narrow page, the keyboard's way in, through and out of
// the sheet, and lines pasted into the Add a task line. The decisions are tested in Node. A
// matrix is seeded through the API under the test's own login.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/design/journal`;

// The workshop profile's preferences, with Vim keys on.
const VIM_ON = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

const ID = "01K7TEST00000000000000MXK1";
const A = "01K7TEST00000000000000TAK1";
const B = "01K7TEST00000000000000TAK2";
const C = "01K7TEST00000000000000TAK3";

const dayOf = (ms) => {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
};
// Today's journal day: it ends at 2:00 the next night (13, Journal).
const today = () => dayOf(Date.now() - 2 * 3600e3);

const TASKS = [
  { id: A, text: "Send the invoice", place: "do", done: false },
  { id: B, text: "Book the dentist", place: null, done: false, suggested: { place: "schedule", sure: false } },
  { id: C, text: "Sort the photos", place: null, done: false },
];

async function open(browser, { viewport = { width: 900, height: 900 }, vim = false, tasks = TASKS } = {}) {
  const context = await browser.newContext({ viewport });
  context.setDefaultTimeout(4000);
  await signedIn(context, forgeCookie("matrix"));
  const put = await context.request.put(`${BASE_URL}/api/matrices/${ID}`, { data: { day: today(), tasks, baseVersion: null } });
  assert.equal(put.status(), 200);
  if (vim) await context.addInitScript((v) => localStorage.setItem("settings", v), VIM_ON);
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  const sheet = page.locator("matrix-sheet");
  await sheet.locator(".card").waitFor();
  return { context, page, problems, sheet };
}

const inSheet = (page, fn) =>
  page.evaluate((fn) => new Function("root", `return (${fn})(root)`)(document.querySelector("matrix-sheet").shadowRoot), fn.toString());

// What holds the keyboard inside the view: a task by its words, or the class of what else.
const at = (page) =>
  inSheet(page, (root) => {
    const el = root.activeElement;
    if (!el) return null;
    if (el.classList.contains("txt")) return el.textContent.trim();
    return el.matches(".add input") ? "add" : el.className.trim();
  });

// The tasks of each place, by their words.
const places = (page) =>
  inSheet(page, (root) =>
    Object.fromEntries(
      [".tray", ".quad.do", ".quad.schedule", ".quad.delegate", ".quad.drop"].map((s) => [s.replace(/^\.(quad\.)?/, ""), [...(root.querySelector(s)?.querySelectorAll(".txt") ?? [])].map((t) => t.textContent.trim())]),
    ),
  );

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`matrix-sheet in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: rendering and layout.
    test("each task shows its tag and a direct delete button", async () => {
      const { context, page, problems, sheet } = await open(browser);
      try {
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        assert.deepEqual(await places(page), { tray: ["Sort the photos"], do: ["Send the invoice"], schedule: ["Book the dentist"], delegate: [], drop: [] });
        assert.deepEqual(await sheet.locator(".tag").allTextContents(), ["Not sure"]);
        assert.equal(await sheet.locator(".placebtn, .place").count(), 0);
        const row = sheet.locator(`.task[data-id="${B}"] .row`);
        const [grip, tick, words, tag, bin] = await row.locator(":scope > *").evaluateAll((els) => els.map((el) => {
          const { x, y, width, height } = el.getBoundingClientRect();
          return { x, y, width, height };
        }));
        assert.ok(grip.x < tick.x && tick.x < words.x && words.x < tag.x && tag.x < bin.x, "task controls stay in order on one row");
        assert.ok(Math.max(tick.y, words.y, bin.y) < Math.min(tick.y + tick.height, words.y + words.height, bin.y + bin.height), "checkbox, words and delete overlap vertically");
        await sheet.locator(`.task[data-id="${B}"]`).getByRole("button", { name: "Delete this task" }).click();
        await until(async () => !(await places(page)).schedule.includes("Book the dentist"));
        assert.equal(await sheet.locator(".bin").count(), 2);
        await sheet.locator(".bin").first().click();
        await sheet.locator(".bin").first().click();
        await sheet.locator(".add input").waitFor();
        assert.equal(await sheet.locator(".txt").count(), 0);
        assert.equal(await sheet.locator(".sheet").count(), 1, "the last task leaves the sheet open");
        await until(async () => {
          const { matrices } = await (await context.request.get(`${BASE_URL}/api/matrices?day=${today()}`)).json();
          return matrices.some((m) => m.id === ID && m.tasks.length === 0);
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        await sheet.locator(".card").click();
        assert.equal(await sheet.locator(".txt").count(), 0, "the empty matrix survives a reload");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("the four places stand as the matrix on a wide page and under each other, Do first, on a narrow one", async () => {
      const { context, page, problems, sheet } = await open(browser);
      try {
        await sheet.locator(".card").click();
        const tops = () => inSheet(page, (root) => ["do", "schedule", "delegate", "drop"].map((p) => Math.round(root.querySelector(`.quad.${p}`).getBoundingClientRect().top)));
        const [d, s, g, x] = await tops();
        assert.ok(d === s && g === x && g > d, `side by side: ${[d, s, g, x]}`);
        await page.setViewportSize({ width: 390, height: 800 });
        await until(async () => {
          const t = await tops();
          return t[0] < t[1] && t[1] < t[2] && t[2] < t[3];
        });
        assert.equal(await sheet.locator(".quad.do .where").isVisible(), true, "each says what it means");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("the keys walk the tasks, move one to its neighbor and back, tick it, delete it with the notice, and fold the sheet", async () => {
      const { context, page, problems, sheet } = await open(browser, { vim: true });
      const press = async (key, want) => {
        await page.keyboard.press(key);
        await until(async () => (await at(page)) === want);
      };
      try {
        await sheet.locator(".card").focus();
        await press("Enter", "add");
        await press("ArrowDown", "Sort the photos");
        await press("j", "Send the invoice");
        await press("k", "Sort the photos");
        await press("ArrowUp", "add");
        await press("ArrowDown", "Sort the photos");
        await press("j", "Send the invoice");
        await press("Shift+ArrowRight", "Send the invoice");
        assert.deepEqual((await places(page)).schedule, ["Send the invoice", "Book the dentist"], "the order inside a place is the order kept");
        await press("H", "Send the invoice");
        assert.deepEqual((await places(page)).do, ["Send the invoice"], "the opposite key moves it back");
        await page.keyboard.press(" ");
        await until(async () => (await sheet.locator(`.task[data-id="${A}"]`).getAttribute("class")).includes("done"));
        await press("G", "done");
        await press("k", "Book the dentist");
        await page.keyboard.press("d");
        await press("d", "Send the invoice");
        await until(async () => (await page.locator("notice-stack").evaluate((el) => el.shadowRoot.textContent)).includes("Delete task"));
        assert.deepEqual((await places(page)).schedule, []);
        await press("Escape", "card");
        assert.match(await sheet.locator(".card").innerText(), /To sort 1/);

        // j and k past the sheet go on to the page around, and come back to the card.
        await page.keyboard.press("k");
        await until(async () => (await at(page)) === null);
        await press("j", "card");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("Reset empties the sheet and Done keeps its empty card", async () => {
      const { context, page, problems, sheet } = await open(browser);
      try {
        await sheet.locator(".card").click();
        await sheet.locator(".reset").click();
        await until(async () => (await sheet.locator(".txt").count()) === 0);
        assert.equal(await at(page), "add", "the keyboard waits on the Add a task line");
        assert.equal(await sheet.locator(".reset").isDisabled(), true);
        await sheet.locator(".done").click();
        await sheet.locator(".card").waitFor();
        await sheet.locator(".card").click();
        assert.equal(await sheet.locator(".txt").count(), 0);
        assert.equal(await sheet.locator(".sheet").count(), 1);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("Delete by key takes the matrix away at once, the keyboard on + Add sheet, and Undo brings it back", async () => {
      const { context, page, problems, sheet } = await open(browser);
      try {
        await sheet.locator(".card").click();
        await sheet.locator(".done").focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await at(page), "delete");
        await page.keyboard.press("Enter");
        await until(async () => (await sheet.locator("section").count()) === 0);
        await until(() => page.evaluate(() => document.querySelector("sheet-picker").shadowRoot.activeElement?.className === "new"));
        await page.locator("notice-stack .undo").click();
        await sheet.locator(`.card[data-id="${ID}"]`).waitFor();
        await sheet.locator(".card").click();
        assert.equal(await sheet.locator(".txt").count(), 3, "Undo brings every task back");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("pulling a task by its handle moves it inside its place and to another place", async () => {
      const D = "01K7TEST00000000000000TAK4";
      const tasks = [...TASKS, { id: D, text: "Pay the rent", place: "do", done: false }];
      // Tall enough that every place stands inside the page around, which scrolls and clips.
      const { context, page, problems, sheet } = await open(browser, { tasks, viewport: { width: 900, height: 1300 } });
      // The tasks a list shows while one is pulled, the line where it will land among them,
      // leaving out the copy that follows the pointer.
      const landing = (place) =>
        page.evaluate(
          (place) => [...document.querySelector("matrix-sheet").shadowRoot.querySelector(`[data-place="${place}"]`).children].filter((el) => el.matches(".task:not(.sortable-fallback)")).map((el) => el.dataset.id),
          place,
        );
      // Sortable follows the pointer, so the mouse moves in steps as a hand would, and lets go
      // once the line shows where the task lands.
      const drag = async (id, target, place, want) => {
        const from = await sheet.locator(`.task[data-id="${id}"] .grip`).boundingBox();
        const to = await target.boundingBox();
        const x0 = from.x + from.width / 2;
        const y0 = from.y + from.height / 2;
        const x1 = to.x + to.width / 2;
        const y1 = to.y + to.height * 0.8;
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (let i = 1; i <= 12; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12);
        await until(async () => (await landing(place)).join() === want.join());
        await page.mouse.up();
      };
      try {
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        assert.equal(await sheet.locator(".task .grip").count(), 4, "every task has a handle");
        await drag(A, sheet.locator(`.task[data-id="${D}"]`), "do", [D, A]);
        await until(async () => (await places(page)).do.join() === "Pay the rent,Send the invoice");
        await drag(C, sheet.locator(".quad.delegate"), "delegate", [C]);
        await until(async () => (await places(page)).delegate.join() === "Sort the photos");
        assert.deepEqual(await places(page), { tray: [], do: ["Pay the rent", "Send the invoice"], schedule: ["Book the dentist"], delegate: ["Sort the photos"], drop: [] });
        assert.equal(await sheet.locator(".task").count(), 4, "nothing is left behind by the drag");
        await sheet.locator(".buttons .done").click();
        await sheet.locator(".card").click();
        assert.deepEqual((await places(page)).do, ["Pay the rent", "Send the invoice"], "drawn again from what was saved");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("Enter adds what is typed, and pasting several lines adds one task per line", async () => {
      const { context, page, problems, sheet } = await open(browser, { tasks: [TASKS[0]] });
      try {
        await sheet.locator(".card").click();
        const line = sheet.locator(".add input");
        await line.fill("Call the bank");
        await line.press("Enter");
        await until(async () => (await places(page)).tray.includes("Call the bank"));
        assert.equal(await line.inputValue(), "");
        await line.evaluate((input) => {
          const data = new DataTransfer();
          data.setData("text/plain", "Water the plants\n\nRenew the passport\n");
          input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true }));
        });
        await until(async () => (await places(page)).tray.length === 3);
        assert.deepEqual((await places(page)).tray, ["Call the bank", "Water the plants", "Renew the passport"]);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

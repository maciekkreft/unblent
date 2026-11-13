import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// What only a browser shows: the places drawn from one matrix and the place button that moves
// a task, the layout on a wide and a narrow page, the keyboard's way in, through and out of
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
    test("each task shows where it stands with its tag, the place button opens the places under it, and a pick moves it", async () => {
      const { context, page, problems, sheet } = await open(browser);
      try {
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        assert.deepEqual(await places(page), { tray: ["Sort the photos"], do: ["Send the invoice"], schedule: ["Book the dentist"], delegate: [], drop: [] });
        assert.deepEqual(await sheet.locator(".tag").allTextContents(), ["Not sure"]);
        const button = sheet.locator(`.task[data-id="${B}"] .placebtn`);
        assert.deepEqual(await button.locator("i").evaluateAll((is) => is.map((i) => i.className)), ["", "on", "", ""], "the suggested place is filled");

        await sheet.getByRole("button", { name: "Book the dentist, in Schedule" }).click();
        assert.equal(await sheet.locator(".place").count(), 0, "pressing the words does not open the places");
        await sheet.locator(".words").press("Escape");

        await button.click();
        const under = sheet.locator(`.task[data-id="${B}"] .place`);
        await under.waitFor();
        await under.getByRole("button", { name: "Delegate", exact: true }).click();
        await until(async () => (await places(page)).delegate.includes("Book the dentist"));
        assert.equal(await sheet.locator(".place").count(), 0, "a pick closes the places");
        assert.deepEqual(await sheet.locator(".tag").allTextContents(), [], "a place the user chose has no tag");
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

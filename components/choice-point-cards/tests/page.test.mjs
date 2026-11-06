import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// What only a browser shows: the New choice point row opens a sheet with the keyboard in Situation,
// Escape folds it into a card that a reload keeps, Enter makes a paragraph with a gap and
// Shift+Enter a line break, with Vim keys on the first Escape
// only leaves insert mode, and on a narrow page the V stands above the boxes rather than
// between them, and Jev's marks stand at the end of checked lines, coloured by the expected
// answer, checked once the user moves on from a line, with the answer said in the status line, Your values as one
// compass per line, and an earlier day's choice point can
// be read but not typed in. The decisions are tested in Node.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/design/journal`;

// The workshop profile's preferences, with Vim keys on.
const VIM_ON = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

const inCards = (page, fn) =>
  page.evaluate((fn) => new Function("root", `return (${fn})(root)`)(document.querySelector("choice-point-cards").shadowRoot), fn.toString());

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`choice-point-cards in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: a reload against real storage.
    test("the New choice point row opens a sheet in Situation, Escape folds it to a card, and a reload keeps it", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
      context.setDefaultTimeout(4000);
      // Signed out the journal page asks to sign in and draws no choice points.
      await signedIn(context, forgeCookie("choice-points"));
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await page.click("choice-point-cards .new");
        await until(async () => (await inCards(page, (root) => root.activeElement?.closest(".box")?.dataset.field)) === "situation");
        await page.keyboard.type("Family dinner");
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.type("Listened");
        await page.keyboard.press("Escape");
        const card = () => inCards(page, (root) => root.querySelector(".card")?.innerText.replace(/\s+/g, " ").trim() ?? null);
        await until(async () => (await card()) === "SITUATION Family dinner TOWARDS Listened");
        assert.equal(await inCards(page, (root) => root.activeElement?.className), "card", "the keyboard stays on the folded card");
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await card().catch(() => null)) === "SITUATION Family dinner TOWARDS Listened");

        // A sheet left unfolded is unfolded again after a reload.
        await page.click("choice-point-cards .card");
        await until(async () => (await inCards(page, (root) => root.querySelectorAll(".sheet").length)) === 1);
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await inCards(page, (root) => root.querySelectorAll(".sheet").length).catch(() => 0)) === 1);
        assert.equal(await card(), null, "no card is left folded");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on, the first Escape in a box leaves insert mode and the second folds the sheet", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
      context.setDefaultTimeout(4000);
      // Signed out the journal page asks to sign in and draws no choice points.
      await signedIn(context, forgeCookie("choice-points"));
      try {
        await context.addInitScript((v) => localStorage.setItem("settings", v), VIM_ON);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await until(async () => (await inCards(page, (root) => root.querySelector(".new")?.disabled)) === false);
        await page.click("choice-point-cards .new");
        await until(async () => (await inCards(page, (root) => root.activeElement?.closest(".box")?.dataset.field)) === "situation");
        await page.keyboard.press("Escape");
        await page.keyboard.type("iWalk");
        await page.keyboard.press("Escape");
        const situation = () => inCards(page, (root) => root.querySelector('.box[data-field="situation"] .cm-content')?.innerText ?? null);
        assert.equal(await situation(), "Walk", "i entered insert mode; the sheet is still open");
        await page.keyboard.press("Escape");
        await until(async () => (await inCards(page, (root) => root.querySelector(".card")?.innerText ?? "")).includes("Walk"));
        assert.equal(await situation(), null, "the sheet folded");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Lit draws the list by position, so folding the sheet above moves the editors of the
    // one below rather than making them again: what is typed there stays and takes keys.
    // Browser: focus and keys.
    test("two choice points stay open, and Done folds only its own", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 1200 } });
      context.setDefaultTimeout(4000);
      // Signed out the journal page asks to sign in and draws no choice points.
      await signedIn(context, forgeCookie("choice-points"));
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        const cards = page.locator("choice-point-cards");
        await cards.locator(".new").click();
        await page.keyboard.type("First");
        await cards.locator(".new").click();
        await page.keyboard.type("Second");
        assert.equal(await cards.locator(".sheet").count(), 2);
        await cards.locator(".sheet").first().locator(".done").click();
        const situation = cards.locator('.sheet .box[data-field="situation"] .cm-content');
        await until(async () => (await cards.locator(".sheet").count()) === 1);
        await situation.click();
        await page.keyboard.press("End");
        await page.keyboard.type(" too");
        assert.equal(await situation.innerText(), "Second too");
        assert.match(await cards.locator(".card").innerText(), /First/);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Settings are written through the APIs under the test's own login; Jev is answered
    // here through page.route, so no real request is made, and the account is told it has
    // a key.
    // Browser: rendering and layout.
    test("checked lines get Jev's marks, the status line says the answer, and the card shows them after each line", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("marks"));
        const id = (tail) => "01J" + "0".repeat(23 - tail.length) + tail;
        const [evaluator, question, behavioral, emotional] = [id("E1"), id("Q1"), id("A0"), id("A1")];
        const options = [
          { id: behavioral, name: "Behavioral Goal", description: "", icon: "person-simple-walk" },
          { id: emotional, name: "Emotional Goal", description: "" },
        ];
        const made = await context.request.put(`${BASE_URL}/api/evaluators/${evaluator}`, {
          data: { book: id("B1"), name: "Therapy Goal", on: true, baseVersion: null, questions: [{ id: question, kind: "pick", text: "Which kind of goal?", yes: "", no: "", options, expect: behavioral }] },
        });
        assert.equal(made.status(), 200);
        const box = await context.request.put(`${BASE_URL}/api/choice-point-checks/boxes/towards`, {
          data: { baseVersion: null, evaluator, questions: [{ id: question, show: true, expect: null, when: null, icons: {} }] },
        });
        assert.equal(box.status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        await page.route("**/api/llm", async (route) => {
          const res = await route.fetch();
          const json = await res.json();
          await route.fulfill({ response: res, json: { ...json, jev: { ...json.jev, keySet: true }, decider: { ...json.decider, ready: true } } });
        });
        await page.route("**/api/llm/decide", (route) => {
          const calm = /calm/.test(route.request().postDataJSON().state.text);
          route.fulfill({ json: { answers: [{ id: question, p: 0.92, choice: calm ? emotional : behavioral }], inputTokens: 1, ms: 1 } });
        });
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        const cards = page.locator("choice-point-cards");
        await cards.locator(".new").click();
        await cards.locator('.box[data-field="towards"] .cm-content').click();
        await page.keyboard.type("Call Anna");
        const line = (text) => cards.locator(".cm-line", { hasText: text });
        await page.keyboard.press("Enter");
        await line("Call Anna").locator(".mark.right").waitFor();
        await page.keyboard.type("Feel calm");
        assert.equal(await line("Feel calm").locator(".mark").count(), 0, "the line being typed is not checked");
        await page.keyboard.press("ArrowUp");
        await line("Feel calm").locator(".mark.wrong").waitFor();
        assert.equal(await cards.locator(".status").innerText(), "Therapy Goal: Behavioral Goal", "the line the cursor is on");
        await line("Feel calm").locator(".mark").hover();
        assert.equal(await cards.locator(".status").innerText(), "Therapy Goal: Emotional Goal, you expect Behavioral Goal", "the line the pointer is over");
        await cards.locator(".done").click();
        const onCard = (text) => cards.locator(".card .towards .line", { hasText: text }).locator(".mark");
        await onCard("Feel calm").and(cards.locator(".mark.wrong")).waitFor();
        assert.equal(await onCard("Feel calm").getAttribute("title"), "Therapy Goal: Emotional Goal, you expect Behavioral Goal");
        assert.equal(await onCard("Call Anna").and(cards.locator(".mark.right")).count(), 1);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // The values and the box arrive through the APIs under the test's own login; Jev is
    // answered through page.route, each value's question by the line's text.
    // Browser: rendering and layout.
    test("Your values on Towards draws one compass per line, green or red, naming the value", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("values-mark"));
        const id = (tail) => "01J" + "0".repeat(23 - tail.length) + tail;
        const [parent, health] = [id("V1"), id("V2")];
        // Today's journal day: it ends at 2:00 the next night (13, Journal).
        const at = new Date(Date.now() - 2 * 3600e3);
        const today = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
        const values = [
          { id: parent, name: "Being a present parent", meaning: "" },
          { id: health, name: "Health", meaning: "" },
        ];
        assert.equal((await context.request.put(`${BASE_URL}/api/values/${today}`, { data: { values, baseVersion: null } })).status(), 200);
        const box = await context.request.put(`${BASE_URL}/api/choice-point-checks/boxes/towards`, {
          data: { baseVersion: null, evaluator: "0000000000000000000000YVAS", questions: [] },
        });
        assert.equal(box.status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        await page.route("**/api/llm", async (route) => {
          const res = await route.fetch();
          const json = await res.json();
          await route.fulfill({ response: res, json: { ...json, jev: { ...json.jev, keySet: true }, decider: { ...json.decider, ready: true } } });
        });
        await page.route("**/api/llm/decide", (route) => {
          const { state, questions } = route.request().postDataJSON();
          const pool = /pool/.test(state.text);
          const answers = questions.map((q) => ({
            id: q.id,
            p: 0.95,
            choice: q.id === parent ? (pool ? "0000000000000000000000SRVS" : "0000000000000000000000AGST") : "0000000000000000000000NRTD",
          }));
          route.fulfill({ json: { answers, inputTokens: 1, ms: 1 } });
        });
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        const cards = page.locator("choice-point-cards");
        await cards.locator(".new").click();
        await cards.locator('.box[data-field="towards"] .cm-content').click();
        const line = (text) => cards.locator(".cm-line", { hasText: text });
        await page.keyboard.type("Take the kids to the pool");
        await page.keyboard.press("Enter");
        await line("pool").locator(".mark.right svg").waitFor();
        assert.equal(await line("pool").locator(".mark").count(), 1, "one mark for all the values");
        await page.keyboard.type("Answer every work email");
        await page.keyboard.press("ArrowUp");
        await line("work email").locator(".mark.wrong").waitFor();
        assert.equal(await cards.locator(".status").innerText(), "Your values: Serves Being a present parent", "the line the cursor is on");
        await line("work email").locator(".mark").hover();
        assert.equal(await cards.locator(".status").innerText(), "Your values: Goes against Being a present parent", "the line the pointer is over");
        await cards.locator(".done").click();
        await cards.locator(".card .towards .line", { hasText: "work email" }).locator(".mark.wrong").waitFor();
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // An earlier day and its choice point arrive through the APIs under the test's own login.
    // Browser: rendering and layout.
    test("an earlier day's choice point opens to be read: no New row, no typing, Close", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
      context.setDefaultTimeout(4000);
      try {
        const cookie = forgeCookie("read");
        await signedIn(context, cookie);
        const then = Date.now() - 3 * 864e5;
        const at = new Date(then);
        const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
        const put = (path, data) => context.request.put(`${BASE_URL}/api/${path}`, { data });
        assert.equal((await put("journal/days", { record: { id: "01J00000000000000000000DAY", day, text: "Earlier", editedAt: then }, baseVersion: null })).status(), 200);
        assert.equal((await put("choice-points/01J000000000000000000000CP", { day, situation: "Old", thoughts: "", away: "Snapped", towards: "Paused", baseVersion: null })).status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await page.locator("journal-days .row", { hasText: "Earlier" }).click();
        const cards = page.locator("choice-point-cards");
        await cards.locator(".card").click();
        await cards.locator(".close").waitFor();
        assert.equal(await cards.locator(".new").count(), 0, "no New choice point on an earlier day");
        assert.equal(await cards.locator(".done").count(), 0);
        assert.equal(await cards.locator(".delete").count(), 0);
        await cards.locator('.box[data-field="towards"]').click();
        await page.keyboard.type("zzz");
        assert.equal(await cards.locator('.box[data-field="towards"] .cm-content').innerText(), "Paused", "the boxes cannot be typed in");
        await cards.locator(".close").click();
        await cards.locator(".card").waitFor();
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Enter starts a new line after a short gap, Shift+Enter one right under it; each is
    // one item, so the card still shows them one after another.
    // Browser: focus and keys.
    test("Enter makes a paragraph and Shift+Enter a line break, and the card lists each line", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
      context.setDefaultTimeout(4000);
      // Signed out the journal page asks to sign in and draws no choice points.
      await signedIn(context, forgeCookie("choice-points"));
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await page.click("choice-point-cards .new");
        await until(async () => (await inCards(page, (root) => root.activeElement?.closest(".box")?.dataset.field)) === "situation");
        await page.keyboard.type("Dinner");
        await page.keyboard.press("Enter");
        await page.keyboard.type("Late");
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.type("Tired");
        const box = () =>
          inCards(page, (root) => {
            const content = root.querySelector('.box[data-field="situation"] .cm-content');
            return content.cmView.view.state.doc.toString();
          });
        assert.equal(await box(), "Dinner\n\nLate\nTired");
        await page.keyboard.press("Escape");
        const lines = () => inCards(page, (root) => [...root.querySelectorAll(".card .situation .line")].map((l) => l.innerText.trim()));
        await until(async () => (await lines()).join() === "Dinner,Late,Tired");
        const tops = await inCards(page, (root) => [...root.querySelectorAll(".card .situation .line")].map((l) => l.getBoundingClientRect().top));
        assert.ok(tops[0] < tops[1] && tops[1] < tops[2], "each line stands on its own");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Delete sits before Done, so Tab reaches it from the last box; the keyboard moves on to
    // the row after the sheet, and the notice's Undo brings the card back.
    // Browser: focus and keys.
    test("Delete, reached by Tab, moves the keyboard to the next card, and the notice's Undo brings the card back", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 1000 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("choice-points"));
      try {
        // Today's journal day: it ends at 2:00 the next night (13, Journal).
        const now = new Date(Date.now() - 2 * 3600e3);
        const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
        const put = (id, situation) => context.request.put(`${BASE_URL}/api/choice-points/${id}`, { data: { day, situation, thoughts: "Tired", away: "Left", towards: "Stay" } });
        assert.ok((await put("01K7TEST00000000000000CPD1", "First")).ok());
        assert.ok((await put("01K7TEST00000000000000CPD2", "Second")).ok());
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        const cards = page.locator("choice-point-cards");
        await cards.locator(".card").first().click();
        await cards.locator('.box[data-field="thoughts"] .cm-content').click();
        await page.keyboard.press("Tab");
        const focused = () => inCards(page, (root) => root.activeElement?.className ?? null);
        assert.equal(await focused(), "delete", "Tab goes from the last box to Delete, then Done");
        await page.keyboard.press("Tab");
        assert.equal(await focused(), "done");
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Enter");
        await until(async () => (await cards.locator(".sheet").count()) === 0 && (await cards.locator(".card").count()) === 1);
        assert.equal(await focused(), "card", "the keyboard is on the next card");
        assert.match(await cards.locator(".card").innerText(), /Second/);
        await page.locator("notice-stack .undo").click();
        await until(async () => (await cards.locator(".card").count()) === 2);
        const first = (await cards.locator(".card").first().innerText()).replace(/\s+/g, " ").trim();
        assert.equal(first, "SITUATION First THOUGHTS & FEELINGS Tired AWAY Left TOWARDS Stay");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("on a wide page the V stands between the moves, on a phone-wide page above them", async () => {
      const layout = async (width) => {
        const context = await browser.newContext({ viewport: { width, height: 800 } });
        context.setDefaultTimeout(4000);
        // Signed out the journal page asks to sign in and draws no choice points.
        await signedIn(context, forgeCookie("choice-points"));
        try {
          const page = await context.newPage();
          const problems = watch(page);
          await page.goto(PAGE, { waitUntil: "domcontentloaded" });
          await page.click("choice-point-cards .new");
          const box = (sel) => page.locator(`choice-point-cards ${sel}`).boundingBox();
          const [v, away, towards] = [await box(".v"), await box(".field.away"), await box(".field.towards")];
          assert.deepEqual(problems, []);
          return { v, away, towards };
        } finally {
          await context.close();
        }
      };
      const wide = await layout(900);
      assert.ok(wide.away.x + wide.away.width <= wide.v.x && wide.v.x + wide.v.width <= wide.towards.x, "away, V, towards in one row");
      const narrow = await layout(390);
      assert.ok(narrow.v.y + narrow.v.height <= narrow.away.y && narrow.away.y < narrow.towards.y, "the V above away, away above towards");
    });

    // Browser: focus and keys.
    test("with Vim keys on, j and k step through the cards and the boxes, Enter opens, Escape folds onto the card, o adds", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("choice-points"));
      try {
        // Today's journal day: it ends at 2:00 the next night (13, Journal).
        const now = new Date(Date.now() - 2 * 3600e3);
        const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
        const put = await context.request.put(`${BASE_URL}/api/choice-points/01K7TEST00000000000000CPK1`, {
          data: { day: today, situation: "Dinner", thoughts: "", away: "a1\na2", towards: "t1" },
        });
        assert.ok(put.ok());
        await context.addInitScript((v) => localStorage.setItem("settings", v), VIM_ON);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await until(async () => (await inCards(page, (root) => root.querySelector(".card")?.innerText ?? "")).includes("Dinner"));
        const at = () => inCards(page, (root) => root.activeElement?.closest(".box")?.dataset.field ?? root.activeElement?.className ?? null);
        const press = async (key, want) => {
          await page.keyboard.press(key);
          await until(async () => (await at()) === want);
        };
        await page.evaluate(() => document.querySelector("choice-point-cards").focus());
        await until(async () => (await at()) === "card");
        await press("j", "new");
        await press("k", "card");
        await press("Enter", "situation");
        await press("Escape", "situation");
        await press("k", "towards");
        // k from Towards' first line lands on the last line of Away, so j goes straight back.
        await press("k", "away");
        await press("j", "towards");
        await press("Escape", "card");
        await press("o", "situation");
        assert.equal(await inCards(page, (root) => root.querySelectorAll(".sheet").length), 1, "o opened a new choice point");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

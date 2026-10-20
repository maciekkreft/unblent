import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// Comments on the last answer, on the conversations stem page: what only a browser has,
// a mouse selection over the drawn answer mapped back to the answer's characters. Which
// selections may become a comment, the throttle and the undo window are decisions of the
// machine, tested in Node (9).
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn, shortUndo } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
const CHAT = U("C1");
const ANSWER = "## Plan\n\nA book was a path through the box. He could work on **whatever** interested him.";
const PHRASE = "a path through the box";
const MARK = { id: U("M1"), start: ANSWER.indexOf(PHRASE), end: ANSWER.indexOf(PHRASE) + PHRASE.length, quote: PHRASE, comment: "Say why." };

// A fresh account on the Echo test provider holding one chat whose last answer is done,
// with `marks` when given, opened on the stem page (in the phone preview when asked).
async function open(browser, { marks = null, phone = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  context.setDefaultTimeout(4000);
  await shortUndo(context);
  await signedIn(context, forgeCookie("chat-marks"));
  assert.ok((await context.request.put(`${BASE_URL}/api/llm`, { data: { provider: "echo" } })).ok());
  const chat = {
    title: "Plan the box",
    about: [],
    start: "",
    turns: [
      { id: U("Q1"), role: "user", text: "Plan the box" },
      { id: U("A1"), role: "assistant", text: ANSWER, status: "done" },
    ],
    ...(marks ? { marks: { answerId: U("A1"), marks } } : {}),
  };
  assert.ok((await context.request.put(`${BASE_URL}/api/conversations/${CHAT}`, { data: chat })).ok(), "the chat is seeded");
  if (phone) await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
  await page.locator("conversation-list .row", { hasText: "Plan the box" }).click();
  await until(() => inThread(page, (root) => Boolean(root.querySelector(".answer.markable [data-s]"))));
  return { context, page, problems };
}

const inThread = (page, fn, arg) =>
  page.evaluate(([fn, arg]) => new Function("root", "arg", `return (${fn})(root, arg)`)(document.querySelector("chat-thread").shadowRoot, arg), [fn.toString(), arg]);

// The screen box of a phrase inside one drawn run, for a mouse drag across it.
const drag = async (page, phrase) => {
  const { x0, x1, y } = await inThread(
    page,
    (root, phrase) => {
      const span = [...root.querySelectorAll(".markable [data-s]")].find((s) => s.textContent.includes(phrase));
      const node = [...span.childNodes].find((n) => n.nodeType === 3);
      const range = document.createRange();
      range.setStart(node, node.data.indexOf(phrase));
      range.setEnd(node, node.data.indexOf(phrase) + phrase.length);
      const r = range.getBoundingClientRect();
      return { x0: r.left + 1, x1: r.right - 1, y: r.top + r.height / 2 };
    },
    phrase,
  );
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await page.mouse.move(x1, y, { steps: 6 });
  await page.mouse.up();
};

// What the reader sees of the comments on the last answer.
const look = (page) =>
  inThread(page, (root) => ({
    marked: [...root.querySelectorAll(".markable mark")].map((m) => m.textContent).join("|"),
    numbers: [...root.querySelectorAll(".markable sup.num")].map((s) => s.textContent).join(","),
    box: root.querySelector(".popover textarea")?.value ?? null,
    list: [...root.querySelectorAll(".comments li")].map((li) => ({
      n: li.querySelector(".n").textContent,
      quote: li.querySelector(".quote").textContent,
      text: li.querySelector(".text").textContent,
      removing: li.classList.contains("removing"),
    })),
  }));

const kept = async (context) => (await (await context.request.get(`${BASE_URL}/api/conversations/${CHAT}`)).json()).marks ?? null;

for (const engine of ENGINES) {
  describe(`comments on the last answer in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    // Browser: a gesture.
    test("a selection in the last answer takes a comment, shown highlighted, numbered and listed; Remove has Undo; it is kept", async () => {
      const { context, page, problems } = await open(browser);
      try {
        await drag(page, PHRASE);
        await until(async () => (await look(page)).box !== null);
        assert.equal((await look(page)).marked, PHRASE, "the passage is marked the moment the box opens");
        assert.ok(await inThread(page, (root) => root.activeElement?.localName === "textarea"), "the box takes the keys");
        await page.keyboard.type("Say why.");
        await page.keyboard.press("Enter");
        await until(async () => (await look(page)).box === null);
        let seen = await look(page);
        assert.equal(seen.numbers, "1");
        assert.deepEqual(seen.list, [{ n: "1", quote: PHRASE, text: "Say why.", removing: false }]);

        await page.locator("chat-thread .comments .remove").click();
        await until(async () => (await look(page)).list[0]?.removing);
        await page.locator("chat-thread .comments .undo").click();
        await until(async () => (await look(page)).list[0]?.removing === false);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal((await look(page)).list.length, 1, "undone, the comment stays after the window");

        await until(async () => (await kept(context))?.marks?.[0]?.comment === "Say why.");
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await look(page)).marked === PHRASE);
        seen = await look(page);
        assert.deepEqual(seen.list, [{ n: "1", quote: PHRASE, text: "Say why.", removing: false }]);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("in the phone preview kept comments show and a selection opens the comment box", async () => {
      const { context, page, problems } = await open(browser, { marks: [MARK], phone: true });
      try {
        assert.equal(await page.evaluate(() => document.documentElement.dataset.viewport), "phone");
        await until(async () => (await look(page)).marked === PHRASE);
        assert.equal((await look(page)).numbers, "1");
        await drag(page, "interested him");
        await until(async () => (await look(page)).box !== null);
        assert.equal((await look(page)).marked, `${PHRASE}|interested him`);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

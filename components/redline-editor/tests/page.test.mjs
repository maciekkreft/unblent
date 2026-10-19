import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, shortUndo } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const TEXT = [
  "# Slip-box",
  "",
  "A book was a path through the box. He could work on whatever interested him.",
  "",
  "- one item",
  "",
  "| Luhmann | Here |",
  "|---|---|",
  "| The slip-box | The bus |",
  "",
  "```",
  "code stays code",
  "```",
].join("\n");
const PHRASE = "A book was a path";

// A context whose clipboard is the fixture to read and a capture for what is written:
// headless engines have no real clipboard to grant. The text and comments live in
// localStorage, which each context starts without (11.2).
async function open(browser, { phone = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  context.setDefaultTimeout(4000);
  await shortUndo(context);
  await context.addInitScript(
    ({ text, phone }) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          readText: () => Promise.resolve(text),
          writeText: (t) => {
            window.__copied = t;
            return Promise.resolve();
          },
        },
      });
      if (phone) localStorage.setItem("viewport", "phone");
    },
    { text: TEXT, phone },
  );
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/workshop/design/redline`, { waitUntil: "domcontentloaded" });
  await until(() => page.evaluate(() => Boolean(document.querySelector("redline-editor")?.shadowRoot?.querySelector(".page"))));
  return { context, page, problems };
}

const inEditor = (page, fn, arg) => page.evaluate(([fn, arg]) => new Function("root", "arg", `return (${fn})(root, arg)`)(document.querySelector("redline-editor").shadowRoot, arg), [fn.toString(), arg]);

const pasteFixture = async (page) => {
  await page.locator("redline-editor button", { hasText: "Paste" }).click();
  await until(() => inEditor(page, (root) => Boolean(root.querySelector("article h1"))));
};

// The screen box of a phrase inside one rendered run, for a mouse drag across it.
const phraseBox = (page, phrase) =>
  inEditor(
    page,
    (root, phrase) => {
      const span = [...root.querySelectorAll("[data-s]")].find((s) => s.textContent.includes(phrase));
      const node = [...span.childNodes].find((n) => n.nodeType === 3);
      const i = node.data.indexOf(phrase);
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + phrase.length);
      const r = range.getBoundingClientRect();
      return { x0: r.left + 1, x1: r.right - 1, y: r.top + r.height / 2 };
    },
    phrase,
  );

const drag = async (page, phrase) => {
  const { x0, x1, y } = await phraseBox(page, phrase);
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await page.mouse.move(x1, y, { steps: 6 });
  await page.mouse.up();
};

const marked = (page) => inEditor(page, (root) => [...root.querySelectorAll("mark")].map((m) => m.textContent).join("|"));
const popoverText = (page) => inEditor(page, (root) => root.querySelector(".popover textarea")?.value ?? null);
const comment = async (page, phrase, text) => {
  await drag(page, phrase);
  await until(async () => (await popoverText(page)) !== null);
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await until(async () => (await popoverText(page)) === null);
};

for (const engine of ENGINES) {
  describe(`redline-editor in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    // Browser: a gesture.
    test("an empty page takes a paste and shows the text formatted", async () => {
      const { context, page, problems } = await open(browser);
      try {
        assert.ok(await inEditor(page, (root) => Boolean(root.querySelector(".drop"))), "the paste box is shown");
        // A paste into the box, the ⌘V path, where the engine can build the event.
        const pasted = await inEditor(
          page,
          (root, text) => {
            if (typeof DataTransfer !== "function") return false;
            const data = new DataTransfer();
            data.setData("text/plain", text);
            root.querySelector(".drop").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, composed: true, cancelable: true }));
            return true;
          },
          TEXT,
        );
        if (!pasted) await pasteFixture(page);
        await until(() => inEditor(page, (root) => Boolean(root.querySelector("article h1"))));
        const shown = await inEditor(page, (root) => ({
          h1: root.querySelector("article h1").textContent,
          cells: [...root.querySelectorAll("article td")].map((td) => td.textContent),
          code: root.querySelector("article pre").textContent,
          item: root.querySelector("article li").textContent,
        }));
        assert.deepEqual(shown, { h1: "Slip-box", cells: ["The slip-box", "The bus"], code: "code stays code", item: "one item" });
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("a selection opens a comment that saves as typed, survives a reload, and is removed with an undo", async () => {
      const { context, page, problems } = await open(browser);
      try {
        await pasteFixture(page);
        await drag(page, PHRASE);
        await until(async () => (await popoverText(page)) !== null);
        assert.equal(await marked(page), PHRASE, "the fragment is marked the moment the box opens");
        assert.ok(await inEditor(page, (root) => root.activeElement?.localName === "textarea"), "the box takes the keys");
        await page.keyboard.type("needs work");
        await until(() => page.evaluate(() => (localStorage.getItem("redline") ?? "").includes("needs work")));

        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await marked(page)) === PHRASE);
        await page.locator("redline-editor mark").first().click();
        await until(async () => (await popoverText(page)) === "needs work");

        await page.locator("redline-editor button.remove").click();
        await until(() => inEditor(page, (root) => Boolean(root.querySelector("mark.removing")) && root.querySelector(".bar").textContent.includes("Comment removed")));
        await until(async () => (await marked(page)) === "");
        assert.ok(await inEditor(page, (root) => root.querySelector(".count").textContent === "0 comments"));
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("Copy with comments puts the text with CriticMarkup on the clipboard", async () => {
      const { context, page, problems } = await open(browser);
      try {
        await pasteFixture(page);
        await comment(page, PHRASE, "Say an app too.");
        await comment(page, "The bus", "Name the module.");
        await page.locator("redline-editor button.copy").click();
        await until(() => inEditor(page, (root) => root.querySelector("button.copy").textContent.trim() === "Copied"));
        const copied = await page.evaluate(() => window.__copied);
        assert.equal(
          copied,
          TEXT.replace(PHRASE, `{==${PHRASE}==}{>>Say an app too.<<}`).replace("The bus", "{==The bus==}{>>Name the module.<<}"),
        );
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("in the phone preview the marks show and a touch opens no comment", async () => {
      const { context, page, problems } = await open(browser, { phone: true });
      try {
        await page.evaluate((text) => localStorage.setItem("redline", text), JSON.stringify({ text: TEXT, comments: [{ id: "01ARZ3NDEKTSV4RRFFQ69G5FA0", start: 12, end: 29, quote: PHRASE, text: "x" }] }));
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await marked(page)) === PHRASE);
        assert.equal(await page.evaluate(() => document.documentElement.dataset.viewport), "phone");
        // A finger's selection and lift: the page reads, it does not comment.
        await inEditor(page, (root) => {
          const span = [...root.querySelectorAll("[data-s]")].find((s) => s.textContent.includes("He could"));
          const node = [...span.childNodes].find((n) => n.nodeType === 3);
          const range = document.createRange();
          range.setStart(node, node.data.indexOf("He could"));
          range.setEnd(node, node.data.indexOf("He could") + 8);
          document.getSelection().removeAllRanges();
          document.getSelection().addRange(range);
          for (const type of ["pointerdown", "pointerup"]) span.dispatchEvent(new PointerEvent(type, { pointerType: "touch", bubbles: true, composed: true }));
        });
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(await popoverText(page), null);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("New text empties the page with an undo, then clears the text", async () => {
      const { context, page, problems } = await open(browser);
      try {
        await pasteFixture(page);
        await page.locator("redline-editor button", { hasText: "New text" }).click();
        await until(() => inEditor(page, (root) => Boolean(root.querySelector(".drop")) && root.textContent.includes("Text cleared")));
        await page.locator("redline-editor button.undo").click();
        await until(() => inEditor(page, (root) => Boolean(root.querySelector("article h1"))));
        await page.locator("redline-editor button", { hasText: "New text" }).click();
        await until(() => page.evaluate(() => !localStorage.getItem("redline")));
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(() => inEditor(page, (root) => Boolean(root.querySelector(".drop"))));
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

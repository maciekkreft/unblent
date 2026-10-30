import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub");
// The subject stem page holds the reader with `highlights` and the notes fact.
const PAGE = `${BASE_URL}/workshop/design/subject`;
const BOOK_ID = "01K00000000000000000000SMP";

// The "Vim keys" preference (12), seeded the way settings stores it (the workshop
// profile, since the page is under /workshop/).
const seed = (vimKeys) =>
  JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });

// A user set up straight through the server (5): the sample book, open.
const seedUser = async ({ highlight = false, split = false } = {}) => {
  const cookie = forgeCookie("reader-keys");
  const put = async (path, type, body) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
    assert.equal(res.status, 200, `PUT ${path}`);
  };
  await put(`/api/books/${BOOK_ID}`, "application/epub+zip", readFileSync(SAMPLE));
  await put(`/api/books/${BOOK_ID}/opened`, "application/json", "{}");
  if (highlight) {
    const about = [{ kind: "book", id: BOOK_ID, place: HL_PLACE, quote: { exact: "Chapter One", prefix: "", suffix: "" } }];
    await put(`/api/notes/${HL_ID}`, "application/json", JSON.stringify({ title: "", body: "", baseVersion: null, about }));
  }
  if (split) {
    await put(`/api/books/${BOOK_ID}/position`, "application/json", JSON.stringify({ chapter: 1, block: 0 }));
    const about = [{ kind: "book", id: BOOK_ID, place: SPLIT_PLACE, quote: { exact: "A paragraph that outruns a page.", prefix: "", suffix: "" } }];
    await put(`/api/notes/${SPLIT_ID}`, "application/json", JSON.stringify({ title: "", body: "", baseVersion: null, about }));
  }
  return cookie;
};
// A highlight of the first page's heading, which the Vim cursor starts on.
const HL_ID = "01K00000000000000000000HG1";
const HL_PLACE = { chapter: 0, contentVersion: 1, start: { block: 0, offset: 0 }, end: { block: 0, offset: 11 } };
const LINK = `[Chapter One](note:${HL_ID})`;
// A highlight of Chapter Two's over-long first paragraph, from its start on the first
// page far into the second.
const SPLIT_ID = "01K00000000000000000000HG3";
const SPLIT_PLACE = { chapter: 1, contentVersion: 1, start: { block: 1, offset: 0 }, end: { block: 1, offset: 2000 } };
// A highlight of the heading half way through Chapter Two, several pages in, and a note
// holding a source link to it.
const MID_ID = "01K00000000000000000000HG2";
const MID_PLACE = { chapter: 1, contentVersion: 1, start: { block: 32, offset: 0 }, end: { block: 32, offset: 10 } };
const LIT_ID = "01K00000000000000000000NT1";
// The text the page last put on the clipboard: writeText is recorded, so the test reads
// what was copied without a clipboard permission prompt.
const recordClipboard = () => {
  navigator.clipboard.writeText = async (t) => {
    window.__copied = t;
  };
};
const copied = (page) => page.evaluate(() => window.__copied ?? null);
const bubble = (page) =>
  page.evaluate(() => [...(document.querySelector("book-reader").shadowRoot.querySelectorAll(".bubble .act") ?? [])].map((b) => b.textContent.trim()));

const marks = (page) =>
  page.evaluate(() => [...document.querySelector("book-reader").shadowRoot.querySelectorAll(".strip mark")].map((m) => m.textContent));
const serverNotes = (page) =>
  page.evaluate(async () => {
    const res = await fetch("/api/notes");
    if (!res.ok) throw new Error(`list ${res.status}`);
    return (await res.json()).notes;
  });
// Nudge `notes` to drain its outbox now rather than after its idle window.
const drain = (page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
// The pending passage the reader paints while a highlight is in progress.
const pending = (page) => page.evaluate(() => String(CSS.highlights.get("reader-pending")?.values().next().value ?? ""));

for (const engine of ENGINES) {
  describe(`keyboard highlights in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    let context;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 30000 });
    afterEach(async () => {
      await context?.close();
      context = null;
    });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // `product` opens the product page, `/`, whose preferences settings keeps under the
    // product profile's name.
    // `before` runs in the page ahead of its own scripts.
    const open = async (vimKeys, { highlight = false, split = false, touch = false, product = false, before } = {}) => {
      const problems = [];
      context = await browser.newContext({ hasTouch: touch });
      context.setDefaultTimeout(4000);
      await signedIn(context, await seedUser({ highlight, split }));
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [product ? "settings:product" : "settings", seed(vimKeys)]);
      await page.addInitScript(recordClipboard);
      if (before) await page.addInitScript(before);
      await page.goto(product ? `${BASE_URL}/` : PAGE, { waitUntil: "domcontentloaded" });
      await page.waitForFunction((chap) => {
        const r = document.querySelector("book-reader")?.shadowRoot;
        return r?.querySelector(".footer .chap")?.textContent.trim() === chap && r.querySelector(".strip")?.textContent.includes(chap);
      }, split ? "Chapter Two" : "Chapter One");
      await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".reader").focus());
      return { page, problems };
    };

    // v starts at the cursor, on the page's first word; two w move it onto the next
    // heading, which the passage stops before. Enter makes the highlight the mouse
    // would: painted in the reader and saved as a note with a place.
    // Browser: focus and keys.
    test(`v w w Enter makes a highlight in ${engine.name}`, async () => {
      const { page, problems } = await open(true);
      // Vim arrives with the settings reply; v starts a highlight only once it has.
      await until(async () => {
        await page.keyboard.press("v");
        if ((await pending(page)) === "C") return true;
        await page.keyboard.press("Escape");
        return false;
      });
      await page.keyboard.press("w");
      await page.keyboard.press("w");
      assert.equal(await pending(page), "Chapter One");
      await page.keyboard.press("Enter");
      await until(async () => (await marks(page)).join(" ") === "Chapter One");
      assert.equal(await pending(page), "");
      await drain(page);
      await until(async () => (await serverNotes(page)).some((n) => (n.about ?? []).some((l) => l.place && l.quote?.exact === "Chapter One")), 8000);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // The Mac app's window is the Mac's own WebKit, and Safari 17 and 18 take
    // getComposedRanges' shadow roots only as separate arguments, throwing on the
    // { shadowRoots } form: the page is given that older signature, and a mouse drag
    // still makes the highlight.
    // Browser: a gesture.
    test(`a mouse drag makes a highlight where getComposedRanges takes only shadow roots in ${engine.name}`, async () => {
      const { page, problems } = await open(false, {
        before: () => {
          const real = Selection.prototype.getComposedRanges;
          Selection.prototype.getComposedRanges = function (...roots) {
            if (roots.some((r) => !(r instanceof ShadowRoot))) throw new TypeError("getComposedRanges takes shadow roots");
            return real.call(this, { shadowRoots: roots });
          };
        },
      });
      const r = await page.evaluate(() => {
        const strip = document.querySelector("book-reader").shadowRoot.querySelector(".strip");
        const block = [...strip.children].find((el) => el.textContent.trim().split(/\s+/).length >= 4);
        const tn = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode();
        const range = document.createRange();
        range.setStart(tn, 2);
        range.setEnd(tn, Math.min(tn.data.length, 12));
        const b = range.getBoundingClientRect();
        return { x1: b.left + 1, x2: b.right - 1, y: b.top + b.height / 2 };
      });
      await page.mouse.move(r.x1, r.y);
      await page.mouse.down();
      await page.mouse.move(r.x2, r.y, { steps: 8 });
      await page.mouse.up();
      await until(async () => (await marks(page)).length === 1);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Ctrl+v starts a highlight exactly as v does (12, "Vim keys").
    // Browser: focus and keys.
    test(`Escape drops a keyboard highlight begun with Ctrl+v in ${engine.name}`, async () => {
      const { page, problems } = await open(true);
      await until(async () => {
        await page.keyboard.press("Control+v");
        if ((await pending(page)) === "C") return true;
        await page.keyboard.press("Escape");
        return false;
      });
      await page.keyboard.press("w");
      await page.keyboard.press("Escape");
      assert.equal(await pending(page), "");
      await page.keyboard.press("Enter");
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(await marks(page), []);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // A click on a mark opens its bubble; Copy link puts the stored link on the clipboard
    // and only that button reads Copied.
    // Browser: a gesture.
    test(`Copy link in a highlight's bubble copies the link in ${engine.name}`, async () => {
      const { page, problems } = await open(false, { highlight: true });
      await until(async () => (await marks(page)).join(" ") === "Chapter One");
      const box = await page.evaluate(() => {
        const r = document.querySelector("book-reader").shadowRoot.querySelector(".strip mark").getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.click(box.x, box.y);
      await until(async () => (await bubble(page)).join(" · ") === "Copy · Copy link · Remove");
      await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".bubble .copy-link").click());
      await until(async () => (await bubble(page)).join(" · ") === "Copy · Copied · Remove");
      assert.equal(await copied(page), LINK);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // A highlight split across a page turn: on the second page a click on its part there
    // opens the bubble above that part, not beside the part on the page before.
    // Browser: rendering and layout.
    test(`the bubble of a highlight split across pages sits on the page shown in ${engine.name}`, async () => {
      const { page, problems } = await open(false, { split: true });
      await until(async () => (await marks(page)).length > 0);
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => /Page 2 of/.test(document.querySelector("book-reader").shadowRoot.querySelector(".footer .pageno").textContent));
      await page.waitForFunction(() => document.querySelector("book-reader").shadowRoot.getAnimations().every((a) => a.playState !== "running"));
      // The mark's first line on the page shown, and a line in the middle of it to click.
      const at = await page.evaluate(() => {
        const r = document.querySelector("book-reader").shadowRoot;
        const vp = r.querySelector(".viewport").getBoundingClientRect();
        const lines = [...r.querySelectorAll(".strip mark")].flatMap((m) => [...m.getClientRects()]).filter((q) => q.width > 0 && q.left >= vp.left - 1 && q.right <= vp.right + 1);
        return lines.length ? { first: lines[0].toJSON(), middle: lines[Math.floor(lines.length / 2)].toJSON() } : null;
      });
      assert.ok(at, "part of the highlight shows on the second page");
      await page.mouse.click(at.middle.left + at.middle.width / 2, at.middle.top + at.middle.height / 2);
      await until(async () => (await bubble(page)).join(" · ") === "Copy · Copy link · Remove");
      const b = await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".bubble").getBoundingClientRect().toJSON());
      const line = at.first;
      assert.ok(Math.abs(b.left + b.width / 2 - (line.left + line.width / 2)) <= 2, `the bubble is centred over the part shown (bubble ${b.left}–${b.right}, line ${line.left}–${line.right})`);
      const gap = b.bottom <= line.top ? line.top - b.bottom : b.top - line.bottom;
      assert.ok(gap >= 0 && gap <= 12, `the bubble sits next to the part shown (bubble ${b.top}–${b.bottom}, line ${line.top}–${line.bottom})`);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // On a touch screen a selection in the text offers a Highlight button under it; a tap
    // on it makes the highlight and leaves neither the button nor the selection behind.
    // Playwright cannot press and hold, so the selection the iPhone would make is set from
    // the page, after a tap in the middle third has made the last pointer a finger.
    // Browser: a gesture.
    test(`a finger's selection and the Highlight button make a highlight in ${engine.name}`, async () => {
      const { page, problems } = await open(false, { touch: true });
      const box = await page.evaluate(() => {
        const r = document.querySelector("book-reader").shadowRoot.querySelector(".viewport").getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height - 4 };
      });
      await page.touchscreen.tap(box.x, box.y);
      const words = await page.evaluate(() => {
        const r = document.querySelector("book-reader").shadowRoot;
        const p = [...r.querySelectorAll(".strip p")].find((x) => x.firstChild?.nodeType === Node.TEXT_NODE && x.firstChild.data.trim().length > 20);
        const text = p.firstChild;
        const end = text.data.indexOf(" ", 12);
        document.getSelection().setBaseAndExtent(text, 0, text, end);
        return text.data.slice(0, end).trim();
      });
      const make = () => page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".bubble.make button.highlight")?.getBoundingClientRect().toJSON() ?? null);
      await until(async () => (await make()) != null);
      // Widening the selection moves the finger sideways, as a swipe would; it must not
      // turn the page. Synthetic touch pointer events, since the touchscreen has only tap().
      const footer = () => page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".footer").textContent.replace(/\s+/g, " "));
      const before = await footer();
      await page.evaluate((y) => {
        const vp = document.querySelector("book-reader").shadowRoot.querySelector(".viewport");
        const b = vp.getBoundingClientRect();
        const send = (type, x) => vp.dispatchEvent(new PointerEvent(type, { pointerId: 2, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true }));
        send("pointerdown", b.x + b.width * 0.8);
        for (let i = 1; i <= 6; i++) send("pointermove", b.x + b.width * 0.8 - i * 28);
        send("pointerup", b.x + b.width * 0.8 - 6 * 28);
      }, box.y - 40);
      assert.equal(await footer(), before, "a finger moving over a selection turns no page");
      const b = await make();
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      await until(async () => (await marks(page)).join(" ").trim() === words);
      assert.equal(await make(), null, "the Highlight button is gone");
      const selected = await page.evaluate(() => {
        const r = document.querySelector("book-reader").shadowRoot;
        return (document.getSelection()?.toString() ?? "") + (r.getSelection?.()?.toString() ?? "");
      });
      assert.equal(selected, "", "the selection is collapsed");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // y with the cursor inside a highlight opens its bubble and does Copy link.
    // Browser: focus and keys.
    test(`y inside a highlight copies its link in ${engine.name}`, async () => {
      const { page, problems } = await open(true, { highlight: true });
      await until(async () => (await marks(page)).join(" ") === "Chapter One");
      // Vim arrives with the settings reply; y acts only once it has.
      await until(async () => {
        await page.keyboard.press("y");
        return (await bubble(page)).join(" · ") === "Copy · Copied · Remove";
      });
      assert.equal(await copied(page), LINK);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // y on a passage marked with v copies it, says Copied over the footer and makes no
    // highlight.
    // Browser: focus and keys.
    test(`v w w y copies the passage without highlighting it in ${engine.name}`, async () => {
      const { page, problems } = await open(true);
      await until(async () => {
        await page.keyboard.press("v");
        if ((await pending(page)) === "C") return true;
        await page.keyboard.press("Escape");
        return false;
      });
      await page.keyboard.press("w");
      await page.keyboard.press("w");
      await page.keyboard.press("y");
      await until(async () => (await copied(page)) === "Chapter One");
      assert.equal(await pending(page), "");
      assert.equal(await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".footer .command")?.textContent.trim()), "Copied");
      await page.keyboard.press("Enter");
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(await marks(page), []);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Text copied in the reader is in Vim's register of every editor: on the product page,
    // after v … y over two blocks, p in the journal pastes it, the blocks a paragraph gap
    // apart.
    // Browser: focus and keys.
    test(`v … y in the reader, then p in the journal pastes the passage in ${engine.name}`, async () => {
      const { page, problems } = await open(true, { product: true });
      await until(async () => {
        await page.keyboard.press("v");
        if ((await pending(page)) === "C") return true;
        await page.keyboard.press("Escape");
        return false;
      });
      for (const key of ["w", "w", "w", "w", "y"]) await page.keyboard.press(key);
      await until(async () => (await copied(page)) === "Chapter One\n\nA LINKED");
      await page.locator("book-shelf .tile").filter({ hasText: "Journal" }).first().click();
      const journal = page.locator("journal-entry .cm-content").first();
      await journal.click();
      await until(async () => (await page.locator("journal-entry .cm-fat-cursor").count()) === 1);
      await page.keyboard.press("p");
      await until(async () => (await page.locator("journal-entry .cm-line").allTextContents()).join("|") === "Chapter One||A LINKED");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // y i s and y i p copy the sentence and the paragraph under the cursor.
    // Browser: focus and keys.
    test(`y i s and y i p copy the sentence and the paragraph in ${engine.name}`, async () => {
      const { page, problems } = await open(true);
      // Vim arrives with the settings reply; ) moves the cursor only once it has.
      const cursor = () => page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".cursor")?.dataset.block ?? null);
      await until(async () => {
        await page.keyboard.press(")");
        return (await cursor()) === "1";
      });
      await page.keyboard.press(")");
      await page.keyboard.press("w");
      for (const key of ["y", "i", "s"]) await page.keyboard.press(key);
      await until(async () => (await copied(page)) === "A short opening chapter, one page long.");
      for (const key of ["y", "i", "p"]) await page.keyboard.press(key);
      await until(async () => (await copied(page)) === "A short opening chapter, one page long. It links to the third chapter, to the middle, and to a definition.");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // y y inside a highlight copies its quote; its bubble's Copy reads Copied.
    // Browser: focus and keys.
    test(`y y inside a highlight copies its text in ${engine.name}`, async () => {
      const { page, problems } = await open(true, { highlight: true });
      await until(async () => (await marks(page)).join(" ") === "Chapter One");
      await until(async () => {
        await page.keyboard.press("y");
        return (await bubble(page)).join(" · ") === "Copy · Copied · Remove";
      });
      await page.keyboard.press("y");
      await until(async () => (await bubble(page)).join(" · ") === "Copied · Copy link · Remove");
      assert.equal(await copied(page), "Chapter One");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // d d inside a highlight does Remove, and u brings it back while it counts down.
    // Browser: focus and keys.
    test(`d d removes a highlight and u brings it back in ${engine.name}`, async () => {
      const { page, problems } = await open(true, { highlight: true });
      await until(async () => (await marks(page)).join(" ") === "Chapter One");
      // Vim arrives with the settings reply; d d acts only once it has.
      await until(async () => {
        await page.keyboard.press("d");
        await page.keyboard.press("d");
        return (await bubble(page)).join(" · ") === "Undo";
      });
      await page.keyboard.press("u");
      await until(async () => (await bubble(page)).join(" · ") === "Copy · Copy link · Remove");
      assert.equal((await marks(page)).join(" "), "Chapter One");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // A click on a source link in a note opens the page holding the passage, in another
    // chapter, and its highlight glows for about a second.
    // Browser: rendering and layout.
    test(`following a source link opens the passage and glows it in ${engine.name}`, async () => {
      const problems = [];
      context = await browser.newContext({ viewport: { width: 1300, height: 800 } });
      context.setDefaultTimeout(4000);
      const cookie = await seedUser();
      const put = async (id, note) => {
        const res = await fetch(`${BASE_URL}/api/notes/${id}`, { method: "PUT", headers: { "content-type": "application/json", Cookie: `unblent_session=${cookie}` }, body: JSON.stringify({ baseVersion: null, ...note }) });
        assert.equal(res.status, 200);
      };
      await put(MID_ID, { title: "", body: "", about: [{ kind: "book", id: BOOK_ID, place: MID_PLACE, quote: { exact: "The Middle", prefix: "", suffix: "" } }] });
      await put(LIT_ID, { title: "Lit", body: `Lit\n\nsee [The Middle](note:${MID_ID}) end`, about: [{ kind: "book", id: BOOK_ID }] });
      await signedIn(context, cookie);
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => localStorage.setItem("settings", v), seed(false));
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await page.locator("note-list").getByText("Lit", { exact: true }).click();
      await page.locator("note-editor .cm-source-link").click();
      // The glowing mark is the passage, shown on the page in view, in Chapter Two.
      const glow = () =>
        page.evaluate(() => {
          const r = document.querySelector("book-reader").shadowRoot;
          const mark = r.querySelector(".strip mark.glow");
          if (!mark) return null;
          const m = mark.getBoundingClientRect();
          const p = r.querySelector(".page").getBoundingClientRect();
          return { text: mark.textContent, chap: r.querySelector(".footer .chap").textContent.trim(), shown: m.left >= p.left && m.right <= p.right, tinted: getComputedStyle(mark).backgroundColor };
        });
      let lit = null;
      await until(async () => (lit = await glow())?.shown === true);
      assert.equal(lit.text, "The Middle");
      assert.equal(lit.chap, "Chapter Two");
      // The glow ends by itself: the mark goes back to the plain highlight.
      await until(async () => (await glow()) === null, 3000);
      assert.equal(await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".strip mark")?.textContent), "The Middle");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // The command line covers the footer, as Vim's covers its status line, so the
    // page keeps its size.
    // Browser: rendering and layout.
    test(`: draws the command line over the footer and it takes typing in ${engine.name}`, async () => {
      const { page, problems } = await open(true);
      const line = () =>
        page.evaluate(() => {
          const r = document.querySelector("book-reader").shadowRoot;
          const c = r.querySelector(".footer .command");
          if (!c) return null;
          const [a, f] = [c.getBoundingClientRect(), r.querySelector(".footer").getBoundingClientRect()];
          return { text: c.textContent, over: a.top >= f.top && a.bottom === f.bottom && a.left === f.left && a.right === f.right, footer: f.height };
        });
      const footer = await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".footer").getBoundingClientRect().height);
      // Vim arrives with the settings reply; : opens the line only once it has.
      await until(async () => {
        await page.keyboard.press(":");
        return (await line()) !== null;
      });
      await page.keyboard.type("wq");
      assert.deepEqual(await line(), { text: ":wq", over: true, footer });
      await page.keyboard.press("Enter");
      await until(async () => (await line())?.text === "Not a command: wq");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: focus and keys.
    test(`with Vim keys off v does nothing in ${engine.name}`, async () => {
      const { page, problems } = await open(false);
      // Give the settings reply time to land, so off is the answer and not the default.
      await new Promise((r) => setTimeout(r, 200));
      await page.keyboard.press("v");
      await page.keyboard.press("Control+v");
      await page.keyboard.press("w");
      await page.keyboard.press("Enter");
      assert.equal(await pending(page), "");
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(await marks(page), []);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });
  });
}

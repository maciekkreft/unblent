import { test, describe, before, after } from "node:test";
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
const SCREENSHOTS = resolve(HERE, "..", "..", "..", ".screenshots");

// The "Vim keys" preference, seeded the way the settings fact stores it (one
// localStorage key), so a reload restores the same picture.
const settings = (vimKeys, editors = {}) =>
  JSON.stringify({
    nav: [],
    viewportSwitchHidden: false,
    layoutSwitchHidden: false,
    arranging: true,
    vimKeys,
    editors,
  });
const VIM = settings(true);
const NO_VIM = settings(false);

// The editor has mounted and taken the "Vim keys" preference: Vim arrives with the
// settings reply, which the level bar's keys show.
const vimReady = (page) =>
  page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector("button.level kbd"));

function watch(page, problems) {
  page.on("console", (msg) => msg.type() === "error" && problems.push(`console error: ${msg.text()}`));
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => res.status() >= 400 && problems.push(`HTTP ${res.status()}: ${res.url()}`));
}

async function until(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

// The element filling the note-editor role: the page's own tag, or a member the
// composer swapped in, which carries data-role (3.6).
const slotted = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('note-editor:not([stage]), [data-role="note-editor"]');
    return el ? { tag: el.localName, role: el.dataset.role ?? null } : null;
  });

// The notes stem page is the smallest page holding the editor with the list beside it.
const STEM = "/workshop/design/notes";

// The document as the user sees it: each CM6 line's text and classes, marker-free.
const lines = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("note-editor").shadowRoot;
    return [...root.querySelectorAll(".cm-line")].map((l) => ({ text: l.textContent, className: l.className }));
  });

// The line the normal-mode cursor sits on: the .cm-line whose box holds the top of
// the vim fat cursor. Read from the DOM so the test needs no vendor import.
const caretLine = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("note-editor").shadowRoot;
    const fat = root.querySelector(".cm-fat-cursor")?.getBoundingClientRect();
    return [...root.querySelectorAll(".cm-line")].findIndex((l) => {
      const r = l.getBoundingClientRect();
      return fat && fat.top >= r.top - 1 && fat.top < r.bottom;
    });
  });

// The line the caret comes to rest on after a motion, different from `from`. CM6 remeasures
// line heights asynchronously after a level change, so a read taken mid-remeasure can name
// the wrong line for a frame; require the reading to hold across two polls before trusting it.
const restLine = async (page, from) => {
  let prev = null;
  await until(async () => {
    const now = await caretLine(page);
    const settled = now === prev && now !== from && now >= 0;
    prev = now;
    return settled;
  });
  return prev;
};

// The insert caret CM6 draws, against the scroller that clips it.
const insertCaret = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("note-editor").shadowRoot;
    const caret = root.querySelector(".cm-layer.cm-cursorLayer .cm-cursor")?.getBoundingClientRect();
    const scroller = root.querySelector(".cm-scroller").getBoundingClientRect();
    return caret ? { left: caret.left, height: caret.height, scrollerLeft: scroller.left } : null;
  });

// How the fat cursor and the level lines are drawn: the parts a screenshot cannot
// assert deterministically.
const drawn = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("note-editor").shadowRoot;
    const fat = root.querySelector(".cm-fat-cursor");
    const fatStyle = fat && getComputedStyle(fat);
    return {
      fat: fatStyle ? { outlineStyle: fatStyle.outlineStyle, boxShadow: fatStyle.boxShadow } : null,
      levelMargins: [...root.querySelectorAll('.cm-line[class*="cm-level-"]')].map((l) => {
        const s = getComputedStyle(l);
        return [s.marginTop, s.marginBottom];
      }),
    };
  });

// A source link as book-reader's Copy link writes it, to a highlight this browser does not
// hold, so following it finds the highlight gone.
const GONE = "01ARZ3NDEKTSV4RRFFQ69G5FC0";
const LINK = `[The quote](note:${GONE})`;

// The editor's document as stored: the raw text, with the link in it.
const docText = (page) =>
  page.evaluate(() => document.querySelector("note-editor").shadowRoot.querySelector(".cm-content").cmView.rootView.view.state.doc.toString());

// An editor on the notes stem page, holding `see <link> end`, typed without Vim.
async function withLink(browser, vimKeys) {
  const context = await browser.newContext();
  context.setDefaultTimeout(4000);
  const problems = [];
  const page = await context.newPage();
  watch(page, problems);
  await page.addInitScript((v) => localStorage.setItem("settings", v), vimKeys ? VIM : NO_VIM);
  await page.goto(`${BASE_URL}${STEM}`);
  await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector(".cm-content"));
  if (vimKeys) await vimReady(page);
  await page.locator("note-editor .cm-content").click();
  if (vimKeys) await page.keyboard.press("i");
  await page.keyboard.insertText(`see ${LINK} end`);
  if (vimKeys) await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("note-editor").shadowRoot.querySelector(".cm-source-link"));
  return { context, page, problems };
}

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  describe(`note-editor in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 30000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: focus and keys.
    test("edits under Vim: lines start as Body, \\2 makes a Heading and \\1 a Title, no markers in the buffer", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => localStorage.setItem("settings", v), VIM);
      await page.goto(`${BASE_URL}${STEM}`);
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector(".cm-content"));
      await vimReady(page);
      assert.deepEqual(await slotted(page), { tag: "note-editor", role: null });

      // Vim boots in normal mode: enter insert, type two lines, return to normal.
      await page.locator("note-editor .cm-content").click();
      await page.keyboard.press("i");
      await page.keyboard.type("Alpha");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("Beta");
      await page.keyboard.press("Escape");
      await until(async () => (await lines(page)).map((l) => l.text).join("\n") === "Alpha\nBeta");

      // No level is imposed on the first line: both lines start as Body.
      const start = await lines(page);
      assert.ok(!start.some((l) => l.className.includes("cm-level-")), "lines start as Body, no forced Title");

      // The caret is on line two (Beta): the leader map \2 makes it a Heading.
      await page.keyboard.type("\\2");
      await until(async () => (await lines(page))[1]?.className.includes("cm-level-heading"));
      // Move to line one and raise it to a Title with \1.
      await page.keyboard.type("k");
      await page.keyboard.type("\\1");
      await until(async () => (await lines(page))[0]?.className.includes("cm-level-title"));

      const shown = await lines(page);
      assert.equal(shown.map((l) => l.text).join("\n"), "Alpha\nBeta", "the buffer holds no marker characters");
      assert.ok(shown[0].className.includes("cm-level-title"), "line one became a Title");
      assert.ok(shown[1].className.includes("cm-level-heading"), "line two became a Heading");

      const sizes = await page.evaluate(() => {
        const root = document.querySelector("note-editor").shadowRoot;
        const px = (sel) => parseFloat(getComputedStyle(root.querySelector(sel)).fontSize);
        return { title: px(".cm-level-title"), heading: px(".cm-level-heading") };
      });
      assert.ok(sizes.title > sizes.heading, `Title larger than Heading, saw ${sizes.title} vs ${sizes.heading}`);

      // Enter after a Heading starts a paragraph: the gap and the new line are Body.
      await page.keyboard.type("GA");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Gamma");
      await page.keyboard.press("Escape");
      await until(async () => (await lines(page)).map((l) => l.text).join("\n") === "Alpha\nBeta\n\nGamma");
      assert.ok(!(await lines(page)).slice(2).some((l) => l.className.includes("cm-level-")), "new lines are Body");

      await until(async () => (await page.locator("note-editor .status > span:first-child").textContent())?.trim() === "Saved");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    // Browser: rendering and layout.
    test("a list item is drawn as a dot with a hanging indent, its marker kept in the text", async () => {
      const context = await browser.newContext({ viewport: { width: 700, height: 600 } });
      context.setDefaultTimeout(4000);
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => localStorage.setItem("settings", v), NO_VIM);
      await page.goto(`${BASE_URL}${STEM}`);
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector(".cm-content"));
      await page.locator("note-editor .cm-content").click();
      await page.keyboard.type("- one item long enough to wrap onto a second line in this narrow editor, and on again past it");
      await page.keyboard.press("Enter");
      await page.keyboard.type("two");

      await until(async () => (await lines(page)).filter((l) => l.className.includes("cm-item")).length === 2);
      const shape = await page.evaluate(() => {
        const root = document.querySelector("note-editor").shadowRoot;
        const line = root.querySelector(".cm-line.cm-item");
        const dot = line.querySelector(".cm-item-dot");
        const text = [...line.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
        const range = document.createRange();
        range.selectNodeContents(text);
        const rows = [...range.getClientRects()].map((r) => Math.round(r.left));
        return { dot: dot.textContent, dotRight: dot.getBoundingClientRect().right, rows, text: text.textContent.slice(0, 3) };
      });
      assert.equal(shape.dot, "•", "the marker is drawn as a dot");
      assert.equal(shape.text, "one", "the dot stands in for the marker; the text follows it");
      assert.ok(shape.rows.length >= 2, `the item wraps, saw ${shape.rows.length} rows`);
      assert.ok(shape.dotRight <= shape.rows[0] + 1, "the dot stands left of the text");
      assert.ok(shape.rows.every((left) => Math.abs(left - shape.rows[0]) <= 1), `every row of the item starts under the first, saw ${shape.rows}`);

      // The text keeps the markdown marker, one line per item.
      await until(async () => (await page.locator("note-editor .status > span:first-child").textContent())?.trim() === "Saved");
      const body = await page.evaluate(() => document.querySelector("note-editor").shadowRoot.querySelector(".cm-content").cmView.rootView.view.state.doc.toString());
      assert.match(body, /^- one item .*\n- two$/);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    // Browser: a page's composition.
    test("a choice the composer cannot load leaves the page's default", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      // The notes stem page loads no composer, so this runs on the product, whose
      // editor in the Notes panel shows once a note is picked from the Notes list.
      await page.addInitScript((v) => localStorage.setItem("settings:product", v), settings(false, { "note-editor": "no-such-editor" }));
      await page.goto(`${BASE_URL}/`);
      await page.waitForFunction(() => document.querySelector("note-list")?.shadowRoot?.querySelector(".row.draft"));
      await page.locator("note-list").evaluate((el) => el.shadowRoot.querySelector(".row.draft").click());
      await page.waitForFunction(() => document.querySelector("#notes-editor")?.shadowRoot?.querySelector(".cm-content"));
      assert.deepEqual(await slotted(page), { tag: "note-editor", role: null }, "the page's own editor stayed");

      await page.locator("#notes-editor .cm-content").click();
      await page.keyboard.type("Still here");
      await until(async () => (await page.locator("#notes-editor .status > span:first-child").textContent())?.trim() === "Saved");
      // The one failed request is the missing component the stored choice names; the
      // browser also logs it as a console error, which names no URL.
      const missing = "/static/components/no-such-editor/view.js";
      const others = problems.filter((p) => !p.includes(missing) && !/^console error: Failed to load resource: .*404/.test(p));
      assert.ok(problems.some((p) => p.includes(missing)), "the composer did try the choice");
      assert.deepEqual(others, [], `${engine.name} reported: ${others.join("; ")}`);
      await context.close();
    });

    // Browser: a gesture.
    test("the level bar sets and follows the level", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => localStorage.setItem("settings", v), VIM);
      await page.goto(`${BASE_URL}${STEM}`);
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector(".cm-content"));
      await vimReady(page);

      await page.locator("note-editor .cm-content").click();
      await page.keyboard.press("i");
      await page.keyboard.type("Alpha");
      await page.keyboard.press("Escape");

      const pressed = () =>
        page.evaluate(() =>
          [...document.querySelector("note-editor").shadowRoot.querySelectorAll('button.level[aria-pressed="true"]')].map((b) => b.dataset.level),
        );
      assert.deepEqual(await pressed(), ["body"], "a new line starts as Body");
      assert.equal(await page.locator("note-editor button.level kbd").count(), 4, "each button shows its Vim key");

      await page.locator('note-editor button.level[data-level="heading"]').click();
      await until(async () => (await lines(page))[0]?.className.includes("cm-level-heading"));
      assert.deepEqual(await pressed(), ["heading"]);

      // A Vim key flashes its button too; the flash is caught as it starts, since it
      // is gone within --duration-slide.
      await page.evaluate(() => {
        window.flashes = [];
        document.querySelector("note-editor").shadowRoot.addEventListener("animationstart", (e) => window.flashes.push(e.target.dataset.level));
      });
      await page.keyboard.type("\\1");
      await until(async () => (await lines(page))[0]?.className.includes("cm-level-title"));
      assert.deepEqual(await pressed(), ["title"]);
      await until(() => page.evaluate(() => window.flashes.includes("title")));
      assert.equal((await lines(page))[0].text, "Alpha", "the click left the text alone");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    // Browser: focus and keys.
    test("levels keep Vim motions exact and both cursors stay visible", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => localStorage.setItem("settings", v), VIM);
      await page.goto(`${BASE_URL}${STEM}`);
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector(".cm-content"));
      await vimReady(page);

      await page.locator("note-editor .cm-content").click();
      await page.keyboard.press("i");
      for (const [i, word] of ["One", "Two", "Three", "Four"].entries()) {
        if (i > 0) await page.keyboard.press("Shift+Enter");
        await page.keyboard.type(word);
      }
      await page.keyboard.press("Escape");
      await until(async () => (await lines(page)).length === 4);

      // Vim moves j/k by pixels through CM6's height map, which measures a line's
      // box and not its margins: a level must not change what j reaches.
      await page.keyboard.press("g");
      await page.keyboard.press("g");
      const landed = [];
      let from = await caretLine(page);
      for (const [key, expect] of [["\\1", 1], ["\\2", 2], ["\\3", 3]]) {
        await page.keyboard.type(key);
        await until(async () => (await lines(page)).some((l) => l.className.includes("cm-level-")));
        await page.keyboard.press("j");
        from = await restLine(page, from);
        landed.push([expect, from]);
      }
      await page.keyboard.press("k");
      from = await restLine(page, from);
      landed.push([2, from]);
      assert.deepEqual(landed.map(([, got]) => got), landed.map(([want]) => want), `j/k landed on ${JSON.stringify(landed)}`);
      const before = await drawn(page);
      assert.ok(before.levelMargins.length >= 3, "three leveled lines");
      assert.ok(before.levelMargins.every(([t, b]) => t === "0px" && b === "0px"), `level lines carry no margin, saw ${JSON.stringify(before.levelMargins)}`);

      // o opens a line at column 0: the caret must lie inside the scroller's clip.
      await page.keyboard.press("G");
      await page.keyboard.press("o");
      await until(async () => (await insertCaret(page))?.height > 0);
      const caret = await insertCaret(page);
      assert.ok(caret.left >= caret.scrollerLeft, `insert caret clipped: left ${caret.left} < scroller ${caret.scrollerLeft}`);

      // An unfocused editor hollows the fat cursor from the inside, so no edge of
      // it can be clipped; a focused one fills it.
      await page.keyboard.press("Escape");
      await until(async () => (await drawn(page)).fat !== null);
      await page.evaluate(() => document.querySelector("note-editor").shadowRoot.querySelector(".cm-content").blur());
      await until(async () => (await drawn(page)).fat?.boxShadow.includes("inset"));
      const blurred = (await drawn(page)).fat;
      assert.equal(blurred.outlineStyle, "none", "no outline on the unfocused fat cursor");
      await page.locator("note-editor .cm-content").click();
      await until(async () => (await drawn(page)).fat?.boxShadow === "none");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    // Browser: focus and keys.
    test("with Vim keys off it types straight in; turned on, the block cursor is back", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.goto(`${BASE_URL}${STEM}`);
      await page.evaluate((v) => localStorage.setItem("settings", v), NO_VIM);
      await page.reload();
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector("button.level"));

      await page.locator("note-editor .cm-content").click();
      await page.keyboard.type("iAlpha");
      await until(async () => (await lines(page))[0]?.text === "iAlpha");
      assert.equal(await page.locator("note-editor .cm-fat-cursor").count(), 0, "no block cursor");
      assert.equal(await page.locator("note-editor button.level kbd").count(), 0, "the buttons show names only");
      await until(async () => (await page.locator("note-editor .status > span:first-child").textContent())?.trim() === "Saved");

      await page.evaluate((v) => localStorage.setItem("settings", v), VIM);
      await page.reload();
      await vimReady(page);
      await page.locator("note-editor .cm-content").click();
      await until(async () => (await page.locator("note-editor .cm-fat-cursor").count()) > 0);
      // Normal mode: 0 goes to the line's start and x deletes the stray "i".
      await page.keyboard.type("0x");
      await until(async () => (await lines(page))[0]?.text === "Alpha");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    // Browser: focus and keys.
    test("undo stops at the note as it was opened", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => localStorage.setItem("settings", v), VIM);
      await page.goto(`${BASE_URL}${STEM}`);
      await vimReady(page);
      await page.locator("note-editor .cm-content").click();
      await page.keyboard.type("iAlpha");
      await page.keyboard.press("Escape");
      await until(async () => (await page.locator("note-editor .status > span:first-child").textContent())?.trim() === "Saved");

      await page.reload();
      await vimReady(page);
      await until(async () => (await lines(page))[0]?.text === "Alpha");
      await page.locator("note-editor .cm-content").click();
      await page.keyboard.type("u");
      await page.keyboard.press("Control+z");
      await page.waitForTimeout(300);
      assert.deepEqual((await lines(page)).map((l) => l.text), ["Alpha"], "undo did not take back the opening");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    // Browser: rendering and layout.
    test("the editor mounts on the phone", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => {
        localStorage.setItem("viewport", "phone");
        localStorage.setItem("settings", v);
      }, VIM);
      await page.goto(`${BASE_URL}${STEM}`);
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector(".cm-content"));
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      assert.deepEqual(await slotted(page), { tag: "note-editor", role: null });
      const fits = await page.evaluate(() => {
        const el = document.querySelector("note-editor");
        return el.scrollWidth <= el.clientWidth + 1;
      });
      assert.ok(fits, "the editor must not overflow sideways on the phone");
      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `notes-editor-phone-${engine.name}.png`) });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    // Browser: a reload against real storage.
    test("Enter starts a paragraph drawn as a gap, Shift+Enter breaks the line, and a reload shows the gap again", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => localStorage.setItem("settings", v), NO_VIM);
      await page.goto(`${BASE_URL}${STEM}`);
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector("button.level"));
      await page.locator("note-editor .cm-content").click();
      await page.keyboard.type("Plan");
      await page.locator('note-editor button.level[data-level="heading"]').click();
      await page.keyboard.press("Enter");
      await page.keyboard.type("One");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("Two");
      const shown = async () => (await lines(page)).map((l) => [l.text, l.className.includes("cm-level-"), l.className.includes("cm-gap")]);
      const want = [
        ["Plan", true, false],
        ["", false, true],
        ["One", false, false],
        ["Two", false, false],
      ];
      await until(async () => (await shown()).length === 4);
      assert.deepEqual(await shown(), want);
      await until(async () => (await page.locator("note-editor .status > span:first-child").textContent())?.trim() === "Saved");
      const body = await page.evaluate(
        () =>
          new Promise((res, rej) => {
            const open = indexedDB.open("notes");
            open.onerror = () => rej(open.error);
            open.onsuccess = () => {
              const all = open.result.transaction("notes", "readonly").objectStore("notes").getAll();
              all.onsuccess = () => res(all.result.map((n) => n.body));
            };
          }),
      );
      assert.deepEqual(body, ["## Plan\n\nOne\nTwo"]);

      // The editor reopens the newest note: the stored blank line is a gap again.
      await page.reload();
      await until(async () => (await lines(page))[2]?.text === "One");
      assert.deepEqual(await shown(), want);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    // Browser: rendering and layout.
    test("a source link is drawn as one tag, the link icon and its label, its text kept as stored", async () => {
      const { context, page, problems } = await withLink(browser, false);
      const tag = await page.evaluate(() => {
        const root = document.querySelector("note-editor").shadowRoot;
        const el = root.querySelector(".cm-source-link");
        const s = getComputedStyle(el);
        return {
          count: root.querySelectorAll(".cm-source-link").length,
          label: el.textContent.trim(),
          icon: Boolean(el.querySelector("svg path")),
          line: root.querySelector(".cm-line").textContent.replace(/\s+/g, " "),
          tinted: s.backgroundColor !== "rgba(0, 0, 0, 0)",
          struck: s.textDecorationLine.includes("line-through"),
        };
      });
      assert.deepEqual(tag, { count: 1, label: "The quote", icon: true, line: "see The quote end", tinted: true, struck: false });
      assert.equal(await docText(page), `see ${LINK} end`);
      await until(async () => (await page.locator("note-editor .status > span:first-child").textContent())?.trim() === "Saved");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    // Browser: focus and keys.
    test("the cursor steps over a source link as one character, p on it pastes after it, and x or Backspace removes it whole", async () => {
      const { context, page, problems } = await withLink(browser, true);
      const head = () =>
        page.evaluate(() => document.querySelector("note-editor").shadowRoot.querySelector(".cm-content").cmView.rootView.view.state.selection.main.head);
      const after = 4 + LINK.length;
      // 0 then four l's: on the tag; one more l: past it; h: back on it.
      await page.keyboard.type("0llll");
      await until(async () => (await head()) === 4);
      await page.keyboard.type("l");
      await until(async () => (await head()) === after);
      await page.keyboard.type("h");
      await until(async () => (await head()) === 4);
      await page.keyboard.type("x");
      await until(async () => (await docText(page)) === "see  end");
      await page.keyboard.type("u");
      await until(async () => (await docText(page)) === `see ${LINK} end`);
      // p on the tag pastes after the whole tag, never inside its text.
      await page.keyboard.type("0yl");
      await page.keyboard.type("llll");
      await until(async () => (await head()) === 4);
      await page.keyboard.type("p");
      await until(async () => (await docText(page)) === `see ${LINK}s end`);
      await page.keyboard.type("u");
      await until(async () => (await docText(page)) === `see ${LINK} end`);
      // Backspace just after the tag, in insert mode.
      await page.keyboard.type("0lllll");
      await until(async () => (await head()) === after);
      await page.keyboard.press("i");
      await page.keyboard.press("Backspace");
      await until(async () => (await docText(page)) === "see  end");
      assert.equal(await head(), 4);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    // Browser: a gesture.
    test("following a source link to a removed highlight greys and strikes its tag", async () => {
      const { context, page, problems } = await withLink(browser, true);
      const struck = () =>
        page.evaluate(() => {
          const el = document.querySelector("note-editor").shadowRoot.querySelector(".cm-source-link");
          return getComputedStyle(el).textDecorationLine.includes("line-through");
        });
      assert.equal(await struck(), false);
      // Enter on the tag in normal mode follows it.
      await page.keyboard.type("0llll");
      await page.keyboard.press("Enter");
      await until(struck);
      await until(async () => (await page.locator("note-editor .status > span:first-child").textContent())?.trim() === "Saved");
      await page.reload();
      // A click follows it too, on a fresh page.
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector(".cm-source-link"));
      assert.equal(await struck(), false);
      await page.locator("note-editor .cm-source-link").click();
      await until(struck);
      assert.equal(await docText(page), `see ${LINK} end`, "following changes nothing in the text");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });
  });
}

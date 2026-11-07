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

// The kit (10): a forged sign-in, for the product, which hides the notes signed out.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

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

// The note on screen has reached notes' store in this browser: a record holds the
// editor's text, its level markers aside. A database not made yet is left unmade.
const stored = (page, sel = "note-editor") =>
  page.evaluate(
    (sel) =>
      new Promise((res) => {
        const text = document.querySelector(sel).shadowRoot.querySelector(".cm-content").cmView.rootView.view.state.doc.toString();
        const open = indexedDB.open("notes");
        open.onupgradeneeded = () => open.transaction.abort();
        open.onerror = () => res(false);
        open.onsuccess = () => {
          const db = open.result;
          const all = db.transaction("notes", "readonly").objectStore("notes").getAll();
          all.onsuccess = () => {
            db.close();
            res(all.result.some((r) => r.body.split("\n").map((l) => l.replace(/^#{1,3} /, "")).join("\n") === text));
          };
          all.onerror = () => {
            db.close();
            res(false);
          };
        };
      }),
    sel,
  );

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

// The level lines' margins: what a screenshot cannot assert deterministically.
const levelMargins = (page) =>
  page.evaluate(() =>
    [...document.querySelector("note-editor").shadowRoot.querySelectorAll('.cm-line[class*="cm-level-"]')].map((l) => {
      const s = getComputedStyle(l);
      return [s.marginTop, s.marginBottom];
    }),
  );

// A source link as book-reader's Copy link writes it, to a highlight this browser does not
// hold, so its tag is grey from the start and following it finds the highlight gone.
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

      await until(() => stored(page));
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    // Browser: a page's composition.
    test("a choice the composer cannot load leaves the page's default", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      // Signed out the product hides the notes and offers no New note.
      await signedIn(context, forgeCookie("note-composer"));
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
      await until(() => stored(page, "#notes-editor"));
      // The one failed request is the missing component the stored choice names; the
      // browser also logs it as a console error, which names no URL.
      const missing = "/static/components/no-such-editor/view.js";
      const others = problems.filter((p) => !p.includes(missing) && !/^console error: Failed to load resource: .*404/.test(p));
      assert.ok(problems.some((p) => p.includes(missing)), "the composer did try the choice");
      assert.deepEqual(others, [], `${engine.name} reported: ${others.join("; ")}`);
      await context.close();
    });

    // Browser: rendering and layout.
    test("on the product, the editor in front after a reload hides its note signed out and shows it again on sign-in", async () => {
      const cookie = forgeCookie("note-editor");
      const res = await fetch(`${BASE_URL}/api/notes/01K0000000000000000000N0TE`, {
        method: "PUT",
        headers: { "content-type": "application/json", Cookie: `unblent_session=${cookie}` },
        body: JSON.stringify({ title: "Kept", body: "Kept\nprivate words", baseVersion: null, about: [] }),
      });
      assert.equal(res.status, 200);
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, cookie);
      // The note is to stay in front across the reload: "Keep the open note and chat", as
      // Settings stores it on the product.
      await context.addInitScript(() => localStorage.setItem("settings:product", JSON.stringify({ keepOpen: true })));
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      const content = () => page.evaluate(() => document.querySelector("#notes-editor").shadowRoot.querySelector(".cm-content")?.textContent ?? null);
      await page.goto(`${BASE_URL}/`);
      await page.waitForFunction(() => document.querySelector("note-list")?.shadowRoot?.querySelector(".row:not(.draft)"));
      await page.locator("note-list").evaluate((el) => el.shadowRoot.querySelector(".row:not(.draft)").click());
      await until(async () => (await content())?.includes("private words"));
      await page.reload();
      await until(async () => (await content())?.includes("private words"));

      await page.locator('session-switch button[aria-label="Sign out"]').click();
      await until(async () => (await page.evaluate(() => document.querySelector("#notes-editor").shadowRoot.textContent.trim())) === "Sign in to see your notes.");
      assert.equal(await content(), null, "nothing of the note stays in the page");

      await signedIn(context, cookie);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await until(async () => (await content())?.includes("private words"));
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
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
    test("levels keep Vim motions exact, and o opens a line the caret shows in", async () => {
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
      const margins = await levelMargins(page);
      assert.ok(margins.length >= 3, "three leveled lines");
      assert.ok(margins.every(([t, b]) => t === "0px" && b === "0px"), `level lines carry no margin, saw ${JSON.stringify(margins)}`);

      // o opens a line at column 0: the caret must lie inside the scroller's clip.
      await page.keyboard.press("G");
      await page.keyboard.press("o");
      await until(async () => (await insertCaret(page))?.height > 0);
      const caret = await insertCaret(page);
      assert.ok(caret.left >= caret.scrollerLeft, `insert caret clipped: left ${caret.left} < scroller ${caret.scrollerLeft}`);

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
      await until(() => stored(page));

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
      await until(() => stored(page));

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
    test("a Heading and a paragraph are stored with the Heading's marker, and a reload draws them again", async () => {
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
      await until(() => stored(page));
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

    // Browser: focus and keys.
    test("with Vim keys a new note picked in the list starts in insert mode, an existing one in normal mode", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => localStorage.setItem("settings", v), VIM);
      await page.goto(`${BASE_URL}${STEM}`);
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector(".cm-content"));
      await vimReady(page);
      const normal = () => page.evaluate(() => Boolean(document.querySelector("note-editor").shadowRoot.querySelector(".cm-scroller.cm-vimMode")));
      // The empty page the editor starts on is nobody's pick: the keyboard arrives in normal mode.
      await page.locator("note-editor .cm-content").click();
      assert.equal(await normal(), true, "the starting empty page is in normal mode");
      await page.keyboard.press("i");
      await page.keyboard.type("First");
      await page.keyboard.press("Escape");
      await page.locator("note-list li.row", { hasText: "New note" }).click();
      await page.locator("note-list li.row", { hasText: "First" }).waitFor();
      await until(async () => (await docText(page)) === "");
      await page.locator("note-editor .cm-content").click();
      await until(async () => !(await normal()));
      await page.keyboard.type("hi");
      assert.equal(await docText(page), "hi", "the first letters typed are text");
      await page.keyboard.press("Escape");
      // Saved and listed first, so the list does not redraw under the click.
      await page.locator("note-list li.row .name", { hasText: "hi" }).waitFor();
      // On its name: the row's middle may be its Delete button.
      await page.locator("note-list li.row .name", { hasText: "First" }).click();
      await until(async () => (await docText(page)) === "First");
      await page.locator("note-editor .cm-content").click();
      assert.equal(await normal(), true, "an existing note opens in normal mode");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    // Browser: focus and keys.
    test("the keyboard handed over before the editor is drawn lands in it once it is", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      const problems = [];
      await signedIn(context, forgeCookie("focus-early"));
      // The sign-in answer held, so nothing is drawn yet. The list that hands the keyboard over
      // also waits for this answer, by a moment too short for keys to hit, so here the panel
      // shows the editor by hand and the keyboard is handed the same way list-then-item does.
      let release;
      const held = new Promise((r) => (release = r));
      await context.route(/\/api\/session\/me/, async (route) => {
        await held;
        await route.continue();
      });
      const page = await context.newPage();
      watch(page, problems);
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      const inBox = () =>
        page.evaluate(() => {
          const editor = document.querySelector("#notes note-editor");
          return editor.shadowRoot.activeElement?.classList.contains("cm-content") === true;
        });
      await page.waitForFunction(() => document.querySelector("#notes")?.shadowRoot?.querySelector("slot") && document.querySelector("#notes note-editor")?.shadowRoot);
      await page.evaluate(() => {
        const editor = document.querySelector("#notes note-editor");
        document.querySelector("#notes").shadowRoot.querySelector("slot").assign(editor);
        editor.focus();
      });
      assert.equal(await inBox(), false, "no box yet");
      release();
      await until(inBox);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    // Browser: focus and keys.
    test("with Vim keys o under a Heading opens a Body line, and dd on blank lines above a Heading keeps its level", async () => {
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
      await page.keyboard.type("One");
      await page.keyboard.press("Escape");
      await page.keyboard.type("\\2");
      const level = async (text) => (await lines(page)).find((l) => l.text === text)?.className.match(/cm-level-(\w+)/)?.[1] ?? "body";
      await until(async () => (await level("One")) === "heading");
      await page.keyboard.press("o");
      await page.keyboard.type("Two");
      await page.keyboard.press("Escape");
      await until(async () => (await docText(page)) === "One\n\nTwo");
      assert.equal(await level("Two"), "body", "o under a Heading opens a Body line");
      await page.keyboard.type("\\2");
      await until(async () => (await level("Two")) === "heading");
      // O left empty between the two leaves two blank lines past the gap.
      await page.keyboard.press("O");
      await page.keyboard.press("Escape");
      await until(async () => (await docText(page)) === "One\n\n\n\nTwo");
      await page.keyboard.press("g");
      await page.keyboard.press("g");
      await page.keyboard.press("j");
      await until(async () => (await caretLine(page)) === 2);
      for (const want of ["One\n\n\nTwo", "One\n\nTwo"]) {
        await page.keyboard.press("d");
        await page.keyboard.press("d");
        await until(async () => (await docText(page)) === want);
        assert.equal(await level("Two"), "heading", `Two is still a Heading after dd, in ${JSON.stringify(want)}`);
      }
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    // Browser: rendering and layout.
    test("a tag whose highlight is gone is grey and struck from the start, also after a reload, and following it changes nothing", async () => {
      const { context, page, problems } = await withLink(browser, true);
      const struck = () =>
        page.evaluate(() => {
          const el = document.querySelector("note-editor").shadowRoot.querySelector(".cm-source-link");
          return getComputedStyle(el).textDecorationLine.includes("line-through");
        });
      await until(struck);
      // Enter on the tag in normal mode follows it, and nothing opens.
      await page.keyboard.type("0llll");
      await page.keyboard.press("Enter");
      await until(() => stored(page));
      await page.reload();
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector(".cm-source-link"));
      await until(struck);
      await page.locator("note-editor .cm-source-link").click();
      assert.equal(await struck(), true);
      assert.equal(await docText(page), `see ${LINK} end`, "following changes nothing in the text");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });
  });
}

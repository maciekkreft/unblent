import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The editor kit's own browser tests (9): what every editor built from it draws and does
// with the keys, on the bare editor of its stem page, so no editor's own behavior is in
// the way.
const PAGE = "/workshop/design/editor";

// A source link as book-reader's Copy link writes it. The id must be a whole ULID, or
// the kit leaves the text plain.
const LINK = "[The quote](note:01ARZ3NDEKTSV4RRFFQ69G5FC0)";

// The document as the user sees it: each line's text and classes.
const lines = (page) =>
  page.evaluate(() =>
    [...document.querySelector("editor-sample").shadowRoot.querySelectorAll(".cm-line")].map((l) => ({ text: l.textContent, className: l.className })),
  );

const text = (page) => page.evaluate(() => document.querySelector("editor-sample").text);

const head = (page) =>
  page.evaluate(() => document.querySelector("editor-sample").shadowRoot.querySelector(".cm-content").cmView.rootView.view.state.selection.main.head);

// The line the normal-mode cursor sits on: the .cm-line whose box holds the top of the
// Vim block cursor.
const caretLine = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("editor-sample").shadowRoot;
    const fat = root.querySelector(".cm-fat-cursor")?.getBoundingClientRect();
    return [...root.querySelectorAll(".cm-line")].findIndex((l) => {
      const r = l.getBoundingClientRect();
      return fat && fat.top >= r.top - 1 && fat.top < r.bottom;
    });
  });

const fatVisibility = (page) =>
  page.evaluate(() => {
    const fat = document.querySelector("editor-sample").shadowRoot.querySelector(".cm-fat-cursor");
    return fat ? getComputedStyle(fat).visibility : null;
  });

for (const engine of ENGINES) {
  describe(`the editor kit in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    // Each test gets a fresh context on the sample editor, with Vim keys on or off as the
    // settings fact stores them, and the keyboard in the editor. With Vim on, the block
    // cursor shows once the settings reply has switched Vim on.
    const run = (name, { vim = false, viewport } = {}, body) =>
      test(name, async () => {
        const context = await browser.newContext(viewport ? { viewport } : {});
        context.setDefaultTimeout(4000);
        try {
          const page = await context.newPage();
          const problems = watch(page);
          await page.addInitScript((v) => localStorage.setItem("settings", JSON.stringify({ vimKeys: v })), vim);
          await page.goto(`${BASE_URL}${PAGE}`);
          await page.waitForFunction(() => document.querySelector("editor-sample")?.shadowRoot?.querySelector(".cm-content"));
          await page.locator("editor-sample .cm-content").click();
          if (vim) await until(async () => (await page.locator("editor-sample .cm-fat-cursor").count()) > 0);
          await body(page, context);
          assert.deepEqual(problems, [], problems.join("; "));
        } finally {
          await context.close();
        }
      });

    // Browser: rendering and layout.
    run("a \"- \" item is drawn as a dash with a hanging indent, its marker kept in the text", { viewport: { width: 700, height: 600 } }, async (page) => {
      await page.keyboard.type("- one item long enough to wrap onto a second line in this narrow editor, and on again past it");
      await page.keyboard.press("Enter");
      await page.keyboard.type("two");
      await until(async () => (await lines(page)).filter((l) => l.className.includes("cm-item")).length === 2);
      const shape = await page.evaluate(() => {
        const line = document.querySelector("editor-sample").shadowRoot.querySelector(".cm-line.cm-item");
        const dot = line.querySelector(".cm-item-dot");
        const node = [...line.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
        const range = document.createRange();
        range.selectNodeContents(node);
        const rows = [...range.getClientRects()].map((r) => Math.round(r.left));
        return { dot: dot.textContent, dotRight: dot.getBoundingClientRect().right, rows, text: node.textContent.slice(0, 3) };
      });
      assert.equal(shape.dot, "–", "the marker is drawn as a dash");
      assert.equal(shape.text, "one", "the dash stands in for the marker; the text follows it");
      assert.ok(shape.rows.length >= 2, `the item wraps, saw ${shape.rows.length} rows`);
      assert.ok(shape.dotRight <= shape.rows[0] + 1, "the dash stands left of the text");
      assert.ok(shape.rows.every((left) => Math.abs(left - shape.rows[0]) <= 1), `every row of the item starts under the first, saw ${shape.rows}`);
      // The text keeps the markdown marker, Enter putting the next item directly below.
      assert.match(await text(page), /^- one item .*\n- two$/);
    });

    // Browser: rendering and layout.
    run("Enter starts a paragraph drawn as a gap shorter than a line, and Shift+Enter breaks the line", {}, async (page) => {
      await page.keyboard.type("Plan");
      await page.keyboard.press("Enter");
      await page.keyboard.type("One");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("Two");
      const shown = async () => (await lines(page)).map((l) => [l.text, l.className.includes("cm-gap")]);
      await until(async () => (await shown()).length === 4);
      assert.deepEqual(await shown(), [["Plan", false], ["", true], ["One", false], ["Two", false]]);
      assert.equal(await text(page), "Plan\n\nOne\nTwo");
      const heights = await page.evaluate(() => {
        const [, gap, one] = document.querySelector("editor-sample").shadowRoot.querySelectorAll(".cm-line");
        return { gap: gap.getBoundingClientRect().height, line: one.getBoundingClientRect().height };
      });
      assert.ok(heights.gap > 0 && heights.gap < heights.line, `a gap is shorter than a line, saw ${heights.gap} vs ${heights.line}`);
    });

    // Browser: focus and keys.
    run("with Vim keys o and O open a paragraph a gap apart, and on an item the next item", { vim: true }, async (page) => {
      await page.keyboard.press("i");
      await page.keyboard.type("Plan");
      await page.keyboard.press("Escape");
      // o opens a paragraph a gap below the line.
      await page.keyboard.press("o");
      await page.keyboard.type("One");
      await page.keyboard.press("Escape");
      // O opens one a gap above, between the two.
      await page.keyboard.press("O");
      await page.keyboard.type("Zero");
      await page.keyboard.press("Escape");
      // On an item, o opens the next item directly below it.
      await page.keyboard.press("j");
      await page.keyboard.press("o");
      await page.keyboard.type("- a");
      await page.keyboard.press("Escape");
      await page.keyboard.press("o");
      await page.keyboard.type("b");
      await page.keyboard.press("Escape");
      const shown = async () => (await lines(page)).map((l) => [l.text, l.className.includes("cm-gap"), l.className.includes("cm-item")]);
      const want = [
        ["Plan", false, false],
        ["", true, false],
        ["Zero", false, false],
        ["", true, false],
        ["One", false, false],
        ["", true, false],
        ["–a", false, true],
        ["–b", false, true],
      ];
      await until(async () => (await shown()).length === want.length);
      assert.deepEqual(await shown(), want);
    });

    // Browser: focus and keys.
    run("with Vim keys j stops on an extra blank line, dd removes it, and J joins two paragraphs in one u", { vim: true }, async (page) => {
      await page.keyboard.press("i");
      await page.keyboard.type("One");
      await page.keyboard.press("Escape");
      await page.keyboard.press("o");
      await page.keyboard.type("Two");
      await page.keyboard.press("Escape");
      // O left empty between two paragraphs leaves two blank lines past the gap.
      await page.keyboard.press("O");
      await page.keyboard.press("Escape");
      await until(async () => (await text(page)) === "One\n\n\n\nTwo");
      await page.keyboard.press("g");
      await page.keyboard.press("g");
      await page.keyboard.press("j");
      await until(async () => (await caretLine(page)) === 2);
      for (const want of ["One\n\n\nTwo", "One\n\nTwo"]) {
        await page.keyboard.press("d");
        await page.keyboard.press("d");
        await until(async () => (await text(page)) === want);
      }
      await page.keyboard.press("g");
      await page.keyboard.press("g");
      await page.keyboard.press("Shift+J");
      await until(async () => (await text(page)) === "One Two");
      await page.keyboard.press("u");
      await until(async () => (await text(page)) === "One\n\nTwo");
    });

    // Browser: focus and keys.
    run("with Vim keys one u takes back o and what was typed after it, and Ctrl+r brings it back", { vim: true }, async (page) => {
      await page.keyboard.press("i");
      await page.keyboard.type("Plan");
      await page.keyboard.press("Escape");
      // Pauses longer than CodeMirror's own grouping, so only the insert session joins them.
      await page.keyboard.press("o");
      await page.keyboard.type("Ab", { delay: 600 });
      await page.keyboard.press("Escape");
      await until(async () => (await text(page)) === "Plan\n\nAb");
      await page.keyboard.press("u");
      await until(async () => (await text(page)) === "Plan");
      await page.keyboard.press("Control+r");
      await until(async () => (await text(page)) === "Plan\n\nAb");
      assert.deepEqual((await lines(page)).map((l) => l.text), ["Plan", "", "Ab"]);
    });

    // Browser: focus and keys.
    run("with Vim keys the block cursor shows only while the editor has the keyboard", { vim: true }, async (page) => {
      // A page of many boxes shows one cursor, in the box with the keyboard.
      await until(async () => (await fatVisibility(page)) === "visible");
      await page.evaluate(() => document.querySelector("editor-sample").shadowRoot.querySelector(".cm-content").blur());
      await until(async () => (await fatVisibility(page)) === "hidden");
      await page.locator("editor-sample .cm-content").click();
      await until(async () => (await fatVisibility(page)) === "visible");
    });

    // Browser: rendering and layout.
    run("a source link is drawn as one tag, the link icon and its label, its text kept as stored", {}, async (page) => {
      await page.keyboard.insertText(`see ${LINK} end`);
      await page.waitForFunction(() => document.querySelector("editor-sample").shadowRoot.querySelector(".cm-source-link"));
      const tag = await page.evaluate(() => {
        const root = document.querySelector("editor-sample").shadowRoot;
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
      assert.equal(await text(page), `see ${LINK} end`);
    });

    // Browser: focus and keys.
    run("the cursor steps over a source link as one character, p on it pastes after it, and x or Backspace removes it whole", { vim: true }, async (page) => {
      await page.keyboard.press("i");
      await page.keyboard.insertText(`see ${LINK} end`);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector("editor-sample").shadowRoot.querySelector(".cm-source-link"));
      const after = 4 + LINK.length;
      // 0 then four l's: on the tag; one more l: past it; h: back on it.
      await page.keyboard.type("0llll");
      await until(async () => (await head(page)) === 4);
      await page.keyboard.type("l");
      await until(async () => (await head(page)) === after);
      await page.keyboard.type("h");
      await until(async () => (await head(page)) === 4);
      await page.keyboard.type("x");
      await until(async () => (await text(page)) === "see  end");
      await page.keyboard.type("u");
      await until(async () => (await text(page)) === `see ${LINK} end`);
      // p on the tag pastes after the whole tag, never inside its text.
      await page.keyboard.type("0yl");
      await page.keyboard.type("llll");
      await until(async () => (await head(page)) === 4);
      await page.keyboard.type("p");
      await until(async () => (await text(page)) === `see ${LINK}s end`);
      await page.keyboard.type("u");
      await until(async () => (await text(page)) === `see ${LINK} end`);
      // Backspace just after the tag, in insert mode.
      await page.keyboard.type("0lllll");
      await until(async () => (await head(page)) === after);
      await page.keyboard.press("i");
      await page.keyboard.press("Backspace");
      await until(async () => (await text(page)) === "see  end");
      assert.equal(await head(page), 4);
    });

    // Browser: rendering and layout.
    run("a known hashtag is drawn in the accent colour and an unknown one muted, its text kept", {}, async (page) => {
      await page.evaluate(() => (document.querySelector("editor-sample").known = ["in-my-control"]));
      await page.keyboard.insertText("Tonight #in-my-control #foo");
      await page.waitForFunction(() => document.querySelector("editor-sample").shadowRoot.querySelectorAll(".cm-hashtag").length === 2);
      const drawn = await page.evaluate(() => {
        const root = document.querySelector("editor-sample").shadowRoot;
        const paint = (name) => {
          const probe = document.createElement("span");
          probe.style.color = `var(${name})`;
          root.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        const tag = (cls) => {
          const el = root.querySelector(cls);
          return { text: el.textContent, color: getComputedStyle(el).color };
        };
        return { known: tag(".cm-hashtag-known"), unknown: tag(".cm-hashtag-unknown"), accent: paint("--color-accent"), mute: paint("--color-mute") };
      });
      assert.deepEqual(drawn.known, { text: "#in-my-control", color: drawn.accent });
      assert.deepEqual(drawn.unknown, { text: "#foo", color: drawn.mute });
      // Once the name is known, the editor redraws it.
      await page.evaluate(() => (document.querySelector("editor-sample").known = ["in-my-control", "foo"]));
      await page.waitForFunction(() => document.querySelector("editor-sample").shadowRoot.querySelectorAll(".cm-hashtag-known").length === 2);
      assert.equal(await text(page), "Tonight #in-my-control #foo");
    });

    // Browser: rendering and layout.
    run("a line's marks stand at the right of its first row, and its text never runs under them, on the desk and on a phone", { viewport: { width: 360, height: 640 } }, async (page) => {
      const long = "The rain kept on all evening and the trains stopped, so the plan for tonight had to change twice";
      await page.keyboard.insertText(`Short line\n${long}\nPlain`);
      await page.evaluate(
        (long) => (document.querySelector("editor-sample").marks = { "Short line": ["In my control"], [long]: ["Not in my control", "Story"] }),
        long,
      );
      await page.waitForFunction(() => document.querySelector("editor-sample").shadowRoot.querySelectorAll(".cm-line-marks").length === 2);
      for (const size of [{ width: 1000, height: 700 }, { width: 360, height: 640 }]) {
        await page.setViewportSize(size);
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const shape = await page.evaluate(() => {
          const root = document.querySelector("editor-sample").shadowRoot;
          return [...root.querySelectorAll(".cm-line")].map((line) => {
            const box = line.getBoundingClientRect();
            const marks = line.querySelector(".cm-line-marks")?.getBoundingClientRect();
            const node = [...line.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
            const range = document.createRange();
            range.selectNodeContents(node);
            const rows = [...range.getClientRects()].map((r) => ({ top: r.top, bottom: r.bottom, right: r.right }));
            return { line: { top: box.top, bottom: box.bottom, right: box.right }, marks: marks && { top: marks.top, bottom: marks.bottom, left: marks.left, right: marks.right }, rows };
          });
        });
        assert.equal(shape[2].marks, undefined, "a line without marks shows none");
        for (const [i, { line, marks, rows }] of shape.slice(0, 2).entries()) {
          assert.ok(Math.abs(marks.right - line.right) <= 1, `${size.width}px line ${i}: the marks end at the line's right edge`);
          assert.ok(marks.top >= line.top - 1 && marks.bottom <= line.bottom + 1, `${size.width}px line ${i}: the marks stay inside their line`);
          const beside = rows.filter((r) => r.top < marks.bottom - 1 && r.bottom > marks.top + 1);
          assert.ok(beside.every((r) => r.right <= marks.left + 1), `${size.width}px line ${i}: no text runs under the marks`);
        }
        if (size.width < 400) {
          assert.ok(shape[1].rows.length >= 2, "the long line wraps on a phone");
          const first = shape[1].rows[0];
          assert.ok(shape[1].marks.top < first.bottom && shape[1].marks.bottom > first.top, "a wrapped line's marks are on its first row");
        }
      }
      assert.equal(await text(page), `Short line\n${long}\nPlain`, "the marks are not text");
    });

    // Browser: focus and keys.
    run("with Vim keys j and k move line by line past a line with marks", { vim: true }, async (page) => {
      await page.keyboard.press("i");
      await page.keyboard.insertText("One\nTwo\nThree");
      await page.keyboard.press("Escape");
      await page.evaluate(() => (document.querySelector("editor-sample").marks = { Two: ["A mark", "Another"] }));
      await page.waitForFunction(() => document.querySelector("editor-sample").shadowRoot.querySelector(".cm-line-marks"));
      await page.keyboard.type("gg");
      await until(async () => (await head(page)) === 0);
      for (const want of [4, 8]) {
        await page.keyboard.press("j");
        await until(async () => (await head(page)) === want);
      }
      for (const want of [4, 0]) {
        await page.keyboard.press("k");
        await until(async () => (await head(page)) === want);
      }
      await page.keyboard.type("j$");
      await until(async () => (await head(page)) === 6);
      assert.equal(await caretLine(page), 1, "the cursor is drawn on the marked line, before its marks");
    });

    // Browser: a gesture.
    run("a web link shows its label off the cursor's line, and a click opens it in a new tab", {}, async (page, context) => {
      // The new tab gets an empty page, so the test never leaves this host.
      await context.route("https://example.com/**", (route) => route.fulfill({ body: "ok", contentType: "text/plain" }));
      await page.keyboard.insertText("Read [the site](https://example.com/a) now");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.insertText("next");
      const link = page.locator("editor-sample .cm-web-link");
      await until(async () => (await link.textContent()) === "the site");
      assert.equal((await lines(page))[0].text, "Read the site now");
      const opened = context.waitForEvent("page");
      await link.click();
      const tab = await opened;
      await tab.waitForLoadState();
      assert.equal(tab.url(), "https://example.com/a");
      assert.equal(page.url(), `${BASE_URL}${PAGE}`, "the app stays where it was");
      assert.equal(await text(page), "Read [the site](https://example.com/a) now\nnext", "the text stays as typed");
    });

    // The hashtag picker's rows as drawn: each row's tag, its description (or null), and
    // whether it is the marked one; [] while the list is closed.
    const picker = (page) =>
      page.evaluate(() =>
        [...document.querySelector("editor-sample").shadowRoot.querySelectorAll(".cm-hashtag-picker-row")].map((row) => ({
          tag: row.querySelector(".cm-hashtag-picker-tag").textContent,
          about: row.querySelector(".cm-hashtag-picker-about")?.textContent ?? null,
          selected: row.classList.contains("cm-hashtag-picker-selected"),
        })),
      );
    const pickerShown = async (page, tags) => until(async () => JSON.stringify((await picker(page)).map((r) => r.tag)) === JSON.stringify(tags));

    // Browser: rendering and layout.
    run("typing # opens the tags under it, narrowed to the ones matching what follows", { viewport: { width: 1000, height: 600 } }, async (page) => {
      await page.keyboard.type("Tonight #");
      await pickerShown(page, ["#in-my-control", "#inner-critic", "#thinking-traps"]);
      const rows = await picker(page);
      assert.deepEqual(rows.map((r) => r.selected), [true, false, false], "the first row is marked");
      assert.equal(rows[2].about, null, "a tag without a description shows none");
      const shape = await page.evaluate(() => {
        const root = document.querySelector("editor-sample").shadowRoot;
        const card = root.querySelector(".cm-hashtag-picker").getBoundingClientRect();
        const tag = root.querySelector(".cm-hashtag-picker-tag");
        const about = root.querySelector(".cm-hashtag-picker-about");
        const hash = [...root.querySelectorAll(".cm-line")][0].getBoundingClientRect();
        return { width: card.width, top: card.top, lineMiddle: (hash.top + hash.bottom) / 2, tagColor: getComputedStyle(tag).color, aboutWraps: getComputedStyle(about).whiteSpace };
      });
      assert.ok(Math.abs(shape.width - 300) <= 2, `about 300px wide on the desk, saw ${shape.width}`);
      assert.ok(shape.top > shape.lineMiddle, `the list opens under the line, saw ${JSON.stringify(shape)}`);
      assert.equal(shape.aboutWraps, "nowrap", "a description stays on one line");
      assert.equal(shape.tagColor, "rgb(251, 146, 60)", "a tag is in the accent color");
      await page.keyboard.type("in");
      await pickerShown(page, ["#in-my-control", "#inner-critic"]);
      await page.keyboard.type("-");
      await pickerShown(page, ["#in-my-control"]);
      await page.keyboard.type("x");
      await pickerShown(page, []);
      assert.equal(await text(page), "Tonight #in-x");
    });

    // Browser: rendering and layout.
    run("on a phone the picker's rows are tall enough for a finger", { viewport: { width: 390, height: 700 } }, async (page) => {
      await page.keyboard.type("#");
      await pickerShown(page, ["#in-my-control", "#inner-critic", "#thinking-traps"]);
      const heights = await page.evaluate(() =>
        [...document.querySelector("editor-sample").shadowRoot.querySelectorAll(".cm-hashtag-picker-row")].map((r) => r.getBoundingClientRect().height),
      );
      assert.ok(heights.every((h) => h >= 44), `every row at least 44px tall, saw ${heights}`);
    });

    // Browser: focus and keys.
    run("Down then Up returns to the first tag, Enter adds it and a space, and Enter after it starts a bullet below", {}, async (page) => {
      await page.keyboard.type("Tonight #in");
      await pickerShown(page, ["#in-my-control", "#inner-critic"]);
      await page.keyboard.press("ArrowDown");
      await until(async () => (await picker(page))[1]?.selected === true);
      await page.keyboard.press("ArrowUp");
      await until(async () => (await picker(page))[0]?.selected === true);
      await page.keyboard.press("Enter");
      await until(async () => (await text(page)) === "Tonight #in-my-control ");
      await pickerShown(page, []);
      await page.keyboard.press("Enter");
      await page.keyboard.type("one");
      await until(async () => (await text(page)) === "Tonight #in-my-control \n- one");
      assert.ok((await lines(page))[1].className.includes("cm-item"), "the line below is a bullet item");
    });

    // Browser: focus and keys.
    run("Tab adds the marked tag, Ctrl+n moves the mark, and Esc closes the list leaving the text", {}, async (page) => {
      await page.keyboard.type("#in");
      await pickerShown(page, ["#in-my-control", "#inner-critic"]);
      await page.keyboard.press("Control+n");
      await until(async () => (await picker(page))[1]?.selected === true);
      await page.keyboard.press("Tab");
      await until(async () => (await text(page)) === "#inner-critic ");
      await page.keyboard.type("and #th");
      await pickerShown(page, ["#thinking-traps"]);
      await page.keyboard.press("Escape");
      await pickerShown(page, []);
      assert.equal(await text(page), "#inner-critic and #th");
      // Typing on in the same tag keeps it closed.
      await page.keyboard.type("i");
      assert.deepEqual(await picker(page), []);
      assert.equal(await text(page), "#inner-critic and #thi");
    });

    // Browser: a gesture.
    run("a click on a tag adds it and the keyboard stays in the editor", {}, async (page) => {
      await page.keyboard.type("Tonight #");
      await pickerShown(page, ["#in-my-control", "#inner-critic", "#thinking-traps"]);
      await page.locator("editor-sample .cm-hashtag-picker-row").nth(2).click();
      await until(async () => (await text(page)) === "Tonight #thinking-traps ");
      await pickerShown(page, []);
      await page.keyboard.type("next");
      assert.equal(await text(page), "Tonight #thinking-traps next", "the keyboard stayed in the editor");
    });

    // Browser: focus and keys.
    run("with Vim keys the picker works in insert mode, and Esc closes it before it leaves insert mode", { vim: true }, async (page) => {
      await page.keyboard.press("i");
      await page.keyboard.type("#in-");
      await pickerShown(page, ["#in-my-control"]);
      await page.keyboard.press("Enter");
      await until(async () => (await text(page)) === "#in-my-control ");
      await page.keyboard.type("#t");
      await pickerShown(page, ["#thinking-traps"]);
      await page.keyboard.press("Escape");
      await pickerShown(page, []);
      assert.equal(await page.locator("editor-sample .cm-fat-cursor").count(), 0, "still in insert mode");
      await page.keyboard.type("h");
      assert.equal(await text(page), "#in-my-control #th");
      await page.keyboard.press("Escape");
      await until(async () => (await page.locator("editor-sample .cm-fat-cursor").count()) > 0);
    });
  });
}

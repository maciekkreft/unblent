import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// Highlights on an earlier day as the user meets them: the decisions are tested in Node
// (highlights-rules.test.mjs), here what a mouse, a finger and the keys do on screen.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const STEM = `${BASE_URL}/workshop/design/journal`;

const DAY = "01K7TEST00000000000000DY01";
const OTHER = "01K7TEST00000000000000DY02";
const FIRST = "First paragraph about the morning walk and how the light fell on the river near the old bridge.";
const SECOND = "Second paragraph where I wrote about a hard talk with a friend and what I wish I had said.";
const FILLER = Array.from({ length: 30 }, (_, i) => `Filler line ${i + 1} that makes the day long enough to scroll.`).join("\n\n");
const TEXT = `${FIRST}\n\n${SECOND}`;
// Past the hold time, so a hold that should have started has shown by then.
const PAST_HOLD_MS = 500;

const dayRecord = (id, day, text) => ({ id, day, text, editedAt: new Date(2025, 2, 2, 21).getTime(), version: 1 });

const inEntry = (page, fn, arg) =>
  page.evaluate(([fn, arg]) => new Function("root", "arg", `return (${fn})(root, arg)`)(document.querySelector("journal-entry").shadowRoot, arg), [fn.toString(), arg]);

// The text is on screen under these coordinates, read from the drawn line.
const wordBox = (page, word) =>
  inEntry(page, (root, word) => {
    for (const line of root.querySelectorAll(".cm-line")) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const i = node.textContent.indexOf(word);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + word.length);
        const b = r.getBoundingClientRect();
        return { x0: b.left + 1, x1: b.right - 1, y: b.top + b.height / 2 };
      }
    }
    return null;
  }, word);
const marks = (page) => inEntry(page, (root) => [...root.querySelectorAll(".hl")].map((m) => m.textContent).join("|"));
const bubble = (page) => inEntry(page, (root) => [...root.querySelectorAll(".bubble button")].map((b) => b.textContent.trim()));
const painted = (page) => inEntry(page, (root) => root.querySelector(".passage").dataset.text ?? "");
const firstLine = (page) => inEntry(page, (root) => root.querySelector(".cm-line").textContent);
const atText = (page) => inEntry(page, (root) => root.activeElement?.classList.contains("cm-content") === true);

async function seed(page, days) {
  await page.evaluate(async (days) => {
    const db = await new Promise((ok, no) => {
      const r = indexedDB.open("journal");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
    const tx = db.transaction("days", "readwrite");
    for (const d of days) tx.objectStore("days").put(d);
    await new Promise((ok) => (tx.oncomplete = ok));
    db.close();
  }, days);
  await page.reload({ waitUntil: "domcontentloaded" });
}

const pick = async (page, id, heading) => {
  await page.locator(`journal-days .row[data-day="${id}"]`).click();
  await until(async () => (await page.locator("journal-entry h2").textContent()) === heading);
  await until(async () => (await firstLine(page)) !== "");
};

const openDay = async (page, days = [dayRecord(DAY, "2025-03-02", TEXT)]) => {
  await page.goto(STEM, { waitUntil: "domcontentloaded" });
  await page.locator("journal-entry .cm-content").waitFor();
  await seed(page, days);
  await pick(page, days[0].id, "Sunday 2 March");
};

const drag = async (page, from, to) => {
  await page.mouse.move(from.x0, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x1, to.y, { steps: 4 });
  await page.mouse.up();
};

// A finger, as pointer events on what lies under it: Playwright's touchscreen has only tap().
// Each move waits two frames, because the entry follows a finger once a frame.
const finger = (page) => {
  const send = (type, x, y) =>
    page.evaluate(([type, x, y]) => {
      const root = document.querySelector("journal-entry").shadowRoot;
      window.__pressed ??= root.elementFromPoint(x, y);
      window.__pressed.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true, composed: true }));
      if (type === "pointerup" || type === "pointercancel") window.__pressed = null;
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    }, [type, x, y]);
  return { down: (x, y) => send("pointerdown", x, y), move: (x, y) => send("pointermove", x, y), up: (x, y) => send("pointerup", x, y), cancel: (x, y) => send("pointercancel", x, y) };
};
// A plain event, because an engine without a touch screen may have no TouchEvent to construct.
const refused = (page) =>
  inEntry(page, (root) => {
    const event = new Event("touchmove", { bubbles: true, composed: true, cancelable: true });
    root.querySelector(".cm-content").dispatchEvent(event);
    return event.defaultPrevented;
  });

// A highlight stays on the account and comes back with the pull, so each test has its own.
let accounts = 0;

for (const engine of ENGINES) {
  describe(`highlights on an earlier day in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    const run = (name, body, { vim = false, phone = false } = {}) =>
      test(name, async () => {
        const context = await browser.newContext(phone ? { hasTouch: true, viewport: { width: 390, height: 844 } } : {});
        context.setDefaultTimeout(4000);
        accounts += 1;
        await signedIn(context, forgeCookie(`journal-highlights-${accounts}`));
        try {
          const page = await context.newPage();
          const problems = watch(page);
          await page.addInitScript(([vim, phone]) => {
            if (vim) localStorage.setItem("settings", JSON.stringify({ nav: [], vimKeys: true }));
            if (phone) localStorage.setItem("viewport", "phone");
            // writeText is recorded, so the test reads what was copied without a permission prompt.
            navigator.clipboard.writeText = async (t) => {
              window.__copied = t;
            };
          }, [vim, phone]);
          await body(page);
          assert.deepEqual(problems, []);
        } finally {
          await context.close();
        }
      });

    // Browser: a gesture.
    run("a mouse selection makes a highlight at once, opens its bubble, and the browser's copy still copies it", async (page) => {
      await openDay(page);
      const word = await wordBox(page, "morning");
      const end = await wordBox(page, "walk");
      await drag(page, word, end);
      await until(async () => (await marks(page)) === "morning walk");
      await until(async () => (await bubble(page)).includes("Comment"));
      const copied = await inEntry(page, (root) => {
        const data = new DataTransfer();
        const event = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, composed: true, cancelable: true });
        root.querySelector(".cm-content").dispatchEvent(event);
        return data.getData("text/plain");
      });
      assert.equal(copied, "morning walk");
      assert.ok(await atText(page), "the keyboard stays on the text");
      await page.locator("journal-entry .bubble .copy").click();
      assert.equal(await page.evaluate(() => window.__copied), "morning walk");
    });

    // Browser: a gesture.
    run("a press on a highlight opens its bubble, a press elsewhere closes it, and Remove goes with Undo to bring it back", async (page) => {
      await openDay(page);
      await drag(page, await wordBox(page, "morning"), await wordBox(page, "walk"));
      await until(async () => (await bubble(page)).length > 0);
      const away = await wordBox(page, "Second");
      await page.mouse.click(away.x0 + 2, away.y);
      await until(async () => (await bubble(page)).length === 0);
      const on = await wordBox(page, "morning");
      await page.mouse.click(on.x0 + 2, on.y);
      await until(async () => (await bubble(page)).length > 0);
      await page.locator("journal-entry .bubble .remove").click();
      await until(async () => (await marks(page)) === "");
      assert.equal((await bubble(page)).length, 0);
      assert.ok(await atText(page), "the keyboard goes back to the text");
      await page.locator("undo-bar .undo").click();
      await until(async () => (await marks(page)) === "morning walk");
    });

    // Browser: rendering and layout.
    run("a comment saved from the box draws the accent line, and Escape walks back out", async (page) => {
      await openDay(page);
      await drag(page, await wordBox(page, "morning"), await wordBox(page, "walk"));
      await page.locator("journal-entry .bubble .comment").click();
      await page.locator("journal-entry .bubble textarea").waitFor();
      await until(() => inEntry(page, (root) => root.activeElement?.localName === "textarea"));
      await page.keyboard.type("Felt calm");
      await page.keyboard.press("Escape");
      await until(() => inEntry(page, (root) => root.activeElement?.classList.contains("comment") === true));
      await until(() => inEntry(page, (root) => root.querySelector(".hl.commented") != null));
      const line = await inEntry(page, (root) => getComputedStyle(root.querySelector(".hl.commented")).boxShadow);
      assert.notEqual(line, "none");
      await page.keyboard.press("Escape");
      await until(async () => (await bubble(page)).length === 0);
      assert.ok(await atText(page));
      const on = await wordBox(page, "morning");
      await page.mouse.click(on.x0 + 2, on.y);
      await page.locator("journal-entry .bubble .comment").click();
      await until(async () => (await inEntry(page, (root) => root.querySelector(".bubble textarea")?.value)) === "Felt calm");
    });

    // Browser: a gesture.
    run("a finger's hold paints the word, a drag grows it from there either way, and lifting makes it with the bubble open", async (page) => {
      await openDay(page);
      const f = finger(page);
      const word = await wordBox(page, "morning");
      await f.down(word.x0 + 5, word.y);
      assert.equal(await painted(page), "", "no passage before the hold");
      assert.equal(await refused(page), false, "before the hold a move may still scroll");
      await page.waitForTimeout(PAST_HOLD_MS);
      assert.equal(await painted(page), "morning");
      assert.equal(await refused(page), true, "from the hold on a move is the passage's");
      const later = await wordBox(page, "Second");
      await f.move(later.x0 + 5, later.y);
      assert.match(await painted(page), /^morning walk[\s\S]*Second$/);
      const earlier = await wordBox(page, "First");
      await f.move(earlier.x0 + 5, earlier.y);
      assert.match(await painted(page), /^First[\s\S]*morning$/, "the start stays where the hold began");
      await f.up(earlier.x0 + 5, earlier.y);
      await until(async () => (await marks(page)).startsWith("First paragraph about the morning"));
      await until(async () => (await bubble(page)).includes("Remove"));
      assert.equal(await painted(page), "", "the tinted boxes are gone");
      assert.equal(await refused(page), false, "the day scrolls again");
    }, { phone: true });

    // Browser: a gesture.
    run("a finger that moves first is a scroll, a tap on a highlight opens its bubble, a tap elsewhere closes it, and a cancelled touch counts as a lift", async (page) => {
      await openDay(page);
      const f = finger(page);
      const word = await wordBox(page, "morning");
      await f.down(word.x0 + 5, word.y);
      await f.move(word.x0 + 5, word.y + 40);
      await page.waitForTimeout(PAST_HOLD_MS);
      assert.equal(await painted(page), "", "no hold after a move");
      await f.up(word.x0 + 5, word.y + 40);
      assert.equal(await marks(page), "");
      // iOS ended the touch while the finger rested in mid-drag.
      await f.down(word.x0 + 5, word.y);
      await page.waitForTimeout(PAST_HOLD_MS);
      await f.cancel(word.x0 + 5, word.y);
      await until(async () => (await marks(page)) === "morning");
      await until(async () => (await bubble(page)).length > 0);
      const away = await wordBox(page, "Second");
      await f.down(away.x0 + 2, away.y);
      await f.up(away.x0 + 2, away.y);
      await until(async () => (await bubble(page)).length === 0);
      const on = await wordBox(page, "morning");
      await f.down(on.x0 + 2, on.y);
      await f.up(on.x0 + 2, on.y);
      await until(async () => (await bubble(page)).length > 0);
    }, { phone: true });

    // Browser: a gesture.
    run("a finger's hold scrolled down the day finds the word under it", async (page) => {
      await openDay(page, [dayRecord(DAY, "2025-03-02", `${TEXT}\n\n${FILLER}\n\nThe very last words here.`)]);
      await inEntry(page, (root) => {
        const scroll = root.querySelector(".scroll");
        scroll.scrollTop = scroll.scrollHeight;
      });
      await until(async () => (await wordBox(page, "last")) != null);
      const word = await wordBox(page, "last");
      const f = finger(page);
      await f.down(word.x0 + 3, word.y);
      await page.waitForTimeout(PAST_HOLD_MS);
      assert.equal(await painted(page), "last");
      const box = await inEntry(page, (root) => root.querySelector(".passage i").getBoundingClientRect().toJSON());
      assert.ok(Math.abs(box.left - word.x0) < 3 && Math.abs(box.top + box.height / 2 - word.y) < 3, "the tint sits on the word");
      await f.up(word.x0 + 3, word.y);
      await until(async () => (await marks(page)) === "last");
    }, { phone: true });

    // Browser: focus and keys.
    run("with Vim keys on, the text holds the keyboard: motions and v work, Enter makes a highlight, y copies a passage, and edits do nothing", async (page) => {
      await openDay(page);
      await page.evaluate(() => document.querySelector("journal-entry").focus());
      await until(() => atText(page));
      for (const k of ["w", "v", "e", "Enter"]) await page.keyboard.press(k);
      await until(async () => (await marks(page)) === "paragraph");
      assert.equal((await bubble(page)).length, 0, "the keyboard's highlight leaves the bubble closed");
      for (const k of ["i", "x", "d", "w", "o", "p"]) await page.keyboard.press(k);
      assert.equal(await firstLine(page), FIRST, "nothing changed");
      assert.ok(await atText(page));
      for (const k of ["0", "v", "e", "y"]) await page.keyboard.press(k);
      await until(() => page.evaluate(() => window.__copied === "First"));
      assert.equal(await marks(page), "paragraph", "y makes no highlight");
      await until(async () => (await inEntry(page, (root) => root.querySelector(".said")?.textContent)) === "Copied");
    }, { vim: true });

    // Browser: focus and keys.
    run("with Vim keys on inside a highlight, y copies the link, y y the text, a says why, Enter gives the bubble the keyboard, d d removes and u brings it back", async (page) => {
      await openDay(page);
      await page.evaluate(() => document.querySelector("journal-entry").focus());
      await until(() => atText(page));
      for (const k of ["w", "v", "e", "Enter"]) await page.keyboard.press(k);
      await until(async () => (await marks(page)) === "paragraph");
      await page.keyboard.press("b");
      await page.keyboard.press("y");
      await until(() => page.evaluate(() => /^\[paragraph\]\(note:/.test(window.__copied ?? "")));
      await page.keyboard.press("y");
      await until(() => page.evaluate(() => window.__copied === "paragraph"));
      await page.keyboard.press("a");
      await until(async () => (await inEntry(page, (root) => root.querySelector(".said")?.textContent)) === "Open a note first");
      // Moving off the highlight takes its bubble with it, and back onto it opens nothing.
      await page.keyboard.press("0");
      await until(async () => (await bubble(page)).length === 0);
      await page.keyboard.press("w");
      await page.keyboard.press("Enter");
      await until(() => inEntry(page, (root) => root.activeElement?.classList.contains("copy") === true));
      await page.keyboard.press("l");
      await until(() => inEntry(page, (root) => root.activeElement?.classList.contains("copy-link") === true));
      await page.keyboard.press("h");
      await until(() => inEntry(page, (root) => root.activeElement?.classList.contains("copy") === true));
      await page.keyboard.press("Escape");
      await until(() => atText(page));
      assert.equal((await bubble(page)).length, 0);
      await page.keyboard.press("d");
      await page.keyboard.press("d");
      await until(async () => (await marks(page)) === "");
      await page.keyboard.press("u");
      await until(async () => (await marks(page)) === "paragraph");
    }, { vim: true });

    // Browser: rendering and layout.
    run("following a link to a highlight on another day shows that day, scrolls to the passage and makes it glow", async (page) => {
      await openDay(page, [dayRecord(DAY, "2025-03-02", `${TEXT}\n\n${FILLER}\n\nThe very last words here.`)]);
      await inEntry(page, (root) => {
        const scroll = root.querySelector(".scroll");
        scroll.scrollTop = scroll.scrollHeight;
      });
      await until(async () => (await wordBox(page, "last")) != null);
      await drag(page, await wordBox(page, "last"), await wordBox(page, "last"));
      await until(async () => (await marks(page)) === "last");
      const id = await inEntry(page, (root) => root.querySelector(".hl").dataset.id);
      await seed(page, [dayRecord(OTHER, "2025-03-03", `See [last](note:${id}) there.`)]);
      await pick(page, OTHER, "Monday 3 March");
      await page.locator("journal-entry .cm-source-link").waitFor();
      await page.locator("journal-entry .cm-source-link").click();
      await until(async () => (await page.locator("journal-entry h2").textContent()) === "Sunday 2 March");
      await until(() => inEntry(page, (root) => root.querySelector(".hl.glow") != null));
      const seen = await inEntry(page, (root) => {
        const mark = root.querySelector(".hl.glow").getBoundingClientRect();
        const scroll = root.querySelector(".scroll").getBoundingClientRect();
        return mark.top >= scroll.top && mark.bottom <= scroll.bottom;
      });
      assert.ok(seen, "the passage is on screen");
      await until(() => inEntry(page, (root) => root.querySelector(".hl.glow") == null));
    });
  });
}

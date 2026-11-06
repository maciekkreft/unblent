import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// A highlight's handles on an earlier day: the decisions are tested in Node
// (highlights-rules.test.mjs), here what a press and a drag on a handle do on screen.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const STEM = `${BASE_URL}/workshop/design/journal`;

const DAY = "01K7TEST00000000000000DY01";
const FIRST = "First paragraph about the morning walk and how the light fell on the river near the old bridge.";
const SECOND = "Second paragraph where I wrote about a hard talk with a friend and what I wish I had said.";
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
const handle = (page, end) =>
  inEntry(page, (root, end) => {
    const el = root.querySelector(`.handle.${end}`);
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, end);
const handleStyle = (page) =>
  inEntry(page, (root) => {
    const el = root.querySelector(".handle.end");
    const r = el.getBoundingClientRect();
    return { touchAction: getComputedStyle(el).touchAction, big: r.width >= 40 && r.height >= 40 };
  });
const touchRefused = (page, selector) =>
  inEntry(page, (root, selector) => {
    const event = new Event("touchstart", { bubbles: true, composed: true, cancelable: true });
    root.querySelector(selector).dispatchEvent(event);
    return event.defaultPrevented;
  }, selector);
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
  describe(`a highlight's handles on an earlier day in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    const run = (name, body, { phone = false } = {}) =>
      test(name, async () => {
        const context = await browser.newContext(phone ? { hasTouch: true, viewport: { width: 390, height: 844 } } : {});
        context.setDefaultTimeout(4000);
        accounts += 1;
        await signedIn(context, forgeCookie(`journal-handles-${accounts}`));
        try {
          const page = await context.newPage();
          const problems = watch(page);
          await page.addInitScript((phone) => {
            if (phone) localStorage.setItem("viewport", "phone");
          }, phone);
          await body(page);
          assert.deepEqual(problems, []);
        } finally {
          await context.close();
        }
      });

    // The owner's report: iOS ends a touch whose finger rests, and a handle is what survives it.
    // Browser: a gesture.
    run("a handle dragged with a pause moves that end, one change to the same highlight, and Undo returns the old ends", async (page) => {
      await openDay(page);
      const f = finger(page);
      const word = await wordBox(page, "morning");
      await f.down(word.x0 + 5, word.y);
      await page.waitForTimeout(PAST_HOLD_MS);
      await f.up(word.x0 + 5, word.y);
      await until(async () => (await handle(page, "end")) != null);
      const id = await inEntry(page, (root) => root.querySelector(".hl").dataset.id);
      assert.deepEqual(await handleStyle(page), { touchAction: "none", big: true });
      assert.equal(await touchRefused(page, ".handle.end"), true, "a touch on a handle is refused");
      assert.equal(await touchRefused(page, ".cm-content"), false, "and one on the text is not, since the day scrolls");
      const end = await handle(page, "end");
      await f.down(end.x, end.y);
      assert.ok((await bubble(page)).length > 0, "the press does not close the bubble");
      assert.equal(await refused(page), true, "the moves are the handle's");
      const walk = await wordBox(page, "walk");
      await f.move(end.x + (walk.x1 - word.x1), end.y);
      assert.equal(await painted(page), "morning walk");
      await page.waitForTimeout(PAST_HOLD_MS * 2);
      assert.equal(await painted(page), "morning walk", "a pause changes nothing");
      await f.up(end.x + (walk.x1 - word.x1), end.y);
      await until(async () => (await marks(page)) === "morning walk");
      assert.equal(await painted(page), "", "the mark takes over from the drag's boxes");
      assert.equal(await inEntry(page, (root) => root.querySelector(".hl").dataset.id), id, "the same highlight");
      assert.ok((await bubble(page)).length > 0, "its bubble is still open");
      assert.equal(await refused(page), false, "the day scrolls again");
      await page.locator("undo-bar .undo").click();
      await until(async () => (await marks(page)) === "morning");
    }, { phone: true });

    // Browser: a gesture.
    run("a mouse drags a handle, the ends cannot cross, the selection follows and can still be copied, and a move over another highlight joins them", async (page) => {
      await openDay(page);
      await drag(page, await wordBox(page, "river"), await wordBox(page, "river"));
      await until(async () => (await marks(page)) === "river");
      await drag(page, await wordBox(page, "morning"), await wordBox(page, "morning"));
      await until(async () => (await marks(page)) === "river|morning" || (await marks(page)) === "morning|river");
      await until(async () => (await handle(page, "end")) != null);
      let end = await handle(page, "end");
      const start = await handle(page, "start");
      const walk = await wordBox(page, "walk");
      await page.mouse.move(end.x, end.y);
      await page.mouse.down();
      await page.mouse.move(start.x - 200, start.y, { steps: 4 });
      await until(async () => (await painted(page)).length === 1);
      const from = await wordBox(page, "morning");
      await page.mouse.move(end.x + (walk.x1 - from.x1), end.y, { steps: 4 });
      await page.mouse.up();
      await until(async () => (await marks(page)).startsWith("morning walk"));
      const copied = await inEntry(page, (root) => {
        const data = new DataTransfer();
        root.querySelector(".cm-content").dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, composed: true, cancelable: true }));
        return data.getData("text/plain");
      });
      assert.equal(copied, "morning walk", "the browser's copy copies what the highlight now holds");
      // On to the other highlight, which it joins.
      end = await handle(page, "end");
      const river = await wordBox(page, "river");
      const nowEnd = await wordBox(page, "walk");
      await page.mouse.move(end.x, end.y);
      await page.mouse.down();
      await page.mouse.move(end.x + (river.x0 + 3 - nowEnd.x1), end.y + (river.y - nowEnd.y), { steps: 4 });
      await page.mouse.up();
      await until(async () => (await inEntry(page, (root) => new Set([...root.querySelectorAll(".hl")].map((h) => h.dataset.id)).size)) === 1);
      assert.match(await marks(page), /^morning walk.*river$/s);
    });
  });
}

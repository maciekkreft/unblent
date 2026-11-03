import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The "Vim keys" preference (12), seeded the way the settings fact stores it; `/` is in
// the product profile, which keeps its own copy under its own key.
const seed = (vimKeys) =>
  JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });

// Which panel holds the keyboard: the desk's child that contains the focused element,
// by its address (4.1), and the tag of the element focused inside that panel's tree.
const focused = (page) =>
  page.evaluate(() => {
    const desk = document.querySelector("dock-desk");
    const active = document.activeElement;
    const child = [...desk.children].find((c) => c.contains(active));
    let deep = active;
    while (deep?.shadowRoot?.activeElement) deep = deep.shadowRoot.activeElement;
    return {
      panel: child ? child.localName + (child.id ? "#" + child.id : "") : null,
      host: active?.localName ?? null,
      row: deep?.getAttribute?.("tabindex") === "0" && deep.getAttribute("role") === "option",
    };
  });

const rightTab = (page) =>
  page.evaluate(
    () =>
      document
        .querySelector("dock-desk")
        .shadowRoot.querySelector('.dock.right .panel [role="tab"][aria-selected="true"]')
        ?.textContent.trim() ?? null,
  );

// The groups drawn with the frame that says the keyboard is in them.
const framed = (page) =>
  page.evaluate(() =>
    [...document.querySelector("dock-desk").shadowRoot.querySelectorAll(".body")]
      .filter((b) => getComputedStyle(b.parentElement, "::after").content !== "none")
      .map((b) => b.dataset.side),
  );

// Turn "Vim keys" on or off as the settings sheet does, from a throwaway emitter: the bus
// checks only that the emit is declared, so settings receives it exactly as in the app.
const editSettings = (page, vimKeys) =>
  page.evaluate(async (vimKeys) => {
    const name = "settings.edited";
    const [{ mount, unmount }, { setup, emit }] = await Promise.all([import("/static/bus/bus.js"), import("xstate")]);
    const schema = await (await fetch(`/static/components/settings-sheet/events/${name}.json`)).json();
    const emitter = setup({}).createMachine({
      id: "test-emitter",
      meta: { kind: "view", emits: [name], attributes: [] },
      on: { go: { actions: emit(({ event }) => event.body) } },
    });
    const actor = mount(emitter, { events: { [name]: schema } });
    actor.send({ type: "go", body: { type: name, nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys } });
    await new Promise((r) => setTimeout(r, 40));
    unmount(actor);
  }, vimKeys);

// The colour drawn at one point of the page, as [r, g, b]: a 1x1 screenshot is one PNG
// row of one pixel, which every PNG filter stores as the pixel itself.
const pixel = async (page, x, y) => {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const chunks = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
};

async function open(engine, vimKeys, viewport = { width: 1400, height: 900 }) {
  const browser = await engine.launch();
  const context = await browser.newContext({ viewport });
  context.setDefaultTimeout(4000);
  await signedIn(context, forgeCookie("panel-keys"));
  await context.addInitScript((value) => {
    localStorage.setItem("settings", value);
    localStorage.setItem("settings:product", value);
  }, seed(vimKeys));
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/`);
  await page.waitForFunction(
    () =>
      document.querySelector("dock-desk")?.shadowRoot?.querySelector(".dock.right .panel") &&
      document.querySelector("note-list")?.shadowRoot?.querySelector("li.draft") &&
      // The reader settled on its empty page: a page drawn while it still loads is
      // replaced, and the focus with it.
      document.querySelector("book-reader")?.shadowRoot?.querySelector(".reader .message"),
  );
  return { browser, context, page, problems };
}

for (const engine of ENGINES) {
  // Browser: focus and keys.
  test(`Ctrl+h/l and Ctrl+. move the keyboard between panels and tabs on / in ${engine.name}`, async () => {
    const { browser, context, page, problems } = await open(engine, true);
    try {
      await page.evaluate(() => document.querySelector("book-reader").focus());
      assert.equal((await focused(page)).panel, "book-stage");

      await page.keyboard.press("Control+l");
      await until(async () => (await focused(page)).panel === "list-then-item#notes");
      const notes = await focused(page);
      assert.equal(notes.host, "note-list", "the Notes list holds the keyboard");
      assert.ok(notes.row, "on its roving row");

      await page.keyboard.press("Control+.");
      await until(async () => (await focused(page)).panel === "list-then-item#chats");
      assert.equal(await rightTab(page), "Chats", "the next tab is shown");

      await page.keyboard.press("Control+h");
      await until(async () => (await focused(page)).panel === "book-stage");
      await page.keyboard.press("Control+h");
      await until(async () => (await focused(page)).panel === "list-then-item#books");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  // Browser: focus and keys.
  test(`with Vim keys on the keyboard starts on the stage, so Ctrl+l works at once on / in ${engine.name}`, async () => {
    const { browser, context, page, problems } = await open(engine, true);
    try {
      await until(async () => (await focused(page)).panel === "book-stage");
      await page.keyboard.press("Control+l");
      await until(async () => (await focused(page)).panel === "list-then-item#notes");
      assert.ok((await focused(page)).row, "on the Notes row");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  // Browser: focus and keys.
  test(`with Vim keys off nothing takes the focus at load on / in ${engine.name}`, async () => {
    const { browser, context, page, problems } = await open(engine, false);
    try {
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(await page.evaluate(() => document.activeElement?.localName), "body");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  // Browser: focus and keys.
  test(`with Vim keys off Ctrl+l leaves the keyboard where it is on / in ${engine.name}`, async () => {
    const { browser, context, page, problems } = await open(engine, false);
    try {
      await page.evaluate(() => document.querySelector("book-reader").focus());
      await page.keyboard.press("Control+l");
      await new Promise((r) => setTimeout(r, 150));
      assert.equal((await focused(page)).panel, "book-stage");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  // Safari does not focus a pressed checkbox or button, so the press drops the focus on
  // the page; landing the keyboard on the view then would scroll it to its top before the
  // release, and the click would hit something else. The blur imitates Safari in any engine.
  // Browser: focus and keys.
  test(`with Vim keys on a press that drops the focus keeps the scroll and the click lands on / in ${engine.name}`, async () => {
    const { browser, context, page, problems } = await open(engine, true, { width: 1280, height: 520 });
    try {
      const sheet = page.locator("settings-sheet");
      await page.locator("dock-desk .controls .pill").first().click();
      // What the chat may read starts folded.
      await sheet.locator(".tools summary").click();
      const box = sheet.locator(".tools input[type=checkbox]").last();
      await box.scrollIntoViewIfNeeded();
      const scrolled = () => page.evaluate(() => document.querySelector("dock-desk").shadowRoot.querySelector('.body[data-side="stage"]').scrollTop);
      const before = await scrolled();
      assert.ok(before > 0, "the sheet is scrolled down to the box");
      const was = await box.isChecked();
      const at = await box.boundingBox();
      await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
      await page.mouse.down();
      await page.evaluate(() => {
        let a = document.activeElement;
        while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
        a?.blur();
      });
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(await scrolled(), before, "nothing scrolls between press and release");
      await page.mouse.up();
      await until(async () => (await box.isChecked()) !== was);
      await until(() => box.evaluate((el) => el.getRootNode().activeElement === el));
      assert.equal(await scrolled(), before, "the sheet stays where it was");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  // Browser: rendering and layout.
  test(`with Vim keys off no group is framed, and turning them on frames the keyboard's group at once on / in ${engine.name}`, async () => {
    const { browser, context, page, problems } = await open(engine, false);
    try {
      await page.evaluate(() => document.querySelector("book-reader").focus());
      await new Promise((r) => setTimeout(r, 150));
      assert.equal((await focused(page)).panel, "book-stage");
      assert.deepEqual(await framed(page), [], "nothing is framed with Vim keys off");
      await editSettings(page, true);
      await until(async () => JSON.stringify(await framed(page)) === JSON.stringify(["stage"]));
      await editSettings(page, false);
      await until(async () => JSON.stringify(await framed(page)) === "[]");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  // A view's positioned content, such as a picture at the top of the Reader's page, paints
  // above anything the desk draws as the body's own outline; the frame must stay on top.
  // Browser: rendering and layout.
  test(`the frame is drawn above what the view paints at its edge on / in ${engine.name}`, async () => {
    const { browser, context, page, problems } = await open(engine, true);
    try {
      await until(async () => JSON.stringify(await framed(page)) === JSON.stringify(["stage"]));
      // An opaque positioned box across the top of the Reader, where a picture at the top
      // of a page sits.
      await page.evaluate(() => {
        const box = document.createElement("div");
        box.style.cssText = "position: absolute; inset: 0 0 auto 0; height: 3rem; background: rgb(0, 0, 255); z-index: 1";
        document.querySelector("book-reader").shadowRoot.querySelector(".reader").append(box);
      });
      const at = await page.evaluate(() => {
        const frame = document.querySelector("dock-desk").shadowRoot.querySelector('.body[data-side="stage"]').parentElement;
        const r = frame.getBoundingClientRect();
        const color = getComputedStyle(frame, "::after").borderTopColor;
        return { x: Math.round(r.left + r.width / 2), y: Math.floor(r.top), color: color.match(/\d+/g).slice(0, 3).map(Number) };
      });
      const [r, g, b] = await pixel(page, at.x, at.y);
      const near = (c, w) => Math.abs(c - w) <= 8;
      assert.ok(near(r, at.color[0]) && near(g, at.color[1]) && near(b, at.color[2]), `the frame's top edge shows rgb(${r}, ${g}, ${b}), not the accent rgb(${at.color.join(", ")})`);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}

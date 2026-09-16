import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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

// The console lines trace prints (section 10): the round trip the editor and the
// fact make through the bus, proof the stem is wired, not just rendered.
const SAVED = /event note\.saved note-editor → notes delivered/;
// note.changed now reaches both the editor and the list, so the recipient list is
// no longer just note-editor; match it wherever it sits among the recipients.
const CHANGED = /event note\.changed notes → .*\bnote-editor\b.* delivered/;
// The list ↔ editor round trip (6.4): the editor announces the note it shows, the
// list announces the note the user picked.
const OPENED = /event note\.opened note-editor → note-list delivered/;
const SELECTED = /event note\.selected note-list → note-editor delivered/;
// A note deleted: the list announces the gesture on elapse, and notes announces the
// note gone (to the list, and to the editor when it was showing it).
const DISCARDED = /event note\.discarded note-list → notes delivered/;
const DELETED = /event note\.deleted notes → .*\bnote-list\b.* delivered/;

// The list's own shadow, read as the user sees it: each row's title and whether it
// is the highlighted (open) one.
const listRows = (page) =>
  page.evaluate(() =>
    [...document.querySelector("note-list").shadowRoot.querySelectorAll(".row")].map((r) => ({
      title: r.querySelector(".name").textContent.trim(),
      subtitle: r.querySelector(".subtitle")?.textContent.trim() ?? null,
      selected: r.getAttribute("aria-selected") === "true",
    })),
  );
const clickRow = (page, title) =>
  page.evaluate((title) => {
    [...document.querySelector("note-list").shadowRoot.querySelectorAll(".row")]
      .find((r) => r.querySelector(".name").textContent.trim() === title)
      ?.click();
  }, title);
const editorStatus = (page) => page.locator("note-editor .status").textContent();
const editorBody = (page) => page.locator("note-editor textarea").inputValue();
// Type a note and commit it: a blur saves at once (4.3), no throttle wait needed.
const write = (page, text) =>
  page.evaluate((t) => {
    const ta = document.querySelector("note-editor").shadowRoot.querySelector("textarea");
    ta.value = t;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("blur"));
  }, text);

// One row's delete-related state, read as the user sees it, addressed by its title.
const listState = (page, title) =>
  page.evaluate((title) => {
    const root = document.querySelector("note-list").shadowRoot;
    const row = [...root.querySelectorAll(".row")].find((r) => r.querySelector(".name")?.textContent.trim() === title);
    if (!row) return { present: false };
    const bin = row.querySelector(".bin");
    return {
      present: true,
      discarding: row.classList.contains("discarding"),
      hasUndo: Boolean(row.querySelector(".undo")),
      binVisible: bin ? getComputedStyle(bin).visibility === "visible" : false,
    };
  }, title);
const clickBin = (page, title) =>
  page.evaluate((title) => {
    const root = document.querySelector("note-list").shadowRoot;
    [...root.querySelectorAll(".row")]
      .find((r) => r.querySelector(".name")?.textContent.trim() === title)
      ?.querySelector(".bin")
      ?.click();
  }, title);
const clickUndo = (page, title) =>
  page.evaluate((title) => {
    const root = document.querySelector("note-list").shadowRoot;
    [...root.querySelectorAll(".row")]
      .find((r) => r.querySelector(".name")?.textContent.trim() === title)
      ?.querySelector(".undo")
      ?.click();
  }, title);
// Set a short undo window and remount the list so the actor reads the new value
// (--duration-undo is read once, at mount); the note itself is kept by the fact.
const shortUndo = (page, ms = 150) =>
  page.evaluate((ms) => {
    const el = document.querySelector("note-list");
    el.style.setProperty("--duration-undo", `${ms}ms`);
    const parent = el.parentNode;
    const next = el.nextSibling;
    el.remove();
    parent.insertBefore(el, next);
  }, ms);
// A left swipe on a row, synthesised as a mouse drag (which fires pointer events):
// press near the trailing edge and drag left past the delete threshold.
const swipeRow = async (page, title) => {
  const box = await page.locator("note-list .row", { hasText: title }).boundingBox();
  const cy = box.y + box.height / 2;
  const startX = box.x + box.width * 0.8;
  await page.mouse.move(startX, cy);
  await page.mouse.down();
  await page.mouse.move(startX - box.width * 0.5, cy, { steps: 10 });
  await page.mouse.up();
};

async function until(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

function watch(page, problems) {
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
}

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  test(`the note-editor saves through the notes fact in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    try {
      const problems = [];
      const debug = [];
      const page = await context.newPage();
      watch(page, problems);
      page.on("console", (msg) => {
        if (msg.type() === "debug") debug.push(msg.text());
      });

      await page.goto(`${BASE_URL}/design/notes`, { waitUntil: "domcontentloaded" });
      const ready = (p) =>
        p.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector("textarea"));
      await ready(page);

      // One text whose first line is the title; a blur saves it at once (4.3), so one
      // note.saved follows, to version 1.
      await page.evaluate(() => {
        const textarea = document.querySelector("note-editor").shadowRoot.querySelector("textarea");
        textarea.value = "A note\nits body";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("blur"));
      });

      await until(() => debug.some((l) => SAVED.test(l)) && debug.some((l) => CHANGED.test(l)));
      await until(async () => (await page.locator("note-editor .status").textContent())?.trim() === "Saved");

      // Persistence: the fact wrote through the store to IndexedDB (5), not just to
      // its in-memory Map. Read the raw database the store opened.
      const records = await page.evaluate(
        () =>
          new Promise((res, rej) => {
            const open = indexedDB.open("notes");
            open.onerror = () => rej(open.error);
            open.onsuccess = () => {
              const all = open.result.transaction("notes", "readonly").objectStore("notes").getAll();
              all.onsuccess = () => res(all.result);
              all.onerror = () => rej(all.error);
            };
          }),
      );
      assert.equal(records.length, 1);
      assert.equal(records[0].title, "A note");
      assert.equal(records[0].body, "A note\nits body");
      assert.equal(records[0].version, 1);

      // A reload continues where the user left off: the editor asks notes: list on
      // start and reopens the newest note from the store.
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready(page);
      await until(async () => (await page.locator("note-editor .status").textContent())?.trim() === "Saved");
      assert.equal(await page.locator("note-editor textarea").inputValue(), "A note\nits body");

      // Height (the editor's one attribute): in content mode the body grows with its
      // lines; in neither mode does it grow past the viewport, so the status stays in
      // view and the page does not scroll. The page declares fill, so content is set.
      const measure = () =>
        page.evaluate(() => {
          const root = document.querySelector("note-editor").shadowRoot;
          const status = root.querySelector(".status").getBoundingClientRect();
          return {
            textarea: root.querySelector("textarea").getBoundingClientRect().height,
            statusInView: status.bottom <= innerHeight,
            pageScrolls: document.documentElement.scrollHeight > innerHeight + 1,
          };
        });
      const type = (text) =>
        page.evaluate((t) => {
          const textarea = document.querySelector("note-editor").shadowRoot.querySelector("textarea");
          textarea.value = t;
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }, text);
      await page.evaluate(() => document.querySelector("note-editor").setAttribute("height", "content"));
      const short = await measure();
      await type(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"));
      const grown = await measure();
      assert.ok(grown.textarea > short.textarea, "content mode grows with the lines");
      await type(Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n"));
      for (const mode of ["content", "fill"]) {
        await page.evaluate((m) => document.querySelector("note-editor").setAttribute("height", m), mode);
        const long = await measure();
        assert.ok(long.statusInView, `${mode}: the status line stays in view`);
        assert.equal(long.pageScrolls, false, `${mode}: the page does not scroll`);
      }

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);

      // Phone: a fresh page of the same context that chose the phone preview before
      // load, so the editor is measured inside the narrowed body. It must not
      // overflow its own box sideways.
      const phone = await context.newPage();
      watch(phone, problems);
      await phone.addInitScript(() => localStorage.setItem("viewport", "phone"));
      await phone.goto(`${BASE_URL}/design/notes`, { waitUntil: "domcontentloaded" });
      await ready(phone);
      await phone.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      const fits = await phone.evaluate(() => {
        const el = document.querySelector("note-editor");
        return el.scrollWidth <= el.clientWidth + 1;
      });
      assert.ok(fits, "the editor must not overflow sideways on the phone");
      mkdirSync(SCREENSHOTS, { recursive: true });
      await phone.screenshot({ path: resolve(SCREENSHOTS, `notes-phone-${engine.name}.png`) });

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  test(`the note-list highlights the open note and drives the editor in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    try {
      const problems = [];
      const debug = [];
      const page = await context.newPage();
      watch(page, problems);
      page.on("console", (msg) => {
        if (msg.type() === "debug") debug.push(msg.text());
      });

      await page.goto(`${BASE_URL}/design/notes`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document.querySelector("note-editor")?.shadowRoot?.querySelector("textarea") &&
          document.querySelector("note-list")?.shadowRoot,
      );

      // The list opens with the next-note row and nothing else (the blank page on
      // top of the pad), and it is not selected until something is opened.
      await until(async () => {
        const rows = await listRows(page);
        return rows.length === 1 && rows[0].title === "New note" && !rows[0].selected;
      });
      // The next-note row is one centred line, not a note with a second line: it has
      // no subtitle, and its height matches a note row (asserted below).
      assert.equal((await listRows(page)).find((r) => r.title === "New note")?.subtitle, null);

      // The first keystroke mints an id and the editor announces it (note.opened);
      // the list gains that row and highlights it, since the highlighted row is
      // whatever the editor is showing (6.4), never the list's own choice.
      await write(page, "First\nbody");
      await until(async () => (await listRows(page)).some((r) => r.title === "First" && r.selected));
      await until(() => debug.some((l) => OPENED.test(l)));
      // The row shows the note's second line as a Notes.app-style subtitle.
      assert.equal((await listRows(page)).find((r) => r.title === "First")?.subtitle, "body");

      // Picking the next-note row opens a blank editor under a note not yet written.
      await clickRow(page, "New note");
      await until(async () => (await editorStatus(page))?.trim() === "New note");
      assert.equal(await editorBody(page), "", "the editor is empty for a new note");
      await until(async () => (await listRows(page)).some((r) => r.title === "New note" && r.selected));

      // Typing turns the next-note row into a real note and a fresh next-note row
      // takes its place on top: the real note is highlighted, the new one is not.
      await write(page, "Second\nx");
      await until(async () => {
        const rows = await listRows(page);
        return (
          rows[0]?.title === "New note" &&
          !rows[0].selected &&
          rows[1]?.title === "Second" &&
          rows[1].selected
        );
      });

      // The next-note row is the same height as a note row, so the list does not jump
      // as the top row turns from the next-note affordance into a real note.
      const heights = await page.evaluate(() => {
        const rows = [...document.querySelector("note-list").shadowRoot.querySelectorAll(".row")];
        return { draft: Math.round(rows[0].getBoundingClientRect().height), note: Math.round(rows[1].getBoundingClientRect().height) };
      });
      assert.ok(
        Math.abs(heights.draft - heights.note) <= 1,
        `the next-note row matches a note row, saw ${heights.draft} vs ${heights.note}`,
      );

      // Selecting the next-note row and leaving without typing writes no note: the
      // editor holds no note until a keystroke, so no empty row is ever created.
      await clickRow(page, "New note");
      await until(async () => (await editorStatus(page))?.trim() === "New note");
      const rowsBefore = (await listRows(page)).length;
      await clickRow(page, "First");
      await until(async () => (await editorBody(page)) === "First\nbody");
      assert.equal((await listRows(page)).length, rowsBefore, "no empty note was created");
      assert.equal(
        (await listRows(page)).filter((r) => r.title === "New note").length,
        1,
        "exactly one next-note row",
      );
      assert.ok(!(await listRows(page)).some((r) => r.title === "Untitled"), "no untitled ghost row");

      // The older row is loaded into the editor and holds the highlight; the list
      // announced the pick (note.selected), the editor consumed it.
      await clickRow(page, "First");
      await until(() => debug.some((l) => SELECTED.test(l)));
      await until(async () => (await editorBody(page)) === "First\nbody");
      await until(async () => {
        const rows = await listRows(page);
        return rows.find((r) => r.title === "First")?.selected && !rows.find((r) => r.title === "Second")?.selected;
      });

      // Keyboard: pick Second so the roving focus sits there, then ArrowDown moves
      // it to the next row and Enter selects that one (First).
      await clickRow(page, "Second");
      await until(async () => (await editorBody(page)) === "Second\nx");
      // The roving focus sits on the picked row (Second) before any key is pressed.
      await page.waitForFunction(() => {
        const r = document.querySelector("note-list").shadowRoot.querySelector('.row[tabindex="0"]');
        return r && r.querySelector(".name").textContent.trim() === "Second";
      });
      await page.evaluate(() =>
        document.querySelector("note-list").shadowRoot.querySelector('.row[tabindex="0"]').focus(),
      );
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await until(async () => (await editorBody(page)) === "First\nbody");
      assert.ok((await listRows(page)).find((r) => r.title === "First")?.selected, "Enter selected the next row");

      // The list title stays live as the user types (item 3, 4.3 third rule): a
      // throttle saves within a typing run, so a save lands mid-run and the row shows
      // the title before the typing ends, note.saved already in the trace. Typing char
      // by char without a blur, over a run longer than the throttle window, is the
      // load-proof discriminator — a wall-clock bound is not, on this small VPS.
      const live = "A live headline";
      await page.locator("note-editor textarea").fill("");
      const before = debug.length;
      await page.locator("note-editor textarea").focus();
      await page.keyboard.type(live, { delay: 60 });
      // Measured at the last keystroke, before any settling wait: only the throttle
      // has saved by now.
      const savedDuringRun = debug.slice(before).filter((l) => SAVED.test(l)).length;
      await until(async () => (await listRows(page)).some((r) => r.title === live && r.selected));
      assert.ok(savedDuringRun >= 1, `the throttle saved during the typing run, saw ${savedDuringRun}`);

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  test(`the notes app composes the list and editor in a dock-desk in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    try {
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.goto(`${BASE_URL}/apps/notes`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelector("dock-desk")?.shadowRoot?.querySelector(".stage"));

      // The three views are the desk's children (8): the page composes, dock-desk
      // lays out.
      const children = await page.evaluate(() =>
        [...document.querySelector("dock-desk").children].map((c) => c.localName),
      );
      assert.ok(
        ["note-editor", "note-list"].every((n) => children.includes(n)),
        "editor and list are dock-desk children",
      );

      // Editor is the stage tab; Notes seeds onto the left dock (the page's side="left",
      // §6.4), the default a fresh desk shows before any user arrangement.
      const tabs = await page.evaluate(() =>
        [...document.querySelector("dock-desk").shadowRoot.querySelectorAll('.stage [role="tab"]')].map((b) =>
          b.textContent.trim(),
        ),
      );
      assert.deepEqual(tabs, ["Editor"]);
      const notesDock = await page.evaluate(() => {
        const root = document.querySelector("dock-desk").shadowRoot;
        const aside = root.querySelector('slot[name="note-list"]')?.closest("aside.dock");
        return aside ? [...aside.classList].find((c) => ["left", "right", "bottom"].includes(c)) : null;
      });
      assert.equal(notesDock, "left", "Notes seeds onto the left dock");

      // The editor is the shown stage tab; its status line proves it has rendered.
      await page.waitForFunction(
        () => document.querySelector("note-editor")?.shadowRoot?.querySelector(".status"),
      );
      // A group's body is a flex column (fix 2), so height="fill" fills it: the editor
      // host is as tall as the stage body and its status sits at the body's bottom,
      // within one --space-md (16px), not stranded under the first line.
      const fill = await page.evaluate(() => {
        const desk = document.querySelector("dock-desk");
        const body = desk.shadowRoot.querySelector('.body[data-side="stage"]').getBoundingClientRect();
        const editor = document.querySelector("note-editor");
        const host = editor.getBoundingClientRect();
        const status = editor.shadowRoot.querySelector(".status").getBoundingClientRect();
        return { bodyH: body.height, hostH: host.height, gap: body.bottom - status.bottom };
      });
      assert.ok(Math.abs(fill.hostH - fill.bodyH) <= 1, `the editor fills the stage body, saw ${fill.hostH} vs ${fill.bodyH}`);
      assert.ok(fill.gap >= -1 && fill.gap <= 16, `the status sits at the body's bottom, gap ${fill.gap}px`);

      // note-list carries no chrome of its own: the frame names it, and creating a
      // note is the first row, not a title, a band, or a button.
      const listChrome = await page.evaluate(() => {
        const root = document.querySelector("note-list").shadowRoot;
        return {
          hasTitle: Boolean(root.querySelector(".title")),
          hasHead: Boolean(root.querySelector(".head")),
          // Row actions (the trash) are row content; the list has no chrome of its own.
          chromeButtons: [...root.querySelectorAll("button")].filter((b) => !b.closest(".row")).length,
          firstRow: root.querySelector(".row .name")?.textContent.trim() ?? null,
        };
      });
      assert.equal(listChrome.hasTitle, false, "the list carries no title of its own");
      assert.equal(listChrome.hasHead, false, "the list carries no head band");
      assert.equal(listChrome.chromeButtons, 0, "the list has no chrome buttons of its own");
      assert.equal(listChrome.firstRow, "New note", "the first row is the next note");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  test(`a hidden tab drains the outbox at once when signed in, in ${engine.name}`, async () => {
    const browser = await engine.launch();
    // Sign in without a passkey ceremony: forge the session cookie the server would
    // set (as api.test.mjs does), so notes syncs. A fresh user per run gets its own
    // throwaway per-user database (5).
    const SECRET = process.env.SESSION_SECRET;
    assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
    const userId = `notes-page-${Date.now()}`;
    const cookie = `${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    await context.addCookies([{ name: "unblent_session", value: cookie, url: BASE_URL }]);
    try {
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      // Record every request the page made, with the keepalive flag, before it flies.
      await page.addInitScript(() => {
        window.__fetches = [];
        const real = window.fetch;
        window.fetch = (url, init) => {
          window.__fetches.push({ url: String(url), method: init?.method ?? "GET", keepalive: Boolean(init?.keepalive) });
          return real(url, init);
        };
      });

      await page.goto(`${BASE_URL}/apps/notes`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector("textarea"));
      // Signing in pulls at once (5): wait for that GET so the fact is signed in.
      await until(() => page.evaluate(() => window.__fetches.some((f) => /\/api\/notes\?since=/.test(f.url))));

      const puts = () => page.evaluate(() => window.__fetches.filter((f) => f.method === "PUT" && /\/api\/notes\//.test(f.url)));
      const gets = () => page.evaluate(() => window.__fetches.filter((f) => f.method === "GET" && /\/api\/notes\?since=/.test(f.url)));
      assert.equal((await puts()).length, 0, "no PUT yet");
      const getsBefore = (await gets()).length;

      // A save (blur commits it at once), then the tab goes hidden inside the idle
      // window: the drain must fire now, not 2 s later, and use keepalive.
      await write(page, "Hidden\ndrain");
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await until(async () => (await puts()).length >= 1);
      const afterHidden = await puts();
      assert.equal(afterHidden.length, 1, "the hidden tab drained the outbox at once");
      assert.equal(afterHidden[0].keepalive, true, "the drain used keepalive so it survives the tab");
      assert.equal((await gets()).length, getsBefore, "a hidden-tab drain does not pull");

      // Coming back to the front pulls again (5).
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await until(async () => (await gets()).length > getsBefore);

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  // The deletion gestures share one browser per engine: the launch is the costly part
  // on a small host, so a fresh page per test keeps each isolated without paying for a
  // new browser each time. The suite's own timeout must exceed the sum of its tests
  // (each still bounded at the run's per-test timeout); otherwise the suite itself
  // times out and fails every test in it.
  describe(`deleting a note in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    let context;
    // Launching a browser can take several seconds on a small host; give the hook its
    // own room so a slow launch never eats a test's budget.
    before(async () => {
      browser = await engine.launch();
      context = await browser.newContext();
      context.setDefaultTimeout(4000);
    }, { timeout: 30000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    const open = async (opts = {}) => {
      const problems = [];
      const debug = [];
      const page = await context.newPage();
      watch(page, problems);
      page.on("console", (msg) => msg.type() === "debug" && debug.push(msg.text()));
      if (opts.phone) await page.addInitScript(() => localStorage.setItem("viewport", "phone"));
      await page.goto(`${BASE_URL}/design/notes`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document.querySelector("note-editor")?.shadowRoot?.querySelector("textarea") &&
          document.querySelector("note-list")?.shadowRoot,
      );
      if (opts.phone) await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      return { page, problems, debug };
    };

    test("the trash starts an undoable delete", async () => {
      const { page, problems, debug } = await open();
      await write(page, "First\nbody");
      await until(async () => (await listState(page, "First")).present);

      // The trash is a signifier shown on hover, not a standing column (Norman).
      await page.locator("note-list .row", { hasText: "First" }).hover();
      await until(async () => (await listState(page, "First")).binVisible);

      // Clicking it turns the row into its own undo: struck through, an Undo button,
      // and a draining bar. Nothing is a fact yet (the default window is long).
      await clickBin(page, "First");
      await until(async () => {
        const s = await listState(page, "First");
        return s.discarding && s.hasUndo;
      });

      // Undo brings it straight back, and no note.discarded was ever emitted.
      await clickUndo(page, "First");
      await until(async () => !(await listState(page, "First")).discarding);
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(!debug.some((l) => DISCARDED.test(l)), "undo emits no discard");
      assert.equal((await listState(page, "First")).present, true, "the note is still there");
      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
    });

    test("a delete commits when its window ends and stays gone", async () => {
      const { page, problems, debug } = await open();
      await write(page, "First\nbody");
      await until(async () => (await listState(page, "First")).present);

      // A short window, so the bar drains at once and the delete becomes a fact.
      await shortUndo(page);
      await until(async () => (await listState(page, "First")).present);
      await clickBin(page, "First");
      await until(() => debug.some((l) => DISCARDED.test(l)) && debug.some((l) => DELETED.test(l)));
      await until(async () => !(await listState(page, "First")).present);
      await until(async () => (await editorStatus(page))?.trim() === "New note");

      // The tombstone is durable: marked deleted in IndexedDB, and after a reload the
      // note does not come back (5).
      const record = await page.evaluate(
        () =>
          new Promise((res, rej) => {
            const req = indexedDB.open("notes");
            req.onerror = () => rej(req.error);
            req.onsuccess = () => {
              const all = req.result.transaction("notes", "readonly").objectStore("notes").getAll();
              all.onsuccess = () => res(all.result);
            };
          }),
      );
      assert.equal(record.length, 1);
      assert.equal(record[0].deleted, true, "the note is a tombstone, not erased");

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("note-list")?.shadowRoot);
      await until(async () => (await listState(page, "New note")).present);
      assert.equal((await listState(page, "First")).present, false, "it stays gone after a reload");
      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
    });

    test("a left swipe deletes a note on the desk", async () => {
      const { page, problems, debug } = await open();
      await write(page, "Swiped\nbody");
      await until(async () => (await listState(page, "Swiped")).present);
      await shortUndo(page);
      await until(async () => (await listState(page, "Swiped")).present);
      await swipeRow(page, "Swiped");
      await until(() => debug.some((l) => DISCARDED.test(l)));
      await until(async () => !(await listState(page, "Swiped")).present);
      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
    });

    test("a left swipe deletes a note on the phone", async () => {
      // The phone has no hover, so the swipe is the delete there.
      const { page, problems } = await open({ phone: true });
      await write(page, "Touch\nbody");
      await until(async () => (await listState(page, "Touch")).present);
      await swipeRow(page, "Touch");
      await until(async () => (await listState(page, "Touch")).discarding);
      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
    });
  });
}

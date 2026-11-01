import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The reader's highlights on the subject stem page: one journey (9), approved in
// checks/journeys.json. One account with the sample book open and nothing else; the page
// loads once. A drag makes the one highlight every later step reads, the bubble removes it
// with Undo, and a removal that outlasts its window stays gone after a reload. Which notes the list
// shows and which the editor opens as the stage moves are note-list's bus test.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, journey, until, forgeCookie, signedIn, shortUndo } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub");
const PAGE = `${BASE_URL}/workshop/design/subject`;
const BOOK = "01K00000000000000000000BK1";

// Long enough to click Undo inside, short enough that a removal that runs it out costs
// the step a second.
const UNDO_MS = 1000;

// A reload aborts whatever pull was in flight (WebKit: "Load request cancelled", Chromium:
// "net::ERR_ABORTED"), and WebKit sometimes reports that abort again as a page error naming
// "access control checks"; both are navigation, not a fault. A real failure keeps its own
// text, and a 4xx/5xx is still caught.
function watch(page, problems) {
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    if (/due to access control checks/.test(err.message)) return;
    problems.push(`page error: ${err.message}`);
  });
  page.on("requestfailed", (req) => {
    const err = req.failure()?.errorText ?? "";
    if (/cancelled|ERR_ABORTED/i.test(err)) return;
    problems.push(`request failed: ${req.url()} ${err}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
  return problems;
}

const ready = (page) =>
  page.waitForFunction(
    () =>
      document.querySelector("dock-desk")?.shadowRoot?.querySelector(".stage") &&
      document.querySelector("book-reader")?.shadowRoot &&
      document.querySelector("note-list")?.shadowRoot &&
      document.querySelector("note-editor")?.shadowRoot,
  );

// A user set up straight through the server (5): the sample book imported and open.
const seedUser = async (name) => {
  const cookie = forgeCookie(`subject-${name}`);
  const put = async (path, type, body) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
    assert.equal(res.status, 200, `PUT ${path}`);
  };
  await put(`/api/books/${BOOK}`, "application/epub+zip", readFileSync(SAMPLE));
  await put(`/api/books/${BOOK}/opened`, "application/json", "{}");
  return cookie;
};

// The notes the server actually holds for this signed-in user, read from the page so the
// request carries the session cookie. Proves a write reached the server, not only the cache.
const serverNotes = (page) =>
  page.evaluate(async () => {
    const res = await fetch("/api/notes");
    if (!res.ok) throw new Error(`list ${res.status}`);
    return (await res.json()).notes;
  });

// Nudge `notes` to sync now instead of after its idle window: it drains the outbox on a
// visibilitychange (fact.js). Until the server holds what `holds` looks for, nudging on every
// look: a save lands a moment after it shows, and a nudge before it finds an empty outbox.
const drain = (page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
const synced = (page, holds, timeout = 3500) =>
  until(async () => {
    await drain(page);
    return holds(await serverNotes(page));
  }, timeout);
const placed = (n) => (n.about ?? []).some((l) => l.place);

// The client rect of a short run of text in the first roomy paragraph, to drag across.
const dragRect = (page) =>
  page.evaluate(() => {
    const strip = document.querySelector("book-reader").shadowRoot.querySelector(".strip");
    const block = [...strip.children].find((el) => el.textContent.trim().split(/\s+/).length >= 4);
    const tn = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.setStart(tn, 2);
    range.setEnd(tn, Math.min(tn.data.length, 12));
    const r = range.getBoundingClientRect();
    return { x1: r.left + 1, x2: r.right - 1, y: r.top + r.height / 2 };
  });

// A synthetic mouse drag across the text: the highlight gesture (D3).
const dragOver = async (page) => {
  const r = await dragRect(page);
  await page.mouse.move(r.x1, r.y);
  await page.mouse.down();
  await page.mouse.move((r.x1 + r.x2) / 2, r.y, { steps: 5 });
  await page.mouse.move(r.x2, r.y, { steps: 5 });
  await page.mouse.up();
};

// A mark opens its bubble on a real mouse click (its #pointerup), so the click goes through
// the mouse at the mark's centre, not mark.click() (which fires no pointer events).
const clickFirstMark = async (page) => {
  const box = await page.evaluate(() => {
    const m = document.querySelector("book-reader").shadowRoot.querySelector(".strip mark");
    const r = m.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
};
const clickBubble = (page, sel) =>
  page.evaluate((s) => document.querySelector("book-reader").shadowRoot.querySelector(`.bubble ${s}`)?.click(), sel);

// Bring a view to the front of the stage: its stage tab when it is already on the stage,
// else the desk's "Return <label> to the stage" action (shown while the desk is being
// arranged; workshop arranges by default).
const toStage = (page, label) =>
  page.evaluate((label) => {
    const desk = document.querySelector("dock-desk").shadowRoot;
    const tab = [...desk.querySelectorAll('.stage [role="tab"]')].find((t) => t.textContent.trim() === label);
    const back = [...desk.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === `Return ${label} to the stage`);
    (tab ?? back)?.click();
  }, label);

// What the user sees of the reader and the Notes pair, read in one go.
const look = ({ page }) =>
  page.evaluate(() => {
    const reader = document.querySelector("book-reader")?.shadowRoot;
    const strip = reader?.querySelector(".strip");
    const list = document.querySelector("note-list")?.shadowRoot;
    const pair = document.querySelector("list-then-item#notes")?.shadowRoot;
    return {
      // The reader's first chapter has laid out enough text to drag over.
      text: Boolean(strip && strip.children.length && strip.textContent.trim().length > 20),
      pageno: reader?.querySelector(".pageno")?.textContent ?? "",
      marks: [...(strip?.querySelectorAll("mark") ?? [])].map((m) => m.textContent),
      bubble: reader?.querySelector(".bubble")?.textContent.replace(/\s+/g, " ").trim() ?? null,
      // The titles the list shows (the draft and the apart row excluded).
      titles: [...(list?.querySelectorAll(".row:not(.draft):not(.apart)") ?? [])].map((r) =>
        r.querySelector(".name").textContent.trim(),
      ),
      // What the Notes pair has assigned to its slot.
      notes: pair?.querySelector("slot")?.assignedElements().map((el) => el.localName) ?? [],
      staged:
        document.querySelector("dock-desk")?.shadowRoot?.querySelector('.stage [role="tab"][aria-selected="true"]')?.textContent.trim() ?? null,
    };
  });

// The Reader shows its open book as a tab of its own, named by the book's title.
const TITLE = "Sample Book";

const want = (cond, msg) => (cond ? null : msg);
const all = (...checks) => checks.find(Boolean) ?? null;
const sameSet = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

// Make the one highlight the later steps read, on the freshly loaded book.
const highlight = async (v) => {
  await v.see((s) => want(s.text, "the reader shows no text yet"));
  await dragOver(v.page);
  await v.see((s) => want(s.marks.length > 0, "no highlight is painted"));
};

// The book on the stage holds one highlight, its bubble closed, and Notes shows its list.
const oneHighlight = {
  state: "one highlight painted on the staged book and Notes showing its list",
  check: (s) =>
    all(
      want(s.staged === TITLE, `the stage shows ${s.staged}, not ${TITLE}`),
      want(s.marks.length > 0, "no highlight is painted"),
      want(s.notes.includes("note-list"), `Notes shows ${s.notes}, not its list`),
    ),
  reach: highlight,
};

for (const engine of ENGINES) {
  // Browser: a gesture.
  test(`the reader's highlights in ${engine.name}`, ...journey({
    launch: () => engine.launch(),
    open: async (browser) => {
      const context = await browser.newContext();
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, await seedUser(engine.name));
        await shortUndo(context, UNDO_MS);
        const page = await context.newPage();
        const problems = watch(page, []);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await ready(page);
        // The reader's first chapter laid out, so a step can drag over it at once.
        await until(() => look({ page }).then((s) => s.text), 8000);
        return { page, problems, close: () => context.close() };
      } catch (error) {
        await context.close();
        throw error;
      }
    },
    look,
  }, [
    {
      // A drag paints a highlight snapped to whole words; it never moves the text (D4) nor
      // grows the list a row (D2), and a reload paints it again.
      name: "a drag makes a highlight that holds the page count, stays off the list, and survives a reload",
      from: {
        state: "the book open with its text laid out and no highlight",
        check: (s) => all(want(s.text, "the reader shows no text"), want(s.marks.length === 0, "a highlight is already painted")),
        reach: () => {},
      },
      run: async (v) => {
        const before = await v.look();
        await dragOver(v.page);
        const s = await v.see((s) => want(s.marks.length > 0, "no highlight is painted"));
        const text = s.marks.join("");
        assert.ok(text.trim().length > 0, "the mark holds the highlighted text");
        assert.equal(text, text.trim(), "the highlight is snapped, with no surrounding space");
        assert.equal(s.pageno, before.pageno, "the page count is unchanged");
        assert.ok(sameSet(s.titles, before.titles), "the note list shows no new row");

        // The highlight note reaches the server, so the reload is deterministic.
        await synced(v.page, (notes) => notes.some(placed));
        await v.page.reload({ waitUntil: "domcontentloaded" });
        await ready(v.page);
        const back = await v.see((s) => want(s.marks.length > 0, "the highlight is not painted after the reload"));
        assert.equal(back.marks.join(""), text, "the same highlight comes back");
      },
    },
    {
      // A click on a mark opens Copy · Remove; Remove deletes the highlight at once and the
      // short notice's Undo brings it back (12, Undo).
      name: "the notice's Undo brings a removed highlight back",
      from: oneHighlight,
      run: async (v) => {
        await clickFirstMark(v.page);
        await v.see((s) => want(/Copy/.test(s.bubble ?? "") && /Remove/.test(s.bubble ?? ""), `the bubble reads ${s.bubble}`));
        await clickBubble(v.page, ".act.remove");
        await v.see((s) => want(s.marks.length === 0, `${s.marks.length} marks still painted`));
        await v.page.locator("notice-stack .undo").click();
        const s = await v.see((s) => want(s.marks.length > 0, "no mark is painted"));
        assert.ok(s.marks.length > 0, "the highlight is back after undo");
      },
    },
    {
      // Remove: the mark goes at once and the note becomes a
      // tombstone on the server, so a reload pulls it and paints no mark.
      name: "a removed highlight stays gone after a reload",
      from: {
        state: "one highlight on the book",
        check: (s) => want(s.marks.length > 0, "no highlight is painted"),
        reach: highlight,
      },
      run: async (v) => {
        await toStage(v.page, TITLE);
        await v.see((s) => want(s.staged === TITLE && s.marks.length > 0, `the stage shows ${s.staged} with ${s.marks.length} marks`));
        await synced(v.page, (notes) => notes.some(placed));
        await clickFirstMark(v.page);
        await v.see((s) => want(/Remove/.test(s.bubble ?? ""), `the bubble reads ${s.bubble}`));
        await clickBubble(v.page, ".act.remove");
        await v.see((s) => want(s.marks.length === 0, "the highlight is still painted"), UNDO_MS + 1500);
        await synced(v.page, (notes) => notes.some((n) => n.deleted && placed(n)));

        const pulled = v.page.waitForResponse((res) => res.url().includes("/api/notes?since="));
        await v.page.reload({ waitUntil: "domcontentloaded" });
        await ready(v.page);
        await v.see((s) => want(s.text, "the reader shows no text after the reload"));
        // What the pull brought has been announced and painted.
        await pulled;
        await v.page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
        assert.equal((await v.look()).marks.length, 0, "the removed highlight does not come back");
      },
    },
  ]));
}

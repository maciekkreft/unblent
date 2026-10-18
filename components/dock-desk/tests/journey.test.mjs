import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomInt } from "node:crypto";

// The keyboard journey on the product page (plan Revision 1, item 4): the owner's own way
// of using `/` with "Vim keys" on, pressed at a human pace, asserting after every step what
// the user sees. The lists, the chat box, tabs and panels, the focus ring and folding the
// docks are journeys of their own (journey-*.test.mjs); what is left here is the Reader's
// cursor, highlights from the keyboard, and Vim keys off.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub");

// A person's pace: a pause between keys, and a longer one after a key that opens or focuses
// something, so a focus that moves late is seen moving.
// The plan asks ~1.5 s after a focusing key; 1 s is what fits a step or two of it into
// the five-second budget of a test (11) after the page's own load.
const KEY = 300;
const SETTLE = 1000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Ids are ULIDs; the server refuses anything else.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () => {
  let t = Date.now();
  let time = "";
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rest = "";
  for (let i = 0; i < 16; i += 1) rest += CROCKFORD[randomInt(32)];
  return time + rest;
};

const BOOK = "01K00000000000000000000SMP";
const NOTES = ["Note one", "Note two", "Note three"];

// A user set up straight through the server (5): the sample book open, three notes about it,
// and two chats about it.
const seedUser = async () => {
  const cookie = forgeCookie("journey");
  const put = async (path, type, body) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
    assert.equal(res.status, 200, `PUT ${path}`);
  };
  const json = (path, body) => put(path, "application/json", JSON.stringify(body));
  await put(`/api/books/${BOOK}`, "application/epub+zip", readFileSync(SAMPLE));
  await json(`/api/books/${BOOK}/opened`, {});
  for (const [k, title] of NOTES.entries()) {
    await json(`/api/notes/${ulid()}`, { title, body: `${title} body ${k}`, baseVersion: null, about: [{ kind: "book", id: BOOK }] });
    await pause(5);
  }
  for (const k of [1, 2]) {
    const turns = [
      { id: ulid(), role: "user", text: `question ${k}` },
      { id: ulid(), role: "assistant", text: `answer ${k}`, status: "done" },
    ];
    await json(`/api/conversations/${ulid()}`, { title: `Chat ${k}`, about: [{ kind: "book", id: BOOK }], start: "", turns });
  }
  return cookie;
};

// The "Vim keys" preference (12) in both profiles' copies, the way settings stores it.
const seed = (vimKeys) =>
  JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });

// Everything the user can see that the journey asserts on, read in one go.
const look = (page) =>
  page.evaluate(async () => {
    // A page turn in progress: the Reader's cursor is placed on its letter once the slide
    // has settled (it says so by dropping data-sliding), so what is read is the page the
    // user is left looking at, not a frame of the slide.
    const box = () => document.querySelector("book-reader")?.shadowRoot?.querySelector(".cursor");
    for (const t0 = performance.now(); box()?.hasAttribute("data-sliding") && performance.now() - t0 < 1000; ) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    const chain = [];
    let el = document.activeElement;
    while (el) {
      chain.push(el.localName + (el.id ? `#${el.id}` : "") + (el.dataset?.id ? `[${el.dataset.id}]` : ""));
      el = el.shadowRoot?.activeElement ?? null;
    }
    let deep = document.activeElement;
    while (deep?.shadowRoot?.activeElement) deep = deep.shadowRoot.activeElement;
    const shows = (id) => {
      const lti = document.getElementById(id);
      return [...(lti?.children ?? [])].find((c) => c.assignedSlot)?.localName ?? null;
    };
    const desk = document.querySelector("dock-desk").shadowRoot;
    const tab = (sel) => desk.querySelector(`${sel} [role="tab"][aria-selected="true"]`)?.textContent.trim() ?? null;
    const folded = (side) => {
      const dock = desk.querySelector(`aside.dock.${side}`);
      return dock ? dock.classList.contains("folded") : null;
    };
    // The text typed into a CodeMirror editor, its placeholder left out.
    const cm = (tag) => {
      const content = document.querySelector(tag)?.shadowRoot?.querySelector(".cm-content");
      if (!content) return null;
      return [...content.querySelectorAll(".cm-line")]
        .map((line) => [...line.childNodes].filter((n) => !n.classList?.contains("cm-placeholder")).map((n) => n.textContent).join(""))
        .join("\n");
    };
    const reader = document.querySelector("book-reader").shadowRoot;
    const strip = reader.querySelector(".strip");
    const flat = (t) => t.replace(/\s+/g, " ");
    // The reader's cursor: the block drawn over one character, which names its place. "at"
    // is the text from it to the end of its block; "off" how far the block's box is from
    // that character's own box, in pixels, so a cursor drawn late or in the old place shows.
    const cursorAt = () => {
      const el = reader.querySelector(".cursor");
      if (!el || el.hidden || !strip) return null;
      const block = strip.children[Number(el.dataset.block)];
      let left = Number(el.dataset.offset);
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && left >= node.data.length) {
        left -= node.data.length;
        node = walker.nextNode();
      }
      if (!node) return { text: null, at: null, off: Infinity };
      const ch = document.createRange();
      ch.setStart(node, left);
      ch.setEnd(node, left + 1);
      const want = [...ch.getClientRects()].find((r) => r.width > 0 || r.height > 0) ?? ch.getBoundingClientRect();
      const got = el.getBoundingClientRect();
      const rest = document.createRange();
      rest.setStart(node, left);
      rest.setEnd(block, block.childNodes.length);
      const off = Math.max(Math.abs(got.left - want.left), Math.abs(got.top - want.top), Math.abs(got.width - want.width), Math.abs(got.height - want.height));
      return { text: ch.toString(), at: flat(rest.toString()).slice(0, 24), off: Math.round(off * 10) / 10 };
    };
    // The passage in progress, painted through the CSS Custom Highlight API.
    const painted = (name) => {
      const range = globalThis.CSS?.highlights?.get(name)?.values().next().value;
      if (!range) return null;
      let block = range.startContainer;
      while (block && !block.parentNode?.classList?.contains("strip")) block = block.parentNode;
      const rest = document.createRange();
      rest.setStart(range.startContainer, range.startOffset);
      if (block) rest.setEnd(block, block.childNodes.length);
      return { text: flat(range.toString()), at: flat(rest.toString()).slice(0, 24) };
    };
    const rows = [...(document.querySelector("note-list")?.shadowRoot?.querySelectorAll("li.row") ?? [])].map((r) =>
      r.querySelector(".name")?.textContent.trim() ?? r.textContent.trim(),
    );
    const owner = [...document.querySelector("dock-desk").children].find((c) => c.contains(document.activeElement));
    const chatRows = [...(document.querySelector("conversation-list")?.shadowRoot?.querySelectorAll("li.row") ?? [])].map((r) =>
      (r.querySelector(".name") ?? r).textContent.trim(),
    );
    const chatOpen = [...(document.querySelector("conversation-list")?.shadowRoot?.querySelectorAll('li.row[aria-selected="true"]') ?? [])].map((r) =>
      (r.querySelector(".name") ?? r).textContent.trim(),
    )[0] ?? null;
    // The groups drawn with the frame that says the keyboard is in them.
    const framed = [...desk.querySelectorAll(".body")].filter((b) => getComputedStyle(b).outlineStyle !== "none").map((b) => b.dataset.side);
    const thread = [...(document.querySelector("chat-thread")?.shadowRoot?.querySelectorAll(".turn") ?? [])].map(
      (t) => `${t.classList.contains("user") ? "user" : "model"}: ${(t.querySelector(".answer") ?? t).textContent.trim()}`,
    );
    // Where the row or tile with the keyboard is among its kind, and whether every box
    // that scrolls around it shows it whole, top to bottom.
    const kind = deep?.classList?.[0];
    const peers = kind ? [...deep.getRootNode().querySelectorAll(`.${kind}`)] : [];
    let shown = Boolean(deep);
    if (deep) {
      const r = deep.getBoundingClientRect();
      for (let a = deep.assignedSlot ?? deep.parentElement ?? deep.getRootNode().host; a; a = a.assignedSlot ?? a.parentElement ?? a.getRootNode().host) {
        if (!/auto|scroll|hidden/.test(getComputedStyle(a).overflowY) || a.scrollHeight <= a.clientHeight) continue;
        const box = a.getBoundingClientRect();
        if (r.top < box.top - 1 || r.bottom > box.bottom + 1) shown = false;
      }
    }
    return {
      // The focus ring (7.4's --focus-ring) as drawn on whatever has the keyboard.
      ring: deep ? getComputedStyle(deep).boxShadow : null,
      place: peers.length ? `${peers.indexOf(deep) + 1} of ${peers.length}` : null,
      shown,
      framed,
      thread,
      chatRows,
      chatOpen,
      panel: owner ? owner.localName + (owner.id ? `#${owner.id}` : "") : null,
      focus: chain.join(" > "),
      deep: deep ? deep.localName + (deep.getAttribute?.("role") ? `[${deep.getAttribute("role")}]` : "") + (deep.className && typeof deep.className === "string" ? `.${deep.className.trim().split(/\s+/)[0]}` : "") : null,
      deepText: (deep?.querySelector?.(".name") ?? deep)?.textContent?.trim().slice(0, 30) ?? null,
      books: shows("books"),
      notes: shows("notes"),
      chats: shows("chats"),
      rightTab: tab(".dock.right .panel"),
      leftFolded: folded("left"),
      rightFolded: folded("right"),
      editor: cm("note-editor"),
      chatBox: cm("chat-input"),
      // Vim's normal mode in the chat box: the block cursor in place of the caret. The
      // box enters insert mode a frame after it takes the keyboard, so letters typed
      // before that would be Vim commands.
      chatNormal: Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector(".cm-scroller.cm-vimMode")),
      rows,
      chapter: reader.querySelector(".footer .chap")?.textContent.trim() ?? null,
      pageNo: reader.querySelector(".footer .pageno")?.textContent.trim() ?? null,
      cursor: cursorAt(),
      pending: painted("reader-pending"),
      marks: [...reader.querySelectorAll(".strip mark")].map((m) => m.textContent.replace(/\s+/g, " ")),
    };
  });

// The panel (a desk child, by its address) the keyboard is in.
const panel = (s) => s.panel;

const keys = (page, ...list) => async () => {
  for (const [i, k] of list.entries()) {
    if (i) await pause(KEY);
    await page.keyboard.press(k);
  }
};
// Keys pressed at machine pace, only to move into place before the steps that matter.
const quick = (page, ...list) => async () => {
  for (const k of list) await page.keyboard.press(k);
};
// Safari leaves a clicked button unfocused, and the keyboard on the bare page: drop the
// focus after a click the way it does.
const safari = (page) =>
  page.evaluate(() => {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    a?.blur();
    document.activeElement?.blur();
  });
// A click where the user would put the mouse, by the box of what they see.
const clickAt = (page, find, arg) => async () => {
  const box = await page.evaluate(find, arg);
  assert.ok(box, `nothing to click for ${find.name || "a target"} ${arg ?? ""}`);
  await page.mouse.click(box.x, box.y);
};
// A word of the reader's text, clicked in its middle.
function word(text) {
  const strip = document.querySelector("book-reader").shadowRoot.querySelector(".strip");
  const walker = document.createTreeWalker(strip, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.data.indexOf(text);
    if (i < 0) continue;
    const range = document.createRange();
    range.setStart(n, i + 1);
    range.setEnd(n, i + 2);
    const r = range.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return null;
}

const want = (cond, msg) => (cond ? null : msg);
const all = (...checks) => checks.find(Boolean) ?? null;
const unchanged = (s, before, what) => want(JSON.stringify(s[what]) === JSON.stringify(before[what]), `${what} changed from ${JSON.stringify(before[what])} to ${JSON.stringify(s[what])}`);

for (const engine of ENGINES) {
  describe(`the keyboard journey on / in ${engine.name}`, { timeout: 300000 }, () => {
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

    // `/` signed in as a fresh seeded user, settled: the book open on Chapter One, the
    // three notes and two chats listed, and with Vim keys on the keyboard on the Reader.
    const open = async (vimKeys = true) => {
      context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, await seedUser());
      await context.addInitScript((value) => {
        localStorage.setItem("settings", value);
        localStorage.setItem("settings:product", value);
      }, seed(vimKeys));
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      const ready = () => page.waitForFunction(
        ([n, vim]) => {
          const r = document.querySelector("book-reader")?.shadowRoot;
          return (
            r?.querySelector(".footer .chap")?.textContent.trim() === "Chapter One" &&
            r.querySelector(".strip")?.textContent.includes("A short opening") &&
            document.querySelector("note-list")?.shadowRoot?.querySelectorAll("li.row:not(.draft):not(.highlights)").length === n &&
            document.querySelector("conversation-list")?.shadowRoot?.querySelectorAll("li.row").length >= 2 &&
            (!vim || r.activeElement)
          );
        },
        [NOTES.length, vimKeys],
      );
      await ready();
      // Each step: a name, what the user does, how long they then wait, and what they
      // expect to see, as a function returning a complaint or nothing.
      const seen = [];
      const step = async (name, act, expect, wait = KEY) => {
        await act?.();
        await pause(wait);
        const s = await look(page);
        seen.push({ step: name, ...s });
        const wrong = expect(s);
        if (wrong) {
          const trail = seen.map((x) => `  ${JSON.stringify(x)}`).join("\n");
          assert.fail(`${engine.name}, step "${name}": ${wrong}\nobserved, step by step:\n${trail}`);
        }
        return s;
      };
      // Moving into place before the steps that matter, at machine pace.
      const reach = async (act, cond) => {
        await act();
        await until(async () => cond(await look(page)));
      };
      return { page, problems, step, reach };
    };
    const clean = (problems) => assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);

    // --- F3, R3: the Reader's cursor ------------------------------------------------------

    test(`the Reader's cursor shows and moves by word, and v starts a highlight in ${engine.name}`, async () => {
      const { page, problems, step } = await open();
      await step("the Reader focused", null, (s) => all(want(s.cursor?.at.startsWith("Chapter One"), `the cursor is at ${JSON.stringify(s.cursor)}`), want(!s.pending, "a passage is pending")));
      await step("w w w", keys(page, "w", "w", "w"), (s) => all(want(s.cursor?.at.startsWith("LINKED HEADING"), `the cursor is at ${JSON.stringify(s.cursor)}`), want(!s.pending, `a passage is pending: ${JSON.stringify(s.pending)}`)));
      await step("v", keys(page, "v"), (s) => want(s.pending?.text === "L", `pending ${JSON.stringify(s.pending)}`));
      clean(problems);
    });

    test(`v w w Enter in the Reader makes a highlight in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "w", "w", "w", "v"), (s) => s.pending?.text === "L");
      await step("w w", keys(page, "w", "w"), (s) =>
        all(want(s.pending?.text === "LINKED HEADING", `pending ${JSON.stringify(s.pending)}`), want(s.cursor?.at.startsWith("A short"), `the cursor is at ${JSON.stringify(s.cursor)}`)));
      await step("Enter", keys(page, "Enter"), (s) =>
        all(want(JSON.stringify(s.marks) === JSON.stringify(["LINKED HEADING"]), `marks ${JSON.stringify(s.marks)}`), want(!s.pending, "still pending"), want(s.cursor?.at.startsWith("A short"), `the cursor is at ${JSON.stringify(s.cursor)}`)));
      clean(problems);
    });

    test(`the Reader's cursor moves by paragraph in ${engine.name}`, async () => {
      const { page, problems, step } = await open();
      await step("}", keys(page, "}"), (s) => want(s.cursor?.text === "e" && s.cursor.at === "e", `the cursor is at ${JSON.stringify(s.cursor)}`));
      await step("} w", keys(page, "}", "w"), (s) => want(s.cursor?.at.startsWith("A short"), `the cursor is at ${JSON.stringify(s.cursor)}`));
      clean(problems);
    });

    test(`v ) in the Reader highlights a sentence in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "}", "}", "w"), (s) => Boolean(s.cursor?.at.startsWith("A short")));
      await step("v )", keys(page, "v", ")"), (s) =>
        all(want(s.pending?.text === "A short opening chapter, one page long.", `pending ${JSON.stringify(s.pending)}`), want(s.cursor?.at.startsWith("It links"), `the cursor is at ${JSON.stringify(s.cursor)}`)));
      await step("Enter", keys(page, "Enter"), (s) => want(JSON.stringify(s.marks) === JSON.stringify(["A short opening chapter, one page long."]), `marks ${JSON.stringify(s.marks)}`));
      clean(problems);
    });

    test(`Escape drops a passage in progress and leaves the cursor in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "w", "w", "w", "v", "w"), (s) => s.pending?.text === "LINKED" && Boolean(s.cursor?.at.startsWith("HEADING")));
      await step("Escape", keys(page, "Escape"), (s) =>
        all(want(!s.pending, "still pending"), want(s.marks.length === 0, `marks ${JSON.stringify(s.marks)}`), want(s.cursor?.at.startsWith("HEADING"), `the cursor is at ${JSON.stringify(s.cursor)}`), want(s.notes === "note-list", `Notes shows ${s.notes}`)));
      await step("{", keys(page, "{"), (s) => want(s.cursor?.at.startsWith("A LINKED"), `the cursor is at ${JSON.stringify(s.cursor)}`));
      await step("{", keys(page, "{"), (s) => want(s.cursor?.at.startsWith("Chapter One"), `the cursor is at ${JSON.stringify(s.cursor)}`));
      clean(problems);
    });

    test(`a click on the text puts the Reader's cursor there in ${engine.name}`, async () => {
      const { page, problems, step } = await open();
      await step("click on 'page long'", clickAt(page, word, "page long"), (s) =>
        all(want(panel(s) === "book-stage", `the keyboard is in ${s.focus}`), want(s.cursor?.at.startsWith("age long"), `the cursor is at ${JSON.stringify(s.cursor)}`), want(s.pageNo === "Page 1 of 1", s.pageNo)));
      await step("v e... b", keys(page, "v", "b"), (s) => want(s.pending?.text === "pa", `pending ${JSON.stringify(s.pending)}`));
      clean(problems);
    });

    // Read a frame after the key, no later: a cursor drawn late, or left in the old place,
    // is a word or a line off its character. After a page turn the read waits for the
    // slide to settle (look). Two pixels allow for sub-pixel rounding.
    const atOnce = (page, k) => async () => {
      await page.keyboard.press(k);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    };
    const onItsLetter = (s) => want(s.cursor && s.cursor.off <= 2, `the cursor is drawn ${s.cursor?.off}px off its letter: ${JSON.stringify(s.cursor)}`);

    test(`the Reader's cursor is drawn on its letter at once after w, ) and j in ${engine.name}`, async () => {
      const { page, problems, step } = await open();
      const first = await step("the Reader focused", null, (s) => all(onItsLetter(s), want(s.cursor?.at.startsWith("Chapter One"), `the cursor is at ${JSON.stringify(s.cursor)}`)));
      const w = await step("w", atOnce(page, "w"), (s) => all(onItsLetter(s), want(s.cursor.at.startsWith("One"), `the cursor is at ${JSON.stringify(s.cursor)}`)), 0);
      const sentence = await step(")", atOnce(page, ")"), (s) => all(onItsLetter(s), want(s.cursor.at !== w.cursor.at, `the cursor stayed at ${JSON.stringify(s.cursor)}`)), 0);
      await step("j", atOnce(page, "j"), (s) => all(onItsLetter(s), want(s.cursor.at !== sentence.cursor.at && s.cursor.at !== first.cursor.at, `the cursor stayed at ${JSON.stringify(s.cursor)}`)), 0);
      clean(problems);
    });

    test(`the Reader turns pages with Ctrl+f and Space, and the cursor follows in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "Control+f"), (s) => s.chapter === "Chapter Two" && s.pageNo?.startsWith("Page 1 of") && Boolean(s.cursor?.at.startsWith("Chapter Two")));
      await step("Space", keys(page, " "), (s) =>
        all(want(s.pageNo?.startsWith("Page 2 of"), s.pageNo), want(s.cursor && !s.cursor.at.startsWith("Chapter Two"), `the cursor is at ${JSON.stringify(s.cursor)}`)));
      await step("k across the page's top", keys(page, "k"), (s) => all(want(s.pageNo?.startsWith("Page 1 of"), s.pageNo), onItsLetter(s)));
      await step("j back across it", keys(page, "j"), (s) => all(want(s.pageNo?.startsWith("Page 2 of"), s.pageNo), onItsLetter(s)));
      clean(problems);
    });

    test(`the Reader's G, gg and Ctrl+b in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "Control+f"), (s) => s.chapter === "Chapter Two" && Boolean(s.cursor?.at.startsWith("Chapter Two")));
      const last = await step("G", keys(page, "G"), (s) => {
        const [, at, of] = s.pageNo?.match(/Page (\d+) of (\d+)/) ?? [];
        return all(want(at && at === of && at !== "1", s.pageNo), want(s.cursor && !s.cursor.at.startsWith("Chapter Two"), `the cursor is at ${JSON.stringify(s.cursor)}`));
      });
      await step("Ctrl+b", keys(page, "Control+b"), (s) => want(s.pageNo !== last.pageNo && s.chapter === "Chapter Two", `${s.chapter} ${s.pageNo}`));
      await step("g g", keys(page, "g", "g"), (s) => all(want(s.pageNo?.startsWith("Page 1 of"), s.pageNo), want(s.cursor?.at.startsWith("Chapter Two"), `the cursor is at ${JSON.stringify(s.cursor)}`)));
      clean(problems);
    });

    // --- R4: page keys and Ctrl+v ---------------------------------------------------------

    // l and h move the cursor one letter, as in Vim; only the page keys turn pages, and
    // the cursor leaving the page turns it as any motion does (12, "Vim keys").
    test(`l and h move the Reader's cursor one letter on the same page in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page), (s) => Boolean(s.cursor?.at.startsWith("Chapter One")));
      await step("l l l", keys(page, "l", "l", "l"), (s) =>
        all(want(s.cursor?.at.startsWith("pter One"), `the cursor is at ${JSON.stringify(s.cursor)}`), want(s.chapter === "Chapter One" && s.pageNo === "Page 1 of 1", `${s.chapter} ${s.pageNo}`), want(!s.pending, "a highlight began"), onItsLetter(s)));
      await step("h", keys(page, "h"), (s) =>
        all(want(s.cursor?.at.startsWith("apter One"), `the cursor is at ${JSON.stringify(s.cursor)}`), want(s.chapter === "Chapter One" && s.pageNo === "Page 1 of 1", `${s.chapter} ${s.pageNo}`), onItsLetter(s)));
      clean(problems);
    });

    test(`l on the page's last letter turns the page, and h turns it back in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "Control+f"), (s) => s.chapter === "Chapter Two" && s.pageNo?.startsWith("Page 1 of") && Boolean(s.cursor?.at.startsWith("Chapter Two")));
      await reach(quick(page, " "), (s) => Boolean(s.pageNo?.startsWith("Page 2 of")));
      await reach(quick(page, "k", "$"), (s) => s.pageNo?.startsWith("Page 1 of") && Boolean(s.cursor) && !s.cursor.at.startsWith("Chapter Two"));
      const last = await step("l", keys(page, "l"), (s) => all(want(s.pageNo?.startsWith("Page 2 of"), s.pageNo), onItsLetter(s)));
      await step("h", keys(page, "h"), (s) =>
        all(want(s.chapter === "Chapter Two" && s.pageNo?.startsWith("Page 1 of"), `${s.chapter} ${s.pageNo}`), want(s.cursor && !s.cursor.at.startsWith("Chapter Two") && s.cursor.at !== last.cursor?.at, `the cursor is at ${JSON.stringify(s.cursor)}`), onItsLetter(s)));
      clean(problems);
    });

    test(`Ctrl+d and Ctrl+u turn pages in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "Control+f"), (s) => s.chapter === "Chapter Two" && s.pageNo?.startsWith("Page 1 of"));
      await step("Ctrl+d", keys(page, "Control+d"), (s) => want(s.pageNo?.startsWith("Page 2 of"), s.pageNo));
      await step("Ctrl+u", keys(page, "Control+u"), (s) => want(s.chapter === "Chapter Two" && s.pageNo?.startsWith("Page 1 of"), `${s.chapter} ${s.pageNo}`));
      clean(problems);
    });

    test(`Ctrl+v starts a highlight as v does, and Ctrl+f carries it onto the next page in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "Control+f"), (s) => s.chapter === "Chapter Two" && Boolean(s.cursor?.at.startsWith("Chapter Two")));
      await step("Ctrl+v", keys(page, "Control+v"), (s) => want(s.pending?.text === "C", `pending ${JSON.stringify(s.pending)}`));
      await step("Ctrl+f", keys(page, "Control+f"), (s) =>
        all(want(s.pageNo?.startsWith("Page 2 of"), s.pageNo), want(s.pending?.text.startsWith("Chapter Two") && s.pending.text.length > 40, `pending ${JSON.stringify(s.pending)}`), onItsLetter(s)));
      await step("Escape", keys(page, "Escape"), (s) => all(want(!s.pending, "still pending"), want(s.marks.length === 0, `marks ${JSON.stringify(s.marks)}`)));
      clean(problems);
    });

    // --- S2: l and h inside a highlight move its end by one letter, as outside one --------

    test(`v l l l h in the Reader grows the passage by three letters and shrinks it by one in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "v"), (s) => s.pending?.text === "C");
      await step("l l l", keys(page, "l", "l", "l"), (s) =>
        all(want(s.pending?.text === "Chap", `pending ${JSON.stringify(s.pending)}`), want(s.pageNo === "Page 1 of 1", s.pageNo), want(s.cursor?.at.startsWith("pter"), `the cursor is at ${JSON.stringify(s.cursor)}`)));
      await step("h", keys(page, "h"), (s) => all(want(s.pending?.text === "Cha", `pending ${JSON.stringify(s.pending)}`), want(s.cursor?.at.startsWith("apter"), `the cursor is at ${JSON.stringify(s.cursor)}`)));
      clean(problems);
    });

    test(`Enter after v l l l h marks exactly the letters passed over in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "v", "l", "l", "l", "h"), (s) => s.pending?.text === "Cha");
      await step("Enter", keys(page, "Enter"), (s) => all(want(JSON.stringify(s.marks) === JSON.stringify(["Cha"]), `marks ${JSON.stringify(s.marks)}`), want(!s.pending, "still pending")));
      clean(problems);
    });

    test(`h before where v was pressed grows the highlight to the left in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "w", "v"), (s) => s.pending?.text === "O");
      await step("h h", keys(page, "h", "h"), (s) => all(want(s.pending?.text === "r O", `pending ${JSON.stringify(s.pending)}`), want(s.chapter === "Chapter One" && s.pageNo === "Page 1 of 1", `${s.chapter} ${s.pageNo}`)));
      clean(problems);
    });

    // --- Vim keys off: every letter and Ctrl key does nothing ----------------------------

    // The ring is drawn as a box-shadow; "none" is what a view showed when its ring was
    // written as an outline, which no engine draws from a box-shadow value.
    const ringed = (s) => want(s.ring && s.ring !== "none", `${s.deep} "${s.deepText}" shows no focus ring`);

    test(`with Vim keys off, Tab from the page start puts the focus ring on the Books tab in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open(false);
      await reach(() => safari(page), (s) => s.focus === "body");
      await step("Tab", keys(page, "Tab"), (s) =>
        all(want(s.deep === "button[tab]" && s.deepText === "Books", `the keyboard is on ${s.deep} "${s.deepText}"`), ringed(s)), SETTLE);
      clean(problems);
    });

    for (const [what, list] of [
      ["the panel and fold keys", ["Control+l", "Control+.", "Control+Shift+l", "Control+Shift+h"]],
      ["the tab letters", ["g", "t"]],
      ["the Reader's highlight letters", ["w", "v", "w", "Enter", "Control+v"]],
      ["the Reader's cursor and page letters", ["l", "}", "Control+f", "Control+d", "G"]],
    ]) {
      test(`with Vim keys off, ${what} do nothing in ${engine.name}`, async () => {
        const { page, problems, step, reach } = await open(false);
        await reach(() => page.evaluate(() => document.querySelector("book-reader").focus()), (s) => panel(s) === "book-stage");
        const before = await look(page);
        const same = (s) =>
          all(...["panel", "rightTab", "leftFolded", "rightFolded", "editor", "chatBox", "chapter", "pageNo", "marks", "rows", "framed"].map((k) => unchanged(s, before, k)), want(!s.cursor && !s.pending, "a cursor shows"));
        await step(list.join(" "), keys(page, ...list), same);
        clean(problems);
      });
    }
  });
}

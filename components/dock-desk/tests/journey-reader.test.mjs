import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomInt } from "node:crypto";

// The Reader's cursor and highlights from the keyboard on the product page, with "Vim keys"
// on: one journey (9), approved in checks/journeys.json. One account with the sample book and
// three notes; the page loads once. Making a highlight with v w w Enter, Escape after Ctrl+v,
// and the page keys Ctrl+d, Ctrl+u, G, gg and Ctrl+b are the Reader's own tests
// (book-reader/tests/keys.test.mjs and page.test.mjs); this journey covers the cursor drawn
// on the desk, its motions, and the passage it grows.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, journey, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub");

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
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const BOOK = "01K00000000000000000000SMP";
const NOTES = ["Note one", "Note two", "Note three"];
const SENTENCE = "A short opening chapter, one page long.";

// A user set up straight through the server (5): the sample book open and three notes about it.
const seedUser = async () => {
  const cookie = forgeCookie("reader");
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
  return cookie;
};

// The "Vim keys" preference (12) in both profiles' copies, the way settings stores it.
const VIM = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

// Settled: the book open on Chapter One, the notes listed, the keyboard on the Reader.
const ready = (page) =>
  page.waitForFunction((n) => {
    const r = document.querySelector("book-reader")?.shadowRoot;
    return (
      r?.querySelector(".footer .chap")?.textContent.trim() === "Chapter One" &&
      r.querySelector(".strip")?.textContent.includes("A short opening") &&
      document.querySelector("note-list")?.shadowRoot?.querySelectorAll("li.row:not(.draft):not(.highlights)").length === n &&
      Boolean(r.activeElement)
    );
  }, NOTES.length);

// The Reader as the user sees it, read in one go.
const look = ({ page }) =>
  page.evaluate(async () => {
    // A page turn in progress: the Reader's cursor is placed on its letter once the slide
    // has settled (it says so by dropping data-sliding), so what is read is the page the
    // user is left looking at, not a frame of the slide.
    const box = () => document.querySelector("book-reader")?.shadowRoot?.querySelector(".cursor");
    for (const t0 = performance.now(); box()?.hasAttribute("data-sliding") && performance.now() - t0 < 1000; ) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    const chain = [];
    for (let el = document.activeElement; el; el = el.shadowRoot?.activeElement ?? null) chain.push(el.localName);
    const owner = [...document.querySelector("dock-desk").children].find((c) => c.contains(document.activeElement));
    const shows = (id) => [...(document.getElementById(id)?.children ?? [])].find((c) => c.assignedSlot)?.localName ?? null;
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
    return {
      panel: owner ? owner.localName + (owner.id ? `#${owner.id}` : "") : null,
      focus: chain.join(" > "),
      notes: shows("notes"),
      chapter: reader.querySelector(".footer .chap")?.textContent.trim() ?? null,
      pageNo: reader.querySelector(".footer .pageno")?.textContent.trim() ?? null,
      cursor: cursorAt(),
      pending: painted("reader-pending"),
      marks: [...reader.querySelectorAll(".strip mark")].map((m) => m.textContent.replace(/\s+/g, " ")),
    };
  });

const want = (cond, msg) => (cond ? null : msg);
const all = (...checks) => checks.find(Boolean) ?? null;
const inPanel = (address) => (s) => want(s.panel === address, `the keyboard is in ${s.focus}, not ${address}`);
const cursorAt = (start) => (s) => want(s.cursor?.at?.startsWith(start), `the cursor is at ${JSON.stringify(s.cursor)}`);
const pendingIs = (text) => (s) => want(s.pending?.text === text, `pending ${JSON.stringify(s.pending)}`);
const nothingPending = (s) => want(!s.pending, `a passage is pending: ${JSON.stringify(s.pending)}`);
const marked = (...texts) => (s) => want(texts.every((t) => s.marks.includes(t)), `marks ${JSON.stringify(s.marks)}`);
const onPage = (chapter, page) => (s) => want(s.chapter === chapter && s.pageNo?.startsWith(`Page ${page} of`), `${s.chapter} ${s.pageNo}`);
// Two pixels allow for sub-pixel rounding.
const onItsLetter = (s) => want(s.cursor && s.cursor.off <= 2, `the cursor is drawn ${s.cursor?.off}px off its letter: ${JSON.stringify(s.cursor)}`);

const press = async (page, ...keys) => {
  for (const key of keys) await page.keyboard.press(key);
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

// Every step about Chapter One starts here and first presses g g, which puts the cursor on
// the chapter's first letter.
const inChapterOne = {
  state: "the Reader on Chapter One with the keyboard and nothing pending",
  check: (s) => all(inPanel("book-stage")(s), onPage("Chapter One", 1)(s), nothingPending(s)),
  reach: () => {},
};
const toTop = async (v) => {
  await press(v.page, "g", "g");
  await v.see(cursorAt("Chapter One"));
};

for (const engine of ENGINES) {
  // focus and keys
  test(`the Reader's cursor and highlights from the keyboard on / in ${engine.name}`, ...journey({
    launch: () => engine.launch(),
    open: async (browser) => {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, await seedUser());
        await context.addInitScript((value) => {
          localStorage.setItem("settings", value);
          localStorage.setItem("settings:product", value);
        }, VIM);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await ready(page);
        return { page, problems, close: () => context.close() };
      } catch (error) {
        await context.close();
        throw error;
      }
    },
    look,
  }, [
    {
      // Read a frame after the key, no later: a cursor drawn late, or left in the old
      // place, is a word or a line off its character.
      name: "the cursor shows on the first letter and is drawn on its letter at once after w, ) and j",
      from: inChapterOne,
      run: async (v) => {
        const first = await v.see((s) => all(cursorAt("Chapter One")(s), onItsLetter(s)));
        const atOnce = async (key, check) => {
          await v.page.keyboard.press(key);
          await v.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
          const s = await v.look();
          const complaint = check(s);
          if (complaint) throw new Error(`after ${key}: ${complaint}`);
          return s;
        };
        const w = await atOnce("w", (s) => all(onItsLetter(s), cursorAt("One")(s)));
        const sentence = await atOnce(")", (s) => all(onItsLetter(s), want(s.cursor.at !== w.cursor.at, `the cursor stayed at ${JSON.stringify(s.cursor)}`)));
        await atOnce("j", (s) => all(onItsLetter(s), want(s.cursor.at !== sentence.cursor.at && s.cursor.at !== first.cursor.at, `the cursor stayed at ${JSON.stringify(s.cursor)}`)));
      },
    },
    {
      name: "w moves the cursor by word and v starts a passage there",
      from: inChapterOne,
      run: async (v) => {
        await toTop(v);
        await press(v.page, "w", "w", "w");
        await v.see((s) => all(cursorAt("LINKED HEADING")(s), nothingPending(s)));
        await press(v.page, "v");
        await v.see(pendingIs("L"));
      },
    },
    {
      name: "w grows the passage, and Escape drops it, leaving the cursor and the Notes list",
      run: async (v) => {
        await press(v.page, "w");
        await v.see((s) => all(pendingIs("LINKED")(s), cursorAt("HEADING")(s)));
        await press(v.page, "Escape");
        await v.see((s) => all(nothingPending(s), want(s.marks.length === 0, `marks ${JSON.stringify(s.marks)}`), cursorAt("HEADING")(s), want(s.notes === "note-list", `Notes shows ${s.notes}`)));
      },
    },
    {
      name: "{ and } move the cursor by paragraph",
      run: async (v) => {
        await press(v.page, "{");
        await v.see(cursorAt("A LINKED"));
        await press(v.page, "{");
        await v.see(cursorAt("Chapter One"));
        await press(v.page, "}");
        await v.see((s) => want(s.cursor?.text === "e" && s.cursor.at === "e", `the cursor is at ${JSON.stringify(s.cursor)}`));
        await press(v.page, "}", "w");
        await v.see(cursorAt("A short"));
      },
    },
    // l and h move the cursor one letter, as in Vim; only the page keys turn pages (12,
    // "Vim keys").
    {
      name: "l and h move the cursor one letter on the same page",
      from: inChapterOne,
      run: async (v) => {
        await toTop(v);
        await press(v.page, "l", "l", "l");
        await v.see((s) => all(cursorAt("pter One")(s), onPage("Chapter One", 1)(s), nothingPending(s), onItsLetter(s)));
        await press(v.page, "h");
        await v.see((s) => all(cursorAt("apter One")(s), onPage("Chapter One", 1)(s), onItsLetter(s)));
      },
    },
    {
      name: "h before where v was pressed grows the passage to the left",
      from: inChapterOne,
      run: async (v) => {
        await toTop(v);
        await press(v.page, "w", "v");
        await v.see(pendingIs("O"));
        await press(v.page, "h", "h");
        await v.see((s) => all(pendingIs("r O")(s), onPage("Chapter One", 1)(s)));
        await press(v.page, "Escape");
        await v.see(nothingPending);
      },
    },
    {
      name: "a click on the text puts the cursor there, and v b grows a passage back from it",
      from: inChapterOne,
      run: async (v) => {
        const box = await v.page.evaluate(word, "page long");
        assert.ok(box, "no 'page long' to click");
        await v.page.mouse.click(box.x, box.y);
        await v.see((s) => all(inPanel("book-stage")(s), cursorAt("age long")(s), onPage("Chapter One", 1)(s)));
        await press(v.page, "v", "b");
        await v.see(pendingIs("pa"));
        await press(v.page, "Escape");
        await v.see(nothingPending);
      },
    },
    {
      name: "v l l l h grows the passage by three letters and shrinks it by one",
      from: inChapterOne,
      run: async (v) => {
        await toTop(v);
        await press(v.page, "v");
        await v.see(pendingIs("C"));
        await press(v.page, "l", "l", "l");
        await v.see((s) => all(pendingIs("Chap")(s), onPage("Chapter One", 1)(s), cursorAt("pter")(s)));
        await press(v.page, "h");
        await v.see((s) => all(pendingIs("Cha")(s), cursorAt("apter")(s)));
      },
    },
    {
      name: "Enter marks exactly the letters passed over",
      run: async (v) => {
        await press(v.page, "Enter");
        await v.see((s) => all(marked("Cha")(s), nothingPending(s)));
      },
    },
    {
      name: "v ) highlights a sentence",
      from: inChapterOne,
      run: async (v) => {
        await toTop(v);
        await press(v.page, "}", "}", "w");
        await v.see(cursorAt("A short"));
        await press(v.page, "v", ")");
        await v.see((s) => all(pendingIs(SENTENCE)(s), cursorAt("It links")(s)));
        await press(v.page, "Enter");
        await v.see((s) => all(marked(SENTENCE)(s), nothingPending(s)));
      },
    },
    {
      name: "Ctrl+f and Space turn pages with the cursor, and k and j carry it across the page's top",
      from: inChapterOne,
      run: async (v) => {
        await press(v.page, "Control+f");
        await v.see((s) => all(onPage("Chapter Two", 1)(s), cursorAt("Chapter Two")(s)));
        await press(v.page, " ");
        await v.see((s) => all(onPage("Chapter Two", 2)(s), want(s.cursor && !s.cursor.at.startsWith("Chapter Two"), `the cursor is at ${JSON.stringify(s.cursor)}`)));
        await press(v.page, "k");
        await v.see((s) => all(onPage("Chapter Two", 1)(s), onItsLetter(s)));
        await press(v.page, "j");
        await v.see((s) => all(onPage("Chapter Two", 2)(s), onItsLetter(s)));
      },
    },
    {
      name: "l on the page's last letter turns the page, and h turns it back",
      from: {
        state: "the Reader on the second page of Chapter Two",
        check: (s) => all(onPage("Chapter Two", 2)(s), nothingPending(s)),
        reach: async (v) => {
          await press(v.page, "Control+f");
          await v.see((s) => all(onPage("Chapter Two", 1)(s), cursorAt("Chapter Two")(s)));
          await press(v.page, " ");
        },
      },
      run: async (v) => {
        await press(v.page, "k", "$");
        await v.see((s) => all(onPage("Chapter Two", 1)(s), want(s.cursor && !s.cursor.at.startsWith("Chapter Two"), `the cursor is at ${JSON.stringify(s.cursor)}`)));
        await press(v.page, "l");
        const turned = await v.see((s) => all(onPage("Chapter Two", 2)(s), onItsLetter(s)));
        await press(v.page, "h");
        await v.see((s) => all(onPage("Chapter Two", 1)(s), want(s.cursor && !s.cursor.at.startsWith("Chapter Two") && s.cursor.at !== turned.cursor?.at, `the cursor is at ${JSON.stringify(s.cursor)}`), onItsLetter(s)));
      },
    },
    {
      name: "Ctrl+v starts a passage as v does, and Ctrl+f carries it onto the next page",
      from: {
        state: "the Reader in Chapter Two with nothing pending",
        check: (s) => all(inPanel("book-stage")(s), want(s.chapter === "Chapter Two", s.chapter), nothingPending(s)),
        reach: async (v) => {
          await press(v.page, "Control+f");
        },
      },
      run: async (v) => {
        await press(v.page, "g", "g");
        await v.see((s) => all(onPage("Chapter Two", 1)(s), cursorAt("Chapter Two")(s)));
        const marks = (await v.look()).marks.length;
        await press(v.page, "Control+v");
        await v.see(pendingIs("C"));
        await press(v.page, "Control+f");
        await v.see((s) => all(onPage("Chapter Two", 2)(s), want(s.pending?.text.startsWith("Chapter Two") && s.pending.text.length > 40, `pending ${JSON.stringify(s.pending)}`), onItsLetter(s)));
        await press(v.page, "Escape");
        await v.see((s) => all(nothingPending(s), want(s.marks.length === marks, `marks ${JSON.stringify(s.marks)}`)));
      },
    },
  ]));
}

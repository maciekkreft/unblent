import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomInt } from "node:crypto";

// The product page with "Vim keys" off: one journey (9), approved in checks/journeys.json.
// One account with the sample book and three notes; the page loads once. Tab reaches the
// controls with the focus ring, and the Vim keys do nothing anywhere on the desk. Ctrl+l
// is dock-desk's own test (keys.test.mjs), and v, Ctrl+v, w, Enter, Ctrl+f, l and G are
// the Reader's (book-reader/tests/keys.test.mjs and page.test.mjs).
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

// A user set up straight through the server (5): the sample book open and three notes about it.
const seedUser = async () => {
  const cookie = forgeCookie("vim-off");
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

// The "Vim keys" preference (12), off, in both profiles' copies, the way settings stores it.
const OFF = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: false });

// Settled: the book open on Chapter One and the notes listed.
const ready = (page) =>
  page.waitForFunction((n) => {
    const r = document.querySelector("book-reader")?.shadowRoot;
    return (
      r?.querySelector(".footer .chap")?.textContent.trim() === "Chapter One" &&
      r.querySelector(".strip")?.textContent.includes("A short opening") &&
      document.querySelector("note-list")?.shadowRoot?.querySelectorAll("li.row:not(.draft):not(.highlights)").length === n
    );
  }, NOTES.length);

// Everything on the desk a key could change, read in one go.
const look = ({ page }) =>
  page.evaluate(() => {
    const chain = [];
    let deep = document.activeElement;
    for (let el = deep; el; el = el.shadowRoot?.activeElement ?? null) {
      chain.push(el.localName);
      deep = el;
    }
    const owner = [...document.querySelector("dock-desk").children].find((c) => c.contains(document.activeElement));
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
    const cursor = reader.querySelector(".cursor");
    return {
      panel: owner ? owner.localName + (owner.id ? `#${owner.id}` : "") : null,
      focus: chain.join(" > "),
      deep: deep ? deep.localName + (deep.getAttribute?.("role") ? `[${deep.getAttribute("role")}]` : "") + (typeof deep.className === "string" && deep.className.trim() ? `.${deep.className.trim().split(/\s+/)[0]}` : "") : null,
      deepText: (deep?.querySelector?.(".name") ?? deep)?.textContent?.trim().slice(0, 30) ?? null,
      // The focus ring (7.4's --focus-ring) as drawn on whatever has the keyboard.
      ring: deep ? getComputedStyle(deep).boxShadow : null,
      rightTab: tab(".dock.right .panel"),
      leftFolded: folded("left"),
      rightFolded: folded("right"),
      editor: cm("note-editor"),
      chatBox: cm("chat-input"),
      rows: [...(document.querySelector("note-list")?.shadowRoot?.querySelectorAll("li.row") ?? [])].map((r) => (r.querySelector(".name") ?? r).textContent.trim()),
      // The groups drawn with the frame that says the keyboard is in them.
      framed: [...desk.querySelectorAll(".body")].filter((b) => getComputedStyle(b).outlineStyle !== "none").map((b) => b.dataset.side),
      chapter: reader.querySelector(".footer .chap")?.textContent.trim() ?? null,
      pageNo: reader.querySelector(".footer .pageno")?.textContent.trim() ?? null,
      cursor: Boolean(cursor && !cursor.hidden),
      pending: Boolean(globalThis.CSS?.highlights?.get("reader-pending")?.size),
      marks: [...reader.querySelectorAll(".strip mark")].map((m) => m.textContent.replace(/\s+/g, " ")),
    };
  });

const want = (cond, msg) => (cond ? null : msg);
const all = (...checks) => checks.find(Boolean) ?? null;
// The ring is drawn as a box-shadow; "none" is what a view showed when its ring was
// written as an outline, which no engine draws from a box-shadow value.
const ringed = (s) => want(s.ring && s.ring !== "none", `${s.deep} "${s.deepText}" shows no focus ring`);
const WATCHED = ["panel", "rightTab", "leftFolded", "rightFolded", "editor", "chatBox", "chapter", "pageNo", "marks", "rows", "framed"];
const unchanged = (before) => (s) =>
  all(
    ...WATCHED.map((k) => want(JSON.stringify(s[k]) === JSON.stringify(before[k]), `${k} changed from ${JSON.stringify(before[k])} to ${JSON.stringify(s[k])}`)),
    want(!s.cursor && !s.pending, "the Reader shows a cursor or a passage"),
  );

const press = async (page, ...keys) => {
  for (const key of keys) await page.keyboard.press(key);
};
// A key that does nothing has nothing to wait for: what the page draws in answer to a key
// is drawn by the second frame after it.
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const offInReader = {
  state: "Vim keys off: no cursor in the Reader",
  check: (s) => want(!s.cursor && !s.pending, "the Reader shows a cursor or a passage"),
  reach: () => {},
};

// The keys are pressed with the keyboard in the Reader, where Vim keys would act.
const nothingFrom = (keys) => async (v) => {
  await v.page.evaluate(() => document.querySelector("book-reader").focus());
  const before = await v.see((s) => want(s.panel === "book-stage", `the keyboard is in ${s.focus}`));
  await press(v.page, ...keys);
  await frames(v.page);
  const complaint = unchanged(before)(await v.look());
  if (complaint) throw new Error(`after ${keys.join(" ")}: ${complaint}`);
};

for (const engine of ENGINES) {
  // focus and keys
  test(`Vim keys off on / in ${engine.name}`, ...journey({
    launch: () => engine.launch(),
    open: async (browser) => {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, await seedUser());
        await context.addInitScript((value) => {
          localStorage.setItem("settings", value);
          localStorage.setItem("settings:product", value);
        }, OFF);
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
      name: "Tab from the page start puts the focus ring on the Books tab",
      from: {
        state: "the keyboard on the bare page",
        check: (s) => want(s.focus === "body", `the keyboard is on ${s.focus}`),
        reach: () => {},
      },
      run: async (v) => {
        await press(v.page, "Tab");
        await v.see((s) => all(want(s.deep === "button[tab]" && s.deepText === "Books", `the keyboard is on ${s.deep} "${s.deepText}"`), ringed(s)));
      },
    },
    {
      name: "the panel, fold and tab keys do nothing",
      from: offInReader,
      run: nothingFrom(["Control+.", "Control+Shift+l", "Control+Shift+h", "g", "t"]),
    },
    {
      name: "the Reader's paragraph and half-page keys do nothing",
      from: offInReader,
      run: nothingFrom(["}", ")", "Control+d", "Control+u", "Control+b"]),
    },
  ]));
}

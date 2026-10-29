import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomInt } from "node:crypto";

// The focus ring (7.4's --focus-ring) on the product page, with "Vim keys" on: one journey
// (9), approved in checks/journeys.json. One account with the sample book and three notes;
// the page loads once. What the keyboard reaches wears the ring; what a click reaches does
// not, until the keyboard moves on from it.
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

// A user set up straight through the server (5): the sample book open and three notes about
// its first chapter, where it opens, so the editor opens the newest of them.
const seedUser = async () => {
  const cookie = forgeCookie("ring");
  const put = async (path, type, body) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
    assert.equal(res.status, 200, `PUT ${path}`);
  };
  const json = (path, body) => put(path, "application/json", JSON.stringify(body));
  await put(`/api/books/${BOOK}`, "application/epub+zip", readFileSync(SAMPLE));
  await json(`/api/books/${BOOK}/opened`, {});
  for (const [k, title] of NOTES.entries()) {
    await json(`/api/notes/${ulid()}`, { title, body: `${title} body ${k}`, baseVersion: null, about: [{ kind: "book", id: BOOK, chapter: "chapter-one", chapterTitle: "Chapter One" }] });
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

// What the keyboard is on, and the ring drawn on it, read in one go.
const look = ({ page }) =>
  page.evaluate(() => {
    const chain = [];
    let deep = document.activeElement;
    for (let el = deep; el; el = el.shadowRoot?.activeElement ?? null) {
      chain.push(el.localName);
      deep = el;
    }
    const owner = [...document.querySelector("dock-desk").children].find((c) => c.contains(document.activeElement));
    const shows = (id) => [...(document.getElementById(id)?.children ?? [])].find((c) => c.assignedSlot)?.localName ?? null;
    return {
      panel: owner ? owner.localName + (owner.id ? `#${owner.id}` : "") : null,
      focus: chain.join(" > "),
      deep: deep ? deep.localName + (deep.getAttribute?.("role") ? `[${deep.getAttribute("role")}]` : "") + (typeof deep.className === "string" && deep.className.trim() ? `.${deep.className.trim().split(/\s+/)[0]}` : "") : null,
      deepText: (deep?.querySelector?.(".name") ?? deep)?.textContent?.trim().slice(0, 30) ?? null,
      // The focus ring as drawn on whatever has the keyboard.
      ring: deep ? getComputedStyle(deep).boxShadow : null,
      books: shows("books"),
    };
  });

const want = (cond, msg) => (cond ? null : msg);
const all = (...checks) => checks.find(Boolean) ?? null;
const inPanel = (address) => (s) => want(s.panel === address, `the keyboard is in ${s.focus}, not ${address}`);
// The ring is drawn as a box-shadow; "none" is what a view showed when its ring was
// written as an outline, which no engine draws from a box-shadow value.
const ringed = (s) => want(s.ring && s.ring !== "none", `${s.deep} "${s.deepText}" shows no focus ring`);
const unringed = (s) => want(s.ring === "none", `${s.deep} "${s.deepText}" shows the focus ring after a click: ${s.ring}`);

const press = async (page, ...keys) => {
  for (const key of keys) await page.keyboard.press(key);
};
// A click where the user would put the mouse, by the box of what they see.
const clickAt = async (page, find, arg) => {
  const box = await page.evaluate(find, arg);
  assert.ok(box, `nothing to click for ${find.name} ${arg ?? ""}`);
  await page.mouse.click(box.x, box.y);
};
// The first imported book's tile: the journal, which books presents first, has no
// "Chapter Two" in its Contents.
function tile() {
  const el = document.querySelector("book-shelf")?.shadowRoot?.querySelector('.tile:not([data-id="00000000000000000000000JRN"])');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
function contentsRow(text) {
  const el = [...(document.querySelector("book-toc")?.shadowRoot?.querySelectorAll(".entry") ?? [])].find((e) => e.textContent.includes(text));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

const inReader = {
  state: "the keyboard in the Reader",
  check: inPanel("book-stage"),
  reach: () => {},
};
const shelfShown = {
  state: "Books showing the shelf",
  check: (s) => want(s.books === "book-shelf", `Books shows ${s.books}`),
  reach: () => {},
};

for (const engine of ENGINES) {
  // Browser: focus and keys.
  test(`the focus ring on / in ${engine.name}`, ...journey({
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
      name: "Ctrl+l puts the focus ring on the Notes row",
      from: inReader,
      run: async (v) => {
        await press(v.page, "Control+l");
        await v.see((s) => all(want(s.deep?.startsWith("li[option]") && s.deepText?.startsWith("Note"), `the keyboard is on ${s.deep} "${s.deepText}"`), ringed(s)));
        await press(v.page, "Control+h");
        await v.see(inPanel("book-stage"));
      },
    },
    {
      name: "Ctrl+h puts the focus ring on the Books tile",
      from: inReader,
      run: async (v) => {
        await press(v.page, "Control+h");
        await v.see((s) => all(want(s.deep === "li[option].tile", `the keyboard is on ${s.deep} "${s.deepText}"`), ringed(s)));
      },
    },
    {
      name: "a click on a Contents row leaves it without the focus ring",
      from: shelfShown,
      run: async (v) => {
        await clickAt(v.page, tile);
        await v.see((s) => want(s.deep === "button.entry", `the keyboard is on ${s.deep} "${s.deepText}"`));
        await clickAt(v.page, contentsRow, "Chapter Two");
        await v.see((s) => all(want(s.deep === "button.entry" && s.deepText === "Chapter Two", `the keyboard is on ${s.deep} "${s.deepText}"`), unringed(s)));
      },
    },
    {
      name: "Tab from the clicked Contents row puts the focus ring on the Reader's tab",
      run: async (v) => {
        await press(v.page, "Tab");
        await v.see((s) => all(want(s.deep === "button[tab]", `the keyboard is on ${s.deep} "${s.deepText}"`), ringed(s)));
      },
    },
  ]));
}

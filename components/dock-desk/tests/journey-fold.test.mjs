import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomInt } from "node:crypto";

// Folding the docks on the product page from the keyboard, with "Vim keys" on: one journey
// (9), approved in checks/journeys.json. One account with the sample book and three notes;
// the page loads once. A fold puts the keyboard on the stage, and after an unfold Ctrl+l
// reaches the dock again.
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
  const cookie = forgeCookie("fold");
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

// Which panel has the keyboard and which docks are folded, read in one go.
const look = ({ page }) =>
  page.evaluate(() => {
    const chain = [];
    for (let el = document.activeElement; el; el = el.shadowRoot?.activeElement ?? null) chain.push(el.localName);
    const owner = [...document.querySelector("dock-desk").children].find((c) => c.contains(document.activeElement));
    const desk = document.querySelector("dock-desk").shadowRoot;
    const folded = (side) => {
      const dock = desk.querySelector(`aside.dock.${side}`);
      return dock ? dock.classList.contains("folded") : null;
    };
    return {
      panel: owner ? owner.localName + (owner.id ? `#${owner.id}` : "") : null,
      focus: chain.join(" > "),
      leftFolded: folded("left"),
      rightFolded: folded("right"),
    };
  });

const want = (cond, msg) => (cond ? null : msg);
const all = (...checks) => checks.find(Boolean) ?? null;
const inPanel = (address) => (s) => want(s.panel === address, `the keyboard is in ${s.focus}, not ${address}`);

const press = async (page, ...keys) => {
  for (const key of keys) await page.keyboard.press(key);
};

const inReader = {
  state: "the keyboard in the Reader",
  check: inPanel("book-stage"),
  reach: () => {},
};

for (const engine of ENGINES) {
  // Browser: focus and keys.
  test(`folding the docks on / in ${engine.name}`, ...journey({
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
      name: "Ctrl+Shift+l from Notes folds the right dock and puts the keyboard on the stage, and again unfolds it",
      from: inReader,
      run: async (v) => {
        await press(v.page, "Control+l");
        await v.see(inPanel("list-then-item#notes"));
        await press(v.page, "Control+Shift+l");
        await v.see((s) => all(want(s.rightFolded === true, "the right dock is open"), inPanel("book-stage")(s)));
        await press(v.page, "Control+Shift+l");
        await v.see((s) => all(want(s.rightFolded === false, "the right dock is folded"), inPanel("book-stage")(s)));
      },
    },
    {
      name: "Ctrl+l reaches Notes again after the fold and the unfold",
      run: async (v) => {
        await press(v.page, "Control+l");
        await v.see(inPanel("list-then-item#notes"));
      },
    },
  ]));
}

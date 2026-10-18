import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomInt } from "node:crypto";

// The lists on the product page, from the keyboard, with "Vim keys" on: one journey (9),
// approved in checks/journeys.json. One account with a long Books shelf, a long Notes list
// and a book's Highlights; the page loads once and the steps move along the lists. What
// each list does with j, k, G and gg alone is tested in that list's own tests; here it is
// how the lists sit on the desk: a list scrolls to the row the keyboard moved to, the
// keyboard comes back to a row from what the row opened, and a letter on a row types
// nothing into the note behind it.
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
const EXTRA = 30;
const SHELF = 12;
const shelfId = (k) => `01K00000000000000000000B${String(k).padStart(2, "0")}`;

// A user set up straight through the server (5): the sample book open with one highlight,
// so Notes shows its Highlights row, three notes about it and thirty more, and twelve more
// copies of the book, so the Notes list and the Books shelf are longer than their panels.
const seedUser = async () => {
  const cookie = forgeCookie("lists");
  const put = async (path, type, body) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
    assert.equal(res.status, 200, `PUT ${path}`);
  };
  const json = (path, body) => put(path, "application/json", JSON.stringify(body));
  const epub = readFileSync(SAMPLE);
  await put(`/api/books/${BOOK}`, "application/epub+zip", epub);
  await Promise.all(Array.from({ length: SHELF }, (_, k) => put(`/api/books/${shelfId(k)}`, "application/epub+zip", epub)));
  await json(`/api/books/${BOOK}/opened`, {});
  const place = { chapter: 0, contentVersion: 1, start: { block: 2, offset: 2 }, end: { block: 2, offset: 15 } };
  const quote = { exact: "short opening", prefix: "A ", suffix: " chapter, one page long. It link" };
  await json(`/api/notes/${ulid()}`, { title: "", body: "", baseVersion: null, about: [{ kind: "book", id: BOOK, place, quote }] });
  // The newest note is listed first: the extras go in first, so the three come on top.
  for (let k = 0; k < EXTRA; k += 1) {
    await json(`/api/notes/${ulid()}`, { title: `Extra ${k}`, body: "", baseVersion: null, about: [{ kind: "book", id: BOOK }] });
    await pause(2);
  }
  for (const [k, title] of NOTES.entries()) {
    await json(`/api/notes/${ulid()}`, { title, body: `${title} body ${k}`, baseVersion: null, about: [{ kind: "book", id: BOOK }] });
    await pause(5);
  }
  return cookie;
};

// The "Vim keys" preference (12) in both profiles' copies, the way settings stores it.
const VIM = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

// Settled: the book open on Chapter One, every note listed, the keyboard on the Reader.
const ready = (page) =>
  page.waitForFunction((n) => {
    const r = document.querySelector("book-reader")?.shadowRoot;
    return (
      r?.querySelector(".footer .chap")?.textContent.trim() === "Chapter One" &&
      r.querySelector(".strip")?.textContent.includes("A short opening") &&
      document.querySelector("note-list")?.shadowRoot?.querySelectorAll("li.row:not(.draft):not(.highlights)").length === n &&
      Boolean(r.activeElement)
    );
  }, NOTES.length + EXTRA);

// What the user sees of the lists, read in one go, for the checks and the trail.
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
    const cm = (tag) => {
      const content = document.querySelector(tag)?.shadowRoot?.querySelector(".cm-content");
      if (!content) return null;
      return [...content.querySelectorAll(".cm-line")]
        .map((line) => [...line.childNodes].filter((n) => !n.classList?.contains("cm-placeholder")).map((n) => n.textContent).join(""))
        .join("\n");
    };
    const rows = [...(document.querySelector("note-list")?.shadowRoot?.querySelectorAll("li.row") ?? [])].map((r) =>
      r.querySelector(".name")?.textContent.trim() ?? r.textContent.trim(),
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
      panel: owner ? owner.localName + (owner.id ? `#${owner.id}` : "") : null,
      focus: chain.join(" > "),
      deep: deep ? deep.localName + (deep.getAttribute?.("role") ? `[${deep.getAttribute("role")}]` : "") + (typeof deep.className === "string" && deep.className.trim() ? `.${deep.className.trim().split(/\s+/)[0]}` : "") : null,
      deepText: (deep?.querySelector?.(".name") ?? deep)?.textContent?.trim().slice(0, 30) ?? null,
      place: peers.length ? `${peers.indexOf(deep) + 1} of ${peers.length}` : null,
      shown,
      notes: shows("notes"),
      editor: cm("note-editor"),
      chatBox: cm("chat-input"),
      rows: `${rows.length}: ${rows.slice(0, 5).join(", ")}`,
    };
  });

const want = (cond, msg) => (cond ? null : msg);
const all = (...checks) => checks.find(Boolean) ?? null;
const onRow = (s, text) =>
  want(s.deep?.startsWith("li[option]") && s.deepText?.startsWith(text), `the keyboard is on ${s.deep} "${s.deepText}", not the row "${text}"`);
// The row or tile with the keyboard is the first or the last of its list, and in view.
const at = (s, end) => {
  const [n, of] = (s.place ?? "").split(" of ").map(Number);
  return all(want(end === "first" ? n === 1 : n === of && of > 1, `the keyboard is on ${s.deep} ${s.place}, not the ${end}`), want(s.shown, `${s.deep} ${s.place} is scrolled out of view`));
};
const unchanged = (s, before, what) => want(s[what] === before[what], `${what} changed from ${JSON.stringify(before[what])} to ${JSON.stringify(s[what])}`);

const press = async (page, ...keys) => {
  for (const key of keys) await page.keyboard.press(key);
};
// A click where the user would put the mouse: on a row of a list, by its text.
const clickRow = async (page, tag, text) => {
  const box = await page.evaluate(([tag, text]) => {
    const el = [...(document.querySelector(tag)?.shadowRoot?.querySelectorAll("li.row") ?? [])].find((r) => r.textContent.includes(text));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 3, y: r.top + r.height / 2 };
  }, [tag, text]);
  assert.ok(box, `no row "${text}" in ${tag}`);
  await page.mouse.click(box.x, box.y);
};

const inReader = {
  state: "the keyboard in the Reader",
  check: (s) => want(s.panel === "book-stage", `the keyboard is in ${s.panel}`),
  reach: () => {},
};
const onNotesRow = {
  state: "the keyboard on a row of Notes",
  check: (s) => want(s.panel === "list-then-item#notes" && s.deep?.startsWith("li[option]"), `the keyboard is on ${s.deep} in ${s.panel}`),
  reach: async (v) => {
    await press(v.page, "Control+l");
  },
};
const onNewNote = {
  state: "the keyboard on New note",
  check: (s) => onRow(s, "New note"),
  reach: async (v) => {
    await onNotesRow.reach(v);
    await v.see(onNotesRow.check);
    await press(v.page, "g", "g");
  },
};
const notesListed = {
  state: "Notes showing its list",
  check: (s) => want(s.notes === "note-list", `Notes shows ${s.notes}`),
  reach: () => {},
};

for (const engine of ENGINES) {
  test(`the lists on / in ${engine.name}`, ...journey({
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
        const reload = async () => {
          await page.reload({ waitUntil: "domcontentloaded" });
          await ready(page);
        };
        return { page, problems, reload, close: () => context.close() };
      } catch (error) {
        await context.close();
        throw error;
      }
    },
    look,
  }, [
    {
      // Ctrl+h puts the keyboard on the open book's tile, the last of the shelf.
      name: "Ctrl+h then gg in a long Books shelf keeps the first book in view",
      from: inReader,
      run: async (v) => {
        await press(v.page, "Control+h");
        // The twelve copies, the sample and the journal, which books presents first.
        await v.see((s) => want(s.panel === "list-then-item#books" && s.place?.endsWith(`of ${SHELF + 2}`), `the keyboard is on ${s.deep} ${s.place} in ${s.panel}`));
        await press(v.page, "g", "g");
        await v.see((s) => at(s, "first"));
      },
    },
    {
      name: "G in the Books shelf goes to the last book, in view",
      run: async (v) => {
        await press(v.page, "G");
        await v.see((s) => at(s, "last"));
      },
    },
    {
      name: "a note opened by mouse, then Escape, puts the keyboard back on its row",
      run: async (v) => {
        await clickRow(v.page, "note-list", "Note two");
        await v.see((s) => want(s.notes === "note-editor" && s.editor?.startsWith("Note two"), `Notes shows ${s.notes} holding ${JSON.stringify(s.editor)}`));
        await press(v.page, "Escape");
        await v.see((s) => all(want(s.notes === "note-list", `Notes shows ${s.notes}`), onRow(s, "Note two")));
      },
    },
    {
      name: "G in a long Notes list keeps the last note in view",
      from: onNotesRow,
      run: async (v) => {
        await press(v.page, "G");
        await v.see((s) => at(s, "last"));
      },
    },
    {
      // A letter is pressed on a row while the note it opened before is still behind the
      // list: only k may do something. k's move says the letters before it were handled.
      name: "at the last note, j and x a s change nothing and k moves up",
      run: async (v) => {
        const before = await v.look();
        await press(v.page, "j", "x", "a", "s", "k");
        await v.see((s) => {
          const [n, of] = (s.place ?? "").split(" of ").map(Number);
          return all(want(n === of - 1, `the keyboard is on ${s.deep} ${s.place}, not the row above the last`),
            unchanged(s, before, "editor"), unchanged(s, before, "rows"), unchanged(s, before, "chatBox"));
        });
      },
    },
    {
      name: "gg in the Notes list goes back to New note, in view",
      run: async (v) => {
        await press(v.page, "g", "g");
        await v.see((s) => all(onRow(s, "New note"), at(s, "first")));
      },
    },
    {
      name: "j from New note lands on Highlights, and Enter opens them with the keyboard inside",
      from: onNewNote,
      run: async (v) => {
        await press(v.page, "j");
        await v.see((s) => onRow(s, "Highlights"));
        await press(v.page, "Enter");
        await v.see((s) => want(s.notes === "highlight-notes" && s.focus.includes("highlight-notes"), `Notes shows ${s.notes}, the keyboard in ${s.focus}`));
      },
    },
    {
      name: "Escape from the Highlights puts the keyboard on their row, and j goes on to the notes",
      run: async (v) => {
        await press(v.page, "Escape");
        await v.see((s) => all(want(s.notes === "note-list", `Notes shows ${s.notes}`), onRow(s, "Highlights")));
        await press(v.page, "j");
        await v.see((s) => onRow(s, "Note three"));
      },
    },
    {
      name: "the Highlights left open are open after a reload, and Ctrl+l puts the keyboard in them",
      from: notesListed,
      run: async (v) => {
        await clickRow(v.page, "note-list", "Highlights");
        await v.see((s) => want(s.notes === "highlight-notes", `Notes shows ${s.notes}`));
        await v.reload();
        await press(v.page, "Control+l");
        await v.see((s) => want(s.notes === "highlight-notes" && s.focus.includes("highlight-notes"), `Notes shows ${s.notes}, the keyboard in ${s.focus}`));
      },
    },
    {
      name: "after the reload, Escape puts the keyboard on the Highlights row, and j goes on to the notes",
      run: async (v) => {
        await press(v.page, "Escape");
        await v.see((s) => all(want(s.notes === "note-list", `Notes shows ${s.notes}`), onRow(s, "Highlights")));
        await press(v.page, "j");
        await v.see((s) => onRow(s, "Note three"));
      },
    },
  ]));
}

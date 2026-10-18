import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomInt } from "node:crypto";

// Tabs and panels on the product page, from the keyboard, with "Vim keys" on: one journey
// (9), approved in checks/journeys.json. One account with the sample book, three notes and
// two chats, and no model chosen; the page loads once. Which panel Ctrl+h and Ctrl+l reach
// is tested in this component's keys test; here it is the frame that follows them, the tab
// keys, and that the keyboard stays on the desk after a click on bare space, a tab click,
// or a focus Safari drops.
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

// A user set up straight through the server (5): the sample book open, three notes about it
// and two chats about it. No model is chosen, which is what one step is about.
const seedUser = async () => {
  const cookie = forgeCookie("tabs");
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
const VIM = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

// Settled: the book open on Chapter One, the notes and chats listed, the keyboard on the Reader.
const ready = (page) =>
  page.waitForFunction((n) => {
    const r = document.querySelector("book-reader")?.shadowRoot;
    return (
      r?.querySelector(".footer .chap")?.textContent.trim() === "Chapter One" &&
      r.querySelector(".strip")?.textContent.includes("A short opening") &&
      document.querySelector("note-list")?.shadowRoot?.querySelectorAll("li.row:not(.draft):not(.highlights)").length === n &&
      document.querySelector("conversation-list")?.shadowRoot?.querySelectorAll("li.row").length >= 2 &&
      Boolean(r.activeElement)
    );
  }, NOTES.length);

// What the user sees of the desk, read in one go.
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
    const desk = document.querySelector("dock-desk").shadowRoot;
    const cm = (tag) => {
      const content = document.querySelector(tag)?.shadowRoot?.querySelector(".cm-content");
      if (!content) return null;
      return [...content.querySelectorAll(".cm-line")]
        .map((line) => [...line.childNodes].filter((n) => !n.classList?.contains("cm-placeholder")).map((n) => n.textContent).join(""))
        .join("\n");
    };
    return {
      panel: owner ? owner.localName + (owner.id ? `#${owner.id}` : "") : null,
      focus: chain.join(" > "),
      deep: deep ? deep.localName + (deep.getAttribute?.("role") ? `[${deep.getAttribute("role")}]` : "") + (typeof deep.className === "string" && deep.className.trim() ? `.${deep.className.trim().split(/\s+/)[0]}` : "") : null,
      deepText: (deep?.querySelector?.(".name") ?? deep)?.textContent?.trim().slice(0, 30) ?? null,
      // The groups drawn with the frame that says the keyboard is in them.
      framed: [...desk.querySelectorAll(".body")].filter((b) => getComputedStyle(b).outlineStyle !== "none").map((b) => b.dataset.side),
      rightTab: desk.querySelector('.dock.right .panel [role="tab"][aria-selected="true"]')?.textContent.trim() ?? null,
      notes: shows("notes"),
      chats: shows("chats"),
      editor: cm("note-editor"),
      chatBox: cm("chat-input"),
      // A passage in progress in the Reader, painted through the CSS Custom Highlight API.
      pending: Boolean(globalThis.CSS?.highlights?.get("reader-pending")?.size),
    };
  });

const want = (cond, msg) => (cond ? null : msg);
const all = (...checks) => checks.find(Boolean) ?? null;
const unchanged = (s, before, what) => want(JSON.stringify(s[what]) === JSON.stringify(before[what]), `${what} changed from ${JSON.stringify(before[what])} to ${JSON.stringify(s[what])}`);
const onRow = (s, text) =>
  want(s.deep?.startsWith("li[option]") && s.deepText?.startsWith(text), `the keyboard is on ${s.deep} "${s.deepText}", not a row "${text}…"`);
const inPanel = (address) => (s) => want(s.panel === address, `the keyboard is in ${s.focus}, not ${address}`);
const showing = (tab, address) => (s) => all(want(s.rightTab === tab, `the tab shown is ${s.rightTab}`), inPanel(address)(s));
const framed = (side) => (s) => want(JSON.stringify(s.framed) === JSON.stringify([side]), `framed: ${JSON.stringify(s.framed)}`);

const press = async (page, ...keys) => {
  for (const key of keys) await page.keyboard.press(key);
};
// A key that should do nothing shows nothing to wait for: the next two frames are when
// anything it did would have been drawn.
const drawn = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
// Safari leaves a clicked button unfocused, and the keyboard on the bare page: drop the
// focus the way it does.
const safari = (page) =>
  page.evaluate(() => {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    a?.blur();
    document.activeElement?.blur();
  });
// A click where the user would put the mouse, by the box of what they see.
const clickAt = async (page, find, arg) => {
  const box = await page.evaluate(find, arg);
  assert.ok(box, `nothing to click for ${find.name} ${arg ?? ""}`);
  await page.mouse.click(box.x, box.y);
};
function row([tag, text]) {
  const el = [...(document.querySelector(tag)?.shadowRoot?.querySelectorAll("li.row") ?? [])].find((r) => r.textContent.includes(text));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 3, y: r.top + r.height / 2 };
}
function deskTab(label) {
  const el = [...document.querySelector("dock-desk").shadowRoot.querySelectorAll('.dock .panel [role="tab"]')].find((t) => t.textContent.trim() === label);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
// Bare desk: the stage header between the Reader's tab and the header's buttons.
function blankHeader() {
  const strip = document.querySelector("dock-desk").shadowRoot.querySelector(".stage .strip");
  const tabs = strip.querySelector('[role="tablist"]').getBoundingClientRect();
  const next = strip.querySelector('[role="tablist"]').nextElementSibling.getBoundingClientRect();
  return { x: (tabs.right + next.left) / 2, y: tabs.top + tabs.height / 2 };
}
// Bare panel: the Notes panel below the list, which is only as tall as its rows.
function blankNotes() {
  const list = document.querySelector("note-list").getBoundingClientRect();
  const panel = document.getElementById("notes").getBoundingClientRect();
  return { x: list.left + list.width / 2, y: (list.bottom + panel.bottom) / 2 };
}

const inReader = {
  state: "the keyboard in the Reader",
  check: inPanel("book-stage"),
  reach: () => {},
};
const inNotes = {
  state: "the keyboard in Notes",
  check: showing("Notes", "list-then-item#notes"),
  reach: async (v) => {
    await press(v.page, "Control+l");
  },
};
const notesShown = {
  state: "Notes the tab shown, listing the notes",
  check: (s) => want(s.rightTab === "Notes" && s.notes === "note-list", `the tab shown is ${s.rightTab}, Notes shows ${s.notes}`),
  reach: () => {},
};

for (const engine of ENGINES) {
  test(`tabs and panels on / in ${engine.name}`, ...journey({
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
      name: "the frame is on the Reader, Ctrl+l moves it to Notes and Ctrl+h back",
      from: inReader,
      run: async (v) => {
        await v.see(framed("stage"));
        await press(v.page, "Control+l");
        await v.see((s) => all(inPanel("list-then-item#notes")(s), framed("right")(s)));
        await press(v.page, "Control+h");
        await v.see((s) => all(inPanel("book-stage")(s), framed("stage")(s)));
      },
    },
    {
      name: "gt in the Reader, alone on the stage, does nothing",
      from: inReader,
      run: async (v) => {
        await press(v.page, "g", "t");
        await drawn(v.page);
        await v.see((s) => all(inPanel("book-stage")(s), want(s.rightTab === "Notes", `the tab shown is ${s.rightTab}`), want(!s.pending, "a passage is pending")));
      },
    },
    {
      name: "a click on bare desk keeps the keyboard in the Reader, and Ctrl+l and Ctrl+h working",
      from: inReader,
      run: async (v) => {
        await clickAt(v.page, blankHeader);
        await v.see(inPanel("book-stage"));
        await press(v.page, "Control+l");
        await v.see(inPanel("list-then-item#notes"));
        await press(v.page, "Control+h");
        await v.see(inPanel("book-stage"));
      },
    },
    {
      name: "with the focus dropped Safari style on the Reader, Ctrl+l still works",
      from: inReader,
      run: async (v) => {
        await safari(v.page);
        await v.see(inPanel("book-stage"));
        await press(v.page, "Control+l");
        await v.see(inPanel("list-then-item#notes"));
      },
    },
    {
      name: "with the focus dropped Safari style on Notes, j still works",
      from: inNotes,
      run: async (v) => {
        await safari(v.page);
        await v.see(inPanel("list-then-item#notes"));
        await press(v.page, "j");
        await v.see((s) => onRow(s, "Note"));
      },
    },
    {
      name: "gt from a list shows the next tab, and gT the one before",
      from: inNotes,
      run: async (v) => {
        await press(v.page, "g", "t");
        await v.see(showing("Chats", "list-then-item#chats"));
        await press(v.page, "g", "T");
        await v.see(showing("Notes", "list-then-item#notes"));
      },
    },
    {
      name: "a click below the notes keeps Ctrl+. and Ctrl+, working",
      from: inNotes,
      run: async (v) => {
        await clickAt(v.page, blankNotes);
        await v.see((s) => all(inPanel("list-then-item#notes")(s), want(s.notes === "note-list", `Notes shows ${s.notes}`)));
        await press(v.page, "Control+.");
        await v.see(showing("Chats", "list-then-item#chats"));
        await press(v.page, "Control+,");
        await v.see(showing("Notes", "list-then-item#notes"));
      },
    },
    {
      name: "a tab click puts the keyboard in the panel it shows",
      from: notesShown,
      run: async (v) => {
        await clickAt(v.page, deskTab, "Chats");
        await v.see(showing("Chats", "list-then-item#chats"));
        await press(v.page, "j");
        await v.see((s) => onRow(s, "Chat"));
      },
    },
    {
      name: "a tab click Safari style puts the keyboard in the panel it shows",
      run: async (v) => {
        await clickAt(v.page, deskTab, "Notes");
        await safari(v.page);
        await v.see(showing("Notes", "list-then-item#notes"));
        await press(v.page, "j");
        await v.see((s) => onRow(s, "Note"));
      },
    },
    {
      name: "with no model chosen, Ctrl+. from a note to a chat left open puts the keyboard where letters type nothing",
      from: notesShown,
      run: async (v) => {
        await clickAt(v.page, deskTab, "Chats");
        await v.see((s) => want(s.rightTab === "Chats", `the tab shown is ${s.rightTab}`));
        await clickAt(v.page, row, ["conversation-list", "Chat 1"]);
        await v.see((s) => want(s.chats === "chat-thread", `Chats shows ${s.chats}`));
        await clickAt(v.page, deskTab, "Notes");
        await v.see((s) => want(s.rightTab === "Notes", `the tab shown is ${s.rightTab}`));
        await clickAt(v.page, row, ["note-list", "Note two"]);
        await v.see((s) => want(s.notes === "note-editor" && s.focus.includes("note-editor"), `Notes shows ${s.notes}, the keyboard in ${s.focus}`));
        const before = await v.look();
        await press(v.page, "Control+.");
        await v.see(showing("Chats", "list-then-item#chats"));
        await press(v.page, "j", "k");
        await drawn(v.page);
        await v.see((s) => all(unchanged(s, before, "editor"), want(s.chatBox === "", `the chat box holds "${s.chatBox}"`), inPanel("list-then-item#chats")(s)));
      },
    },
  ]));
}

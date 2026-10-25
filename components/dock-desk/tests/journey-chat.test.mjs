import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomInt } from "node:crypto";

// The chat box on the product page, from the keyboard, with "Vim keys" on: one journey (9),
// approved in checks/journeys.json. One account with the sample book, three notes and two
// chats, answered by the Echo provider; the page loads once. The keyboard goes into a
// chat's box and out of it, through the chat list, and from a note being written to the
// chats; no letter lands in a box or a note the user is not in, and a question typed from
// the keyboard is sent and answered.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, journey, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

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

// A user set up straight through the server (5): the sample book open, three notes about it,
// two chats about it, and the Echo provider so the chat box answers without a key.
const seedUser = async () => {
  const cookie = forgeCookie("chat");
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
  await json(`/api/llm`, { provider: "echo", model: "echo" });
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

// What the user sees of the panels, the note and the chat, read in one go.
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
    // The text typed into a CodeMirror editor, its placeholder left out.
    const cm = (tag) => {
      const content = document.querySelector(tag)?.shadowRoot?.querySelector(".cm-content");
      if (!content) return null;
      return [...content.querySelectorAll(".cm-line")]
        .map((line) => [...line.childNodes].filter((n) => !n.classList?.contains("cm-placeholder")).map((n) => n.textContent).join(""))
        .join("\n");
    };
    const names = (tag, sel) => [...(document.querySelector(tag)?.shadowRoot?.querySelectorAll(sel) ?? [])].map((r) => (r.querySelector(".name") ?? r).textContent.trim());
    return {
      panel: owner ? owner.localName + (owner.id ? `#${owner.id}` : "") : null,
      focus: chain.join(" > "),
      deep: deep ? deep.localName + (deep.getAttribute?.("role") ? `[${deep.getAttribute("role")}]` : "") + (typeof deep.className === "string" && deep.className.trim() ? `.${deep.className.trim().split(/\s+/)[0]}` : "") : null,
      deepText: (deep?.querySelector?.(".name") ?? deep)?.textContent?.trim().slice(0, 30) ?? null,
      rightTab: desk.querySelector('.dock.right .panel [role="tab"][aria-selected="true"]')?.textContent.trim() ?? null,
      notes: shows("notes"),
      chats: shows("chats"),
      editor: cm("note-editor#notes-editor"),
      rows: names("note-list", "li.row").join(", "),
      chatRows: names("conversation-list", "li.row"),
      chatOpen: names("conversation-list", 'li.row[aria-selected="true"]')[0] ?? null,
      chatBox: cm("chat-input"),
      // Vim's normal mode in the chat box: the block cursor in place of the caret. The box
      // enters insert mode a frame after it takes the keyboard, so letters typed before
      // that would be Vim commands.
      chatNormal: Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector(".cm-scroller.cm-vimMode")),
      thread: [...(document.querySelector("chat-thread")?.shadowRoot?.querySelectorAll(".turn") ?? [])].map(
        (t) => `${t.classList.contains("user") ? "user" : "model"}: ${(t.querySelector(".answer") ?? t).textContent.trim()}`,
      ),
    };
  });

const want = (cond, msg) => (cond ? null : msg);
const all = (...checks) => checks.find(Boolean) ?? null;
const unchanged = (s, before, what) => want(JSON.stringify(s[what]) === JSON.stringify(before[what]), `${what} changed from ${JSON.stringify(before[what])} to ${JSON.stringify(s[what])}`);
const onRow = (s, text) =>
  want(s.deep?.startsWith("li[option]") && s.deepText?.startsWith(text), `the keyboard is on ${s.deep} "${s.deepText}", not the row "${text}"`);
// The chat list's row for the chat open behind it, or New chat when none is.
const chatRow = (s) => s.chatOpen ?? "New chat";
const inChats = (s) => want(s.panel === "list-then-item#chats", `the keyboard is in ${s.focus}`);

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
function chatBox() {
  const el = document.querySelector("chat-input")?.shadowRoot?.querySelector(".cm-content");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + 10, y: r.top + r.height / 2 };
}
// Bare desk: the stage header between the Reader's tab and the header's buttons.
function blankHeader() {
  const strip = document.querySelector("dock-desk").shadowRoot.querySelector(".stage .strip");
  const tabs = strip.querySelector('[role="tablist"]').getBoundingClientRect();
  const next = strip.querySelector('[role="tablist"]').nextElementSibling.getBoundingClientRect();
  return { x: (tabs.right + next.left) / 2, y: tabs.top + tabs.height / 2 };
}

// The notes as the server holds them, after the page is told to send what it has.
const server = (page) =>
  page.evaluate(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    return (await (await fetch("/api/notes")).json()).notes.map((n) => `${n.title}\n${n.body}`);
  });

// The question sent and the Echo provider's answer shown, the box emptied.
const asked = (text) => (s) =>
  all(want(s.thread.includes(`user: ${text}`), `the thread shows ${JSON.stringify(s.thread)}`), want(s.thread.includes(`model: ${text}`), `no answer: ${JSON.stringify(s.thread)}`), want(s.chatBox === "", `the chat box holds "${s.chatBox}"`));

// The open chat's box, as a person reaches it: the Chats tab, Chat 1, a click in the box.
const openChat1 = async (v) => {
  await clickAt(v.page, deskTab, "Chats");
  await v.see((s) => want(s.rightTab === "Chats", `the tab shown is ${s.rightTab}`));
  await clickAt(v.page, row, ["conversation-list", "Chat 1"]);
  await v.see((s) => want(s.chats === "chat-thread" && s.thread.includes("user: question 1"), `Chats shows ${s.chats}: ${JSON.stringify(s.thread)}`));
  await clickAt(v.page, chatBox);
  await v.see((s) => want(s.focus.includes("chat-input"), `the keyboard is in ${s.focus}`));
};

const inReader = {
  state: "the keyboard in the Reader",
  check: (s) => want(s.panel === "book-stage", `the keyboard is in ${s.panel}`),
  reach: () => {},
};
const onChat1Row = {
  state: "the keyboard on the row of Chat 1, open behind the list",
  check: (s) => all(want(s.chats === "conversation-list" && s.chatOpen === "Chat 1", `Chats shows ${s.chats}, ${s.chatOpen} open`), onRow(s, "Chat 1")),
  reach: async (v) => {
    await openChat1(v);
    await press(v.page, "Escape", "Escape");
  },
};
const notesListed = {
  state: "Notes showing its list",
  check: (s) => want(s.notes === "note-list", `Notes shows ${s.notes}`),
  reach: () => {},
};
const typedNote = {
  state: "Note two open with hey typed at its start, in Vim's normal mode",
  check: (s) => all(want(s.notes === "note-editor" && s.focus.includes("note-editor"), `Notes shows ${s.notes}, the keyboard in ${s.focus}`), want(s.editor?.startsWith("hey"), `the note holds ${JSON.stringify(s.editor)}`)),
  reach: async (v) => {
    await clickAt(v.page, row, ["note-list", "Note two"]);
    await v.see((s) => want(s.focus.includes("note-editor"), `the keyboard is in ${s.focus}`));
    await press(v.page, "i", "h", "e", "y", "Escape");
  },
};
const onNewChat = {
  state: "the keyboard on New chat",
  check: (s) => all(want(s.chats === "conversation-list", `Chats shows ${s.chats}`), onRow(s, "New chat")),
  reach: async (v) => {
    await clickAt(v.page, deskTab, "Chats");
    await v.see(inChats);
    await press(v.page, "g", "g");
  },
};

for (const engine of ENGINES) {
  // Browser: focus and keys.
  test(`the chat box on / in ${engine.name}`, ...journey({
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
      name: "Escape twice from a chat's box puts the keyboard on the chat's row",
      from: inReader,
      run: async (v) => {
        await openChat1(v);
        await press(v.page, "Escape", "Escape");
        await v.see(onChat1Row.check);
      },
    },
    {
      // k's move says the letters before it were handled.
      name: "letters on the chat's row type nothing into its box, and k and j still move",
      run: async (v) => {
        await press(v.page, "a", "s", "k");
        await v.see((s) => all(want(s.chatBox === "", `the chat box holds "${s.chatBox}"`), want(s.deep?.startsWith("li[option]") && s.deepText !== "Chat 1", `the keyboard is on ${s.deep} "${s.deepText}"`)));
        await press(v.page, "j");
        await v.see((s) => onRow(s, "Chat 1"));
      },
    },
    {
      name: "letters after a click on bare desk type nothing anywhere",
      from: onChat1Row,
      run: async (v) => {
        const before = await v.look();
        await clickAt(v.page, blankHeader);
        await v.see(inChats);
        await press(v.page, "a", "s");
        await drawn(v.page);
        await v.see((s) => all(inChats(s), want(s.chatBox === "", `the chat box holds "${s.chatBox}"`), unchanged(s, before, "editor"), unchanged(s, before, "rows")));
      },
    },
    {
      name: "k k from an open chat's row reaches New chat, and Enter puts the cursor in an empty chat",
      from: onChat1Row,
      run: async (v) => {
        await press(v.page, "k", "k");
        await v.see((s) => onRow(s, "New chat"));
        await press(v.page, "Enter");
        await v.see((s) => all(want(s.chats === "chat-thread", `Chats shows ${s.chats}`), want(s.focus.includes("chat-input") && !s.chatNormal, `the keyboard is in ${s.focus}, normal mode ${s.chatNormal}`), want(s.thread.length === 0, `the thread shows ${JSON.stringify(s.thread)}`)));
      },
    },
    {
      // The box opens in Vim's insert mode, where Enter makes a line (architecture 10, the
      // rich editor row); Escape to normal mode, then Enter sends.
      name: "hello, Escape, Enter asks the new chat",
      run: async (v) => {
        await v.page.keyboard.type("hello", { delay: 30 });
        await press(v.page, "Escape", "Enter");
        await v.see(asked("hello"));
        // The box is in normal mode after sending: Escape puts the keyboard on the
        // conversation, and Escape there on the chat's row.
        await press(v.page, "Escape", "Escape");
        await v.see((s) => all(want(s.chats === "conversation-list" && s.chatOpen, `Chats shows ${s.chats}, ${s.chatOpen} open`), onRow(s, chatRow(s))));
      },
    },
    {
      name: "a note opened by mouse takes what is typed",
      from: notesListed,
      run: async (v) => {
        await clickAt(v.page, deskTab, "Notes");
        await v.see((s) => want(s.rightTab === "Notes", `the tab shown is ${s.rightTab}`));
        await typedNote.reach(v);
        // Settled once the list shows the typed note, which then moves to the top.
        await v.see((s) => all(typedNote.check(s), want(s.rows.startsWith("New note, hey") || s.rows.includes(", hey"), `the list shows ${s.rows}`)));
      },
    },
    {
      // The owner's own path: a note typed in, Escape to Vim's normal mode, Ctrl+. to Chats.
      name: "Ctrl+. from the typed note lands on the chat list's row, and j moves there",
      from: typedNote,
      run: async (v) => {
        const typed = await v.look();
        await press(v.page, "Control+.");
        const landed = await v.see((s) => all(want(s.rightTab === "Chats" && s.chats === "conversation-list", `Chats shows ${s.chats} on ${s.rightTab}`), onRow(s, chatRow(s))));
        const below = landed.chatRows[landed.chatRows.indexOf(landed.deepText) + 1];
        await press(v.page, "j");
        await v.see((s) => all(onRow(s, below), unchanged(s, typed, "editor")));
      },
    },
    {
      name: "k back on the chat list leaves the note as typed, here and on the server",
      run: async (v) => {
        const before = await v.look();
        await press(v.page, "k");
        await v.see((s) => all(want(s.deep?.startsWith("li[option]") && s.deepText !== before.deepText, `the keyboard is on ${s.deep} "${s.deepText}"`), unchanged(s, before, "editor"), unchanged(s, before, "rows")));
        let note;
        await until(async () => {
          note = (await server(v.page)).find((n) => n.includes("hey"));
          return Boolean(note);
        });
        assert.ok(!/[jk]/.test(note), `the note was saved with a letter pressed elsewhere: ${JSON.stringify(note)}`);
      },
    },
    {
      name: "gg reaches New chat, and with the focus then dropped Safari style j k j still move the chats",
      run: async (v) => {
        const before = await v.look();
        await press(v.page, "g", "g");
        await v.see((s) => onRow(s, "New chat"));
        await safari(v.page);
        await v.see((s) => onRow(s, "New chat"));
        await press(v.page, "j", "k", "j");
        await v.see((s) => all(onRow(s, s.chatRows[1]), unchanged(s, before, "editor"), unchanged(s, before, "rows")));
        await press(v.page, "k");
        await v.see((s) => onRow(s, "New chat"));
      },
    },
    {
      name: "Enter on New chat puts the cursor in the chat box, and what is typed goes there only",
      from: onNewChat,
      run: async (v) => {
        const before = await v.look();
        await press(v.page, "Enter");
        await v.see((s) => all(want(s.chats === "chat-thread", `Chats shows ${s.chats}`), want(s.focus.includes("chat-input") && !s.chatNormal, `the keyboard is in ${s.focus}, normal mode ${s.chatNormal}`), unchanged(s, before, "editor")));
        await press(v.page, "o", "k");
        await v.see((s) => all(want(s.chatBox === "ok", `the chat box holds "${s.chatBox}"`), unchanged(s, before, "editor")));
      },
    },
    {
      name: "Escape, Enter asks what was typed",
      run: async (v) => {
        await press(v.page, "Escape", "Enter");
        await v.see(asked("ok"));
      },
    },
  ]));
}

import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomInt } from "node:crypto";

// The keyboard journey on the product page (plan Revision 1, item 4): the owner's own way
// of using `/` with "Vim keys" on, pressed at a human pace, asserting after every step what
// the user sees. A late focus move, a letter typed into a hidden editor, a dead key, a tab
// or a fold that does not happen fails here by step name, with every step's state printed.
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
// two chats about it, and the Echo provider so the chat box takes text without a key.
const seedUser = async ({ echo = true } = {}) => {
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
  if (echo) await json(`/api/llm`, { provider: "echo", model: "echo" });
  return cookie;
};

// The "Vim keys" preference (12) in both profiles' copies, the way settings stores it.
const seed = (vimKeys) =>
  JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });

// Everything the user can see that the journey asserts on, read in one go.
const look = (page) =>
  page.evaluate(() => {
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
    return {
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
      rows,
      chapter: reader.querySelector(".footer .chap")?.textContent.trim() ?? null,
      pageNo: reader.querySelector(".footer .pageno")?.textContent.trim() ?? null,
      cursor: cursorAt(),
      pending: painted("reader-pending"),
      marks: [...reader.querySelectorAll(".strip mark")].map((m) => m.textContent.replace(/\s+/g, " ")),
    };
  });

// The panel (a desk child, by its address) the keyboard is in, and the row it is on.
const panel = (s) => s.panel;
const chatRow = (s) => s.chatOpen ?? "New chat";
const onRow = (s, text) => s.deep?.startsWith("li[option]") && s.deepText?.startsWith(text);

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
const centre = (el) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
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
// Bare panel: the Notes list below its last row.
function blankNotes() {
  const r = document.querySelector("note-list").getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.bottom - 40 };
}
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
    const open = async (vimKeys = true, { echo = true } = {}) => {
      context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, await seedUser({ echo }));
      await context.addInitScript((value) => {
        localStorage.setItem("settings", value);
        localStorage.setItem("settings:product", value);
      }, seed(vimKeys));
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
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
      // The notes as the server holds them, after the page is told to send what it has.
      const server = async () => {
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await pause(150);
        return page.evaluate(async () => (await (await fetch("/api/notes")).json()).notes.map((n) => ({ id: n.id, title: n.title, body: n.body, version: n.version })));
      };
      return { page, problems, step, reach, server };
    };
    const clean = (problems) => assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);

    // --- F1: no letter types into a note or a chat box the user is not in -------------

    test(`a note opened by mouse, then Escape, puts the keyboard back on its row in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(clickAt(page, row, ["note-list", "Note two"]), (s) => s.notes === "note-editor" && s.editor?.startsWith("Note two"));
      await step("Escape", keys(page, "Escape"), (s) =>
        all(want(s.notes === "note-list", `Notes shows ${s.notes}`), want(onRow(s, "Note two"), `the keyboard is on ${s.deep} "${s.deepText}"`)), SETTLE);
      clean(problems);
    });

    test(`letters on a list row type nothing into the note it opened in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(clickAt(page, row, ["note-list", "Note two"]), (s) => s.notes === "note-editor" && s.editor?.startsWith("Note two"));
      await reach(quick(page, "Escape"), (s) => s.notes === "note-list" && onRow(s, "Note two"));
      const before = await look(page);
      await step("G then j at the last row", keys(page, "G", "j"), (s) =>
        all(want(onRow(s, "Note one"), `the keyboard is on "${s.deepText}"`), unchanged(s, before, "editor"), unchanged(s, before, "rows")));
      await step("x a s", keys(page, "x", "a", "s"), (s) =>
        all(want(onRow(s, "Note one"), `the keyboard is on "${s.deepText}"`), unchanged(s, before, "editor"), unchanged(s, before, "rows"), unchanged(s, before, "chatBox")));
      await step("k", keys(page, "k"), (s) => all(want(onRow(s, "Note two"), `the keyboard is on "${s.deepText}"`), unchanged(s, before, "editor")));
      clean(problems);
    });

    test(`letters after leaving the chat box type nothing into it in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(clickAt(page, deskTab, "Chat"), (s) => s.rightTab === "Chat");
      await reach(clickAt(page, row, ["conversation-list", "Chat 1"]), (s) => s.chats === "chat-thread" && s.chatBox !== null);
      await reach(clickAt(page, chatBox), (s) => s.focus.includes("chat-input"));
      await step("Escape Escape", keys(page, "Escape", "Escape"), (s) =>
        all(want(s.chats === "conversation-list", `Chat shows ${s.chats}`), want(onRow(s, "Chat"), `the keyboard is on ${s.deep} "${s.deepText}"`)), SETTLE);
      await step("a s on the row", keys(page, "a", "s"), (s) => all(want(s.chatBox === "", `the chat box holds "${s.chatBox}"`), want(onRow(s, "Chat"), `the keyboard is on ${s.deep}`)));
      clean(problems);
    });

    test(`letters after a click on bare desk type nothing anywhere in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(clickAt(page, deskTab, "Chat"), (s) => s.rightTab === "Chat");
      await reach(clickAt(page, row, ["conversation-list", "Chat 1"]), (s) => s.chats === "chat-thread" && s.chatBox !== null);
      await reach(clickAt(page, chatBox), (s) => s.focus.includes("chat-input"));
      await reach(quick(page, "Escape", "Escape"), (s) => s.chats === "conversation-list");
      const before = await look(page);
      await step("click bare desk space", clickAt(page, blankHeader), (s) => want(panel(s) === "list-then-item#chats", `the keyboard is in ${s.focus}`));
      await step("a s", keys(page, "a", "s"), (s) => all(want(s.chatBox === "", `the chat box holds "${s.chatBox}"`), unchanged(s, before, "editor")));
      clean(problems);
    });

    // The owner's own path: a note opened by mouse and typed in, Escape to Vim's normal
    // mode, Ctrl+. to Chat. The keyboard must land on the chat list's row, j/k move there,
    // and the note keeps exactly what was typed, on the page and on the server.
    const typedNote = async (page, reach) => {
      await reach(clickAt(page, row, ["note-list", "Note two"]), (s) => s.notes === "note-editor" && s.focus.includes("note-editor"));
      for (const k of ["i", "h", "e", "y", "Escape"]) await page.keyboard.press(k);
      // Settled once the list shows the typed note, which then moves to the top.
      await until(async () => {
        const s = await look(page);
        return s.editor?.startsWith("hey") && s.rows.some((r) => r.startsWith("hey"));
      });
      return { look: await look(page) };
    };
    // The typed note as the server ends up holding it: "hey" typed, and no j or k after it.
    const savedAsTyped = async (server) => {
      let note;
      await until(async () => {
        note = (await server()).find((n) => `${n.title}\n${n.body}`.includes("hey"));
        return Boolean(note);
      });
      assert.ok(!/[jk]/.test(`${note.title}\n${note.body}`), `the note was saved with a letter pressed elsewhere: ${JSON.stringify(note)}`);
    };

    test(`Ctrl+. from a typed note lands on the chat list, and j moves there in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      const typed = await typedNote(page, reach);
      const landed = await step("Ctrl+.", keys(page, "Control+."), (s) =>
        all(want(s.rightTab === "Chat" && s.chats === "conversation-list", `Chat shows ${s.chats} on ${s.rightTab}`), want(onRow(s, chatRow(s)), `the keyboard is on ${s.deep} "${s.deepText}", not ${chatRow(s)}`)), SETTLE);
      const below = landed.chatRows[landed.chatRows.indexOf(landed.deepText) + 1];
      await step("j", keys(page, "j"), (s) => all(want(onRow(s, below), `the keyboard is on ${s.deep} "${s.deepText}", not ${below}`), unchanged(s, typed.look, "editor")));
      clean(problems);
    });

    test(`j and k on the chat list after Ctrl+. from a typed note leave the note as typed in ${engine.name}`, async () => {
      const { page, problems, step, reach, server } = await open();
      const typed = await typedNote(page, reach);
      await reach(quick(page, "Control+."), (s) => s.chats === "conversation-list" && onRow(s, chatRow(s)));
      const landed = await look(page);
      await step("j k", keys(page, "j", "k"), (s) =>
        all(want(onRow(s, landed.deepText), `the keyboard is on ${s.deep} "${s.deepText}"`), unchanged(s, typed.look, "editor"), unchanged(s, typed.look, "rows")));
      await savedAsTyped(server);
      clean(problems);
    });

    test(`Enter on New chat after Ctrl+. from a typed note puts the cursor in the chat box in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      const typed = await typedNote(page, reach);
      await reach(quick(page, "Control+."), (s) => s.chats === "conversation-list" && onRow(s, chatRow(s)));
      await reach(quick(page, "g", "g"), (s) => onRow(s, "New chat"));
      await step("Enter on New chat", keys(page, "Enter"), (s) =>
        all(want(s.chats === "chat-thread", `Chat shows ${s.chats}`), want(s.focus.includes("chat-input"), `the keyboard is in ${s.focus}`), unchanged(s, typed.look, "editor")), SETTLE);
      await step("type o k", keys(page, "o", "k"), (s) => all(want(s.chatBox === "ok", `the chat box holds "${s.chatBox}"`), unchanged(s, typed.look, "editor")));
      clean(problems);
    });

    test(`Ctrl+. from a typed note, the focus then dropped Safari style, j still moves the chats in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      const typed = await typedNote(page, reach);
      await reach(quick(page, "Control+."), (s) => s.chats === "conversation-list" && onRow(s, chatRow(s)));
      await reach(quick(page, "g", "g"), (s) => onRow(s, "New chat"));
      await step("the focus dropped", () => safari(page), (s) => want(onRow(s, "New chat"), `the keyboard is on ${s.deep} "${s.deepText}"`));
      await step("j k j", keys(page, "j", "k", "j"), (s) => all(want(onRow(s, s.chatRows[1]), `the keyboard is on ${s.deep} "${s.deepText}"`), unchanged(s, typed.look, "editor"), unchanged(s, typed.look, "rows")));
      clean(problems);
    });

    test(`with no model chosen, Ctrl+. to a chat left open puts the keyboard where letters type nothing in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open(true, { echo: false });
      await reach(clickAt(page, deskTab, "Chat"), (s) => s.rightTab === "Chat");
      await reach(clickAt(page, row, ["conversation-list", "Chat 1"]), (s) => s.chats === "chat-thread");
      await reach(clickAt(page, deskTab, "Notes"), (s) => s.rightTab === "Notes");
      await reach(clickAt(page, row, ["note-list", "Note two"]), (s) => s.notes === "note-editor" && s.focus.includes("note-editor"));
      const before = await look(page);
      await step("Ctrl+.", keys(page, "Control+."), (s) =>
        all(want(s.rightTab === "Chat", `the tab shown is ${s.rightTab}`), want(panel(s) === "list-then-item#chats", `the keyboard is in ${s.focus}`)), SETTLE);
      await step("j k", keys(page, "j", "k"), (s) => all(unchanged(s, before, "editor"), want(s.chatBox === "", `the chat box holds "${s.chatBox}"`), want(panel(s) === "list-then-item#chats", `the keyboard is in ${s.focus}`)));
      clean(problems);
    });

    // --- F2: the keyboard is always somewhere on the desk -----------------------------

    test(`a tab click puts the keyboard in the panel it shows in ${engine.name}`, async () => {
      const { page, problems, step } = await open();
      await step("click the Chat tab", clickAt(page, deskTab, "Chat"), (s) =>
        all(want(s.rightTab === "Chat", `the tab shown is ${s.rightTab}`), want(panel(s) === "list-then-item#chats", `the keyboard is in ${s.focus}`)), SETTLE);
      await step("j", keys(page, "j"), (s) => want(onRow(s, "Chat"), `the keyboard is on ${s.deep} "${s.deepText}"`));
      clean(problems);
    });

    test(`a tab click Safari style puts the keyboard in the panel it shows in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(clickAt(page, deskTab, "Chat"), (s) => s.rightTab === "Chat" && panel(s) === "list-then-item#chats");
      await step("click the Notes tab, Safari style", async () => {
        await clickAt(page, deskTab, "Notes")();
        await safari(page);
      }, (s) => all(want(s.rightTab === "Notes", `the tab shown is ${s.rightTab}`), want(panel(s) === "list-then-item#notes", `the keyboard is in ${s.focus}`)), SETTLE);
      await step("j", keys(page, "j"), (s) => want(onRow(s, "Note"), `the keyboard is on ${s.deep} "${s.deepText}"`));
      clean(problems);
    });

    test(`a click on bare desk keeps Ctrl+l working in ${engine.name}`, async () => {
      const { page, problems, step } = await open();
      await step("click bare desk space", clickAt(page, blankHeader), (s) => want(panel(s) === "book-reader", `the keyboard is in ${s.focus}`));
      await step("Ctrl+l", keys(page, "Control+l"), (s) => want(panel(s) === "list-then-item#notes", `the keyboard is in ${s.focus}`), SETTLE);
      clean(problems);
    });

    test(`a click below the notes keeps Ctrl+. working in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "Control+l"), (s) => panel(s) === "list-then-item#notes");
      await step("click below the notes", clickAt(page, blankNotes), (s) => want(panel(s) === "list-then-item#notes", `the keyboard is in ${s.focus}`));
      await step("Ctrl+.", keys(page, "Control+."), (s) =>
        all(want(s.rightTab === "Chat", `the tab shown is ${s.rightTab}`), want(panel(s) === "list-then-item#chats", `the keyboard is in ${s.focus}`)), SETTLE);
      clean(problems);
    });

    test(`with the focus dropped Safari style the keys still work in ${engine.name}`, async () => {
      const { page, problems, step } = await open();
      await step("the focus dropped on the Reader", () => safari(page), (s) => want(panel(s) === "book-reader", `the keyboard is in ${s.focus}`));
      await step("Ctrl+l", keys(page, "Control+l"), (s) => want(panel(s) === "list-then-item#notes", `the keyboard is in ${s.focus}`), SETTLE);
      await step("the focus dropped on Notes", () => safari(page), (s) => want(panel(s) === "list-then-item#notes", `the keyboard is in ${s.focus}`));
      await step("j", keys(page, "j"), (s) => want(onRow(s, "Note"), `the keyboard is on ${s.deep} "${s.deepText}"`));
      clean(problems);
    });

    // --- R1: the panel with the keyboard is framed ---------------------------------------

    test(`Ctrl+l frames Notes and unframes the Reader in ${engine.name}`, async () => {
      const { page, problems, step } = await open();
      await step("the Reader focused", null, (s) => want(JSON.stringify(s.framed) === '["stage"]', `framed: ${JSON.stringify(s.framed)}`));
      await step("Ctrl+l", keys(page, "Control+l"), (s) =>
        all(want(panel(s) === "list-then-item#notes", `the keyboard is in ${s.focus}`), want(JSON.stringify(s.framed) === '["right"]', `framed: ${JSON.stringify(s.framed)}`)), SETTLE);
      clean(problems);
    });

    test(`Ctrl+h back frames the Reader and unframes Notes in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "Control+l"), (s) => panel(s) === "list-then-item#notes");
      await step("Ctrl+h", keys(page, "Control+h"), (s) =>
        all(want(panel(s) === "book-reader", `the keyboard is in ${s.focus}`), want(JSON.stringify(s.framed) === '["stage"]', `framed: ${JSON.stringify(s.framed)}`)), SETTLE);
      clean(problems);
    });

    // --- R2: New chat from the keyboard ---------------------------------------------------

    // A chat open in the Chat tab, then back on the list with the keyboard on its row.
    const fromOpenChat = async (page, reach) => {
      await reach(clickAt(page, deskTab, "Chat"), (s) => s.rightTab === "Chat");
      await reach(clickAt(page, row, ["conversation-list", "Chat 1"]), (s) => s.chats === "chat-thread" && s.thread.includes("user: question 1"));
      await reach(clickAt(page, chatBox), (s) => s.focus.includes("chat-input"));
      await reach(quick(page, "Escape", "Escape"), (s) => s.chats === "conversation-list" && onRow(s, "Chat 1"));
    };
    // The box opens in Vim's insert mode, where Enter makes a line (architecture 10, the
    // rich editor row); Escape to normal mode, then Enter sends.
    const typeAndSend = (page) => async () => {
      await page.keyboard.type("hello", { delay: 30 });
      await keys(page, "Escape", "Enter")();
    };
    const asked = (s) =>
      all(want(s.thread.includes("user: hello"), `the thread shows ${JSON.stringify(s.thread)}`), want(s.thread.includes("model: hello"), `no answer: ${JSON.stringify(s.thread)}`), want(s.chatBox === "", `the chat box holds "${s.chatBox}"`));

    test(`gg from an open chat's row reaches New chat and Enter puts the cursor in the chat box in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await fromOpenChat(page, reach);
      await step("g g", keys(page, "g", "g"), (s) => want(onRow(s, "New chat"), `the keyboard is on ${s.deep} "${s.deepText}"`));
      await step("Enter on New chat", keys(page, "Enter"), (s) =>
        all(want(s.chats === "chat-thread", `Chat shows ${s.chats}`), want(s.focus.includes("chat-input"), `the keyboard is in ${s.focus}`), want(s.thread.length === 0, `the thread shows ${JSON.stringify(s.thread)}`)), SETTLE);
      clean(problems);
    });

    test(`k k from an open chat's row, Enter, hello, Escape, Enter asks the new chat in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await fromOpenChat(page, reach);
      await step("k k", keys(page, "k", "k"), (s) => want(onRow(s, "New chat"), `the keyboard is on ${s.deep} "${s.deepText}"`));
      await reach(quick(page, "Enter"), (s) => s.chats === "chat-thread" && s.focus.includes("chat-input"));
      await step("type hello, Escape, Enter", typeAndSend(page), asked);
      clean(problems);
    });

    test(`Ctrl+. from a note, gg, Enter, hello, Escape, Enter asks a new chat in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(clickAt(page, row, ["note-list", "Note two"]), (s) => s.notes === "note-editor" && s.focus.includes("note-editor"));
      await reach(quick(page, "Control+."), (s) => s.chats === "conversation-list" && onRow(s, chatRow(s)));
      await step("g g", keys(page, "g", "g"), (s) => want(onRow(s, "New chat"), `the keyboard is on ${s.deep} "${s.deepText}"`));
      await reach(quick(page, "Enter"), (s) => s.chats === "chat-thread" && s.focus.includes("chat-input"));
      await step("type hello, Escape, Enter", typeAndSend(page), asked);
      clean(problems);
    });

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

    test(`the Reader's cursor moves by paragraph and sentence in ${engine.name}`, async () => {
      const { page, problems, step } = await open();
      await step("}", keys(page, "}"), (s) => want(s.cursor?.text === "e" && s.cursor.at === "e", `the cursor is at ${JSON.stringify(s.cursor)}`));
      await step("} w", keys(page, "}", "w"), (s) => want(s.cursor?.at.startsWith("A short"), `the cursor is at ${JSON.stringify(s.cursor)}`));
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
        all(want(panel(s) === "book-reader", `the keyboard is in ${s.focus}`), want(s.cursor?.at.startsWith("age long"), `the cursor is at ${JSON.stringify(s.cursor)}`), want(s.pageNo === "Page 1 of 1", s.pageNo)));
      await step("v e... b", keys(page, "v", "b"), (s) => want(s.pending?.text === "pa", `pending ${JSON.stringify(s.pending)}`));
      clean(problems);
    });

    // Read a frame after the key, no later: a cursor drawn late, or left in the old place,
    // is a word or a line off its character. Two pixels allow for a slide's two animations
    // being sampled a hair apart.
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

    test(`l and h turn pages, and so do Ctrl+d and Ctrl+u in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "Control+f"), (s) => s.chapter === "Chapter Two" && s.pageNo?.startsWith("Page 1 of"));
      await step("l", keys(page, "l"), (s) => all(want(s.pageNo?.startsWith("Page 2 of"), s.pageNo), onItsLetter(s)));
      await step("h", keys(page, "h"), (s) => all(want(s.chapter === "Chapter Two" && s.pageNo?.startsWith("Page 1 of"), `${s.chapter} ${s.pageNo}`), want(s.cursor?.at.startsWith("Chapter Two"), `the cursor is at ${JSON.stringify(s.cursor)}`)));
      await step("Ctrl+d", keys(page, "Control+d"), (s) => want(s.pageNo?.startsWith("Page 2 of"), s.pageNo));
      await step("Ctrl+u", keys(page, "Control+u"), (s) => want(s.chapter === "Chapter Two" && s.pageNo?.startsWith("Page 1 of"), `${s.chapter} ${s.pageNo}`));
      clean(problems);
    });

    test(`Ctrl+v starts a highlight as v does, and l carries it onto the next page in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "Control+f"), (s) => s.chapter === "Chapter Two" && Boolean(s.cursor?.at.startsWith("Chapter Two")));
      await step("Ctrl+v", keys(page, "Control+v"), (s) => want(s.pending?.text === "C", `pending ${JSON.stringify(s.pending)}`));
      await step("l", keys(page, "l"), (s) =>
        all(want(s.pageNo?.startsWith("Page 2 of"), s.pageNo), want(s.pending?.text.startsWith("Chapter Two") && s.pending.text.length > 40, `pending ${JSON.stringify(s.pending)}`), onItsLetter(s)));
      await step("Escape", keys(page, "Escape"), (s) => all(want(!s.pending, "still pending"), want(s.marks.length === 0, `marks ${JSON.stringify(s.marks)}`)));
      clean(problems);
    });

    // --- F4: tab keys ---------------------------------------------------------------------

    test(`gt switches the tab from a list in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "Control+l"), (s) => panel(s) === "list-then-item#notes");
      await step("g t", keys(page, "g", "t"), (s) =>
        all(want(s.rightTab === "Chat", `the tab shown is ${s.rightTab}`), want(panel(s) === "list-then-item#chats", `the keyboard is in ${s.focus}`)), SETTLE);
      clean(problems);
    });

    test(`gT switches the tab back from a list in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "Control+l"), (s) => panel(s) === "list-then-item#notes");
      await reach(quick(page, "g", "t"), (s) => s.rightTab === "Chat" && panel(s) === "list-then-item#chats");
      await step("g T", keys(page, "g", "T"), (s) =>
        all(want(s.rightTab === "Notes", `the tab shown is ${s.rightTab}`), want(panel(s) === "list-then-item#notes", `the keyboard is in ${s.focus}`)), SETTLE);
      clean(problems);
    });

    test(`gt in the Reader, alone on the stage, does nothing in ${engine.name}`, async () => {
      const { page, problems, step } = await open();
      await step("g t in the Reader", keys(page, "g", "t"), (s) =>
        all(want(panel(s) === "book-reader", `the keyboard is in ${s.focus}`), want(s.rightTab === "Notes", `the tab shown is ${s.rightTab}`), want(!s.pending, "a passage is pending")));
      clean(problems);
    });

    test(`Ctrl+. and Ctrl+, work inside a note in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(clickAt(page, row, ["note-list", "Note two"]), (s) => s.notes === "note-editor" && s.focus.includes("note-editor"));
      const before = await look(page);
      await step("Ctrl+. in the note", keys(page, "Control+."), (s) =>
        all(want(s.rightTab === "Chat", `the tab shown is ${s.rightTab}`), want(panel(s) === "list-then-item#chats", `the keyboard is in ${s.focus}`), unchanged(s, before, "editor")), SETTLE);
      await step("Ctrl+,", keys(page, "Control+,"), (s) => want(s.rightTab === "Notes", `the tab shown is ${s.rightTab}`));
      clean(problems);
    });

    // --- F5: fold keys --------------------------------------------------------------------

    test(`Ctrl+Shift+l folds and unfolds the right dock in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "Control+l"), (s) => panel(s) === "list-then-item#notes");
      await step("Ctrl+Shift+l", keys(page, "Control+Shift+l"), (s) =>
        all(want(s.rightFolded === true, "the right dock is open"), want(panel(s) === "book-reader", `the keyboard is in ${s.focus}`)), SETTLE);
      await step("Ctrl+Shift+l again", keys(page, "Control+Shift+l"), (s) =>
        all(want(s.rightFolded === false, "the right dock is folded"), want(panel(s) === "book-reader", `the keyboard is in ${s.focus}`)));
      clean(problems);
    });

    test(`Ctrl+l reaches Notes again after a fold and an unfold in ${engine.name}`, async () => {
      const { page, problems, step, reach } = await open();
      await reach(quick(page, "Control+l"), (s) => panel(s) === "list-then-item#notes");
      await reach(quick(page, "Control+Shift+l"), (s) => s.rightFolded === true && panel(s) === "book-reader");
      await reach(quick(page, "Control+Shift+l"), (s) => s.rightFolded === false);
      await step("Ctrl+l", keys(page, "Control+l"), (s) => want(panel(s) === "list-then-item#notes", `the keyboard is in ${s.focus}`), SETTLE);
      clean(problems);
    });

    test(`zh folds the left dock from the Reader; Ctrl+Shift+h unfolds it in ${engine.name}`, async () => {
      const { page, problems, step } = await open();
      await step("z h", keys(page, "z", "h"), (s) =>
        all(want(s.leftFolded === true, "the left dock is open"), want(panel(s) === "book-reader", `the keyboard is in ${s.focus}`), want(s.cursor?.at.startsWith("Chapter One"), `the cursor moved: ${JSON.stringify(s.cursor)}`)));
      await step("Ctrl+Shift+h", keys(page, "Control+Shift+h"), (s) =>
        all(want(s.leftFolded === false, "the left dock is folded"), want(panel(s) === "book-reader", `the keyboard is in ${s.focus}`)));
      clean(problems);
    });

    test(`zh from the Books list folds it and hands the keyboard to the Reader in ${engine.name}`, async () => {
      const { page, problems, step } = await open();
      await step("Ctrl+h then z h", keys(page, "Control+h", "z", "h"), (s) =>
        all(want(s.leftFolded === true, "the left dock is open"), want(panel(s) === "book-reader", `the keyboard is in ${s.focus}`)), SETTLE);
      clean(problems);
    });

    // --- Vim keys off: every letter and Ctrl key does nothing ----------------------------

    for (const [what, list] of [
      ["letters on a row move nothing", ["j", "k", "G"]],
      ["letters on a row type nothing", ["x", "a", "s"]],
    ]) {
      test(`with Vim keys off, ${what} in ${engine.name}`, async () => {
        const { page, problems, step, reach } = await open(false);
        await reach(clickAt(page, row, ["note-list", "Note two"]), (s) => s.notes === "note-editor" && s.editor?.startsWith("Note two"));
        await reach(quick(page, "Escape"), (s) => s.notes === "note-list");
        await pause(KEY);
        const before = await look(page);
        await step(list.join(" "), keys(page, ...list), (s) =>
          all(unchanged(s, before, "focus"), unchanged(s, before, "deepText"), unchanged(s, before, "editor"), unchanged(s, before, "rows"), unchanged(s, before, "chatBox")));
        clean(problems);
      });
    }

    for (const [what, list] of [
      ["the panel and fold keys", ["Control+l", "Control+.", "Control+Shift+l", "Control+Shift+h"]],
      ["the tab and fold letters", ["g", "t", "z", "h"]],
      ["the Reader's highlight letters", ["w", "v", "w", "Enter", "Control+v"]],
      ["the Reader's page letters", ["l", "}", "Control+f", "Control+d", "G"]],
    ]) {
      test(`with Vim keys off, ${what} do nothing in ${engine.name}`, async () => {
        const { page, problems, step, reach } = await open(false);
        await reach(() => page.evaluate(() => document.querySelector("book-reader").focus()), (s) => panel(s) === "book-reader");
        const before = await look(page);
        const same = (s) =>
          all(...["panel", "rightTab", "leftFolded", "rightFolded", "editor", "chatBox", "chapter", "pageNo", "marks", "rows", "framed"].map((k) => unchanged(s, before, k)), want(!s.cursor && !s.pending, "a cursor shows"));
        await step(list.join(" "), keys(page, ...list), same);
        clean(problems);
      });
    }
  });
}

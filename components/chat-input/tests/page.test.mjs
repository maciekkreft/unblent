import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The chat box on the conversations stem page, driven for real: with Vim keys off (the
// default) Enter sends and Shift+Enter makes a line, two of them a paragraph; with them
// on the same in normal and insert mode (10, 12). The box is one CodeMirror editor whose
// Vim lives in a compartment the preference turns on and off in place, so the draft
// survives the switch and a sign-out. This page has no Settings sheet, so the preference
// and the account picture are driven by the events the sheet and `llm` would emit.

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// The "Vim keys" preference, seeded the way the settings fact stores it (the workshop
// copy, since the page is under /workshop/).
const settings = (vimKeys) =>
  JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });

// The account picture `llm` announces, for the sign-out/sign-in test.
const ECHO = {
  signedIn: true,
  provider: "echo",
  providers: [{ id: "echo", label: "Echo", keySet: true, needsKey: false }],
  model: "echo",
  models: [{ id: "echo", label: "Echo" }],
  effort: "default",
  efforts: [],
  ttl: "1h",
};
const SIGNED_OUT = { signedIn: false, provider: "", providers: [], model: "", models: [], effort: "default", efforts: [], ttl: "1h" };

function watch(page) {
  const problems = [];
  page.on("console", (msg) => msg.type() === "error" && problems.push(`console error: ${msg.text()}`));
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => res.status() >= 400 && problems.push(`HTTP ${res.status()}: ${res.url()}`));
  return problems;
}

async function until(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("timed out");
}

const forge = (userId) => {
  const secret = process.env.SESSION_SECRET;
  assert.ok(secret, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
  assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory; never forge a cookie against the running server");
  return `${userId}.${crypto.createHmac("sha256", secret).update(userId).digest("hex")}`;
};

// A signed-in browser on the conversations page, its account on the Echo test provider
// (set over HTTP, since this page has no Settings). `vim` seeds the preference on before
// the page loads.
async function open(engine, name, { vim = false } = {}) {
  const browser = await engine.launch();
  const userId = `chatinput-${engine.name}-${name}-${Date.now()}`;
  const context = await browser.newContext();
  context.setDefaultTimeout(4000);
  await context.addCookies([{ name: "unblent_session", value: forge(userId), url: BASE_URL }]);
  assert.ok((await context.request.put(`${BASE_URL}/api/llm`, { data: { provider: "echo" } })).ok(), "the account is set to Echo");
  if (vim) await context.addInitScript((v) => localStorage.setItem("settings", v), settings(true));
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
  await until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector('.cm-content[contenteditable="true"]'))));
  return { browser, page, problems };
}

// The chat box's EditorView, reached through the handle CM6 hangs on the content node.
const setDraft = (page, text) =>
  page.evaluate((text) => {
    const view = document.querySelector("chat-input").shadowRoot.querySelector(".cm-content").cmView.rootView.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, text);

const draftText = (page) =>
  page.evaluate(() => document.querySelector("chat-input").shadowRoot.querySelector(".cm-content").cmView.rootView.view.state.doc.toString());

const transcript = (page) =>
  page.evaluate(() => document.querySelector("chat-thread")?.shadowRoot?.querySelector(".transcript")?.textContent ?? "");

// Vim is ready when its plugin has mounted on this editor (view.cm is set); off, it stays
// unset, so the same check tells the two modes apart.
const vimOn = (page) =>
  page.evaluate(() => Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector(".cm-content")?.cmView?.rootView?.view?.cm));

// Fire one event onto the bus from a throwaway emitter: the honest way to drive a fact's
// news on a page with no sheet for it. The emitter declares the one emit, and the mounted
// fact or view receives it exactly as in the app (the bus checks only that the emit is
// declared).
const emitEvent = (page, name, dir, fields) =>
  page.evaluate(
    async ({ name, dir, fields }) => {
      const [{ mount, unmount }, { setup, emit }] = await Promise.all([import("/static/bus/bus.js"), import("xstate")]);
      const schema = await (await fetch(`/static/components/${dir}/events/${name}.json`)).json();
      const emitter = setup({}).createMachine({
        id: "test-emitter",
        meta: { kind: "view", emits: [name], attributes: [] },
        on: { go: { actions: emit(({ event }) => event.body) } },
      });
      const actor = mount(emitter, { events: { [name]: schema } });
      actor.send({ type: "go", body: { type: name, ...fields } });
      await new Promise((r) => setTimeout(r, 40));
      unmount(actor);
    },
    { name, dir, fields },
  );

// Switch what the user is working on, as the subject fact would announce it.
const BOOK = { kind: "book", id: "chatinput-book", title: "A book" };
const JOURNAL = { kind: "journal", id: "chatinput-journal", title: "Journal" };
const moveTo = (page, subject) => emitEvent(page, "subject.changed", "subject", { subject });

const editSettings = (page, vimKeys) =>
  emitEvent(page, "settings.edited", "settings-sheet", { nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, vimKeys });

for (const engine of ENGINES) {
  // Browser: focus and keys.
  test(`without Vim keys Enter sends and Shift+Enter makes a line in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "plain");
    try {
      await page.locator("chat-input .cm-content").click();
      await page.keyboard.type("first");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("second");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("third");
      assert.equal(await draftText(page), "first\nsecond\n\nthird", "Shift+Enter makes a line, two a paragraph, never a send");
      assert.equal(await page.locator("chat-input .cm-line.cm-gap").count(), 1, "the blank line is drawn as a gap");

      await page.keyboard.press("Enter");
      await until(async () => (await transcript(page)).includes("first"), 4000);
      assert.equal(await draftText(page), "", "Enter sends and clears the box");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  // Browser: focus and keys.
  test(`with Vim keys Enter sends from insert and Shift+Enter makes a line in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "vim", { vim: true });
    try {
      await until(async () => await vimOn(page), 4000);
      await page.locator("chat-input .cm-content").click();
      // Normal mode boots; `i` enters insert, where Shift+Enter makes a line and Enter
      // sends without leaving insert first.
      await page.keyboard.press("i");
      await page.keyboard.type("one");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("two");
      assert.equal(await draftText(page), "one\ntwo", "Shift+Enter in insert mode makes a line");
      await page.keyboard.press("Enter");
      await until(async () => (await transcript(page)).includes("one"), 4000);
      assert.equal(await draftText(page), "", "Enter in insert mode sends and clears the box");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  // Browser: focus and keys.
  test(`each subject's new chat keeps its own draft in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "subjects");
    try {
      await moveTo(page, BOOK);
      await page.locator("chat-input .cm-content").click();
      await page.keyboard.type("about the book");

      await moveTo(page, JOURNAL);
      await until(async () => (await draftText(page)) === "");
      await page.keyboard.press("ControlOrMeta+z");
      assert.equal(await draftText(page), "", "Undo does not bring back the book's text");

      await moveTo(page, BOOK);
      await until(async () => (await draftText(page)) === "about the book");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  // Browser: focus and keys.
  test(`the draft survives a live Vim toggle in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "toggle");
    try {
      await setDraft(page, "keep this thought");
      assert.equal(await vimOn(page), false, "Vim off to begin");

      await editSettings(page, true);
      await until(async () => await vimOn(page), 4000);
      assert.equal(await draftText(page), "keep this thought", "the draft survives turning Vim on in place");

      await editSettings(page, false);
      await until(async () => !(await vimOn(page)), 4000);
      assert.equal(await draftText(page), "keep this thought", "and survives turning it off again");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  // Browser: focus and keys.
  test(`New chat puts the cursor in the box, in insert mode under Vim, in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "newchat", { vim: true });
    try {
      await until(async () => await vimOn(page), 4000);
      await page.locator("conversation-list li.row", { hasText: "New chat" }).click();
      await until(
        async () => await page.evaluate(() => document.querySelector("chat-input").shadowRoot.activeElement?.classList.contains("cm-content")),
        4000,
      );
      await page.keyboard.type("hi");
      assert.equal(await draftText(page), "hi", "the first keys typed are text");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  // Browser: focus and keys.
  test(`o in the chat list puts the cursor in the box, in insert mode under Vim, in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "olist", { vim: true });
    try {
      await until(async () => await vimOn(page), 4000);
      await page.locator("conversation-list li.row", { hasText: "New chat" }).waitFor();
      await page.evaluate(() => document.querySelector("conversation-list").shadowRoot.querySelector('[data-id][tabindex="0"]').focus());
      await page.keyboard.press("o");
      await until(
        async () => await page.evaluate(() => document.querySelector("chat-input").shadowRoot.activeElement?.classList.contains("cm-content")),
        4000,
      );
      await page.keyboard.type("hi");
      assert.equal(await draftText(page), "hi", "the first keys typed are text");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  // Browser: rendering and layout.
  test(`the box keeps its draft across sign-out and sign-in in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "signout");
    try {
      await setDraft(page, "an unsent thought");

      await emitEvent(page, "llm.changed", "llm", SIGNED_OUT);
      await until(
        async () => await page.evaluate(() => document.querySelector("chat-input").shadowRoot.querySelector(".notice")?.textContent.includes("Sign in")),
        4000,
      );
      // The box is only hidden, not torn down: its editor is still mounted.
      assert.ok(await page.evaluate(() => Boolean(document.querySelector("chat-input").shadowRoot.querySelector(".cm-content"))), "the editor stays mounted");

      await emitEvent(page, "llm.changed", "llm", ECHO);
      await until(async () => await page.evaluate(() => !document.querySelector("chat-input").shadowRoot.querySelector(".notice")), 4000);
      assert.equal(await draftText(page), "an unsent thought", "the draft is still there after signing back in");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });
}

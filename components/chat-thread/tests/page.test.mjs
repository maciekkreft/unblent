import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The books fixture is imported over HTTP so a real chapter can be read as a tool (7.7),
// then converted to markdown; it is another component's test fixture, read as data, not
// imported as code (11.2 covers import specifiers, not a data file a test reads).
const SAMPLE = readFileSync(new URL("../../books/tests/fixtures/sample.epub", import.meta.url));
const BOOK_ID = "01HQ8ZK7M4N5P6Q7R8S9T0V1W6";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = resolve(HERE, "..", "..", "..", ".screenshots");

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

function watch(page) {
  const problems = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
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
// (set over HTTP, since this page has no Settings). The chat box is then usable.
async function open(engine, name, undoMs, tools) {
  const browser = await engine.launch();
  const userId = `chat-${engine.name}-${name}-${Date.now()}`;
  const context = await browser.newContext();
  context.setDefaultTimeout(4000);
  await context.addCookies([{ name: "unblent_session", value: forge(userId), url: BASE_URL }]);
  const put = await context.request.put(`${BASE_URL}/api/llm`, { data: { provider: "echo" } });
  assert.ok(put.ok(), "the account is set to Echo");
  // A tool switched off in Settings (12) is kept per account; setting it over HTTP here is
  // what the sheet's tools.edited does, so `conversations` boots with it off and never
  // offers it to the model.
  if (tools)
    assert.ok((await context.request.put(`${BASE_URL}/api/conversations/tools`, { data: { tools } })).ok(), "the tool preferences are set");
  // Shorten the delete-undo window (default 3s) so a delete test stays within its budget.
  // conversation-list reads --duration-undo off its host at mount, so the short window must
  // be in the cascade before the element upgrades. An adopted stylesheet is applied at
  // document start (before <html> exists), unlike a style on documentElement.
  if (undoMs != null)
    await context.addInitScript((ms) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`:root{--duration-undo:${ms}ms}`);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }, undoMs);
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
  await until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector('.cm-content[contenteditable="true"]'))));
  return { browser, context, page, problems };
}

// --- conversation-list helpers (session 10): the chats list beside the thread ---------
// The chat titles the list shows, newest first; the "New chat" draft row has no title and
// is excluded.
const chatTitles = (page) =>
  page.evaluate(() =>
    [...document.querySelector("conversation-list").shadowRoot.querySelectorAll(".row:not(.draft) .name")].map((n) => n.textContent.trim()),
  );

// Start a fresh chat (the New chat row on top).
const newChat = (page) =>
  page.evaluate(() => document.querySelector("conversation-list").shadowRoot.querySelector(".row.draft").click());

// Switch to the chat whose title matches.
const pickChat = (page, title) =>
  page.evaluate((title) => {
    const rows = [...document.querySelector("conversation-list").shadowRoot.querySelectorAll(".row:not(.draft)")];
    rows.find((r) => r.querySelector(".name").textContent.trim() === title)?.click();
  }, title);

// Delete the chat whose title matches. The trash is revealed on hover, so a DOM click
// bypasses the actionability check a real pointer hover would satisfy on the desk.
const deleteChat = (page, title) =>
  page.evaluate((title) => {
    const rows = [...document.querySelector("conversation-list").shadowRoot.querySelectorAll(".row:not(.draft)")];
    rows.find((r) => r.querySelector(".name").textContent.trim() === title)?.querySelector(".bin").click();
  }, title);

// Undo a counting-down delete.
const undoDelete = (page) =>
  page.evaluate(() => document.querySelector("conversation-list").shadowRoot.querySelector(".row.discarding .undo")?.click());

// The same, with the sample book imported first, so `books: chapter` has a real chapter
// to return. Imported before the page loads, so the browser's `books` fact pulls it.
async function openWithBook(engine, name) {
  const browser = await engine.launch();
  const userId = `chat-${engine.name}-${name}-${Date.now()}`;
  const context = await browser.newContext();
  context.setDefaultTimeout(4000);
  await context.addCookies([{ name: "unblent_session", value: forge(userId), url: BASE_URL }]);
  assert.ok((await context.request.put(`${BASE_URL}/api/llm`, { data: { provider: "echo" } })).ok(), "the account is set to Echo");
  const put = await context.request.put(`${BASE_URL}/api/books/${BOOK_ID}`, { headers: { "content-type": "application/epub+zip" }, data: SAMPLE });
  assert.ok(put.ok(), "the sample book is imported");
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
  await until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector('.cm-content[contenteditable="true"]'))));
  return { browser, context, page, problems };
}

// The product page: the chat runs in the right dock beside an open book,
// so a new chat is linked to that book (about, and the book's line in start) and follows
// the subject. The sample book is imported and set open before the page loads, so
// `subject` settles on it and `conversation-list subject` scopes to its chats.
async function openProduct(engine, name) {
  const browser = await engine.launch();
  const userId = `chat-${engine.name}-${name}-${Date.now()}`;
  const context = await browser.newContext();
  context.setDefaultTimeout(4000);
  await context.addCookies([{ name: "unblent_session", value: forge(userId), url: BASE_URL }]);
  assert.ok((await context.request.put(`${BASE_URL}/api/llm`, { data: { provider: "echo" } })).ok(), "the account is set to Echo");
  const imp = await context.request.put(`${BASE_URL}/api/books/${BOOK_ID}`, { headers: { "content-type": "application/epub+zip" }, data: SAMPLE });
  assert.ok(imp.ok(), "the sample book is imported");
  assert.ok((await context.request.put(`${BASE_URL}/api/books/${BOOK_ID}/opened`)).ok(), "the sample book is the open one");
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector('.cm-content[contenteditable="true"]'))));
  return { browser, context, page, problems };
}

// The subject has settled on the open book: dock-desk marks the tab of the view showing
// the subject (12), so a mark means the book is the subject and chat-input has learned it.
const bookIsSubject = (page) =>
  page.evaluate(() => Boolean(document.querySelector("dock-desk").shadowRoot.querySelector(".mark")));

// The chat box is a CodeMirror document. Reach its EditorView through the handle CM6
// hangs on the content node, as the note tests do. Set the draft with a dispatch, then
// send it with the Send button.
// updateComplete waits for Lit to enable the button (it turns on once the draft has text)
// before the click, as a typing user would.
const setDraft = (page, text) =>
  page.evaluate(async (text) => {
    const host = document.querySelector("chat-input");
    const view = host.shadowRoot.querySelector(".cm-content").cmView.rootView.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    await host.updateComplete;
  }, text);

const draftText = (page) =>
  page.evaluate(() => document.querySelector("chat-input").shadowRoot.querySelector(".cm-content").cmView.rootView.view.state.doc.toString());

const send = async (page, text) => {
  await setDraft(page, text);
  await page.evaluate(() => document.querySelector("chat-input").shadowRoot.querySelector(".send").click());
};

// Send with the Enter key rather than the Send button. Enter reaches the machine directly,
// so it is not swallowed by the button's brief post-change guard (12) — needed when a
// message is sent right after the button last flipped between Send and Stop. The test's
// account leaves Vim keys off, so Enter sends (D10).
const sendEnter = async (page, text) => {
  await setDraft(page, text);
  await page.locator("chat-input .cm-content").click();
  await page.keyboard.press("Enter");
};

const threadText = (page) =>
  page.evaluate(() => document.querySelector("chat-thread").shadowRoot.querySelector(".transcript").textContent);

const lastAnswer = (page) =>
  page.evaluate(() => {
    const answers = document.querySelector("chat-thread").shadowRoot.querySelectorAll(".turn.assistant .answer");
    return answers.length ? answers[answers.length - 1].textContent : "";
  });

// Stopping an answer and reloading mid-answer both cancel the in-flight streaming
// request on purpose (5: an answer still arriving when the page goes away is not kept);
// the browser records that cancellation as a failed request, which the reader never
// sees. These two tests drop that expected noise but
// keep every real error (a console error, an HTTP 4xx/5xx).
const ABORT_NOISE = /Load request cancelled|access control checks|NS_BINDING_ABORTED|aborted|cancelled/i;
const realProblems = (problems) => problems.filter((p) => !ABORT_NOISE.test(p));

const action = (page, label) =>
  page.evaluate(
    (label) =>
      [...document.querySelector("chat-input").shadowRoot.querySelectorAll(".action")].some((b) => b.textContent.trim() === label),
    label,
  );

for (const engine of ENGINES) {
  test(`a message is answered word by word in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "answer");
    try {
      await send(page, "hello there");
      await until(async () => (await lastAnswer(page)).includes("hello there")); // Echo repeats the text
      assert.match(await threadText(page), /hello there/);
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`an answer's markdown renders as formatting in ${engine.name}`, async () => {
    // The stem page sets the markdown attribute (10). Echo repeats the text, so a message
    // written in markdown comes back as an answer whose # and ** are rendered, not shown.
    const { browser, page, problems } = await open(engine, "md");
    try {
      await send(page, "# A Heading\n\nA **bold** point.");
      // The answer streams block by block: the heading (first block) renders before the
      // bold span (second block). Wait until both are present, so the read below is not
      // taken between the two while the ** is still an unclosed run of text.
      await until(async () =>
        await page.evaluate(() => {
          const root = document.querySelector("chat-thread").shadowRoot;
          return Boolean(root.querySelector(".answer.prose h1.md-h") && root.querySelector(".answer.prose strong"));
        }),
      );
      const rendered = await page.evaluate(() => {
        const root = document.querySelector("chat-thread").shadowRoot;
        return {
          heading: root.querySelector(".answer.prose h1.md-h")?.textContent,
          bold: root.querySelector(".answer.prose strong")?.textContent,
          answerText: root.querySelector(".answer.prose")?.textContent ?? "",
        };
      });
      assert.equal(rendered.heading, "A Heading", "the # line rendered as a heading");
      assert.equal(rendered.bold, "bold", "the ** span rendered as bold");
      assert.ok(!rendered.answerText.includes("#") && !rendered.answerText.includes("**"), "the raw markers are not shown in the answer");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`thinking shows a live line and then an openable record in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "think");
    try {
      // The live "Thinking…" line shows only while the model thinks (a short window),
      // so an observer catches it rather than a poll that could miss it.
      await page.evaluate(() => {
        window.__sawThinking = false;
        const root = document.querySelector("chat-thread").shadowRoot;
        const note = () => {
          const w = root.querySelector(".working");
          if (w && w.textContent.includes("Thinking")) window.__sawThinking = true;
        };
        new MutationObserver(note).observe(root, { subtree: true, childList: true, characterData: true });
        note();
      });
      await send(page, "/think please");
      await until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-thread").shadowRoot.querySelector("details.thinking"))));
      const record = await page.evaluate(() => {
        const d = document.querySelector("chat-thread").shadowRoot.querySelector("details.thinking");
        d.querySelector("summary").click(); // opens it (closed by default)
        return d.querySelector(".text").textContent;
      });
      assert.ok(record && record.length > 0, "the thinking record opens to show the thinking text");
      assert.ok(await page.evaluate(() => window.__sawThinking), "the live Thinking… line showed while the model thought");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`a slow answer can be stopped in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "stop");
    try {
      // A long answer, so it is still arriving when Escape stops it.
      await send(page, "/slow " + "the answer keeps arriving slowly here. ".repeat(3));
      await until(async () => (await lastAnswer(page)).length > 0); // an answer is arriving
      // Escape stops the answer (12), and is not subject to the button's change guard.
      await page.locator("chat-input .cm-content").click();
      await page.keyboard.press("Escape");
      await until(async () => (await threadText(page)).includes("Stopped."));
      assert.deepEqual(realProblems(problems), [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`Enter while an answer arrives keeps the typed text in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "keepdraft");
    try {
      // A long answer, so it is still arriving. The box stays editable (12): a question
      // typed and sent with Enter now must survive, not be cleared by a doomed send.
      await send(page, "/slow " + "a long answer that keeps arriving here. ".repeat(3));
      await until(async () => (await lastAnswer(page)).length > 0); // an answer is arriving
      await setDraft(page, "a thought to send next");
      await page.locator("chat-input .cm-content").click();
      await page.keyboard.press("Enter");
      const value = await draftText(page);
      assert.equal(value, "a thought to send next", "the text stays in the box while an answer arrives");
      assert.deepEqual(realProblems(problems), [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`a failed answer offers Try again in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "fail");
    try {
      await send(page, "/fail");
      await until(async () => await action(page, "Try again"));
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`a finished chat survives a reload in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "reload");
    try {
      await send(page, "keep me");
      await until(async () => (await lastAnswer(page)).includes("keep me"));
      await until(async () => !(await threadText(page)).includes("Not saved yet")); // saved to the server
      await page.reload({ waitUntil: "domcontentloaded" });
      await until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector('.cm-content[contenteditable="true"]'))));
      await until(async () => (await threadText(page)).includes("keep me"));
      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `conversations-${engine.name}.png`), fullPage: true });
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`a reload mid-answer ends at the question with Continue in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "continue");
    try {
      // A long answer, reloaded while it is still arriving: the question is saved but the
      // in-progress answer is not (5: an arriving answer is not kept when the page goes away).
      await send(page, "/slow " + "a long answer that is still arriving. ".repeat(3));
      // Arriving, and the question is on the server (not "Not saved yet"), so a reload
      // finds the chat ending at the question.
      await until(async () => {
        const t = await threadText(page);
        return (await lastAnswer(page)).length > 0 && !t.includes("Not saved yet");
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector('.cm-content[contenteditable="true"]'))));
      await until(async () => await action(page, "Continue")); // the chat ends at the question
      assert.equal(await lastAnswer(page), "", "the in-progress answer was not kept");
      assert.deepEqual(realProblems(problems), [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`a lookup runs and its result is fed back in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "tool-subject");
    try {
      // Echo asks for the subject lookup, conversations runs it, and Echo repeats the
      // result so what the model would read is on screen. Nothing is open here, so the
      // reader's context is "nothing open" (the conversations page shows no book).
      await send(page, "/tool subject: read {}");
      // Wait for the lookup's result to be echoed back (nothing is open here, so the
      // subject is null), not just the typed request that also contains the word.
      await until(async () => (await threadText(page)).includes('"subject":null'));
      assert.match(await threadText(page), /Checking what's open/, "the lookup is named on screen");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`a tool switched off is not offered and its call is refused in ${engine.name}`, async () => {
    // subject: read is switched off for this account (12). Echo still asks for it, but the
    // loop was never offered it, so llm refuses the call with an error result instead of
    // running it; the model sees the refusal, and no lookup line is shown for the reader.
    const { browser, page, problems } = await open(engine, "tool-off", undefined, { "subject: read": false });
    try {
      await send(page, "/tool subject: read {}");
      await until(async () => (await threadText(page)).includes("This tool could not be used"));
      assert.doesNotMatch(await threadText(page), /Checking what's open/, "an off tool is never named as a lookup");
      assert.doesNotMatch(await threadText(page), /"subject":null/, "the lookup did not run");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`a chapter is read and comes back as markdown in ${engine.name}`, async () => {
    const { browser, page, problems } = await openWithBook(engine, "tool-chapter");
    try {
      await send(page, `/tool books: chapter {"id":"${BOOK_ID}","chapter":0}`);
      await until(async () => (await threadText(page)).includes("A LINKED HEADING"));
      // The chapter came back from `conversations` as markdown (a `# Chapter One` heading);
      // with the markdown attribute on the stem page (10) the answer renders it as a real
      // heading, so the `#` is gone from the text and lives as an <h1> instead.
      const headings = await page.evaluate(() =>
        [...document.querySelector("chat-thread").shadowRoot.querySelectorAll(".prose h1.md-h")].map((h) => h.textContent),
      );
      assert.ok(headings.some((t) => /Chapter One/.test(t)), "the chapter's # heading rendered as a heading");
      assert.match(await threadText(page), /Reading a chapter/, "the lookup is named on screen");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  // --- conversation-list (session 10) -------------------------------------------------

  test(`a second chat is listed and picking a row switches to it in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "list-switch");
    try {
      await send(page, "first message");
      await until(async () => (await lastAnswer(page)).includes("first message"));
      await newChat(page);
      // Wait until the thread has switched to the empty new chat before sending, so the
      // second message opens a second chat rather than racing into the first.
      await until(async () => await page.evaluate(() => document.querySelector("chat-thread").shadowRoot.querySelectorAll(".turn").length === 0));
      await sendEnter(page, "second message");
      await until(async () => (await lastAnswer(page)).includes("second message"));
      await until(async () => (await chatTitles(page)).length === 2);
      assert.deepEqual(await chatTitles(page), ["second message", "first message"], "both chats, newest first");
      await pickChat(page, "first message");
      await until(async () => (await lastAnswer(page)).includes("first message"));
      assert.match(await threadText(page), /first message/, "picking the older row switched the thread to it");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`a delete can be undone in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "undo", 250);
    try {
      await send(page, "keep me");
      await until(async () => (await lastAnswer(page)).includes("keep me"));
      await until(async () => (await chatTitles(page)).includes("keep me"));
      await deleteChat(page, "keep me");
      await undoDelete(page);
      await page.waitForTimeout(400); // past the (cancelled) window, to prove it never fires
      assert.ok((await chatTitles(page)).includes("keep me"), "the chat is still there after Undo");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`a delete left to run removes the chat in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "delete", 250);
    try {
      await send(page, "delete me");
      await until(async () => (await lastAnswer(page)).includes("delete me"));
      await until(async () => (await chatTitles(page)).includes("delete me"));
      await deleteChat(page, "delete me");
      await until(async () => !(await chatTitles(page)).includes("delete me"));
      assert.ok(!(await chatTitles(page)).includes("delete me"), "the chat is gone once the window ends");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`chats survive a reload in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "reload");
    try {
      await send(page, "remember me");
      await until(async () => (await lastAnswer(page)).includes("remember me"));
      await until(async () => (await chatTitles(page)).includes("remember me"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await until(async () => await page.evaluate(() => Boolean(document.querySelector("conversation-list")?.shadowRoot?.querySelector(".row"))));
      await until(async () => (await chatTitles(page)).includes("remember me"));
      assert.ok((await chatTitles(page)).includes("remember me"), "the chat is listed from the server after a reload");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  // --- the product page beside an open book ---------------------------

  test(`a new chat is linked to the open book on the product in ${engine.name}`, async () => {
    const { browser, page, problems } = await openProduct(engine, "book-link");
    try {
      // Wait until the subject has settled on the book, so chat-input links the new chat
      // to it (7's step A1: a keystroke before the subject is known is held until it is).
      await until(async () => await bookIsSubject(page));
      await send(page, "about this book");
      await until(async () => (await lastAnswer(page)).includes("about this book"));
      await until(async () => !(await threadText(page)).includes("Not saved yet")); // saved to the server
      await page.reload({ waitUntil: "domcontentloaded" });
      await until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector('.cm-content[contenteditable="true"]'))));
      // With the book as subject again, conversation-list scopes to the book's chats; the
      // chat's presence there proves it was linked to the book (about), not left unlinked.
      await until(async () => await bookIsSubject(page));
      await until(async () => (await chatTitles(page)).includes("about this book"));
      assert.ok((await chatTitles(page)).includes("about this book"), "the new chat is listed under the open book after a reload");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });
}

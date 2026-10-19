import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forge, signedIn, shortUndo } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = resolve(HERE, "..", "..", "..", ".screenshots");

const inputReady = (page) =>
  until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector('.cm-content[contenteditable="true"]'))));

// A signed-in context on the conversations page, its account on the Echo test provider
// (set over HTTP, since this page has no Settings). The chat box is then usable. One
// browser serves the suite; each test owns its context (11.2).
async function open(browser, engineName, name, undoMs, tools) {
  const userId = `chat-${engineName}-${name}-${Date.now()}`;
  const context = await browser.newContext();
  context.setDefaultTimeout(4000);
  await signedIn(context, forge(userId));
  const put = await context.request.put(`${BASE_URL}/api/llm`, { data: { provider: "echo" } });
  assert.ok(put.ok(), "the account is set to Echo");
  // A tool switched off in Settings (12) is kept per account; setting it over HTTP here is
  // what the sheet's tools.edited does, so `conversations` boots with it off and never
  // offers it to the model.
  if (tools)
    assert.ok((await context.request.put(`${BASE_URL}/api/conversations/tools`, { data: { tools } })).ok(), "the tool preferences are set");
  // A short delete-undo window (default 3s), so a delete test stays within its budget.
  if (undoMs != null) await shortUndo(context, undoMs);
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
  await inputReady(page);
  return { context, page, problems };
}

// --- conversation-list helpers (session 10): the chats list beside the thread ---------
// The chat titles the list shows, newest first; the "New chat" draft row has no title and
// is excluded.
const chatTitles = (page) =>
  page.evaluate(() =>
    [...document.querySelector("conversation-list").shadowRoot.querySelectorAll(".row:not(.draft) .name")].map((n) => n.textContent.trim()),
  );

const chatSubtitles = (page) =>
  page.evaluate(() =>
    [...document.querySelector("conversation-list").shadowRoot.querySelectorAll(".row:not(.draft) .subtitle")].map((n) => n.textContent.trim()),
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
// sees. Those tests drop that expected noise but keep every real error (a console
// error, an HTTP 4xx/5xx).
const ABORT_NOISE = /Load request cancelled|access control checks|NS_BINDING_ABORTED|aborted|cancelled/i;
const realProblems = (problems) => problems.filter((p) => !ABORT_NOISE.test(p));

const action = (page, label) =>
  page.evaluate(
    (label) =>
      [...document.querySelector("chat-input").shadowRoot.querySelectorAll(".action")].some((b) => b.textContent.trim() === label),
    label,
  );

// WebKit first, then Chromium (10). A lookup fed back to the model and a delete whose
// window runs out are decisions of the machines, tested in Node (9): conversations'
// tool round, conversation-list's countdown. Here is what only a browser shows.
for (const engine of ENGINES) {
  describe(`chat-thread in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 30000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: rendering and layout.
    test("a message is answered word by word", async () => {
      const { context, page, problems } = await open(browser, engine.name, "answer");
      try {
        await send(page, "hello there");
        await until(async () => (await lastAnswer(page)).includes("hello there")); // Echo repeats the text
        assert.match(await threadText(page), /hello there/);
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("an answer's markdown renders as formatting", async () => {
      // The stem page sets the markdown attribute (10). Echo repeats the text, so a message
      // written in markdown comes back as an answer whose # and ** are rendered, not shown.
      const { context, page, problems } = await open(browser, engine.name, "md");
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
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("thinking shows a live line and then an openable record", async () => {
      const { context, page, problems } = await open(browser, engine.name, "think");
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
        await context.close();
      }
    });

    // Browser: a gesture.
    test("a slow answer can be stopped", async () => {
      const { context, page, problems } = await open(browser, engine.name, "stop");
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
        await context.close();
      }
    });

    // Browser: a gesture.
    test("a failed answer offers Try again", async () => {
      const { context, page, problems } = await open(browser, engine.name, "fail");
      try {
        await send(page, "/fail");
        await until(async () => await action(page, "Try again"));
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("Enter while an answer arrives keeps the typed text", async () => {
      const { context, page, problems } = await open(browser, engine.name, "keepdraft");
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
        await context.close();
      }
    });

    // Browser: a reload against real storage.
    test("a finished chat survives a reload", async () => {
      const { context, page, problems } = await open(browser, engine.name, "reload");
      try {
        await send(page, "keep me");
        await until(async () => (await lastAnswer(page)).includes("keep me"));
        await until(async () => !(await threadText(page)).includes("Not saved yet")); // saved to the server
        await page.reload({ waitUntil: "domcontentloaded" });
        await inputReady(page);
        await until(async () => (await threadText(page)).includes("keep me"));
        mkdirSync(SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: resolve(SCREENSHOTS, `conversations-${engine.name}.png`), fullPage: true });
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // What the thread shows of a lookup: a tool the user keeps on is named by its owner's
    // label; one switched off (12) is never named. That the off tool is not offered, and
    // its call is refused rather than asked, is decided in conversations' machine test and
    // llm's api test; here is what the reader sees of it.
    // Browser: rendering and layout.
    test("a lookup is named on screen, and a tool switched off is not", async () => {
      const { context, page, problems } = await open(browser, engine.name, "tool-off", undefined, { "subject: read": false });
      try {
        await send(page, "/tool subject: read {}\n/tool notes: list {}");
        await until(async () => (await threadText(page)).includes("This tool could not be used"));
        assert.match(await threadText(page), /Listing the notes/, "the lookup is named on screen");
        assert.doesNotMatch(await threadText(page), /Checking what's open/, "an off tool is never named as a lookup");
        assert.doesNotMatch(await threadText(page), /"subject":null/, "the lookup did not run");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // --- conversation-list (session 10) -------------------------------------------------

    // Browser: a gesture.
    test("a second chat is listed and picking a row switches to it", async () => {
      const { context, page, problems } = await open(browser, engine.name, "list-switch");
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
        // Each row's second line is the start of its answer, like a note row's.
        await until(async () => (await chatSubtitles(page)).every((s, i) => s.includes(["second message", "first message"][i])));
        await pickChat(page, "first message");
        await until(async () => (await lastAnswer(page)).includes("first message"));
        assert.match(await threadText(page), /first message/, "picking the older row switched the thread to it");
        // After a reload the second lines come from the server's list.
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await chatSubtitles(page)).some((s) => s.includes("second message")));
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("a delete can be undone", async () => {
      const { context, page, problems } = await open(browser, engine.name, "undo", 250);
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
        await context.close();
      }
    });
  });
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// What only a browser shows of the chat thread, on the conversations stem page: one journey
// (9), approved in checks/journeys.json. One account on the Echo test provider, with the
// "subject: read" tool switched off; the page loads once and every step asks the same chat.
// A lookup fed back to the model, a delete and its Undo, Try again offered for a failed
// answer, and picking a chat in the list are decisions of the machines, tested in Node (9).
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, journey, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = resolve(HERE, "..", "..", "..", ".screenshots");

const inputReady = (page) =>
  until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector('.cm-content[contenteditable="true"]'))));

// Stopping an answer cancels its streaming request on purpose (5: an answer still arriving
// when it is stopped is not kept); the browser records that cancellation as a failed
// request, which the reader never sees. From the step that stops an answer on, that
// expected noise is dropped, and every real error (a console error, an HTTP 4xx/5xx) kept.
const ABORT_NOISE = /Load request cancelled|access control checks|NS_BINDING_ABORTED|aborted|cancelled/i;

// The chat box is a CodeMirror document. Reach its EditorView through the handle CM6
// hangs on the content node, as the note tests do. Set the draft with a dispatch, then
// send it with Enter: every step asks the same chat, and the Send button ignores a click
// for a moment after it changes back from Stop, so a click there would be dropped.
const setDraft = (page, text) =>
  page.evaluate(async (text) => {
    const host = document.querySelector("chat-input");
    const view = host.shadowRoot.querySelector(".cm-content").cmView.rootView.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    await host.updateComplete;
  }, text);

const send = async (page, text) => {
  await setDraft(page, text);
  await page.locator("chat-input .cm-content").click();
  await page.keyboard.press("Enter");
};

// What the user sees of the chat, read in one go.
const look = ({ page }) =>
  page.evaluate(() => {
    const thread = document.querySelector("chat-thread")?.shadowRoot;
    const input = document.querySelector("chat-input")?.shadowRoot;
    const answers = [...(thread?.querySelectorAll(".turn.assistant .answer") ?? [])];
    return {
      ready: Boolean(input?.querySelector('.cm-content[contenteditable="true"]')),
      arriving: input?.querySelector(".send")?.getAttribute("aria-label") === "Stop",
      draft: input?.querySelector(".cm-content")?.cmView?.rootView.view.state.doc.toString() ?? null,
      lastAnswer: answers.length ? answers[answers.length - 1].textContent : "",
      stopped: [...(thread?.querySelectorAll(".status") ?? [])].filter((s) => s.textContent === "Stopped.").length,
      thread: thread?.querySelector(".transcript")?.textContent ?? "",
    };
  });

const want = (cond, msg) => (cond ? null : msg);
const all = (...checks) => checks.find(Boolean) ?? null;

// Every step but the slow ones starts here; a fresh visit is already in this state.
const idle = {
  state: "the chat box ready and no answer arriving",
  check: (s) => all(want(s.ready, "the chat box is not ready"), want(!s.arriving, "an answer is still arriving")),
  reach: () => {},
};

for (const engine of ENGINES) {
  // Browser: rendering and layout.
  test(`the chat thread in ${engine.name}`, ...journey({
    launch: () => engine.launch(),
    open: async (browser) => {
      const context = await browser.newContext();
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, forgeCookie(`chat-${engine.name}`));
        assert.ok((await context.request.put(`${BASE_URL}/api/llm`, { data: { provider: "echo" } })).ok(), "the account is set to Echo");
        // A tool switched off in Settings (12) is kept per account; setting it over HTTP
        // here is what the sheet's tools.edited does, so `conversations` boots with it off
        // and never offers it to the model.
        assert.ok((await context.request.put(`${BASE_URL}/api/conversations/tools`, { data: { tools: { "subject: read": false } } })).ok(), "the tool preferences are set");
        const page = await context.newPage();
        const raw = watch(page);
        let from = Infinity;
        await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
        await inputReady(page);
        return {
          page,
          context,
          get problems() {
            return raw.filter((p, i) => i < from || !ABORT_NOISE.test(p));
          },
          tolerateAborts: () => {
            from = Math.min(from, raw.length);
          },
          close: () => context.close(),
        };
      } catch (error) {
        await context.close();
        throw error;
      }
    },
    look,
  }, [
    {
      // The stem page sets the markdown attribute (10). Echo repeats the text, so a message
      // written in markdown comes back as an answer whose # and ** are rendered, not shown.
      name: "an answer's markdown renders as formatting",
      from: idle,
      run: async (v) => {
        await send(v.page, "# A Heading\n\nA **bold** point.");
        // The answer streams block by block: the heading (first block) renders before the
        // bold span (second block). Wait until both are present, so the read below is not
        // taken between the two while the ** is still an unclosed run of text.
        await until(async () =>
          await v.page.evaluate(() => {
            const root = document.querySelector("chat-thread").shadowRoot;
            return Boolean(root.querySelector(".answer.prose h1.md-h") && root.querySelector(".answer.prose strong"));
          }),
        );
        const rendered = await v.page.evaluate(() => {
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
        await v.see(idle.check);
      },
    },
    {
      name: "thinking shows a live line and then an openable record",
      from: idle,
      run: async (v) => {
        // The live "Thinking…" line shows only while the model thinks (a short window),
        // so an observer catches it rather than a poll that could miss it.
        await v.page.evaluate(() => {
          window.__sawThinking = false;
          const root = document.querySelector("chat-thread").shadowRoot;
          const note = () => {
            const w = root.querySelector(".working");
            if (w && w.textContent.includes("Thinking")) window.__sawThinking = true;
          };
          new MutationObserver(note).observe(root, { subtree: true, childList: true, characterData: true });
          note();
        });
        await send(v.page, "/think please");
        await until(async () => await v.page.evaluate(() => Boolean(document.querySelector("chat-thread").shadowRoot.querySelector("details.thinking"))));
        const record = await v.page.evaluate(() => {
          const d = document.querySelector("chat-thread").shadowRoot.querySelector("details.thinking");
          d.querySelector("summary").click(); // opens it (closed by default)
          return d.querySelector(".text").textContent;
        });
        assert.ok(record && record.length > 0, "the thinking record opens to show the thinking text");
        assert.ok(await v.page.evaluate(() => window.__sawThinking), "the live Thinking… line showed while the model thought");
        await v.see(idle.check);
      },
    },
    {
      // What the thread shows of a lookup: a tool the user keeps on is named by its owner's
      // label; one switched off (12) is never named. That the off tool is not offered, and
      // its call is refused rather than asked, is decided in conversations' machine test and
      // llm's api test; here is what the reader sees of it.
      name: "a lookup is named on screen, and a tool switched off is not",
      from: idle,
      run: async (v) => {
        await send(v.page, "/tool subject: read {}\n/tool notes: list {}");
        const s = await v.see((s) => want(s.thread.includes("This tool could not be used"), "the refused lookup is not shown"));
        assert.match(s.thread, /Listing the notes/, "the lookup is named on screen");
        assert.doesNotMatch(s.thread, /Checking what's open/, "an off tool is never named as a lookup");
        assert.doesNotMatch(s.thread, /"subject":null/, "the lookup did not run");
        await v.see(idle.check);
      },
    },
    {
      name: "a finished chat survives a reload",
      from: idle,
      run: async (v) => {
        await send(v.page, "keep me");
        await v.see((s) => want(s.lastAnswer.includes("keep me"), "no answer to keep me"));
        await v.see((s) => want(!s.thread.includes("Not saved yet"), "the chat is not saved yet")); // saved to the server
        await v.page.reload({ waitUntil: "domcontentloaded" });
        await inputReady(v.page);
        await v.see((s) => want(s.thread.includes("keep me"), "the chat is gone after the reload"));
        mkdirSync(SCREENSHOTS, { recursive: true });
        await v.page.screenshot({ path: resolve(SCREENSHOTS, `conversations-${engine.name}.png`), fullPage: true });
      },
    },
    {
      name: "a slow answer can be stopped",
      from: idle,
      run: async (v) => {
        v.tolerateAborts();
        const before = await v.look();
        // A long answer, so it is still arriving when Escape stops it.
        await send(v.page, "/slow " + "the answer keeps arriving slowly here. ".repeat(3));
        await v.see((s) => want(s.lastAnswer.includes("the answer keeps"), "no answer is arriving"));
        // Escape stops the answer (12), and is not subject to the button's change guard.
        await v.page.locator("chat-input .cm-content").click();
        await v.page.keyboard.press("Escape");
        await v.see((s) => want(s.stopped > before.stopped, "the answer was not stopped"));
      },
    },
    {
      name: "Enter while an answer arrives keeps the typed text",
      from: idle,
      run: async (v) => {
        v.tolerateAborts();
        // A long answer, so it is still arriving. The box stays editable (12): a question
        // typed and sent with Enter now must survive, not be cleared by a doomed send.
        await send(v.page, "/slow " + "a long answer that keeps arriving here. ".repeat(3));
        await v.see((s) => want(s.lastAnswer.includes("a long answer"), "no answer is arriving"));
        await setDraft(v.page, "a thought to send next");
        await v.page.locator("chat-input .cm-content").click();
        await v.page.keyboard.press("Enter");
        const s = await v.look();
        assert.equal(s.draft, "a thought to send next", "the text stays in the box while an answer arrives");
      },
    },
  ]));
}

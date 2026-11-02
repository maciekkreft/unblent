import { test } from "node:test";
import assert from "node:assert/strict";

// A lookup line under an answer opens to say what was asked for and what came back
// (7.7). The derivation of count, total and items is tested in Node in `conversations`,
// the plain words of the payload in this component's machine tests.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
const CHAT = U("C1");
const DAYS = {
  days: [
    { id: U("D1"), day: "2026-10-28", summary: "A phone call.", words: 410 },
    { id: U("D2"), day: "2026-10-14", summary: "A dinner.", words: 620 },
  ],
  total: 2,
  more: 0,
};

const look = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("chat-thread").shadowRoot;
    return [...root.querySelectorAll(".lookup")].map((d) => ({
      open: d.open,
      label: d.querySelector("summary").textContent.trim(),
      got: d.querySelector(".got") ? [...d.querySelectorAll(".got dt, .got dd:not(:has(li)), .got li")].map((e) => e.textContent.trim()).join(" | ") : null,
      danger: Boolean(d.querySelector(".err")),
    }));
  });

for (const engine of ENGINES) {
  // A gesture, and focus and keys: a click opens a lookup line and the keyboard's Enter
  // and Space toggle it from its focused summary, like the thinking record.
  test(`a lookup line opens to show what was asked for and what came back in ${engine.name}`, async () => {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, forgeCookie("chat-lookups"));
        const turns = [
          { id: U("Q1"), role: "user", text: "When did I write about my mother?" },
          {
            id: U("A1"), role: "assistant", text: "", status: "done",
            calls: [
              { id: "c1", target: "journal", name: "index", payload: { from: "2026-10-01", contains: "mother" }, label: "Reading journal days" },
              { id: "c2", target: "notes", name: "read", payload: { id: U("N1") }, label: "Reading a note" },
            ],
          },
          { id: U("R1"), role: "user", text: "", results: [{ callId: "c1", content: JSON.stringify(DAYS) }, { callId: "c2", content: "No note with that id.", isError: true }] },
          { id: U("A2"), role: "assistant", text: "On 28 October.", status: "done" },
        ];
        assert.ok((await context.request.put(`${BASE_URL}/api/conversations/${CHAT}`, { data: { title: "Mother", about: [], start: "", turns } })).ok(), "the chat is seeded");
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
        await page.locator("conversation-list .row", { hasText: "Mother" }).click();
        await until(async () => (await look(page)).length === 2);
        assert.deepEqual((await look(page)).map((l) => l.open), [false, false], "closed by default");

        await page.locator("chat-thread .lookup summary", { hasText: "Reading journal days" }).click();
        await until(async () => /28 Oct 2026/.test((await look(page))[0].got ?? ""));
        const days = (await look(page))[0];
        assert.match(days.got, /^Asked for \| From 1 Oct 2026, containing “mother” \| Got \| 28 Oct 2026 A phone call\. \| 14 Oct 2026 A dinner\. \| 2 of 2 · About \d+ words$/);

        const note = page.locator("chat-thread .lookup summary", { hasText: "Reading a note" });
        await note.focus();
        await page.keyboard.press("Enter");
        // The view draws what came back after the browser has opened the record.
        await until(async () => (await look(page))[1].got !== null);
        assert.equal((await look(page))[1].got, "Asked for | One by its id | Got | Nothing: this lookup failed, and the chat was told.");
        assert.ok((await look(page))[1].danger, "the failure is drawn in the danger color");
        await page.keyboard.press("Space");
        await until(async () => !(await look(page))[1].open);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
}

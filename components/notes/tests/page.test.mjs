import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = resolve(HERE, "..", "..", "..", ".screenshots");

// The console lines trace prints (section 10): the round trip the editor and the
// fact make through the bus, proof the stem is wired, not just rendered.
const SAVED = /event note\.saved note-editor → notes delivered/;
const CHANGED = /event note\.changed notes → note-editor delivered/;

async function until(fn, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

function watch(page, problems) {
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
}

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  test(`the note-editor saves through the notes fact in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    try {
      const problems = [];
      const debug = [];
      const page = await context.newPage();
      watch(page, problems);
      page.on("console", (msg) => {
        if (msg.type() === "debug") debug.push(msg.text());
      });

      await page.goto(`${BASE_URL}/design/notes`, { waitUntil: "domcontentloaded" });
      const ready = (p) =>
        p.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector("textarea"));
      await ready(page);

      // One text whose first line is the title; a blur saves it at once (4.3), so one
      // note.saved follows, to version 1.
      await page.evaluate(() => {
        const textarea = document.querySelector("note-editor").shadowRoot.querySelector("textarea");
        textarea.value = "A note\nits body";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("blur"));
      });

      await until(() => debug.some((l) => SAVED.test(l)) && debug.some((l) => CHANGED.test(l)));
      await until(async () => (await page.locator("note-editor .status").textContent())?.trim() === "Saved · v1");

      // Persistence: the fact wrote through the store to IndexedDB (5), not just to
      // its in-memory Map. Read the raw database the store opened.
      const records = await page.evaluate(
        () =>
          new Promise((res, rej) => {
            const open = indexedDB.open("notes");
            open.onerror = () => rej(open.error);
            open.onsuccess = () => {
              const all = open.result.transaction("notes", "readonly").objectStore("notes").getAll();
              all.onsuccess = () => res(all.result);
              all.onerror = () => rej(all.error);
            };
          }),
      );
      assert.equal(records.length, 1);
      assert.equal(records[0].title, "A note");
      assert.equal(records[0].body, "A note\nits body");
      assert.equal(records[0].version, 1);

      // A reload continues where the user left off: the editor asks notes: list on
      // start and reopens the newest note from the store.
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready(page);
      await until(async () => (await page.locator("note-editor .status").textContent())?.trim() === "Saved · v1");
      assert.equal(await page.locator("note-editor textarea").inputValue(), "A note\nits body");

      // Height (the editor's one attribute): in content mode the body grows with its
      // lines; in neither mode does it grow past the viewport, so the status stays in
      // view and the page does not scroll. The page declares fill, so content is set.
      const measure = () =>
        page.evaluate(() => {
          const root = document.querySelector("note-editor").shadowRoot;
          const status = root.querySelector(".status").getBoundingClientRect();
          return {
            textarea: root.querySelector("textarea").getBoundingClientRect().height,
            statusInView: status.bottom <= innerHeight,
            pageScrolls: document.documentElement.scrollHeight > innerHeight + 1,
          };
        });
      const type = (text) =>
        page.evaluate((t) => {
          const textarea = document.querySelector("note-editor").shadowRoot.querySelector("textarea");
          textarea.value = t;
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }, text);
      await page.evaluate(() => document.querySelector("note-editor").setAttribute("height", "content"));
      const short = await measure();
      await type(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"));
      const grown = await measure();
      assert.ok(grown.textarea > short.textarea, "content mode grows with the lines");
      await type(Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n"));
      for (const mode of ["content", "fill"]) {
        await page.evaluate((m) => document.querySelector("note-editor").setAttribute("height", m), mode);
        const long = await measure();
        assert.ok(long.statusInView, `${mode}: the status line stays in view`);
        assert.equal(long.pageScrolls, false, `${mode}: the page does not scroll`);
      }

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);

      // Phone: a fresh page of the same context that chose the phone preview before
      // load, so the editor is measured inside the narrowed body. It must not
      // overflow its own box sideways.
      const phone = await context.newPage();
      watch(phone, problems);
      await phone.addInitScript(() => localStorage.setItem("viewport", "phone"));
      await phone.goto(`${BASE_URL}/design/notes`, { waitUntil: "domcontentloaded" });
      await ready(phone);
      await phone.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      const fits = await phone.evaluate(() => {
        const el = document.querySelector("note-editor");
        return el.scrollWidth <= el.clientWidth + 1;
      });
      assert.ok(fits, "the editor must not overflow sideways on the phone");
      mkdirSync(SCREENSHOTS, { recursive: true });
      await phone.screenshot({ path: resolve(SCREENSHOTS, `notes-phone-${engine.name}.png`) });

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}

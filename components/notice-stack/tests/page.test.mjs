import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
mkdirSync(SCREENSHOTS, { recursive: true });
const FIXTURES = resolve(HERE, "..", "..", "books", "tests", "fixtures");

// The trace lines that prove the round trip through the bus (section 10): the fact
// tells the stack about the clash, the stack tells the fact to keep the user's copy.
const CONFLICTED = /event note\.conflicted notes → .*\bnotice-stack\b.* delivered/;
const KEPT = /event note\.saved notice-stack → notes delivered/;
const REFUSED = /event session\.refused session → .*\bnotice-stack\b.* delivered/;

async function until(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

function watch(page, problems) {
  page.on("console", (msg) => {
    // The clash is provoked on purpose, so the 409 the browser logs as a failed
    // resource is expected, not a fault; everything else counts.
    if (msg.type() === "error" && !/status of 409/.test(msg.text())) problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => {
    if (res.status() >= 400 && !res.url().includes("/api/notes/")) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
}

// Replace the editor's text as one edit and commit it: a blur saves at once (4.3), no
// throttle wait.
const write = (page, text) =>
  page.evaluate((t) => {
    const view = document.querySelector("note-editor").shadowRoot.querySelector(".cm-content").cmView.rootView.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } });
    view.contentDOM.dispatchEvent(new FocusEvent("blur"));
  }, text);

// Push the tab to the background: the fact drains the outbox at once (5), so a PUT
// flies now rather than after the idle window.
const drain = (page) =>
  page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });

// The stack's own shadow, read as the user sees it.
const notices = (page) =>
  page.evaluate(() =>
    [...(document.querySelector("notice-stack")?.shadowRoot?.querySelectorAll(".notice") ?? [])].map((n) => ({
      role: n.getAttribute("role"),
      text: n.querySelector("p").textContent.trim(),
      hasAction: Boolean(n.querySelector(".act")),
    })),
  );
const clickKeepMine = (page) =>
  page.evaluate(() => document.querySelector("notice-stack").shadowRoot.querySelector(".act")?.click());
const clickPhone = (page) =>
  page.evaluate(() => {
    for (const b of document.querySelector("viewport-switch").shadowRoot.querySelectorAll("button")) {
      if (b.textContent.trim() === "Phone") b.click();
    }
  });

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

for (const engine of ENGINES) {
  // A real conflict, end to end: the server holds a newer copy, the tab's edit is
  // refused (409), notes emits note.conflicted, the stack shows it, and Keep mine
  // re-emits note.saved so the user's copy survives (12).
  test(`a conflict shows a notice and Keep mine keeps the user's copy in ${engine.name}`, async () => {
    const SECRET = process.env.SESSION_SECRET;
    assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
    assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");
    const userId = `notice-page-${Date.now()}`;
    const cookie = `${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;
    const browser = await engine.launch();
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    await context.addCookies([{ name: "unblent_session", value: cookie, url: BASE_URL }]);
    try {
      const problems = [];
      const debug = [];
      const puts = [];
      const page = await context.newPage();
      watch(page, problems);
      page.on("console", (msg) => {
        if (msg.type() === "debug") debug.push(msg.text());
      });
      await page.addInitScript(() => {
        window.__puts = [];
        const real = window.fetch;
        window.fetch = (url, init) => {
          const method = init?.method ?? "GET";
          if (method === "PUT" && /\/api\/notes\//.test(String(url))) window.__puts.push(String(url));
          return real(url, init);
        };
      });
      await page.goto(`${BASE_URL}/workshop/apps/notes`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector(".cm-content"));
      // The sign-in pull settles the fact before the first edit (5).
      await until(() => page.evaluate(() => window.__puts !== undefined));

      write(page, "Meeting\nfirst body");
      drain(page);
      await until(async () => (await page.evaluate(() => window.__puts.length)) >= 1);
      const putUrl = await page.evaluate(() => window.__puts[0]);
      const id = putUrl.split("/").pop();

      // Another device writes a newer copy: the server is now at version 2, the tab
      // still holds version 1, so its next save is stale.
      const res = await context.request.put(`${BASE_URL}/api/notes/${id}`, {
        data: { title: "Meeting", body: "their body", baseVersion: 1 },
      });
      assert.equal(res.status(), 200, "the newer copy was accepted");

      write(page, "Meeting\nmy body");
      drain(page);
      await until(() => debug.some((l) => CONFLICTED.test(l)));

      const shown = await notices(page);
      assert.equal(shown.length, 1, "one notice");
      assert.equal(shown[0].role, "alert", "a conflict stands (role=alert)");
      assert.equal(shown[0].hasAction, true, "it offers Keep mine");

      clickKeepMine(page);
      await until(() => debug.some((l) => KEPT.test(l)));
      assert.equal((await notices(page)).length, 0, "the notice is done once the copy is kept");
      // notes held theirs on the clash; the kept save lands, the server acks a newer
      // version, and note.changed brings the user's copy back to the editor.
      drain(page);
      const editorBody = () =>
        page.evaluate(() => document.querySelector("note-editor").shadowRoot.querySelector(".cm-content").cmView.rootView.view.state.doc.toString());
      await until(async () => (await editorBody()).includes("my body"));

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  // The stack is fixed above the switch and stays within the window in a phone
  // preview (7.5): a bounded toast column, not a full-width bar.
  test(`a notice stays within the window in a phone preview in ${engine.name}`, async () => {
    const browser = await engine.launch();
    // A bare context with no authenticator: navigator.credentials rejects promptly,
    // which the fact maps to a refusal (12). That path legitimately returns a 4xx and
    // logs a resource error, as the session ceremony test documents, so only a
    // pageerror counts as a fault here.
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    try {
      const problems = [];
      const page = await context.newPage();
      page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
      // A short window so a passing notice does not linger; seed the notice from a
      // real refusal by clicking sign-in with no authenticator.
      await page.addInitScript(() => localStorage.setItem("viewport", "phone"));
      await page.goto(`${BASE_URL}/workshop/design/session`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      await page.evaluate(() => document.querySelector("notice-stack").style.setProperty("--duration-undo", "4s"));
      await page.evaluate(() => document.querySelector("session-switch").shadowRoot.querySelector("button")?.click());
      await until(async () => (await notices(page)).length >= 1);
      const fits = await page.evaluate(() => {
        const el = document.querySelector("notice-stack");
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth + 1;
      });
      assert.ok(fits, "the stack is within the window, no horizontal overflow");
      await page.screenshot({ path: resolve(SCREENSHOTS, `notice-phone-${engine.name}.png`) });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  // A refused book is a book.refused the stack shows in its own words. The two
  // provokable reasons are driven end to end on the books stem page: signed out (the
  // fact mints nothing anonymously) and a broken file (not an epub). The unavailable
  // wording is the same one the session unavailable path exercises above.
  test(`a refused book shows the stack's message in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    try {
      const problems = [];
      const page = await context.newPage();
      // A 422 on /api/books is the deliberate unreadable path; everything else 4xx is
      // a fault.
      page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
      page.on("response", (res) => {
        if (res.status() >= 400 && !/\/api\/books\//.test(res.url())) problems.push(`HTTP ${res.status()}: ${res.url()}`);
      });
      const setFile = (path) => page.locator("book-shelf input[type=file]").setInputFiles(path);

      // Signed out: a picked file is refused, and the stack invites a sign-in.
      await page.goto(`${BASE_URL}/workshop/design/books`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-shelf")?.shadowRoot);
      await until(async () =>
        (await page.evaluate(() => document.querySelector("book-shelf").shadowRoot.querySelector(".empty p")?.textContent.trim())) ===
        "Sign in to add books",
      );
      await setFile(resolve(FIXTURES, "sample.epub"));
      await until(async () => (await notices(page)).some((n) => n.text === "Sign in to continue."));

      // Signed in: a broken file is refused as not an epub.
      const SECRET = process.env.SESSION_SECRET;
      assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
      assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");
      const userId = `notice-book-${Date.now()}`;
      const cookie = `${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;
      await context.addCookies([{ name: "unblent_session", value: cookie, url: BASE_URL }]);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-shelf")?.shadowRoot);
      await setFile(resolve(FIXTURES, "broken.epub"));
      await until(async () => (await notices(page)).some((n) => n.text === "This file is not an epub."));

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}

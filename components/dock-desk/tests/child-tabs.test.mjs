import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// Arranging off, so the desk draws a child's own tabs, and "Vim keys" on for Ctrl+.
const SETTINGS = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: false, vimKeys: true });

// Stands in for a view that shows tabs of its own: it announces them for the desk's
// Contracts child, follows tab.picked and tab.closed as the view would, and keeps what
// it heard in window.heard.
const harness = (page) =>
  page.evaluate(async () => {
    const [{ mount }, { setup, emit }] = await Promise.all([import("/static/bus/bus.js"), import("xstate")]);
    const schema = await (await fetch("/static/components/book-stage/events/tabs.shown.json")).json();
    window.heard = [];
    let tabs = [
      { id: "journal", label: "Journal", closable: true },
      { id: "b1", label: "Walden", closable: true },
      { id: "b2", label: "Emma", closable: true },
    ];
    let active = "b1";
    const shown = () => ({ type: "tabs.shown", view: "contract-list", tabs, active });
    const machine = setup({}).createMachine({
      id: "test-tabs",
      meta: { kind: "view", emits: ["tabs.shown"], attributes: [] },
      on: {
        go: { actions: emit(shown) },
        "tab.picked": {
          actions: [
            ({ event }) => {
              window.heard.push(["picked", event.id]);
              active = event.id;
            },
            emit(shown),
          ],
        },
        "tab.closed": {
          actions: [
            ({ event }) => {
              window.heard.push(["closed", event.id]);
              tabs = tabs.filter((t) => t.id !== event.id);
              if (active === event.id) active = tabs[0].id;
            },
            emit(shown),
          ],
        },
      },
    });
    mount(machine, { events: { "tabs.shown": schema } }).send({ type: "go" });
  });

const strip = (page) =>
  page.evaluate(() =>
    [...document.querySelector("dock-desk").shadowRoot.querySelectorAll('.stage .strip [role="tab"]')].map(
      (t) => (t.getAttribute("aria-selected") === "true" ? "*" : "") + t.textContent.trim(),
    ),
  );

const heard = (page) => page.evaluate(() => window.heard);
const tab = (page, name) => page.locator("dock-desk .stage .strip").getByRole("tab", { name, exact: true });

for (const engine of ENGINES) {
  // Browser: a gesture.
  test(`a child's own tabs are clicked, closed and stepped with Ctrl+, on the desk in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    context.setDefaultTimeout(4000);
    try {
      await context.addInitScript((value) => {
        localStorage.setItem("settings", value);
        localStorage.setItem("settings:workshop", value);
      }, SETTINGS);
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/workshop/design/dock`);
      await page.waitForFunction(() => document.querySelector("dock-desk")?.shadowRoot?.querySelector(".stage .strip [role=tab]"));
      await harness(page);
      await until(async () => (await strip(page)).join() === "*Tokens,Journal,Walden,Emma,Components");

      await tab(page, "Emma").click();
      await until(async () => (await strip(page)).includes("*Emma"));
      assert.deepEqual(await heard(page), [["picked", "b2"]]);

      await page.locator("dock-desk").getByRole("button", { name: "Close Journal" }).click();
      await until(async () => (await strip(page)).join() === "Tokens,Walden,*Emma,Components");
      assert.deepEqual((await heard(page)).at(-1), ["closed", "journal"]);

      await page.keyboard.press("Control+,");
      await until(async () => (await strip(page)).includes("*Walden"));
      assert.deepEqual((await heard(page)).at(-1), ["picked", "b1"]);
      await page.keyboard.press("Control+,");
      await until(async () => (await strip(page)).includes("*Tokens"));
      await page.keyboard.press("Control+.");
      await until(async () => (await strip(page)).includes("*Walden"));
      assert.equal((await heard(page)).length, 3, "Walden was already the child's tab in front");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}

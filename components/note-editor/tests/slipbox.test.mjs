import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The Slip-Box is not released until the admin releases it (3.1), so the account's
// picture of the features is answered by the route: every feature released and shown.
const showAll = (context) =>
  context.route(/\/api\/flags$/, (route) => route.fulfill({ json: { off: [], hidden: [], released: ["choice-points", "slip-box"], shown: ["choice-points", "slip-box"] } }));

const PANEL = "note-editor:not([stage])";
const inPanel = (page, fn, arg) => page.evaluate(([sel, body, arg]) => new Function("root", "arg", body)(document.querySelector(sel).shadowRoot, arg), [PANEL, fn, arg]);

// The product page on the phone preview with Slip-Box shown, the Slip-Box opened on the
// stage; `body` drives it from there.
async function onSlipBox(engine, body) {
  const browser = await engine.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(4000);
  try {
    await signedIn(context, forgeCookie("editor-home"));
    await showAll(context);
    await context.addInitScript(() => localStorage.getItem("viewport") ?? localStorage.setItem("viewport", "phone"));
    const page = await context.newPage();
    // A reload cuts the first pulls short, which WebKit reports as "access control
    // checks": navigation, not a fault.
    const problems = watch(page, [], { ignore: [/due to access control checks|Load request cancelled/] });
    const openSlipBox = () =>
      until(() =>
        page.evaluate(() => {
          const tile = [...(document.querySelector("book-shelf")?.shadowRoot?.querySelectorAll(".tile") ?? [])].find((t) => t.querySelector(".title")?.textContent.trim() === "Slip-Box");
          tile?.click();
          return Boolean(tile);
        }),
      );
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await openSlipBox();
    await body(page, openSlipBox);
    assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

for (const engine of ENGINES) {
  // Browser: a reload against real storage (the fold is kept in this browser).
  test(`a folded footer section stays folded after a reload in ${engine.name}`, () =>
    onSlipBox(engine, async (page, openSlipBox) => {
      const stageFold = () => page.evaluate(() => document.querySelector("note-editor[stage]").shadowRoot.querySelector(".fold")?.getAttribute("aria-expanded") ?? null);
      await until(async () => (await stageFold()) === "true");
      await page.evaluate(() => document.querySelector("note-editor[stage]").shadowRoot.querySelector(".fold").click());
      await until(async () => (await stageFold()) === "false");
      await page.reload({ waitUntil: "domcontentloaded" });
      await openSlipBox();
      await until(async () => (await stageFold()) === "false");
    }));

  // Browser: rendering and layout (the Add to Slip-Box list inside the narrow Notes drawer
  // of the phone).
  test(`on the phone the Add to Slip-Box list stays inside the editor in ${engine.name}`, () =>
    onSlipBox(engine, async (page) => {
      // A note written under the Slip-Box and taken out of it again, so the list offers the Slip-Box.
      await until(() =>
        page.evaluate(() => {
          const row = document.querySelector("note-list")?.shadowRoot?.querySelector("li .name.draft")?.closest("li");
          row?.click();
          return Boolean(row);
        }),
      );
      await until(() => inPanel(page, `return root.querySelector(".home")?.textContent.includes("Slip-Box")`));
      await inPanel(page, `root.querySelector(".cm-content").focus()`);
      await page.keyboard.type("Alpha");
      await until(() => inPanel(page, `const x = root.querySelector(".home .x"); x?.click(); return Boolean(x)`));
      await until(() => inPanel(page, `const add = root.querySelector(".home-add:not(:disabled)"); add?.click(); return Boolean(add)`));
      await until(() => inPanel(page, `return root.querySelectorAll(".slip-row").length > 0`));
      const box = await inPanel(page, `const l = root.querySelector(".slip-list").getBoundingClientRect(); const e = root.querySelector(".editor").getBoundingClientRect(); return { list: [l.left, l.right], editor: [e.left, e.right] }`);
      assert.ok(box.list[0] >= box.editor[0] - 1 && box.list[1] <= box.editor[1] + 1, `the list within the editor, saw ${JSON.stringify(box)}`);
    }));
}

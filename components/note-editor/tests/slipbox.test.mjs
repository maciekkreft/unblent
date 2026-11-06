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

const SLIPBOX = "00000000000000000000000SBX";
const PARENT = "01K0000000000000000000PRNT";
const KID = "01K0000000000000000000CH1D";

const PANEL = "note-editor:not([stage])";
const inPanel = (page, fn, arg) => page.evaluate(([sel, body, arg]) => new Function("root", "arg", body)(document.querySelector(sel).shadowRoot, arg), [PANEL, fn, arg]);

// The product page on the phone preview with Slip-Box shown, the Slip-Box opened on the
// stage; `body` drives it from there.
async function onSlipBox(engine, body, setup = null) {
  const cookie = forgeCookie("editor-home");
  if (setup) await setup(cookie);
  const browser = await engine.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(4000);
  try {
    await signedIn(context, cookie);
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
      // A note written under the Slip-Box and taken out of it again; Permanent then opens the list.
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
      // Made under the Slip-Box, the note is permanent, which keeps it there; as fleeting it may leave.
      await until(() => inPanel(page, `const t = root.querySelector(".home-type"); t?.click(); return t?.textContent.trim() === "Permanent"`));
      await until(() => inPanel(page, `const row = root.querySelector(".type-row"); row?.click(); return Boolean(row)`));
      await until(() => inPanel(page, `return root.querySelector(".home-type")?.textContent.trim() === "Fleeting"`));
      await until(() => inPanel(page, `const x = root.querySelector(".home .x:not(:disabled)"); x?.click(); return Boolean(x)`));
      await until(() => inPanel(page, `return !root.querySelector(".home .x") && !root.querySelector(".home-add")`));
      await inPanel(page, `root.querySelector(".home-type").click()`);
      await until(() => inPanel(page, `const row = root.querySelectorAll(".type-row")[2]; row?.click(); return Boolean(row)`));
      await until(() => inPanel(page, `return root.querySelectorAll(".slip-row").length > 0`));
      const box = await inPanel(page, `const l = root.querySelector(".slip-list").getBoundingClientRect(); const e = root.querySelector(".editor").getBoundingClientRect(); return { list: [l.left, l.right], editor: [e.left, e.right] }`);
      assert.ok(box.list[0] >= box.editor[0] - 1 && box.list[1] <= box.editor[1] + 1, `the list within the editor, saw ${JSON.stringify(box)}`);
    }));

  // Browser: focus and keys (the type menu is opened, moved through and left from the
  // keyboard, and Permanent outside the Slip-Box leads to the Add to Slip-Box list and back).
  test(`the type menu works from the keyboard and Permanent asks for a place first in ${engine.name}`, () =>
    onSlipBox(engine, async (page) => {
      await until(() =>
        page.evaluate(() => {
          const row = document.querySelector("note-list")?.shadowRoot?.querySelector("li .name.draft")?.closest("li");
          row?.click();
          return Boolean(row);
        }),
      );
      await until(() => inPanel(page, `return root.querySelector(".home")?.textContent.includes("Slip-Box")`));
      await inPanel(page, `root.querySelector(".cm-content").focus()`);
      await page.keyboard.type("Beta");
      const label = () => inPanel(page, `return root.querySelector(".home-type")?.textContent.trim() ?? null`);
      const focused = () => inPanel(page, `return root.activeElement?.className ?? null`);
      await until(async () => (await label()) === "Permanent");
      await inPanel(page, `root.querySelector(".home-type").focus()`);
      await page.keyboard.press("Enter");
      await until(async () => String(await focused()).includes("type-menu"));
      // The menu opens on the note's own type, Permanent; up goes to Literature, and
      // down then up again returns there.
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Enter");
      await until(async () => (await label()) === "Literature");
      await until(async () => (await focused()) === "home-type");
      // Escape closes the menu and gives the keyboard back to the label, changing nothing.
      await page.keyboard.press("Enter");
      await until(async () => String(await focused()).includes("type-menu"));
      await page.keyboard.press("Escape");
      await until(async () => (await focused()) === "home-type");
      assert.equal(await label(), "Literature");
      // Out of the Slip-Box, Enter on Permanent opens the Add to Slip-Box list; Escape gives
      // the keyboard back to the label, changing nothing.
      await until(() => inPanel(page, `const x = root.querySelector(".home .x:not(:disabled)"); x?.click(); return Boolean(x)`));
      await until(() => inPanel(page, `return !root.querySelector(".home .x")`));
      await inPanel(page, `root.querySelector(".home-type").focus()`);
      await page.keyboard.press("Enter");
      await until(async () => String(await focused()).includes("type-menu"));
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await until(async () => String(await focused()).includes("slip-list"));
      await page.keyboard.press("Escape");
      await until(async () => (await focused()) === "home-type");
      assert.equal(await label(), "Literature");
    }));

  // Browser: a gesture (a press on a greyed type shows why, since a phone has no tooltip,
  // and Enter on it does the same).
  test(`a greyed type says why on a press and on Enter in ${engine.name}`, () =>
    onSlipBox(
      engine,
      async (page) => {
        const label = () => inPanel(page, `return root.querySelector(".home-type")?.textContent.trim() ?? null`);
        const line = (i) => inPanel(page, `return root.querySelectorAll(".type-row")[arg]?.querySelector(".under").textContent ?? null`, i);
        const REASON = "Move or delete the notes under it first";
        await until(() =>
          page.evaluate(() => {
            const row = [...(document.querySelector("note-list")?.shadowRoot?.querySelectorAll("li") ?? [])].find((r) => r.querySelector(".name")?.textContent.trim() === "Parent");
            row?.click();
            return Boolean(row);
          }),
        );
        await until(async () => (await label()) === "Permanent");
        await inPanel(page, `root.querySelector(".home-type").click()`);
        await until(async () => (await line(0)) !== null);
        assert.equal(await inPanel(page, `return root.querySelector(".type-row").title`), REASON);
        assert.notEqual(await line(0), REASON);
        await inPanel(page, `root.querySelector(".type-row").click()`);
        await until(async () => (await line(0)) === REASON);
        // The menu stays open on the greyed row, and Enter on the other greyed row says the same.
        await inPanel(page, `root.querySelector(".type-menu").focus()`);
        await page.keyboard.press("ArrowUp");
        await page.keyboard.press("Enter");
        await until(async () => (await line(1)) === REASON);
        await page.keyboard.press("Escape");
        await until(() => inPanel(page, `return !root.querySelector(".type-menu")`));
        assert.equal(await label(), "Permanent");
      },
      async (cookie) => {
        const put = (id, title, about, noteType) =>
          fetch(`${BASE_URL}/api/notes/${id}`, {
            method: "PUT",
            headers: { "content-type": "application/json", Cookie: `unblent_session=${cookie}` },
            body: JSON.stringify({ title, body: title, baseVersion: null, about, noteType }),
          });
        assert.equal((await put(PARENT, "Parent", [{ kind: "note", id: SLIPBOX }], "permanent")).status, 200);
        assert.equal((await put(KID, "Kid", [{ kind: "note", id: PARENT }], "permanent")).status, 200);
      },
    ));
}

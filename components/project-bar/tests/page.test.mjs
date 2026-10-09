import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Judge stem page (8): the bar with its three facts and notice-stack, walked as a
// user would. Projects are kept on this device, so a reload shows what was stored.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, shortUndo } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/design/judge`;
const UNDO_MS = 300;

// The menu as the user reads it: each project's name, the line under it, and the tick.
const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelector("project-bar").shadowRoot.querySelectorAll('[role="menuitemradio"]')].map((r) => ({
      name: r.querySelector(".pname").textContent.trim(),
      sub: r.querySelector(".sub").textContent.trim(),
      ticked: r.getAttribute("aria-checked") === "true" && getComputedStyle(r.querySelector(".tick")).visibility === "visible",
    })),
  );
const current = (page) => page.locator("project-bar button.open .name").textContent();
const pause = (page) => page.waitForTimeout(120);

async function open(page) {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.locator("project-bar button.open").waitFor();
}

async function newProject(page, name) {
  await page.locator("project-bar button.open").click();
  await page.locator("project-bar .item", { hasText: "New project" }).click();
  const field = page.locator("project-bar input");
  await field.waitFor();
  assert.equal(await field.inputValue(), "New project");
  await pause(page);
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  await until(async () => (await current(page)) === name);
}

for (const engine of ENGINES) {
  describe(`the project bar in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    test("switch project, make a new one, and it is still current after a reload", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await open(page);
        assert.equal(await current(page), "Goals and values");

        await page.locator("project-bar button.open").click();
        await until(async () => (await rows(page)).length === 2);
        assert.deepEqual((await rows(page))[0], { name: "Goals and values", sub: "2 tools · 18 cases", ticked: true });
        assert.equal((await rows(page))[1].ticked, false);
        await pause(page);

        await page.locator('project-bar [role="menuitemradio"]', { hasText: "Replies" }).click();
        await until(async () => (await current(page)) === "Replies");
        assert.equal(await page.locator("project-bar .menu").count(), 0, "picking closes the menu");
        await pause(page);

        await newProject(page, "Habits");
        await pause(page);

        await page.reload({ waitUntil: "domcontentloaded" });
        await page.locator("project-bar button.open").waitFor();
        await until(async () => (await current(page)) === "Habits");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    test("delete a project, Undo brings it back; delete again and it is gone", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await shortUndo(context, UNDO_MS);
        const page = await context.newPage();
        const problems = watch(page);
        await open(page);
        await newProject(page, "Habits");

        const remove = async () => {
          await page.locator("project-bar button.open").click();
          await page.locator("project-bar .item", { hasText: "Delete this project" }).click();
          await until(async () => (await current(page)) === "Replies");
        };
        await remove();
        await page.locator("notice-stack .undo").waitFor();
        assert.match(await page.locator("notice-stack .notice").textContent(), /Project “Habits” deleted\./);
        await page.locator("notice-stack .undo").click();
        await until(async () => (await current(page)) === "Habits");
        await page.locator("project-bar button.open").click();
        assert.deepEqual((await rows(page)).map((r) => r.name), ["Goals and values", "Replies", "Habits"]);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("project-bar .menu").count(), 0, "Escape closes the menu");
        await pause(page);

        await remove();
        await page.mouse.move(0, 400);
        await page.locator("notice-stack .undo").waitFor();
        await page.locator("notice-stack .notice").waitFor({ state: "detached" });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.locator("project-bar button.open").click();
        await until(async () => (await rows(page)).length > 0);
        assert.deepEqual((await rows(page)).map((r) => r.name), ["Goals and values", "Replies"]);
        assert.equal(await current(page), "Replies");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
    test("rename with Done, a blank name keeps the old one, and a click outside closes the menu", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await open(page);
        const rename = async (typed) => {
          await page.locator("project-bar button.open").click();
          await page.locator("project-bar .item", { hasText: "Rename this project" }).click();
          await page.locator("project-bar input").fill(typed);
          await pause(page);
          await page.locator("project-bar .done").click();
        };
        await rename("Values");
        await until(async () => (await current(page)) === "Values");
        await rename("   ");
        await pause(page);
        assert.equal(await current(page), "Values", "a blank name keeps the old one");

        await page.locator("project-bar button.open").click();
        await page.locator("project-bar .menu").waitFor();
        await page.mouse.click(600, 500);
        await page.locator("project-bar .menu").waitFor({ state: "detached" });
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

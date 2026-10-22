import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const PAGE = `${BASE_URL}/workshop/design/generators`;

for (const engine of ENGINES) {
  // Browser: a reload against real storage.
  test(`a prompt typed in the box is kept across a reload, and Run says what it asked, in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    try {
      const problems = [];
      await signedIn(context, forgeCookie("generator-settings"));
      const page = await context.newPage();
      watch(page, problems);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      const sections = page.locator("generator-settings section.generator");
      await until(async () => (await sections.count()) === 2);
      assert.deepEqual(await sections.locator("input.name").evaluateAll((els) => els.map((e) => e.value)), ["Chat title", "Journal summary"]);
      // No Anthropic key on a fresh account: one line says where to add it.
      await page.locator("generator-settings").getByText("Generators run on your Anthropic key.", { exact: false }).waitFor();

      const box = sections.first().locator(".cm-content");
      await box.click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("Name the chat in three words.");
      await page.keyboard.press("Tab");

      await sections.nth(1).getByRole("button", { name: "Run" }).click();
      await sections.nth(1).getByText("Asked for a new summary of the picked journal entry.").waitFor();

      await page.reload({ waitUntil: "domcontentloaded" });
      await until(async () => (await sections.count()) === 2);
      await until(async () => (await box.textContent()) === "Name the chat in three words.");
      assert.equal(await sections.first().locator("input.name").inputValue(), "Chat title", "only the prompt changed");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}

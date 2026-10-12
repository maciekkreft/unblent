import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Detectors dock on the journal's stem page, walked as a user would: projects, then a
// project's detectors, then one detector. The journal is kept in this browser while
// signed out, so a reload shows what was stored.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/design/journal`;

// The projects as the user reads them: name, the line under it, and the tick.
const projects = (page) =>
  page.evaluate(() =>
    [...(document.querySelector("detector-projects").shadowRoot?.querySelectorAll(".row[data-id]") ?? [])].map((r) => ({
      name: r.querySelector(".name").textContent.trim(),
      sub: r.querySelector(".sub").textContent.trim(),
      ticked: r.querySelector('input[type="checkbox"]').checked,
    })),
  );

// The Back bars the panel draws, outer then inner; the panel shows one at a time.
const bars = (page) =>
  page.evaluate(() =>
    ["detectors", "project-detectors"]
      .map((id) => document.getElementById(id).shadowRoot.querySelector(".bar button span")?.textContent.trim())
      .filter(Boolean),
  );

// What the user sees in the panel: the deepest shown child.
const showing = (page) =>
  page.evaluate(() => {
    const shown = (el) => el.shadowRoot.querySelector("slot").assignedElements()[0];
    let child = shown(document.getElementById("detectors"));
    while (child?.localName === "list-then-item") child = shown(child);
    return child?.localName;
  });

const listHint = (page) => page.evaluate(() => document.querySelector("detector-list").shadowRoot.querySelector(".hint")?.textContent.trim());

const question = (page) =>
  page.evaluate(() => document.querySelector("detector-editor").shadowRoot.querySelector("textarea.text")?.value);

async function open(page) {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await until(async () => (await projects(page).catch(() => [])).length > 0);
}

for (const engine of ENGINES) {
  describe(`the Detectors dock in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    test("untick and tick a project, open a detector, and reword its question", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await open(page);
        assert.deepEqual(await projects(page), [
          { name: "Cognitive Distortion", sub: "1 of 1 on", ticked: true },
          { name: "Goals and values", sub: "1 of 2 on", ticked: true },
        ]);

        // Unticking a project keeps its detectors' own ticks, and is kept after a reload.
        await page.getByRole("checkbox", { name: "Goals and values reads your writing" }).uncheck();
        await page.waitForTimeout(120);
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await projects(page).catch(() => [])).length === 2);
        assert.deepEqual((await projects(page))[1], { name: "Goals and values", sub: "1 of 2 on", ticked: false });

        // Its detectors say they do not read the writing while it is unticked.
        await page.locator("detector-projects .row[data-id] .open", { hasText: "Goals and values" }).click();
        await until(async () => (await showing(page)) === "detector-list");
        assert.deepEqual(await bars(page), ["Projects"]);
        assert.equal(await listHint(page), "This project is unticked, so none of its detectors read your writing; their own ticks are kept.");

        await page.locator("#detectors").getByRole("button", { name: "Back to Projects" }).click();
        await until(async () => (await showing(page)) === "detector-projects");
        await page.getByRole("checkbox", { name: "Goals and values reads your writing" }).check();
        await until(async () => (await projects(page))[1].ticked);

        // Open a detector: one Back bar, naming the project.
        await page.locator("detector-projects .row[data-id] .open", { hasText: "Goals and values" }).click();
        await until(async () => (await listHint(page)) === "Ticked detectors read your writing.");
        await page.locator("detector-list .row[data-id] .open", { hasText: "Goal or value (yes / no)" }).click();
        await until(async () => (await showing(page)) === "detector-editor");
        assert.deepEqual(await bars(page), ["Goals and values"]);

        // Reword its first question; the new wording is what the journal keeps.
        const first = page.locator("detector-editor").getByRole("textbox", { name: "Question 1" });
        assert.equal(await first.inputValue(), "Is this a goal?");
        await first.fill("Is this something to finish?");
        await first.blur();
        await page.waitForTimeout(120);
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await question(page).catch(() => null)) === "Is this something to finish?");
        assert.deepEqual(await bars(page), ["Goals and values"], "a reload keeps the panel where it was");

        // Back twice: the project's detectors, then the projects.
        await page.locator("#project-detectors").getByRole("button", { name: "Back to Goals and values" }).click();
        await until(async () => (await showing(page)) === "detector-list");
        assert.deepEqual(await bars(page), ["Projects"]);
        await page.locator("#detectors").getByRole("button", { name: "Back to Projects" }).click();
        await until(async () => (await showing(page)) === "detector-projects");
        assert.deepEqual(await bars(page), []);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}

import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): both real machines on the real bus, with their real schemas.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FA0";

test("a paste and a comment reach review and come back as review.changed", async () => {
  const stored = [];
  const { actors, unwire } = await wire(["review", "review-editor"], {
    review: { stored: null, save: (v) => stored.push(v) },
    "review-editor": { mint: () => ID, undoMs: 100, throttleMs: 0 },
  });
  try {
    const editor = actors["review-editor"];
    await until(() => editor.getSnapshot().matches("empty"));
    editor.send({ type: "_pasted", text: "A book was a path." });
    editor.send({ type: "_selected", start: 2, end: 6 });
    editor.send({ type: "_typed", text: "say app" });
    editor.send({ type: "_closed" });
    await until(() => editor.getSnapshot().context.review?.comments.length === 1);
    assert.deepEqual(JSON.parse(stored.at(-1)), {
      text: "A book was a path.",
      comments: [{ id: ID, start: 2, end: 6, quote: "book", text: "say app" }],
    });
  } finally {
    unwire();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine, parseLimit, limitEdit, limitText, shortOf } from "../machine.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

const SPENDING = {
  allGuests: { spent: 3.42, limit: 10 },
  guest: 1,
  providers: [
    { id: "jev", label: "Jev by typesafe.ai", spent: 0.12, limit: null, guestKeySet: true, price: "$42 per billion tokens read" },
    { id: "anthropic", label: "Anthropic", spent: 3.3, limit: 5, guestKeySet: false, price: "Each model's published price per million tokens" },
  ],
  guests: [],
};

test("a typed limit is read as dollars; empty is no limit only for a provider", () => {
  assert.deepEqual(["$2", "2.50", "2,5", " $ 0.10 ", ".5"].map((t) => parseLimit(t, false)), [2, 2.5, 2.5, 0.1, 0.5]);
  assert.equal(parseLimit("", false), undefined);
  assert.equal(parseLimit("", true), null);
  assert.equal(parseLimit("-1", true), undefined);
  assert.equal(parseLimit("ten", true), undefined);
  assert.deepEqual([limitText(1), limitText(null), shortOf("Jev by typesafe.ai")], ["$1.00", "", "Jev"]);
});

test("a limit changes only the field typed in, and nothing when it is the same or not an amount", () => {
  assert.deepEqual(limitEdit(SPENDING, "guest", "$2"), { guest: 2 });
  assert.deepEqual(limitEdit(SPENDING, "allGuests", "20"), { allGuests: 20 });
  assert.deepEqual(limitEdit(SPENDING, "jev", "3"), { providers: { jev: 3 } });
  assert.deepEqual(limitEdit(SPENDING, "anthropic", ""), { providers: { anthropic: null } }, "emptied: no own limit");
  assert.equal(limitEdit(SPENDING, "guest", "$1.00"), null);
  assert.equal(limitEdit(SPENDING, "guest", ""), null, "each guest always has a limit");
  assert.equal(limitEdit(SPENDING, "jev", ""), null);
  assert.equal(limitEdit(SPENDING, "openai", "1"), null);
});

test("it asks only once shown, emits the admin's gestures, and adopts spending.changed", async () => {
  const asked = [];
  const emitted = [];
  const actor = createActor(machine, { input: { ask: async (...a) => (asked.push(a), SPENDING) } });
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  await flush();
  assert.deepEqual(asked, [], "nothing is asked while the part is not shown");
  actor.send({ type: "_shown" });
  await flush();
  assert.deepEqual(asked, [["llm", "spending", {}]]);
  assert.equal(actor.getSnapshot().context.spending.guest, 1);

  actor.send({ type: "_setLimit", field: "guest", text: "2" });
  actor.send({ type: "_setLimit", field: "guest", text: "nonsense" });
  actor.send({ type: "_saveKey", provider: "anthropic", key: "  sk-ant-x  " });
  actor.send({ type: "_saveKey", provider: "anthropic", key: "   " });
  assert.deepEqual(emitted, [
    { type: "limits.edited", guest: 2 },
    { type: "guestkeys.edited", anthropic: "sk-ant-x" },
  ]);
  assert.ok(!JSON.stringify(actor.getSnapshot().context).includes("sk-ant"), "a key never enters context");

  actor.send({ type: "spending.changed", ...SPENDING, guest: 2 });
  assert.equal(actor.getSnapshot().context.spending.guest, 2);
});

test("an answer that is not the picture leaves the part saying so", async () => {
  const actor = createActor(machine, { input: { ask: async () => ({ error: "not-admin" }) } }).start();
  actor.send({ type: "_shown" });
  await flush();
  assert.equal(actor.getSnapshot().context.spending, null);
  assert.equal(actor.getSnapshot().context.failed, true);
});

test("Remove waits out the undo window: Undo keeps the key, the end of the window removes it", async () => {
  const clock = new SimulatedClock();
  const emitted = [];
  const actor = createActor(machine, { input: { ask: async () => SPENDING, undoMs: 3000 }, clock });
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  actor.send({ type: "_shown" });
  await flush();

  actor.send({ type: "_removeKey", provider: "jev" });
  assert.deepEqual(actor.getSnapshot().context.removing, ["jev"]);
  clock.increment(2999);
  assert.deepEqual(emitted, [], "nothing is removed inside the window");
  actor.send({ type: "_undoRemove", provider: "jev" });
  clock.increment(5000);
  assert.deepEqual(emitted, [], "Undo keeps the key");
  assert.deepEqual(actor.getSnapshot().context.removing, []);

  actor.send({ type: "_removeKey", provider: "jev" });
  actor.send({ type: "_removeKey", provider: "jev" });
  clock.increment(3000);
  assert.deepEqual(emitted, [{ type: "guestkeys.edited", jev: "" }], "removed once, when the window ends");
  assert.deepEqual(actor.getSnapshot().context.removing, []);
  assert.deepEqual(actor.getSnapshot().context.removed, ["jev"], "shown as gone until the new picture comes");
  actor.send({ type: "spending.changed", ...SPENDING });
  assert.deepEqual(actor.getSnapshot().context.removed, []);
});

// S8: a Save right after the part came into view was lost. Coming into view reads the
// data again, and a gesture sent while that read is out is applied all the same.
test("a key saved while the part reads its data again is not dropped", async () => {
  let answer;
  const emitted = [];
  const actor = createActor(machine, { input: { ask: () => new Promise((r) => (answer = r)) } });
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  actor.send({ type: "_shown" });
  answer(SPENDING);
  await flush();
  actor.send({ type: "_shown" });
  assert.equal(actor.getSnapshot().value, "reading");
  actor.send({ type: "_saveKey", provider: "jev", key: "jev-key" });
  actor.send({ type: "_setLimit", field: "guest", text: "3" });
  assert.deepEqual(emitted, [
    { type: "guestkeys.edited", jev: "jev-key" },
    { type: "limits.edited", guest: 3 },
  ]);
  answer(SPENDING);
  await flush();
});

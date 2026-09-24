// Tests for the kit's Node half (architecture.md 9, 10): two fixture machines under
// checks/tests/fixtures meet on the real bus. Run through the full check, which sets
// UNBLENT_KIT, or standalone with `node --import ./checks/register.mjs --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const { wire } = await import(process.env.UNBLENT_KIT ?? resolve(HERE, "..", "kit.mjs"));
const FIXTURES = resolve(HERE, "fixtures");

test("two real machines meet on the real bus, and the tap records the delivery", async () => {
  const { actors, records, unwire } = await wire(["ping", "pong"], {}, { root: FIXTURES });
  try {
    actors.ping.send({ type: "go", n: 7 });
    assert.deepEqual(actors.pong.getSnapshot().context.got, [7]);
    const sent = records.find((r) => r.kind === "event" && r.name === "ping.sent");
    assert.ok(sent, "the bus recorded the event");
    assert.equal(sent.outcome, "delivered");
    assert.ok(sent.to.includes("pong"), `delivered to pong: ${JSON.stringify(sent.to)}`);
  } finally {
    unwire();
  }
});

test("a machine's input comes from the caller, beside the bus's ask", async () => {
  const seen = [];
  const { actors, unwire } = await wire(["ping", "pong"], { pong: { sink: (n) => seen.push(n) } }, { root: FIXTURES });
  try {
    actors.ping.send({ type: "go", n: 1 });
    actors.ping.send({ type: "go", n: 2 });
    assert.deepEqual(seen, [1, 2]);
  } finally {
    unwire();
  }
});

test("unwire leaves the bus empty, so the same machines can be wired again", async () => {
  const first = await wire(["ping", "pong"], {}, { root: FIXTURES });
  first.unwire();
  const second = await wire(["ping", "pong"], {}, { root: FIXTURES });
  try {
    second.actors.ping.send({ type: "go", n: 3 });
    assert.deepEqual(second.actors.pong.getSnapshot().context.got, [3]);
    assert.deepEqual(first.actors.pong.getSnapshot().context.got, [], "the unwired pong hears nothing");
  } finally {
    second.unwire();
  }
});

test("a name that does not exist unwires what was mounted before it", async () => {
  await assert.rejects(wire(["ping", "no-such-fixture"], {}, { root: FIXTURES }));
  const again = await wire(["ping"], {}, { root: FIXTURES });
  again.unwire();
});

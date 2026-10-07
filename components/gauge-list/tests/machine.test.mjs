import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, subtitle } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELECTED = JSON.parse(readFileSync(resolve(HERE, "..", "events", "gauge.selected.json"), "utf8"));

const G = "01K6TEST000000000000000G00";
const D1 = "01K6TEST000000000000000D01";
const D2 = "01K6TEST000000000000000D02";
const gauge = (id, over = {}) => ({ id, name: "Clarity", question: "", rule: "adds", questions: [], reading: null, ...over });

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = async (gauges = [gauge(G)], reply) => {
  const ids = [D1, D2];
  const actor = createActor(machine, {
    input: { ask: () => Promise.resolve(reply ?? { gauges }), mint: () => ids.shift() },
  });
  const emitted = [];
  actor.on("gauge.selected", (e) => emitted.push(e));
  actor.start();
  await flush();
  return { actor, emitted };
};

test("the subtitle counts the questions", () => {
  assert.equal(subtitle(gauge(G, { questions: [{}, {}, {}, {}] })), "4 questions");
  assert.equal(subtitle(gauge(G, { questions: [{}] })), "1 question");
});

test("picking a gauge or the draft announces it; a stale id does nothing", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_pick", id: G });
  actor.send({ type: "_pick", id: D1 });
  actor.send({ type: "_pick", id: "01K6TEST000000000000000X99" });
  assert.deepEqual(emitted, [{ type: "gauge.selected", id: G }, { type: "gauge.selected", id: D1 }]);
  assert.equal(actor.getSnapshot().context.open, D1);
  for (const e of emitted) {
    const { type, ...rest } = e;
    assert.ok(new Validator(SELECTED, "2020-12").validate(rest).valid);
  }
});

test("when the draft becomes a gauge a fresh draft is minted", async () => {
  const { actor } = await start();
  actor.send({ type: "gauge.changed", gauges: [gauge(G), gauge(D1)] });
  assert.equal(actor.getSnapshot().context.draft, D2);
  assert.equal(actor.getSnapshot().context.gauges.length, 2);
});

test("a gauge that cannot answer leaves the list failed", async () => {
  const { actor } = await start([], { error: "no-answerer" });
  assert.ok(actor.getSnapshot().matches("failed"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMachine, emit } from "xstate";
import { mount, unmount, ask, tap, pageLoading } from "bus";

// Section 4.2: while the page is still running its scripts, a query to a target not
// mounted yet waits for it. Node has no page, so each test opens the window with
// `pageLoading()` and closes it with the function it returns, as DOMContentLoaded would.
// Its own file, so the window never reaches the other bus tests.
const SCHEMA = {};
const HSCHEMA = { payload: {}, reply: {}, supersededBy: ["thing.changed"] };
const settle = () => new Promise((r) => setTimeout(r, 0));

// A fact that parks each reply so a test decides when it lands, and emits
// `thing.changed`, which supersedes `read`, on a bump.
function fact(id, box) {
  return createMachine({
    id,
    meta: { kind: "fact", shape: "local-only", emits: ["thing.changed"], owns: "a test fact" },
    on: {
      "read?": { actions: ({ event }) => (box.replies ??= []).push({ payload: event.payload, reply: event.reply }) },
      bump: { actions: emit({ type: "thing.changed" }) },
    },
  });
}
const mountFact = (id, box) => mount(fact(id, box), { events: { "thing.changed": SCHEMA }, queries: { read: HSCHEMA } });

function asker(id, asks, received = []) {
  return createMachine({
    id,
    meta: { kind: "view", emits: [], attributes: [], asks },
    on: { "thing.changed": { actions: ({ event }) => received.push(event) } },
  });
}

test("a query asked before its target mounts waits and is delivered at the mount", async () => {
  const done = pageLoading();
  const box = {};
  const a = asker("a1", ["f1: read"]);
  const first = ask(a, "f1", "read", { n: 1 });
  const second = ask(a, "f1", "read", { n: 2 });
  await settle();
  assert.equal(box.replies, undefined);
  const f = mountFact("f1", box);
  assert.deepEqual(box.replies.map((r) => r.payload), [{ n: 1 }, { n: 2 }]); // in the order asked
  box.replies[0].reply({ v: 1 });
  box.replies[1].reply({ v: 2 });
  assert.deepEqual(await Promise.all([first, second]), [{ v: 1 }, { v: 2 }]);
  done();
  unmount(f);
});

test("a target mounted before the query answers it at once while loading", async () => {
  const done = pageLoading();
  const box = {};
  const f = mountFact("f2", box);
  const a = asker("a2", ["f2: read"]);
  const reply = ask(a, "f2", "read", {});
  assert.equal(box.replies.length, 1);
  box.replies[0].reply({ ok: true });
  assert.deepEqual(await reply, { ok: true });
  done();
  unmount(f);
});

test("a target that never mounts is answered no-answerer when loading finishes", async () => {
  const done = pageLoading();
  const records = [];
  const sub = tap((r) => records.push(r));
  const a = asker("a3", ["nobody: read"]);
  let settled = false;
  const reply = ask(a, "nobody", "read", {}).then((v) => ((settled = true), v));
  await settle();
  assert.equal(settled, false);
  assert.equal(records.filter((r) => r.cid).length, 0); // nothing decided yet
  done();
  assert.deepEqual(await reply, { error: "no-answerer" });
  const rec = records.at(-1);
  assert.equal(rec.outcome, "no-answerer");
  assert.match(rec.reason, /by load/);
  sub();
});

test("after loading a query to an unmounted target is answered at once, and a later mount answers later asks", async () => {
  const done = pageLoading();
  done();
  const a = asker("a4", ["f4: read"]);
  assert.deepEqual(await ask(a, "f4", "read", {}), { error: "no-answerer" });
  const box = {};
  const f = mountFact("f4", box);
  const reply = ask(a, "f4", "read", {});
  box.replies[0].reply({ late: true });
  assert.deepEqual(await reply, { late: true });
  unmount(f);
});

test("the hold of a waiting query starts at its delivery and ends after the reply", async () => {
  const done = pageLoading();
  const box = {};
  const received = [];
  const am = asker("a5", ["f5: read"], received);
  const a = mount(am, {});
  const reply = ask(am, "f5", "read", {});
  const f = mountFact("f5", box);
  f.send({ type: "bump" });
  assert.equal(received.length, 0); // held: the query was delivered at the mount
  box.replies[0].reply({});
  await reply;
  await settle();
  assert.equal(received.length, 1);
  done();
  unmount(f);
  unmount(a);
});

test("an undeclared ask still throws at once while loading", () => {
  const done = pageLoading();
  const a = asker("a6", []);
  assert.throws(() => ask(a, "f6", "read", {}), /undeclared ask/);
  done();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// The picture lives on the server, so the server is a small fake that keeps it and
// answers each read and write, as voice/server/router.py does.

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const SCHEMAS = {
  "voice.changed": schema("../events/voice.changed.json"),
  "step.recorded": schema("../events/step.recorded.json"),
  "step.settled": schema("../events/step.settled.json"),
};
const query = (name) => JSON.parse(readFileSync(new URL(`../queries/${name}.json`, import.meta.url)));
const readReply = new Validator(query("read").reply, "2020-12");
const speakReply = new Validator(query("speak").reply, "2020-12");

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

let n = 0;
const mint = () => "01K7APDT" + String((n += 1)).padStart(18, "0");

const SIZE = 353746785;
const MAC_VOICES = [{ id: "af_heart", label: "Heart" }, { id: "am_michael", label: "Michael" }, { id: "test", label: "Test voice" }];
const WEB_VOICES = [{ id: "Ashley", label: "Ashley" }, { id: "Dennis", label: "Dennis" }, { id: "test", label: "Test voice" }];

function server({ here = "mac" } = {}) {
  const state = { here, voice: here === "mac" ? "af_heart" : "Ashley", key: null, kept: {}, download: null, down: false, forgot: [], saves: [] };
  const picture = () =>
    here === "mac"
      ? {
          here,
          kokoro: state.download === null ? { state: "missing", done: 0, size: SIZE } : state.download >= SIZE ? { state: "ready", done: SIZE, size: SIZE } : { state: "downloading", done: state.download, size: SIZE },
          voice: state.voice,
          voices: MAC_VOICES,
        }
      : { here, inworld: { keySet: state.key !== null }, voice: state.voice, voices: WEB_VOICES };
  const up = () => (state.down ? Promise.reject(new Error("offline")) : Promise.resolve());
  return {
    state,
    load: () => up().then(picture),
    save: (patch) =>
      up().then(() => {
        state.saves.push(patch);
        if (patch.voice) state.voice = patch.voice;
        if (patch.download === "start") state.download = 0;
        if (patch.download === "cancel") state.download = null;
        if ("key" in patch) {
          if (patch.step) state.kept[patch.step] = { before: state.key, after: patch.key || null };
          state.key = patch.key || null;
        }
        return picture();
      }),
    moveKey: ({ step, restore, expect }) =>
      up().then(() => {
        const kept = state.kept[step];
        if (!kept || state.key !== kept[expect]) return { error: "changed" };
        state.key = kept[restore];
        return picture();
      }),
    forgetKey: async (step) => state.forgot.push(step),
    speak: (text) => up().then(() => (text === "fail" ? { error: "not-downloaded" } : { mime: "audio/wav", audio: "UklGRg==", words: [{ from: 0, to: text.length, start: 0, end: 0.5 }] })),
  };
}

function start(srv) {
  const timers = [];
  const actor = createActor(machine, {
    input: { ...srv, mint, later: (fn) => timers.push(fn) },
  });
  const seen = { "voice.changed": [], "step.recorded": [], "step.settled": [] };
  for (const name of Object.keys(seen))
    actor.on(name, ({ type: _, ...payload }) => {
      assert.ok(SCHEMAS[name].validate(payload).valid, `${name} ${JSON.stringify(payload)}`);
      seen[name].push(payload);
    });
  actor.start();
  const ask = async (type, payload, validator) => {
    let value;
    actor.send({ type, cid: "c", payload, reply: (v) => (value = v) });
    await flush();
    assert.ok(validator.validate(value).valid, JSON.stringify(value));
    return value;
  };
  const tick = async () => {
    const due = timers.splice(0);
    for (const fn of due) fn();
    await flush();
    return due.length;
  };
  return { actor, seen, timers, tick, read: () => ask("read?", {}, readReply), speak: (text) => ask("speak?", { text }, speakReply) };
}

test("a read is the starting picture and announces nothing; no server answers unavailable", async () => {
  const srv = server();
  const { read, seen } = start(srv);
  assert.deepEqual(await read(), { here: "mac", kokoro: { state: "missing", done: 0, size: SIZE }, voice: "af_heart", voices: MAC_VOICES });
  assert.deepEqual(seen["voice.changed"], []);
  srv.state.down = true;
  assert.deepEqual(await read(), { error: "unavailable" });
});

test("speak answers the server's audio and words, or its error", async () => {
  const srv = server();
  const { speak } = start(srv);
  assert.deepEqual(await speak("Begin."), { mime: "audio/wav", audio: "UklGRg==", words: [{ from: 0, to: 6, start: 0, end: 0.5 }] });
  assert.deepEqual(await speak("fail"), { error: "not-downloaded" });
  srv.state.down = true;
  assert.deepEqual(await speak("Begin."), { error: "unavailable" });
});

test("picking a voice is one step, and Undo then Redo bring it back exactly", async () => {
  const srv = server();
  const { actor, read, seen } = start(srv);
  await read();
  actor.send({ type: "voice.edited", voice: "am_michael" });
  await flush();
  assert.equal(srv.state.voice, "am_michael");
  assert.equal(seen["voice.changed"].at(-1).voice, "am_michael");
  const [step] = seen["step.recorded"];
  assert.equal(step.label, "choose the voice Michael");
  actor.send({ type: "step.undone", id: step.id, owner: "voice", payload: step.undo });
  await flush();
  assert.equal(srv.state.voice, "af_heart");
  actor.send({ type: "step.redone", id: step.id, owner: "voice", payload: step.redo });
  await flush();
  assert.equal(srv.state.voice, "am_michael");
  assert.deepEqual(seen["step.settled"].map((s) => s.outcome), ["applied", "applied"]);
  assert.equal(seen["step.recorded"].length, 1, "Undo and Redo record no new step");
});

test("an Undo of a voice is refused when the voice was changed since", async () => {
  const srv = server();
  const { actor, read, seen } = start(srv);
  await read();
  actor.send({ type: "voice.edited", voice: "am_michael" });
  await flush();
  const [step] = seen["step.recorded"];
  srv.state.voice = "test"; // another tab
  await read();
  actor.send({ type: "step.undone", id: step.id, owner: "voice", payload: step.undo });
  await flush();
  assert.equal(srv.state.voice, "test");
  assert.deepEqual(seen["step.settled"].at(-1), { id: step.id, owner: "voice", outcome: "refused", reason: "changed" });
});

test("a key added is a step with a notice that holds no key; Undo, Redo and a drop reach the server", async () => {
  const srv = server({ here: "web" });
  const { actor, read, seen } = start(srv);
  await read();
  actor.send({ type: "voice.edited", key: "sekrit" });
  await flush();
  assert.equal(srv.state.key, "sekrit");
  assert.deepEqual(seen["voice.changed"].at(-1).inworld, { keySet: true });
  const [step] = seen["step.recorded"];
  assert.equal(step.label, "add the Inworld key");
  assert.equal(step.notice, true);
  assert.ok(!JSON.stringify(step).includes("sekrit"), "no key in the step");
  assert.deepEqual(srv.state.saves.at(-1), { key: "sekrit", step: step.id }, "the server keeps the keys under the step's id");
  actor.send({ type: "step.undone", id: step.id, owner: "voice", payload: step.undo });
  await flush();
  assert.equal(srv.state.key, null);
  assert.deepEqual(seen["voice.changed"].at(-1).inworld, { keySet: false });
  actor.send({ type: "step.redone", id: step.id, owner: "voice", payload: step.redo });
  await flush();
  assert.equal(srv.state.key, "sekrit");
  srv.state.key = "other"; // replaced on another device
  actor.send({ type: "step.undone", id: step.id, owner: "voice", payload: step.undo });
  await flush();
  assert.deepEqual(seen["step.settled"].map((s) => s.outcome), ["applied", "applied", "refused"]);
  actor.send({ type: "step.dropped", id: step.id, owner: "voice", payload: step.redo });
  await flush();
  assert.deepEqual(srv.state.forgot, [step.id]);
});

test("removing a key that is not there sends nothing", async () => {
  const srv = server({ here: "web" });
  const { actor, read, seen } = start(srv);
  await read();
  actor.send({ type: "voice.edited", key: "" });
  await flush();
  assert.deepEqual(srv.state.saves, []);
  assert.deepEqual(seen["step.recorded"], []);
});

test("a download is no step, and its progress is read every second until it is ready", async () => {
  const srv = server();
  const { actor, read, seen, timers, tick } = start(srv);
  await read();
  actor.send({ type: "voice.edited", download: "start" });
  await flush();
  assert.equal(seen["voice.changed"].at(-1).kokoro.state, "downloading");
  assert.equal(timers.length, 1, "one poll waits");
  srv.state.download = 1000;
  await read(); // a read in between starts no second poll
  assert.equal(timers.length, 1);
  await tick();
  assert.deepEqual(seen["voice.changed"].at(-1).kokoro, { state: "downloading", done: 1000, size: SIZE });
  const count = seen["voice.changed"].length;
  await tick();
  assert.equal(seen["voice.changed"].length, count, "a poll that finds nothing new announces nothing");
  srv.state.down = true;
  await tick();
  assert.equal(timers.length, 1, "a poll that finds no server tries again");
  srv.state.down = false;
  srv.state.download = SIZE;
  await tick();
  assert.equal(seen["voice.changed"].at(-1).kokoro.state, "ready");
  assert.equal(timers.length, 0, "polling stops once the voice is ready");
  assert.deepEqual(seen["step.recorded"], []);
});

test("Cancel stops the download and the polling", async () => {
  const srv = server();
  const { actor, read, seen, timers, tick } = start(srv);
  await read();
  actor.send({ type: "voice.edited", download: "start" });
  await flush();
  actor.send({ type: "voice.edited", download: "cancel" });
  await flush();
  assert.equal(seen["voice.changed"].at(-1).kokoro.state, "missing");
  await tick();
  assert.equal(timers.length, 0);
});

test("a change of account reads the picture again and announces it", async () => {
  const srv = server({ here: "web" });
  const { actor, read, seen } = start(srv);
  await read();
  srv.state.voice = "Dennis";
  actor.send({ type: "session.changed", userId: "u2" });
  await flush();
  assert.equal(seen["voice.changed"].at(-1).voice, "Dennis");
});

test("a gesture that cannot be saved announces the saved picture again and records nothing", async () => {
  const srv = server();
  const { actor, read, seen } = start(srv);
  await read();
  srv.state.down = true;
  actor.send({ type: "voice.edited", voice: "am_michael" });
  await flush();
  assert.equal(seen["voice.changed"].at(-1).voice, "af_heart");
  assert.deepEqual(seen["step.recorded"], []);
});

test("steps of another owner are left alone", async () => {
  const srv = server();
  const { actor, read, seen } = start(srv);
  await read();
  actor.send({ type: "step.undone", id: mint(), owner: "llm", payload: { kind: "voice", voice: "test", expect: "af_heart" } });
  await flush();
  assert.equal(srv.state.voice, "af_heart");
  assert.deepEqual(seen["step.settled"], []);
});

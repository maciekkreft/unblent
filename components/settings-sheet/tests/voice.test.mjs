import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, voiceView, SAMPLE } from "../machine.js";

// The Reading aloud rows' decisions: what the rows show, and what each gesture emits.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(resolve(HERE, "..", "events", "voice.edited.json"), "utf8"));
const valid = (e) => {
  const { type, ...rest } = e;
  return new Validator(SCHEMA, "2020-12").validate(rest).valid;
};

const VOICES = [
  { id: "af_heart", label: "Heart" },
  { id: "am_michael", label: "Michael" },
  { id: "test", label: "Test voice" },
];
const MAC = (state, done = 0) => ({ here: "mac", kokoro: { state, done, size: 353746785 }, voice: "af_heart", voices: VOICES });
const WEB = (keySet) => ({ here: "web", inworld: { keySet }, voice: "Ashley", voices: [{ id: "Ashley", label: "Ashley" }, { id: "test", label: "Test voice" }] });

const run = async (voice, { speak = { mime: "audio/wav", audio: "UklGRg==", words: [] } } = {}) => {
  const asked = [];
  const ask = (target, name, payload) => {
    asked.push(`${target}: ${name}`);
    if (target === "voice") return Promise.resolve(name === "read" ? voice : speak);
    if (target === "pages") return Promise.resolve({ pages: [] });
    if (target === "settings") return Promise.resolve({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, editors: {} });
    if (target === "flags") return Promise.resolve({ hidden: [] });
    return Promise.resolve({ error: "no-answerer" });
  };
  const actor = createActor(machine, { input: { ask, current: "/a" } });
  const edited = [];
  actor.on("voice.edited", (e) => edited.push(e));
  actor.start();
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  return { actor, edited, asked, ctx: () => actor.getSnapshot().context };
};

test("the rows show only while Reading aloud is shown and voice gives a picture", () => {
  const voice = MAC("missing");
  assert.equal(voiceView({ voice, hidden: [], profile: "product" }).here, "mac");
  assert.equal(voiceView({ voice, hidden: null, profile: "product" }), null, "flags has not answered");
  assert.equal(voiceView({ voice, hidden: ["reading-aloud"], profile: "product" }), null, "the feature is hidden");
  assert.equal(voiceView({ voice: null, hidden: [], profile: "product" }), null, "voice does not answer");
});

test("the test voice is listed only in the workshop profile, or while it is the one picked", () => {
  const ids = (voice, profile) => voiceView({ voice, hidden: [], profile }).voices.map((v) => v.id);
  assert.deepEqual(ids(MAC("ready"), "product"), ["af_heart", "am_michael"]);
  assert.deepEqual(ids(MAC("ready"), "workshop"), ["af_heart", "am_michael", "test"]);
  assert.deepEqual(ids({ ...MAC("ready"), voice: "test" }, "product"), ["af_heart", "am_michael", "test"]);
});

test("a read that gives an error leaves no picture; voice.changed brings one", async () => {
  const { actor, ctx } = await run({ error: "signed-out" });
  assert.equal(ctx().voice, null);
  actor.send({ type: "voice.changed", ...WEB(false) });
  assert.deepEqual(ctx().voice, WEB(false), "the event's type is not kept");
});

test("the download starts only while missing and is cancelled only while it runs", async () => {
  const { actor, edited } = await run(MAC("missing"));
  actor.send({ type: "_cancelDownload" });
  actor.send({ type: "_download" });
  actor.send({ type: "voice.changed", ...MAC("downloading", 1000) });
  actor.send({ type: "_download" });
  actor.send({ type: "_cancelDownload" });
  assert.deepEqual(edited, [
    { type: "voice.edited", download: "start" },
    { type: "voice.edited", download: "cancel" },
  ]);
  assert.ok(edited.every(valid));
});

test("a voice is emitted only when it is offered and not the one picked", async () => {
  const { actor, edited } = await run(MAC("ready"));
  actor.send({ type: "_setVoice", voice: "af_heart" });
  actor.send({ type: "_setVoice", voice: "nobody" });
  actor.send({ type: "_setVoice", voice: "am_michael" });
  assert.deepEqual(edited, [{ type: "voice.edited", voice: "am_michael" }]);
  assert.ok(edited.every(valid));
});

test("the Inworld key is saved and removed like the other keys, and reads gone until the new picture", async () => {
  const { actor, edited, ctx } = await run(WEB(true));
  actor.send({ type: "_saveInworldKey", key: "iw-not-a-real-key" });
  actor.send({ type: "_removeInworldKey" });
  assert.deepEqual(edited, [
    { type: "voice.edited", key: "iw-not-a-real-key" },
    { type: "voice.edited", key: "" },
  ]);
  assert.ok(edited.every(valid));
  assert.deepEqual(ctx().removed, ["inworldKey"]);
  actor.send({ type: "llm.changed", signedIn: true });
  assert.deepEqual(ctx().removed, ["inworldKey"], "the chat's picture says nothing of the Inworld key");
  actor.send({ type: "voice.changed", ...WEB(false) });
  assert.deepEqual(ctx().removed, []);
});

test("Play a sample asks voice to speak the sample sentence, and each answer is numbered", async () => {
  const { actor, asked, ctx } = await run(MAC("ready"));
  actor.send({ type: "_sample" });
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  assert.ok(asked.includes("voice: speak"));
  assert.ok(SAMPLE.length > 0);
  assert.deepEqual(ctx().sample, { n: 1, mime: "audio/wav", audio: "UklGRg==" });

  const failing = await run(MAC("ready"), { speak: { error: "not-downloaded" } });
  failing.actor.send({ type: "_sample" });
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(failing.ctx().sample, { n: 1, error: "not-downloaded" });
});

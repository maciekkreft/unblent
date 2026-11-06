import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, readingShown, canRead, speakMessage, wordAt } from "../machine.js";

// Reading aloud is decided in the actor (3.2): what is read, in which order, when the next
// block's audio is asked for, and what stops it. The view only plays the clip it is
// handed and says when it ended (_spoken). `voice: speak` is faked here, answering each
// text with a clip that names it, or with an error.

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PICTURE = { here: "web", inworld: { keySet: true }, voice: "test", voices: [{ id: "test", label: "Test voice" }] };

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await tick();
};

const bookReply = () => ({
  book: {
    id: ID,
    title: "T",
    author: "A",
    cover: null,
    chapters: [{ title: "One" }, { title: "Two" }],
    toc: [],
    position: { chapter: 0, block: 0 },
    version: 1,
    contentVersion: 1,
    pending: false,
    addedAt: 10,
    updatedAt: 10,
  },
});

const clip = (text) => ({ mime: "audio/wav", audio: btoa(text), words: [{ from: 0, to: text.length, start: 0, end: 0.2 }] });

// A reader with a book open and its page shown. `speak` answers each text; it may return
// a promise the test resolves itself, to hold a clip back.
async function reader({ hidden = [], voice = PICTURE, speak = (text) => clip(text) } = {}) {
  const spoken = [];
  const ask = (target, name, payload) => {
    if (target === "flags") return Promise.resolve({ hidden, off: [], released: [], shown: [] });
    if (target === "voice" && name === "read") return Promise.resolve(voice ?? { error: "no-answerer" });
    if (target === "voice" && name === "speak") {
      spoken.push(payload.text);
      return Promise.resolve(speak(payload.text));
    }
    if (name === "open") return Promise.resolve({ id: null });
    if (name === "read") return Promise.resolve(bookReply());
    if (name === "chapter") return Promise.resolve({ title: "t", html: "<p>x</p>" });
    return Promise.resolve({});
  };
  const actor = createActor(machine, { input: { ask } });
  actor.start();
  await flush();
  actor.send({ type: "book.opened", id: ID });
  await flush();
  return { actor, spoken };
}

// Where reading aloud stands: idle, loading, speaking.playing or speaking.paused, or gone
// while no page shows.
const speech = (actor) => {
  const s = actor.getSnapshot();
  if (!s.matches({ reading: "ready" })) return "gone";
  const v = s.value.reading.ready.speech;
  return typeof v === "string" ? v : `speaking.${v.speaking}`;
};
const ctx = (actor) => actor.getSnapshot().context;
const blocks = (...texts) => texts.map((text, block) => ({ block, text }));

test("reading aloud shows only while the feature is shown and voice is on the page", async () => {
  assert.equal(readingShown(null), false, "not before flags answers");
  assert.equal(readingShown(["reading-aloud"]), false);
  assert.equal(readingShown([]), true);
  assert.equal(canRead({ hidden: [], voice: null }), false, "not without voice");
  assert.equal(canRead({ hidden: [], voice: PICTURE }), true);

  const hiddenFeature = await reader({ hidden: ["reading-aloud"] });
  hiddenFeature.actor.send({ type: "_say", blocks: blocks("One.") });
  await flush();
  assert.equal(speech(hiddenFeature.actor), "idle", "a hidden feature reads nothing");
  assert.deepEqual(hiddenFeature.spoken, []);

  const noVoice = await reader({ voice: null });
  assert.equal(ctx(noVoice.actor).voice, null);
  noVoice.actor.send({ type: "_say", blocks: blocks("One.") });
  await flush();
  assert.equal(speech(noVoice.actor), "idle", "a page without voice reads nothing");
});

test("a paragraph is asked for, played, and over when its clip ends", async () => {
  const { actor, spoken } = await reader();
  actor.send({ type: "_say", blocks: [{ block: 3, text: "Begin the morning." }] });
  await flush();
  assert.deepEqual(spoken, ["Begin the morning."], "the block's text exactly as the view gave it");
  assert.equal(speech(actor), "speaking.playing");
  const { clip: c, at, queue } = ctx(actor).speech;
  assert.equal(at, 0);
  assert.equal(queue[0].block, 3);
  assert.equal(c.mime, "audio/wav");
  actor.send({ type: "_spoken", n: c.n });
  await flush();
  assert.equal(speech(actor), "idle", "one paragraph stops at its end");
  assert.equal(ctx(actor).speech, null);
});

test("a page is read block by block, the next one fetched ahead while one plays", async () => {
  const { actor, spoken } = await reader();
  actor.send({ type: "_say", blocks: blocks("One.", "  ", "Two.", "Three.") });
  await flush();
  assert.deepEqual(spoken, ["One.", "Two."], "the first is asked, and the next ahead; a blank block is skipped");
  assert.equal(ctx(actor).speech.queue.length, 3);
  assert.equal(ctx(actor).speech.ahead?.at, 1, "the next clip is held ready");
  actor.send({ type: "_spoken", n: ctx(actor).speech.clip.n });
  await flush();
  assert.equal(speech(actor), "speaking.playing", "the next starts from the clip fetched ahead");
  assert.equal(ctx(actor).speech.at, 1);
  assert.equal(atob(ctx(actor).speech.clip.audio), "Two.");
  assert.deepEqual(spoken, ["One.", "Two.", "Three."], "and the one after is fetched ahead");
  actor.send({ type: "_spoken", n: ctx(actor).speech.clip.n });
  await flush();
  assert.equal(atob(ctx(actor).speech.clip.audio), "Three.");
  actor.send({ type: "_spoken", n: ctx(actor).speech.clip.n });
  await flush();
  assert.equal(speech(actor), "idle", "the page stops at its end");
});

test("a clip not fetched ahead yet is asked for when the one before ends", async () => {
  let release;
  const { actor, spoken } = await reader({
    speak: (text) => (text === "Two." ? new Promise((r) => (release = () => r(clip(text)))) : clip(text)),
  });
  actor.send({ type: "_say", blocks: blocks("One.", "Two.") });
  await flush();
  actor.send({ type: "_spoken", n: ctx(actor).speech.clip.n });
  await flush();
  assert.equal(speech(actor), "loading", "waits for the next clip");
  assert.equal(ctx(actor).speech.at, 1);
  assert.equal(spoken.filter((t) => t === "Two.").length, 2, "asked again, since the clip fetched ahead never came");
  release();
  await flush();
});

test("an ended clip that is not the one playing changes nothing", async () => {
  const { actor } = await reader();
  actor.send({ type: "_say", blocks: blocks("One.", "Two.") });
  await flush();
  actor.send({ type: "_spoken", n: ctx(actor).speech.clip.n + 7 });
  await flush();
  assert.equal(ctx(actor).speech.at, 0);
  assert.equal(speech(actor), "speaking.playing");
});

test("Pause holds the place and Resume goes on, also when pressed before the audio came", async () => {
  const { actor } = await reader();
  actor.send({ type: "_say", blocks: blocks("One.", "Two.") });
  await flush();
  actor.send({ type: "_pause" });
  assert.equal(speech(actor), "speaking.paused");
  actor.send({ type: "_spoken", n: ctx(actor).speech.clip.n + 1 });
  assert.equal(speech(actor), "speaking.paused");
  actor.send({ type: "_resume" });
  assert.equal(speech(actor), "speaking.playing");
  assert.equal(ctx(actor).speech.at, 0, "the same block goes on");

  let release;
  const slow = await reader({ speak: (text) => new Promise((r) => (release = () => r(clip(text)))) });
  slow.actor.send({ type: "_say", blocks: blocks("One.") });
  await flush();
  assert.equal(speech(slow.actor), "loading");
  slow.actor.send({ type: "_pause" });
  assert.equal(ctx(slow.actor).speech.held, true, "the footer reads Resume while it waits");
  release();
  await flush();
  assert.equal(speech(slow.actor), "speaking.paused", "the audio arrives paused");
  slow.actor.send({ type: "_resume" });
  assert.equal(speech(slow.actor), "speaking.playing");
});

test("Stop, a page turn, another chapter and another book each end the reading", async () => {
  const { actor } = await reader();
  actor.send({ type: "_say", blocks: blocks("One.") });
  await flush();
  actor.send({ type: "_hush" });
  assert.equal(speech(actor), "idle", "Stop, and a page turn or a new fragment in the view, send _hush");
  assert.equal(ctx(actor).speech, null);

  actor.send({ type: "_say", blocks: blocks("One.") });
  await flush();
  actor.send({ type: "_next" });
  assert.equal(speech(actor), "gone", "a turn past the chapter leaves the page");
  await flush();
  assert.equal(speech(actor), "idle", "and the new chapter starts silent");

  actor.send({ type: "_say", blocks: blocks("One.") });
  await flush();
  actor.send({ type: "book.opened", id: ID });
  await flush();
  assert.equal(speech(actor), "idle", "another book opened starts silent");
});

test("a new _say starts afresh from where it is", async () => {
  const { actor } = await reader();
  actor.send({ type: "_say", blocks: blocks("One.", "Two.") });
  await flush();
  actor.send({ type: "_pause" });
  actor.send({ type: "_say", blocks: [{ block: 5, text: "Five." }] });
  await flush();
  assert.equal(speech(actor), "speaking.playing");
  assert.equal(ctx(actor).speech.queue.length, 1);
  assert.equal(atob(ctx(actor).speech.clip.audio), "Five.");
});

test("a voice that cannot read says why, once, and stops; what tells the user what to do stays about 6 seconds", async () => {
  for (const [error, text, ms] of [
    ["not-downloaded", "Download the voice in Settings", 6000],
    ["no-key", "Add your Inworld key in Settings", 6000],
    ["unavailable", "The voice is not available now", null],
  ]) {
    assert.equal(speakMessage(error), text);
    const { actor } = await reader({ speak: () => ({ error }) });
    actor.send({ type: "_say", blocks: blocks("One.") });
    await flush();
    assert.equal(speech(actor), "idle");
    assert.equal(ctx(actor).notice.text, text);
    assert.equal(ctx(actor).notice.ms, ms);
    const n = ctx(actor).notice.n;
    actor.send({ type: "_say", blocks: blocks("One.") });
    await flush();
    assert.equal(ctx(actor).notice.n, n + 1, "each refusal is said again");
  }
});

test("voice.changed brings reading aloud to a reader that had no voice", async () => {
  const { actor } = await reader({ voice: null });
  actor.send({ type: "voice.changed", ...PICTURE });
  assert.deepEqual(ctx(actor).voice, PICTURE);
  assert.equal(canRead(ctx(actor)), true);
});

test("the word lit is the last one started", () => {
  const words = [
    { from: 0, to: 3, start: 0, end: 0.1 },
    { from: 4, to: 9, start: 0.12, end: 0.3 },
    { from: 10, to: 12, start: 0.3, end: 0.4 },
  ];
  assert.equal(wordAt(words, -1), -1);
  assert.equal(wordAt(words, 0), 0);
  assert.equal(wordAt(words, 0.11), 0, "a gap keeps the word before");
  assert.equal(wordAt(words, 0.2), 1);
  assert.equal(wordAt(words, 9), 2);
  assert.equal(wordAt([], 1), -1);
});

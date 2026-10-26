import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, firstRound, daySource, chatTitle, journalSummary, valueSuggestion, canonical } from "../machine.js";

// The engine's decisions (3.2): which item is asked for next, one at a time, what stops
// and resumes it, Run, and the bytes a source is made from. Driven with a fake store and
// a fake ask (session, journal, choice points and llm: generate answered here) and a
// simulated clock; every generate payload is checked against llm's own schema.

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const generatePayload = new Validator(schema("../../llm/queries/generate.json").payload, "2020-12");
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
// The device's local date: Could be suggests for today's values only.
const pad = (n) => String(n).padStart(2, "0");
const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

// --- The source, byte for byte the backfill script's ----------------------------------

// The same fixture was written to SQLite and read by the backfill script
// (scratchpad backfill/build_inputs.py, Python's json.dumps(obj, separators=(",", ":"),
// ensure_ascii=False)); these are the hashes it printed for the source and for the
// model input; the chat's by a Python copy of the chat-title rule (scratchpad
// chat_title_hash.py, the same json.dumps and SHA-256 hex of the UTF-8). The fixture covers non-ASCII, quotes, a backslash, a control character,
// U+2028, an emoji at the cut, a question of only Python whitespace, a result stored
// after the answer, an error result, a listing without a name, a lookup with a name
// and no excerpt and one with both, and a second question.
const CHAT = "01HQ8ZK7M4N5P6Q7R8S9T0V1W4";
const T = (n) => `01HQ8ZK7M4N5P6Q7R8S9T0V1A${n}`;
const TURNS = [
  { id: T(0), role: "user", text: " 　\x1f" },
  { id: T(1), role: "user", text: 'Café — “what\'s this?” "x"\\ /  line 😀\x01\tend' },
  {
    id: T(2),
    role: "assistant",
    text: "Let me look.",
    status: "done",
    calls: [
      { id: "c1", target: "books", name: "chapter", payload: {}, label: "Reading a chapter" },
      { id: "c2", target: "notes", name: "read", payload: {}, label: "Reading a note" },
      { id: "c3", target: "notes", name: "list", payload: {}, label: "Listing notes" },
      { id: "c4", target: "notes", name: "read", payload: {}, label: "Reading a note" },
    ],
  },
  { id: T(3), role: "assistant", text: "Ä".repeat(8005) + "😀".repeat(3), status: "done" },
  {
    id: T(4),
    role: "user",
    text: "",
    results: [
      { callId: "c1", size: 2111, name: "Kapitel 😀 “eins”" },
      { callId: "c2", size: 4, isError: true, name: "gone" },
      { callId: "c3", size: 2 },
      { callId: "c4", size: 40, name: 'Cats\\ "x"', excerpt: "They purr\u2028 softly — Ü" },
    ],
  },
  { id: T(5), role: "user", text: "Second question" },
  { id: T(6), role: "assistant", text: "Later", status: "done" },
];
const CHAT_SOURCE = "6277359530cad2c0d72d7243b8b7909a4ec4fab8fe9b5a83de3381029021ebbc";
const CHAT_INPUT = "5c9babf5227c28cb20792ea21f566f1d01723b88159ea379e1e1eae22d9955c6";

const DAY = { id: "01K7TEST00000000000000DA01", day: "2026-10-20", text: "Tag “eins”\n\tzwei — Ü" };
const POINTS = [
  { id: "01K7TEST00000000000000CP02", day: "2026-10-20", situation: "Meeting ran late", thoughts: "Tense “again”", away: "Snapped", towards: "Paused" },
  { id: "01K7TEST00000000000000CP01", day: "2026-10-20", situation: "Morning", thoughts: "", away: "", towards: "Walked" },
];
const DAY_SOURCE = "a6a1eab8bdf5e636f0ee4a4cd20e2b0b0ca65c0a89e51f85e74ba67c7363d0d1";
const DAY_INPUT = "69dc3cdc57d38d1f69f7aba029dd940a686f527a2dc2de4e8bdcfdf7e877cd72";

test("a chat's and a day's source and model input are the backfill script's, byte for byte", () => {
  const chat = firstRound(TURNS);
  assert.deepEqual(Object.keys(chat), ["question", "lookups", "answer"]);
  assert.deepEqual(chat.lookups, [
    { label: "Reading a chapter", name: "Kapitel 😀 “eins”", excerpt: "" },
    { label: "Reading a note", name: 'Cats\\ "x"', excerpt: "They purr\u2028 softly — Ü" },
  ], "in call order, the error and the listing left out");
  assert.equal(sha(canonical(chat)), CHAT_SOURCE);
  assert.equal(sha(chatTitle.input(chat)), CHAT_INPUT);

  const day = daySource(DAY, POINTS);
  assert.deepEqual(day.choicePoints.map((c) => c.situation), ["Morning", "Meeting ran late"], "in the order they were made");
  assert.equal(sha(canonical(day)), DAY_SOURCE);
  assert.equal(sha(journalSummary.input(day)), DAY_INPUT);
});

test("the default hash, Web Crypto, gives the same hex as Python's hashlib", async () => {
  const hashes = [];
  const { actor } = start({ sha256: null });
  await settle();
  hashes.push(await actor.getSnapshot().context.sha256(canonical(daySource(DAY, POINTS))));
  assert.deepEqual(hashes, [DAY_SOURCE]);
  actor.stop();
});

test("a chat whose lookups name nothing is named from its question and answer alone", () => {
  const unnamed = TURNS.map((t) => (t.results ? { ...t, results: t.results.map(({ callId, size, isError }) => ({ callId, size, ...(isError ? { isError } : {}) })) } : t));
  assert.deepEqual(firstRound(unnamed).lookups, []);
  assert.ok(!chatTitle.input(firstRound(unnamed)).includes("Looked up:"));
  assert.equal(firstRound(TURNS.slice(0, 2)), null, "no answer yet");
});

// --- The engine -------------------------------------------------------------------------

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await tick();
};

function fakeStore(initial = []) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  return {
    rows,
    all: () => Promise.resolve([...rows.values()]),
    put: (r) => (rows.set(r.id, r), Promise.resolve()),
    outboxAll: () => Promise.resolve([]),
    outboxPut: () => Promise.resolve(),
    outboxDelete: () => Promise.resolve(),
    metaGet: () => Promise.resolve(undefined),
    metaPut: () => Promise.resolve(),
    empty: () => Promise.resolve(),
  };
}

const ID = (n) => `01K7TEST00000000000000DA${String(n).padStart(2, "0")}`;
const day = (n, text, over = {}) => ({ id: ID(n), day: `2026-10-${String(n).padStart(2, "0")}`, text, editedAt: n * 1000, version: 1, waiting: [], unanswered: [], ...over });
const journal = (days, open = null) => ({ days, projects: [], detectors: [], answers: [], open, reason: null });

// Every generate is held until the test answers it, so "one at a time" can be seen.
function fakeAsk({ userId = "u1", guest = false, days = [], open = null, points = [], values = [], checks = [] } = {}) {
  const asked = [];
  const ask = (target, name, payload) => {
    if (target === "session") return Promise.resolve({ userId, registrationOpen: false, guest });
    if (target === "values") return Promise.resolve({ day: TODAY, values, changedSince: false });
    if (target === "value-checks") {
      assert.deepEqual(payload, { day: TODAY }, "today's checks");
      return Promise.resolve({ keySet: true, settings: { values: null, examples: null }, values: checks });
    }
    if (target === "journal") return Promise.resolve(journal(days, open));
    if (target === "choice-points") return Promise.resolve({ choicePoints: points });
    assert.equal(`${target}: ${name}`, "llm: generate");
    assert.ok(generatePayload.validate(payload).valid, JSON.stringify(payload));
    return new Promise((answer) => asked.push({ payload, answer }));
  };
  return { ask, asked };
}

function start({ store = fakeStore(), ask, tryPage, sha256 = async (text) => sha(text) } = {}) {
  const actor = createActor(machine, { input: { store, ask, tryPage, sha256 }, clock: new SimulatedClock() });
  const results = [];
  actor.on("generation.changed", (e) => results.push(e.result));
  actor.start();
  return { actor, results, store };
}

const dayOf = (payload) => /Journal entry for (\S+):/.exec(payload.text)?.[1];

test("days that can no longer be written are summarised one at a time, newest first, and kept", async () => {
  const f = fakeAsk({ days: [day(10, "Ten"), day(12, "Twelve"), day(11, ""), day(13, "Today")], open: ID(13) });
  const s = start({ ask: f.ask });
  await settle();
  assert.equal(f.asked.length, 1, "one request at a time");
  assert.equal(dayOf(f.asked[0].payload), "2026-10-12", "newest first; the open day and an empty one are not items");
  assert.equal(f.asked[0].payload.model, "claude-haiku-5-5");
  f.asked[0].answer({ text: "  Twelve.\n" });
  await settle();
  assert.equal(s.results.at(-1).text, "Twelve.");
  assert.equal(s.results.at(-1).source, sha(canonical({ day: "2026-10-12", text: "Twelve", choicePoints: [] })));
  assert.equal(f.asked.length, 2);
  assert.equal(dayOf(f.asked[1].payload), "2026-10-10");
  f.asked[1].answer({ text: "Ten." });
  await settle();
  assert.equal(f.asked.length, 2, "nothing left");
  s.actor.stop();

  // Loaded again with those results: nothing is asked.
  const again = fakeAsk({ days: [day(10, "Ten"), day(12, "Twelve")] });
  const t = start({ ask: again.ask, store: s.store });
  await settle();
  assert.equal(again.asked.length, 0);
  t.actor.stop();
});

test("a generator that is off is skipped until it is turned on", async () => {
  const f = fakeAsk({ days: [day(10, "Ten")] });
  const store = fakeStore([{ id: "journal-summary", name: "Journal summary", on: false, model: "claude-haiku-5-5", prompt: "Sum", version: 1 }]);
  const s = start({ ask: f.ask, store });
  await settle();
  assert.equal(f.asked.length, 0);
  s.actor.send({ type: "generator.edited", id: "journal-summary", on: true });
  await settle();
  assert.equal(f.asked.length, 1);
  assert.equal(f.asked[0].payload.prompt, "Sum");
  s.actor.stop();
});

test("an error stops the engine; a day closing, or a generator changing, resumes it", async () => {
  const f = fakeAsk({ days: [day(10, "Ten"), day(11, "Eleven")] });
  const s = start({ ask: f.ask });
  await settle();
  f.asked[0].answer({ error: "no-key" });
  await settle();
  assert.equal(f.asked.length, 1, "stopped after the error");

  // The open day 12 closes: a new ready item resumes, newest first.
  s.actor.send({ type: "journal.changed", ...journal([day(10, "Ten"), day(11, "Eleven"), day(12, "Twelve")], ID(12)) });
  await settle();
  assert.equal(f.asked.length, 1, "a change to the open day is not a new item");
  s.actor.send({ type: "journal.changed", ...journal([day(10, "Ten"), day(11, "Eleven"), day(12, "Twelve")], null) });
  await settle();
  assert.equal(f.asked.length, 2);
  assert.equal(dayOf(f.asked[1].payload), "2026-10-12");
  f.asked[1].answer({ error: "unavailable" });
  await settle();
  assert.equal(f.asked.length, 2);

  s.actor.send({ type: "generator.edited", id: "journal-summary", prompt: "Shorter" });
  await settle();
  assert.equal(f.asked.length, 3);
  assert.equal(f.asked[2].payload.prompt, "Shorter");
  s.actor.stop();
});

test("Run makes the shown day's text again first, even when one from the same content exists", async () => {
  const f = fakeAsk({ days: [day(10, "Ten"), day(11, "Eleven")] });
  const s = start({ ask: f.ask });
  await settle();
  f.asked[0].answer({ text: "Eleven." });
  await settle();
  f.asked[1].answer({ text: "Ten." });
  await settle();
  assert.equal(f.asked.length, 2);

  s.actor.send({ type: "day.shown", day: "2026-10-10", writable: false });
  s.actor.send({ type: "generation.requested", generator: "journal-summary" });
  await settle();
  assert.equal(f.asked.length, 3);
  assert.equal(dayOf(f.asked[2].payload), "2026-10-10");
  f.asked[2].answer({ text: "Ten, again." });
  await settle();
  assert.equal(s.results.at(-1).text, "Ten, again.");
  assert.equal(f.asked.length, 3, "Run does one");
  s.actor.stop();
});

const conversation = (turns, over = {}) => ({ type: "conversation.changed", id: CHAT, title: "t", about: [], start: "", turns, pending: false, updatedAt: 99000, ...over });
const Q = { id: T(1), role: "user", text: "Where do herons nest?" };
const A = { id: T(2), role: "assistant", text: "In colonies.", status: "done" };

test("a chat is named once, when its first answer finishes, before older days; Run names the open chat again", async () => {
  const f = fakeAsk({ days: [day(10, "Ten")] });
  const s = start({ ask: f.ask });
  await settle();
  assert.equal(f.asked.length, 1);
  s.actor.send(conversation([Q, { ...A, status: "pending" }]));
  s.actor.send(conversation([Q, A]));
  await settle();
  f.asked[0].answer({ text: "Ten." });
  await settle();
  assert.equal(f.asked.length, 2);
  assert.equal(f.asked[1].payload.text, "First message:\nWhere do herons nest?\n\nFirst answer:\nIn colonies.");
  f.asked[1].answer({ text: "Heron nests" });
  await settle();
  assert.deepEqual([s.results.at(-1).id, s.results.at(-1).text], [`chat-title:${CHAT}`, "Heron nests"]);

  s.actor.send(conversation([Q, A], { updatedAt: 100000 }));
  await settle();
  assert.equal(f.asked.length, 2, "named once");

  s.actor.send({ type: "conversation.opened", id: CHAT });
  s.actor.send({ type: "generation.requested", generator: "chat-title" });
  await settle();
  assert.equal(f.asked.length, 3);
  s.actor.stop();
});

test("a title the user types while the model names the chat is kept; only Run replaces it", async () => {
  const f = fakeAsk();
  const s = start({ ask: f.ask });
  await settle();
  s.actor.send(conversation([Q, A]));
  await settle();
  assert.equal(f.asked.length, 1);
  s.actor.send({ type: "conversation.renamed", id: CHAT, title: "My herons" });
  f.asked[0].answer({ text: "Heron nests" });
  await settle();
  assert.equal(s.results.at(-1).text, "My herons");
  assert.equal(f.asked.length, 1, "a typed title counts as named");
  s.actor.send({ type: "conversation.opened", id: CHAT });
  s.actor.send({ type: "generation.requested", generator: "chat-title" });
  await settle();
  f.asked[1].answer({ text: "Heron nests" });
  await settle();
  assert.equal(s.results.at(-1).text, "Heron nests");
  s.actor.stop();
});

test("nothing runs signed out, for a guest, or on a try page", async () => {
  for (const [over, tryPage] of [[{ userId: null }], [{ guest: true }], [{}, true]]) {
    const f = fakeAsk({ days: [day(10, "Ten")], ...over });
    const s = start({ ask: f.ask, tryPage });
    await settle();
    s.actor.send({ type: "day.shown", day: "2026-10-10" });
    s.actor.send({ type: "generation.requested", generator: "journal-summary" });
    await settle();
    assert.equal(f.asked.length, 0, JSON.stringify({ over, tryPage }));
    s.actor.stop();
  }
});

// --- Could be (value-suggestion) ---------------------------------------------------------

const V = (n) => `01K7TEST00000000000000VA0${n}`;
const value = (n, name, meaning = "") => ({ id: V(n), name, meaning });
const line = (text, unexpected, over = {}) => ({ line: "value", text, status: "done", answers: [], unexpected, ...over });
const VALUES = [value(1, "Being loved", "Calling my sister on Sundays"), value(2, "Being kind", "Holding the door"), value(3, "Success", "")];
const CHECKS = [
  { id: V(1), lines: [line("Being loved", ["A feeling", "Something others give"]), { ...line("Calling my sister on Sundays", ["No"]), line: "example" }] },
  { id: V(2), lines: [line("Being kind", [])] },
  { id: V(3), lines: [line("Success", ["A goal"], { status: "pending" })] },
];

test("Could be: only today's value lines answered with a red mark are items, with the source in a fixed key order", () => {
  const seen = valueSuggestion.start();
  valueSuggestion.loaded(seen, { day: TODAY, checks: { values: CHECKS }, values: { values: VALUES } });
  const items = valueSuggestion.items(seen);
  assert.deepEqual(items.map((i) => i.item), [V(1)], "a green line, and one Jev is still checking, are not items; a red example alone is not");
  assert.deepEqual(Object.keys(items[0].source), ["value", "example", "reads"]);
  assert.equal(canonical(items[0].source), '{"value":"Being loved","example":"Calling my sister on Sundays","reads":"A feeling, Something others give"}');
  assert.equal(valueSuggestion.input(items[0].source), "Value: Being loved\nExample: Calling my sister on Sundays\nReads as: A feeling, Something others give");
  assert.deepEqual(valueSuggestion.target(seen), items[0], "Run takes the first red value");

  // The value line edited since it was checked makes no item: its old result stays unshown.
  valueSuggestion.follow(seen, { type: "values.changed", day: TODAY, values: [value(1, "Being loving", "Calling my sister on Sundays"), ...VALUES.slice(1)] });
  assert.deepEqual(valueSuggestion.items(seen), []);
  assert.equal(valueSuggestion.target(seen), null);

  // Checks of another day are not today's.
  valueSuggestion.follow(seen, { type: "values.checked", day: "2020-01-01", values: [{ id: V(1), lines: [line("Being loving", ["A feeling"])] }] });
  assert.deepEqual(valueSuggestion.items(seen), []);
  valueSuggestion.follow(seen, { type: "values.checked", day: TODAY, values: [{ id: V(1), lines: [line("Being loving", ["A feeling"])] }] });
  assert.deepEqual(valueSuggestion.items(seen).map((i) => i.source.reads), ["A feeling"]);
});

test("Could be: what the events said while the starting reads were open is kept", () => {
  const seen = valueSuggestion.start();
  valueSuggestion.follow(seen, { type: "values.checked", day: TODAY, values: [] });
  valueSuggestion.loaded(seen, { day: TODAY, checks: { values: CHECKS }, values: { values: VALUES } });
  assert.deepEqual(valueSuggestion.items(seen), [], "the newer announcement wins over the read");
});

test("Could be: a red value line is suggested for once per content, and kept with its hash", async () => {
  const f = fakeAsk({ values: VALUES, checks: CHECKS });
  const s = start({ ask: f.ask });
  await settle();
  assert.equal(f.asked.length, 1);
  assert.equal(f.asked[0].payload.text, "Value: Being loved\nExample: Calling my sister on Sundays\nReads as: A feeling, Something others give");
  assert.ok(f.asked[0].payload.prompt.startsWith("This is one of a person's values"));
  f.asked[0].answer({ text: " Being loving. " });
  await settle();
  const r = s.results.at(-1);
  assert.deepEqual([r.id, r.text], [`value-suggestion:${V(1)}`, "Being loving."]);
  assert.equal(r.source, sha('{"value":"Being loved","example":"Calling my sister on Sundays","reads":"A feeling, Something others give"}'));
  assert.ok(valueSuggestion.done(r, r.source));

  // The same content announced again asks nothing; a new example asks again.
  s.actor.send({ type: "values.checked", day: TODAY, values: CHECKS });
  await settle();
  assert.equal(f.asked.length, 1);
  s.actor.send({ type: "values.changed", day: TODAY, values: [value(1, "Being loved", "Visiting my sister"), ...VALUES.slice(1)] });
  await settle();
  assert.equal(f.asked.length, 2);
  assert.match(f.asked[1].payload.text, /Example: Visiting my sister/);
  s.actor.stop();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, shown, apart, signedIn } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (p) => JSON.parse(readFileSync(resolve(HERE, "..", p), "utf8"));

// The schemas the view's traffic must match (shape test, Testing). The events it emits are
// its own; the query payloads it asks belong to conversations and subject, read from their
// directories, not imported (a component may not import another's files, 11.2).
const EVENTS = {
  "conversation.selected": load("events/conversation.selected.json"),
  "conversation.discarded": load("events/conversation.discarded.json"),
};
const other = (component, name) =>
  JSON.parse(readFileSync(resolve(HERE, "..", "..", component, "queries", `${name}.json`), "utf8"));
const CONV_LIST = other("conversations", "list");
const CONV_OPEN = other("conversations", "open");
const SUBJECT_READ = other("subject", "read");
const SESSION_READ = other("session", "read");

// The undo window, driven by a SimulatedClock so the countdown is tested without waiting
// real time (the view reads the value from --duration-undo).
const UNDO_MS = 100;

const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const B = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const C = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const MINTED = "01ARZ3NDEKTSV4RRFFQ69G5FD2";
const MINTED2 = "01ARZ3NDEKTSV4RRFFQ69G5FE3";

const tick = () => new Promise((r) => setTimeout(r, 0));

// A mint that hands out distinct ids in order, so a re-mint (the New chat row after the
// last one became real) is told from the id before it.
const minter = () => {
  const ids = [MINTED, MINTED2];
  let i = 0;
  return () => ids[i++] ?? `01ARZ3NDEKTSV4RRFFQ69G5F${i}`;
};

// Every message the view emits during a run, with the schema it must satisfy; the final
// test validates them all (Testing, shape test). Query payloads asked are all {}.
const recorded = [];
const see = (value, schema) => recorded.push({ value, schema });

function list({ ask, mint = minter(), undoMs = UNDO_MS, following = false } = {}) {
  const selected = [];
  const discarded = [];
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { ask, mint, undoMs, following }, clock });
  actor.on("conversation.selected", (e) => {
    selected.push(e.id);
    see(e, EVENTS["conversation.selected"]);
  });
  actor.on("conversation.discarded", (e) => {
    discarded.push(e.id);
    see(e, EVENTS["conversation.discarded"]);
  });
  actor.start();
  return { actor, selected, discarded, clock };
}

// Answers list, open and subject: read, recording each payload against its schema.
const answering = ({ conversations = [], open = null, subject = null, session } = {}) => (target, name, payload) => {
  if (target === "conversations" && name === "list") {
    see(payload, CONV_LIST.payload);
    return Promise.resolve({ conversations });
  }
  if (target === "conversations" && name === "open") {
    see(payload, CONV_OPEN.payload);
    return Promise.resolve({ id: open });
  }
  if (target === "session" && name === "read" && session !== undefined) {
    see(payload, SESSION_READ.payload);
    if (!("error" in session)) see(session, SESSION_READ.reply);
    return Promise.resolve(session);
  }
  if (target === "subject" && name === "read") {
    see(payload, SUBJECT_READ.payload);
    return Promise.resolve({ subject });
  }
  return Promise.resolve({});
};

const ids = (actor) => actor.getSnapshot().context.chats.map((c) => c.id);
const shownIds = (actor) => shown(actor.getSnapshot().context).map((c) => c.id);

test("the starting picture is conversations: list, sorted newest first", async () => {
  const asked = [];
  const { actor } = list({
    ask: (...args) => {
      asked.push([args[0], args[1]]);
      return answering({ conversations: [{ id: A, title: "A", about: [], updatedAt: 10 }, { id: B, title: "B", about: [], updatedAt: 20 }] })(...args);
    },
  });
  await tick();
  assert.equal(actor.getSnapshot().value, "ready");
  assert.deepEqual(ids(actor), [B, A]);
  assert.ok(asked.some(([t, n]) => t === "conversations" && n === "list"), "it asks conversations: list");
  assert.ok(asked.some(([t, n]) => t === "conversations" && n === "open"), "and conversations: open");
});

test("conversation.changed upserts a row and re-sorts", async () => {
  const { actor } = list({ ask: answering({ conversations: [{ id: A, title: "A", about: [], updatedAt: 10 }] }) });
  await tick();
  actor.send({ type: "conversation.changed", id: B, title: "B", about: [], start: "", turns: [], pending: false, updatedAt: 30 });
  assert.deepEqual(ids(actor), [B, A], "the newer chat leads");
  actor.send({ type: "conversation.changed", id: A, title: "A2", about: [], start: "", turns: [], pending: false, updatedAt: 40 });
  assert.deepEqual(ids(actor), [A, B]);
  assert.equal(actor.getSnapshot().context.chats.find((c) => c.id === A).title, "A2");
});

test("a row keeps the subtitle from the list reply and from conversation.changed", async () => {
  const { actor } = list({ ask: answering({ conversations: [{ id: A, title: "A", subtitle: "First", about: [], updatedAt: 10, pending: false }] }) });
  await tick();
  const subtitle = (id) => actor.getSnapshot().context.chats.find((c) => c.id === id).subtitle;
  assert.equal(subtitle(A), "First");
  actor.send({ type: "conversation.changed", id: A, title: "A", subtitle: "Second", about: [], start: "", turns: [], pending: false, updatedAt: 20 });
  assert.equal(subtitle(A), "Second");
});

test("session.changed asks again, so a first visit's signed-out picture is replaced", async () => {
  let reply = { conversations: [], open: null };
  const { actor, clock } = list({ ask: (...args) => answering(reply)(...args) });
  await tick();
  assert.deepEqual(ids(actor), [], "signed out: no chats yet");
  reply = { conversations: [{ id: A, title: "A", about: [], updatedAt: 10 }, { id: B, title: "B", about: [], updatedAt: 20 }], open: A };
  actor.send({ type: "session.changed", userId: "u1" });
  clock.increment(1);
  await tick();
  assert.equal(actor.getSnapshot().value, "ready");
  assert.deepEqual(ids(actor), [B, A], "the account's chats");
  assert.equal(actor.getSnapshot().context.open, A, "and its open chat");
  reply = { conversations: [], open: null };
  actor.send({ type: "session.changed", userId: null });
  clock.increment(1);
  await tick();
  assert.deepEqual(ids(actor), [], "signing out clears them");
});

test("the open chat is the conversations: open reply, then conversation.opened", async () => {
  const { actor } = list({ ask: answering({ conversations: [{ id: A, title: "A", about: [], updatedAt: 10 }], open: A }) });
  await tick();
  assert.equal(actor.getSnapshot().context.open, A, "the starting open id");
  actor.send({ type: "conversation.opened", id: B });
  assert.equal(actor.getSnapshot().context.open, B, "and it follows conversation.opened after");
});

test("_pick emits conversation.selected for an existing chat, and not for a stale id", async () => {
  const { actor, selected } = list({ ask: answering({ conversations: [{ id: A, title: "A", about: [], updatedAt: 10 }] }) });
  await tick();
  actor.send({ type: "_pick", id: A });
  actor.send({ type: "_pick", id: C });
  assert.deepEqual(selected, [A]);
});

test("the New chat draft is minted on start and can be picked while it has no row", async () => {
  const { actor, selected } = list({ ask: answering({ conversations: [] }) });
  await tick();
  assert.equal(actor.getSnapshot().context.draft, MINTED);
  actor.send({ type: "_pick", id: MINTED });
  assert.deepEqual(selected, [MINTED], "New chat announces a fresh id no chat has yet");
});

test("conversation.changed for the draft turns it into a row and mints the next", async () => {
  const { actor } = list({ ask: answering({ conversations: [] }) });
  await tick();
  const first = actor.getSnapshot().context.draft;
  actor.send({ type: "conversation.changed", id: first, title: "Made", about: [], start: "", turns: [], pending: false, updatedAt: 50 });
  assert.deepEqual(ids(actor), [first], "the draft became a real chat");
  const next = actor.getSnapshot().context.draft;
  assert.notEqual(next, first);
  assert.equal(next, MINTED2, "a fresh New chat id took its place");
});

test("conversation.deleted removes a row and clears the open highlight", async () => {
  const { actor } = list({ ask: answering({ conversations: [{ id: A, title: "A", about: [], updatedAt: 10 }, { id: B, title: "B", about: [], updatedAt: 20 }], open: A }) });
  await tick();
  actor.send({ type: "conversation.deleted", id: A });
  assert.deepEqual(ids(actor), [B]);
  assert.equal(actor.getSnapshot().context.open, null, "the deleted chat is no longer the open row");
});

test("a list conversations cannot answer is the failed state (needs a connection)", async () => {
  const { actor } = list({ ask: (target, name) => (name === "list" ? Promise.resolve({ error: "unavailable" }) : Promise.resolve({ id: null, subject: null })) });
  await tick();
  assert.equal(actor.getSnapshot().value, "failed");
  assert.deepEqual(ids(actor), []);
});

// --- Discard countdown (delayed delete, 5) ---------------------------------------

const discardingHas = (actor, id) => actor.getSnapshot().context.discarding.has(id);

test("a discard starts a countdown and emits conversation.discarded only when it elapses", async () => {
  const { actor, discarded, clock } = list({ ask: answering({ conversations: [{ id: A, title: "A", about: [], updatedAt: 10 }] }) });
  await tick();
  actor.send({ type: "_discard", id: A });
  assert.equal(discardingHas(actor, A), true, "the row is counting down");
  assert.deepEqual(discarded, [], "nothing is a fact yet");
  clock.increment(UNDO_MS - 1);
  assert.deepEqual(discarded, [], "still nothing a tick before the window ends");
  clock.increment(1);
  assert.deepEqual(discarded, [A], "the window ran out: the delete is a fact");
  assert.equal(discardingHas(actor, A), false, "and the countdown is over");
  clock.increment(UNDO_MS * 5);
  assert.deepEqual(discarded, [A], "it fires once, never again");
});

test("undo before the window ends cancels the delete and emits nothing", async () => {
  const { actor, discarded, clock } = list({ ask: answering({ conversations: [{ id: A, title: "A", about: [], updatedAt: 10 }] }) });
  await tick();
  actor.send({ type: "_discard", id: A });
  clock.increment(UNDO_MS - 1);
  actor.send({ type: "_undo", id: A });
  assert.equal(discardingHas(actor, A), false, "the row is back");
  clock.increment(UNDO_MS * 2);
  assert.deepEqual(discarded, [], "the cancelled timer never fires");
});

test("_pick on a counting-down row emits nothing: a click there is the undo", async () => {
  const { actor, selected } = list({ ask: answering({ conversations: [{ id: A, title: "A", about: [], updatedAt: 10 }] }) });
  await tick();
  actor.send({ type: "_discard", id: A });
  actor.send({ type: "_pick", id: A });
  assert.deepEqual(selected, [], "a discarding row is not picked");
});

test("conversation.deleted clears any standing countdown", async () => {
  const { actor, discarded, clock } = list({ ask: answering({ conversations: [{ id: A, title: "A", about: [], updatedAt: 10 }] }) });
  await tick();
  actor.send({ type: "_discard", id: A });
  actor.send({ type: "conversation.deleted", id: A }); // e.g. the same chat deleted on another device
  assert.deepEqual(ids(actor), [], "the row is gone");
  assert.equal(discardingHas(actor, A), false, "the countdown is cleared");
  clock.increment(UNDO_MS * 2);
  assert.deepEqual(discarded, [], "the cancelled timer never fires");
});

// --- Following the stage: the subject's chats only (12) ------------------------------

test("following a subject, every chat is kept but only those about it are shown", async () => {
  const asked = [];
  const { actor } = list({
    following: true,
    ask: (...args) => {
      asked.push([args[0], args[1]]);
      return answering({
        conversations: [
          { id: A, title: "A", about: [{ kind: "book", id: "bk1" }], updatedAt: 10 },
          { id: B, title: "B", about: [{ kind: "book", id: "bk2" }], updatedAt: 20 },
          { id: C, title: "C", about: [], updatedAt: 30 },
        ],
        subject: { kind: "book", id: "bk1", title: "Dune" },
      })(...args);
    },
  });
  await tick();
  assert.deepEqual(ids(actor), [C, B, A], "every chat is kept, newest first");
  assert.deepEqual(shownIds(actor), [A], "only the chat about the subject shows");
  assert.ok(asked.some(([t, n]) => t === "subject" && n === "read"), "a following list asks the subject");
});

test("with the attribute off, the subject is not asked and every chat shows", async () => {
  const asked = [];
  const { actor } = list({
    following: false,
    ask: (...args) => {
      asked.push([args[0], args[1]]);
      return answering({ conversations: [{ id: A, title: "A", about: [{ kind: "book", id: "bk1" }], updatedAt: 10 }] })(...args);
    },
  });
  await tick();
  assert.ok(!asked.some(([t, n]) => t === "subject" && n === "read"), "the subject is not asked");
  assert.deepEqual(shownIds(actor), [A], "links are ignored, every chat shows");
});

test("subject.changed switches which chats are shown", async () => {
  const { actor } = list({
    following: true,
    ask: answering({
      conversations: [
        { id: A, title: "A", about: [{ kind: "book", id: "bk1" }], updatedAt: 10 },
        { id: B, title: "B", about: [{ kind: "book", id: "bk2" }], updatedAt: 20 },
      ],
      subject: { kind: "book", id: "bk1", title: "One" },
    }),
  });
  await tick();
  assert.deepEqual(shownIds(actor), [A]);
  actor.send({ type: "subject.changed", subject: { kind: "book", id: "bk2", title: "Two" } });
  assert.deepEqual(shownIds(actor), [B]);
  actor.send({ type: "subject.changed", subject: null });
  assert.deepEqual(shownIds(actor), [B, A], "no subject on the stage shows every chat");
});

// --- The stage survives a reload: the subject race (3.5) ----------------------------

const SUBJECT_BK1 = { kind: "book", id: "bk1", title: "Dune" };

test("reload race: a slow list reply does not clobber a subject.changed with the read's null", async () => {
  let resolveList;
  const gate = new Promise((r) => (resolveList = r));
  const ask = (target, name) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: null });
    if (name === "open") return Promise.resolve({ id: null });
    if (name === "list") return gate;
    return Promise.resolve({});
  };
  const { actor } = list({ following: true, ask });
  await tick();
  assert.equal(actor.getSnapshot().value, "loading", "the list is still loading");
  actor.send({ type: "subject.changed", subject: SUBJECT_BK1 });
  assert.deepEqual(actor.getSnapshot().context.subject, SUBJECT_BK1, "the change was taken");
  resolveList({ conversations: [{ id: A, title: "A", about: [{ kind: "book", id: "bk1" }], updatedAt: 10 }] });
  await tick();
  const s = actor.getSnapshot();
  assert.equal(s.value, "ready");
  assert.deepEqual(s.context.subject, SUBJECT_BK1, "the list reply left the changed subject in place");
  assert.deepEqual(shownIds(actor), [A], "so the list scopes to the book on the stage");
});

// Signed out, the view shows only "Sign in to chat." (3.4); the decision is signedIn.
test("signed in, signed out, or with no session on the page", async () => {
  const chats = [{ id: A, title: "A", about: [], updatedAt: 10 }];
  const cases = [
    [{ userId: "u1", registrationOpen: false }, true, "signed in"],
    [{ userId: null, registrationOpen: true }, false, "signed out"],
    [{ error: "no-answerer" }, true, "no session mounted counts as signed in"],
  ];
  for (const [session, want, why] of cases) {
    const { actor } = list({ ask: answering({ conversations: chats, session }) });
    assert.equal(actor.getSnapshot().context.signedIn, null, "unknown until session answers");
    await tick();
    assert.equal(actor.getSnapshot().context.signedIn, want, why);
  }
  assert.equal(signedIn(undefined), true, "an empty reply hides nothing");
});

test("signing in after load, and out again, switches without a reload", async () => {
  let reply = { conversations: [], session: { userId: null, registrationOpen: true } };
  const { actor, clock } = list({ ask: (...args) => answering(reply)(...args) });
  await tick();
  assert.equal(actor.getSnapshot().context.signedIn, false);
  reply = { conversations: [{ id: A, title: "A", about: [], updatedAt: 10 }], session: { userId: "u1", registrationOpen: false } };
  actor.send({ type: "session.changed", userId: "u1" });
  assert.equal(actor.getSnapshot().context.signedIn, true, "at once on the event");
  clock.increment(1);
  await tick();
  assert.deepEqual(ids(actor), [A], "with the account's chats");
  actor.send({ type: "session.changed", userId: null });
  assert.equal(actor.getSnapshot().context.signedIn, false);
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    // An emitted event carries `type` (its name); the schema is the payload alone. A query
    // payload has no type, so stripping it leaves the payload unchanged.
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)} against ${schema.description ?? "schema"}: ${JSON.stringify(result.errors?.[0])}`);
  }
});

// The "Vim keys" preference (12): asked of settings at start, followed after.
const VIM_INPUT = { mint: () => "01ARZ3NDEKTSV4RRFFQ69G5FZZ", undoMs: 100, following: false };
const vimAsk = (reply) => (target, name) =>
  Promise.resolve(target === "settings" && name === "read" ? reply : {});
const vimActor = (reply) => createActor(machine, { input: { ...VIM_INPUT, ask: vimAsk(reply) } }).start();
const vimSettle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

test("Vim keys start from settings: read, and are off until it answers", async () => {
  const actor = vimActor({ vimKeys: true, profile: "workshop" });
  assert.equal(actor.getSnapshot().context.vimKeys, false, "off before the reply");
  await vimSettle();
  assert.equal(actor.getSnapshot().context.vimKeys, true);
});

test("Vim keys follow settings.changed, in any state, and never move the view", async () => {
  const actor = vimActor({ vimKeys: false });
  await vimSettle();
  const before = actor.getSnapshot().value;
  actor.send({ type: "settings.changed", vimKeys: true });
  assert.equal(actor.getSnapshot().context.vimKeys, true);
  actor.send({ type: "settings.changed", vimKeys: false });
  assert.equal(actor.getSnapshot().context.vimKeys, false);
  assert.deepEqual(actor.getSnapshot().value, before);
});

test("an error reply, or a reply without the field, leaves Vim keys off", async () => {
  for (const reply of [{ error: "no-answerer" }, { profile: "product" }]) {
    const actor = vimActor(reply);
    await vimSettle();
    assert.equal(actor.getSnapshot().context.vimKeys, false, JSON.stringify(reply));
  }
});

test("the open chat not about the subject is set apart; one about it, or with no subject, is not", () => {
  const about = (id, book) => ({ id, title: id, subtitle: "", about: [{ kind: "book", id: book }], updatedAt: 1 });
  const chats = [about("a", "b1"), about("b", "b2")];
  const subject = { kind: "book", id: "b1" };
  assert.equal(apart({ chats, following: true, subject, open: "b" })?.id, "b", "a pinned chat of another book");
  assert.equal(apart({ chats, following: true, subject, open: "a" }), null, "already shown");
  assert.equal(apart({ chats, following: true, subject: null, open: "b" }), null, "every chat shown");
  assert.equal(apart({ chats, following: true, subject, open: "draft" }), null, "no row yet");
});


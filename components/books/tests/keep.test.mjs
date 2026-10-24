import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The keep variant of changing who the browser belongs to (12, Connect and Disconnect of
// the Mac app, 3.4): on session.changed with `leaving` and `keep` the fact uploads its
// outbox and keeps its copy, marked `adopt` with the account it came from. After the
// reload the account is asked for its books first: when it holds one, the copy is
// emptied and the account's are taken; when it holds none, each book gets one row that
// adds it there (its file read from the Mac's own server after Connect, or from the
// account after Disconnect, imported, then its place and the user's title), except the
// first book while unread; offline, the mark stays for the next load. The pull starts
// again from 0, and the mark is cleared. A book the account already has is not uploaded;
// one whose file cannot be read goes from the copy with a notice. Plain leaving still
// empties. The store, the api and the asks are fakes of the shapes fact.js builds.
const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const B = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const book = (id, extra = {}) => ({
  id,
  title: "File title",
  fileTitle: "File title",
  author: "",
  cover: null,
  chapters: [{ title: "One" }, { title: "Two" }, { title: "Three" }],
  toc: [],
  position: { chapter: 0, block: 0 },
  version: 4,
  contentVersion: 1,
  addedAt: 1,
  updatedAt: 1,
  deleted: false,
  ...extra,
});
const LIVE = book(A, { title: "My title", position: { chapter: 2, block: 3 } });
const GONE = book(B, { deleted: true });
const FIRST = "0000000000000000000000MED1";

const flush = async (n = 40) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeStore(meta0, books = [LIVE, GONE]) {
  const meta = new Map(Object.entries(meta0));
  const outbox = new Map();
  const queued = [];
  const log = [];
  const store = {
    all: async () => books,
    put: async () => {},
    outboxAll: async () => [...outbox.values()],
    outboxPut: async (r) => {
      queued.push(r);
      outbox.set(r.id, r);
    },
    outboxDelete: async (k) => void outbox.delete(k),
    metaGet: async (key) => meta.get(key),
    metaPut: async (key, value) => void meta.set(key, value),
    empty: async () => {
      log.push("empty");
      outbox.clear();
    },
    clear: async () => {},
  };
  return { store, meta, queued, log };
}

// `has` is what the account already holds; `adopt` answers an upload.
function fakeApi({ has = [], offline = false, adopt = (row) => ({ row: book(row.book, { title: row.title ?? "File title", position: row.position, version: 1 }) }) } = {}) {
  const calls = [];
  const api = {
    pull: async (since) => {
      calls.push(["pull", since]);
      if (offline) throw new Error("offline");
      return { books: has, cursor: 0, open: { id: null, at: 0 } };
    },
    adopt: async (row) => {
      calls.push(["adopt", row]);
      return adopt(row);
    },
  };
  return { api, calls };
}

function start(meta, userId = "u1", apiOptions, connect = null, books) {
  const { store, meta: held, queued, log } = fakeStore(meta, books);
  const { api, calls } = fakeApi(apiOptions);
  const ask = async (target) => (target === "session" ? { userId, registrationOpen: false, ...(connect ? { connect } : {}) } : { error: "no-answerer" });
  const actor = createActor(machine, { input: { store, api, ask, now: () => 1000, revoke: () => {} } });
  const emitted = [];
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  return { actor, meta: held, queued, log, calls, emitted };
}

const session = (extra = {}) => ({ type: "session.changed", userId: "u1", registrationOpen: false, ...extra });
const reloaded = { userId: "u0", adopt: "u0", cursor: 7 };

test("keep keeps the copy and marks it with the account it came from", async () => {
  const { actor, meta, log } = start({ userId: "u1" });
  await flush();
  actor.send(session({ leaving: true, keep: true }));
  await flush();
  assert.deepEqual(log, [], "nothing is emptied");
  assert.equal(meta.get("adopt"), "u1");
  actor.send(session());
  await flush();
  assert.equal(meta.get("adopt"), null, "called off, the mark goes");
  actor.stop();
});

test("plain leaving still empties the copy and leaves no mark", async () => {
  const { actor, meta, log } = start({ userId: "u1" });
  await flush();
  actor.send(session({ leaving: true }));
  await flush();
  assert.deepEqual(log, ["empty"]);
  assert.equal(meta.get("adopt"), undefined);
  actor.stop();
});

test("after the reload each book is added with its place and title, from a cursor of 0", async () => {
  const { actor, meta, queued, log, calls, emitted } = start(reloaded);
  await flush();
  assert.deepEqual(log, [], "the copy is kept, not emptied as another account's");
  assert.deepEqual(queued.map((r) => r.id), [`adopt:${A}`], "a tombstone is not sent");
  assert.deepEqual(queued[0], {
    id: `adopt:${A}`,
    kind: "adopt",
    book: A,
    position: { chapter: 2, block: 3 },
    title: "My title",
    from: "remote",
  }, "not connected now: the change was Disconnect, so the file is the account's");
  assert.equal(meta.get("adopt"), null);
  assert.equal(meta.get("userId"), "u1");
  assert.ok(calls.some(([name, row]) => name === "adopt" && row.book === A), "uploaded");
  assert.ok(calls.filter(([name]) => name === "pull").every(([, since]) => since === 0));
  const news = emitted.find((e) => e.type === "book.changed" && e.id === A);
  assert.equal(news?.title, "My title");
  assert.deepEqual(news?.position, { chapter: 2, block: 3 });
  assert.equal(actor.getSnapshot().context.outbox.size, 0);
  actor.stop();
});

test("connected now, the change was Connect: the file is read from the Mac", async () => {
  const { actor, queued } = start(reloaded, "u1", undefined, "on");
  await flush();
  assert.equal(queued[0]?.from, "local");
  actor.stop();
});

test("an account that has books: the copy is emptied and the account's are taken", async () => {
  const theirs = book(A, { title: "Theirs", version: 9, contentVersion: 2 });
  const { actor, calls, emitted, log, queued, meta } = start(reloaded, "u1", { has: [theirs] });
  await flush();
  assert.deepEqual(log, ["empty"], "this copy, outbox included, is emptied");
  assert.deepEqual(queued, []);
  assert.equal(meta.get("adopt"), null);
  assert.equal(meta.get("userId"), "u1");
  assert.ok(!calls.some(([name]) => name === "adopt"));
  assert.equal(emitted.find((e) => e.type === "book.changed" && e.id === A)?.title, "Theirs");
  assert.equal(actor.getSnapshot().context.books.get(A).contentVersion, 2);
  actor.stop();
});

test("a book whose file cannot be read goes from the copy, and a notice says so", async () => {
  const { actor, emitted } = start(reloaded, "u1", { adopt: () => ({ error: "unreadable" }) });
  await flush();
  assert.ok(emitted.some((e) => e.type === "book.deleted" && e.id === A));
  assert.ok(emitted.some((e) => e.type === "book.refused" && e.id === A && e.reason === "unreadable"));
  assert.equal(actor.getSnapshot().context.outbox.size, 0);
  actor.stop();
});

test("an account that holds only deleted books counts as empty", async () => {
  const { actor, queued, log } = start(reloaded, "u1", { has: [book(B, { deleted: true })] });
  await flush();
  assert.deepEqual(log, []);
  assert.deepEqual(queued.map((r) => r.id), [`adopt:${A}`]);
  actor.stop();
});

test("the first book is sent only once it was read or renamed", async () => {
  const unread = book(FIRST);
  for (const [extra, sent] of [
    [{}, false],
    [{ position: { chapter: 1, block: 0 } }, true],
    [{ position: { chapter: 0, block: 2 } }, true],
    [{ title: "Mine" }, true],
  ]) {
    const { actor, queued } = start(reloaded, "u1", undefined, null, [{ ...unread, ...extra }]);
    await flush();
    assert.equal(queued.some((r) => r.book === FIRST), sent, JSON.stringify(extra));
    actor.stop();
  }
});

test("offline after the reload the mark stays and nothing is emptied or queued", async () => {
  const { actor, meta, queued, log } = start(reloaded, "u1", { offline: true });
  await flush();
  assert.deepEqual(log, []);
  assert.deepEqual(queued, []);
  assert.equal(meta.get("adopt"), "u0", "the next load decides");
  assert.equal(meta.get("userId"), "u1", "the copy is not taken for another account's meanwhile");
  actor.stop();
});

test("offline, the book waits in the outbox for the next sync", async () => {
  const { actor } = start(reloaded, "u1", {
    adopt: () => {
      throw new Error("offline");
    },
  });
  await flush();
  assert.ok(actor.getSnapshot().context.outbox.has(`adopt:${A}`));
  actor.stop();
});

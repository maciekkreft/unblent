import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): it is driven with a fake `api` (the
// shape fact.js builds) and a fake `save`, so the ceremony and the network stay
// out of the test. fromPromise settles on a microtask; a few macrotasks flush a
// whole chain (revalidate does a logout then a me).
const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeApi(impl) {
  const calls = { me: 0, register: 0, login: 0, logout: 0, guest: 0, people: 0, forget: 0, allowSync: 0, connect: 0, connectCode: 0 };
  const api = {};
  for (const name of Object.keys(calls)) {
    api[name] = async () => {
      calls[name] += 1;
      return impl[name];
    };
  }
  return { api, calls, impl };
}

function start(stored, api, { tryPage = false } = {}) {
  const saved = [];
  const events = [];
  const actor = createActor(machine, {
    input: { stored: JSON.stringify(stored), save: (v) => saved.push(JSON.parse(v)), api, tryPage },
  });
  actor.on("session.changed", (e) => events.push(e));
  actor.on("session.refused", (e) => events.push(e));
  actor.start();
  return { actor, saved, events };
}

const context = (actor) => actor.getSnapshot().context;

test("read? answers from the cache before any network (4.3)", async () => {
  const { api, calls } = fakeApi({ me: { userId: "later", registrationOpen: false } });
  const { actor } = start({ userId: "cached", registrationOpen: true, logoutOwed: false }, api);
  let reply;
  actor.send({ type: "read?", cid: "c1", payload: {}, reply: (v) => (reply = v) });
  assert.deepEqual(reply, { userId: "cached", registrationOpen: true });
  assert.equal(calls.me, 0);
});

test("signin logs in with an existing passkey rather than registering (5)", async () => {
  // A shared passkey on a second device: login succeeds, so no duplicate account.
  const open = fakeApi({ login: { userId: "u1", registrationOpen: true } });
  const a = start({ userId: null, registrationOpen: true, logoutOwed: false }, open.api);
  a.actor.send({ type: "signin.requested" });
  await flush();
  assert.equal(open.calls.login, 1);
  assert.equal(open.calls.register, 0);
  assert.equal(context(a.actor).userId, "u1");
  assert.deepEqual(a.events, [
    { type: "session.changed", userId: "u1", registrationOpen: true },
  ]);
  assert.equal(a.saved.at(-1).userId, "u1");

  // A full registry: login is still the only ceremony tried.
  const closed = fakeApi({ login: { userId: "u2", registrationOpen: false } });
  const b = start({ userId: null, registrationOpen: false, logoutOwed: false }, closed.api);
  b.actor.send({ type: "signin.requested" });
  await flush();
  assert.equal(closed.calls.login, 1);
  assert.equal(closed.calls.register, 0);
  assert.deepEqual(b.events, [
    { type: "session.changed", userId: "u2", registrationOpen: false },
  ]);
});

test("signin falls back to register when no passkey signs in and a slot is free", async () => {
  // cancelled (empty prompt or user cancel) and unknown-credential (a passkey the
  // registry forgot) both mean no account: with a slot free, create one.
  for (const reason of ["cancelled", "unknown-credential"]) {
    const api = fakeApi({ login: { error: reason }, register: { userId: "u1", registrationOpen: false } });
    const a = start({ userId: null, registrationOpen: true, logoutOwed: false }, api.api);
    a.actor.send({ type: "signin.requested" });
    await flush();
    assert.equal(api.calls.login, 1);
    assert.equal(api.calls.register, 1);
    assert.equal(context(a.actor).userId, "u1");
    assert.deepEqual(a.events, [
      { type: "session.changed", userId: "u1", registrationOpen: false },
    ]);
  }
});

test("a failed login never registers when the registry is full", async () => {
  for (const reason of ["cancelled", "unknown-credential"]) {
    const api = fakeApi({ login: { error: reason } });
    const a = start({ userId: null, registrationOpen: false, logoutOwed: false }, api.api);
    a.actor.send({ type: "signin.requested" });
    await flush();
    assert.equal(api.calls.register, 0);
    assert.deepEqual(a.events, [{ type: "session.refused", reason }]);
    assert.equal(context(a.actor).userId, null);
  }
});

test("an unavailable login is a refusal, never a fallback to register", async () => {
  const api = fakeApi({ login: { error: "unavailable" } });
  const a = start({ userId: null, registrationOpen: true, logoutOwed: false }, api.api);
  a.actor.send({ type: "signin.requested" });
  await flush();
  assert.equal(api.calls.register, 0);
  assert.deepEqual(a.events, [{ type: "session.refused", reason: "unavailable" }]);
  assert.equal(context(a.actor).userId, null);
});

test("a refused register surfaces its reason, leaving the user unchanged", async () => {
  // login fails first so the fallback register is reached; its error is what shows.
  for (const reason of ["registration-closed", "unavailable"]) {
    const { api } = fakeApi({ login: { error: "cancelled" }, register: { error: reason } });
    const a = start({ userId: null, registrationOpen: true, logoutOwed: false }, api);
    a.actor.send({ type: "signin.requested" });
    await flush();
    assert.deepEqual(a.events, [{ type: "session.refused", reason }]);
    assert.equal(context(a.actor).userId, null);
  }
});

test("offline sign-out flips at once, keeps the debt, and ignores a still-signed-in server", async () => {
  const { api, impl } = fakeApi({
    logout: { error: "unavailable" },
    me: { userId: "u1", registrationOpen: false },
  });
  const a = start({ userId: "u1", registrationOpen: false, logoutOwed: false }, api);
  a.actor.send({ type: "signout.requested" });
  await flush();
  // Announced immediately (local-first, 5) and the debt persisted.
  assert.deepEqual(a.events, [
    { type: "session.changed", userId: null, registrationOpen: false },
  ]);
  assert.equal(context(a.actor).userId, null);
  assert.equal(context(a.actor).logoutOwed, true);
  assert.equal(a.saved.at(-1).logoutOwed, true);

  // Revalidate while offline: the retry fails and the server still says signed-in,
  // which must be ignored — no flip back, the debt stands, no new news.
  a.actor.send({ type: "_revalidate" });
  await flush();
  assert.equal(context(a.actor).userId, null);
  assert.equal(context(a.actor).logoutOwed, true);
  assert.equal(a.events.length, 1);

  // The retry finally lands: the debt clears, still no new news.
  impl.logout = { userId: null };
  a.actor.send({ type: "_revalidate" });
  await flush();
  assert.equal(context(a.actor).logoutOwed, false);
  assert.equal(context(a.actor).userId, null);
  assert.equal(a.events.length, 1);
});

test("revalidate announces only a real change of user (5)", async () => {
  const { api, impl } = fakeApi({ me: { userId: "u1", registrationOpen: true } });
  const a = start({ userId: "u1", registrationOpen: true, logoutOwed: false }, api);
  a.actor.send({ type: "_revalidate" });
  await flush();
  assert.deepEqual(a.events, []);

  impl.me = { userId: "u3", registrationOpen: false };
  a.actor.send({ type: "_revalidate" });
  await flush();
  assert.deepEqual(a.events, [
    { type: "session.changed", userId: "u3", registrationOpen: false },
  ]);
  assert.equal(context(a.actor).userId, "u3");
});

test("revalidate announces a registrationOpen flip even when the user is unchanged", async () => {
  const { api, impl } = fakeApi({ me: { userId: "u1", registrationOpen: true } });
  const a = start({ userId: "u1", registrationOpen: true, logoutOwed: false }, api);
  a.actor.send({ type: "_revalidate" });
  await flush();
  assert.deepEqual(a.events, []);

  // The registry fills on the server: the switch must relabel, so the news carries
  // registrationOpen although the user did not change (4.3 fourth rule).
  impl.me = { userId: "u1", registrationOpen: false };
  a.actor.send({ type: "_revalidate" });
  await flush();
  assert.deepEqual(a.events, [
    { type: "session.changed", userId: "u1", registrationOpen: false },
  ]);
  assert.equal(context(a.actor).registrationOpen, false);
});

test("session.rejected re-checks and signs out when the server no longer knows us", async () => {
  // Another fact (books) got a 401 and announced it: the cookie is gone though this
  // cache still reads signed in. session re-checks and announces the sign-out, so the
  // auth control flips at once rather than at the next focus (3.4).
  const { api, calls } = fakeApi({ me: { userId: null, registrationOpen: true } });
  const { actor, events } = start({ userId: "u1", registrationOpen: false, logoutOwed: false }, api);
  actor.send({ type: "session.rejected" });
  await flush();
  assert.equal(calls.me, 1, "it re-checks with the server");
  assert.equal(context(actor).userId, null);
  assert.deepEqual(events, [{ type: "session.changed", userId: null, registrationOpen: true }]);
});

test("session.rejected while already signed out needs no round trip", async () => {
  const { api, calls } = fakeApi({ me: { userId: null, registrationOpen: true } });
  const { actor, events } = start({ userId: null, registrationOpen: true, logoutOwed: false }, api);
  actor.send({ type: "session.rejected" });
  await flush();
  assert.equal(calls.me, 0, "no re-check when we already think we are signed out");
  assert.deepEqual(events, []);
});

let asked = 0;
const ask = (actor, type, payload = {}) =>
  new Promise((resolve) => actor.send({ type, cid: "c" + (asked += 1), payload, reply: resolve }));

test("a fresh browser on a try page becomes Guest 1 at its first server need, once (3.4)", async () => {
  const guest = { userId: "g1", registrationOpen: true, guest: true, admin: false, name: "Guest 1" };
  const { api, calls } = fakeApi({ guest });
  const { actor, events, saved } = start(null, api, { tryPage: true });
  // Two facts asking at once make one guest, and both get it.
  const [a, b] = await Promise.all([ask(actor, "guest?"), ask(actor, "guest?")]);
  const picture = { userId: "g1", registrationOpen: true, guest: true, name: "Guest 1" };
  assert.deepEqual(a, picture);
  assert.deepEqual(b, picture);
  assert.equal(calls.guest, 1);
  assert.deepEqual(events, [{ type: "session.changed", ...picture }]);
  assert.equal(saved.at(-1).name, "Guest 1");
  assert.deepEqual(await ask(actor, "read?"), picture);
  // A later ask is answered with the account held, with no request.
  assert.deepEqual(await ask(actor, "guest?"), picture);
  assert.equal(calls.guest, 1);
});

test("guest? never makes a guest off a try page, nor when an account is held (8)", async () => {
  const { api, calls } = fakeApi({ guest: { userId: "g1", registrationOpen: true, guest: true } });
  const off = start(null, api);
  assert.deepEqual(await ask(off.actor, "guest?"), { error: "not-a-try-page" });
  const held = start({ userId: "u1", registrationOpen: false, admin: true, name: "Admin" }, api, { tryPage: true });
  assert.deepEqual(await ask(held.actor, "guest?"), { userId: "u1", registrationOpen: false, admin: true, name: "Admin" });
  assert.equal(calls.guest, 0);
  assert.deepEqual([...off.events, ...held.events], []);
});

test("a guest the server could not make is unavailable, and the next ask tries again", async () => {
  const { api, calls, impl } = fakeApi({ guest: { error: "unavailable" } });
  const { actor, events } = start(null, api, { tryPage: true });
  assert.deepEqual(await ask(actor, "guest?"), { error: "unavailable" });
  assert.deepEqual(events, []);
  impl.guest = { userId: "g2", registrationOpen: true, guest: true, name: "Guest 2" };
  assert.equal((await ask(actor, "guest?")).userId, "g2");
  assert.equal(calls.guest, 2);
});

test("a guest? that arrives while revalidating waits for the server's answer", async () => {
  const { api, calls } = fakeApi({
    me: { userId: null, registrationOpen: true },
    guest: { userId: "g3", registrationOpen: true, guest: true, name: "Guest 3" },
  });
  const { actor } = start(null, api, { tryPage: true });
  actor.send({ type: "_revalidate" });
  const reply = await ask(actor, "guest?");
  assert.equal(reply.userId, "g3");
  assert.equal(calls.me, 1);
  assert.equal(calls.guest, 1);
});

test("people? is answered by the server for the admin only (12)", async () => {
  const people = { people: [] };
  const { api, calls } = fakeApi({ people });
  const nobody = start(null, api);
  assert.deepEqual(await ask(nobody.actor, "people?"), { error: "not-admin" });
  const guest = start({ userId: "g1", registrationOpen: true, guest: true, name: "Guest 1" }, api);
  assert.deepEqual(await ask(guest.actor, "people?"), { error: "not-admin" });
  assert.equal(calls.people, 0);
  const admin = start({ userId: "u1", registrationOpen: false, admin: true, name: "Admin" }, api);
  assert.deepEqual(await ask(admin.actor, "people?"), people);
  assert.equal(calls.people, 1);
});

test("a guest's Delete, once its Undo window ended, reaches the server and announces the new list (12)", async () => {
  const left = { people: [{ userId: "u1", name: "Admin", guest: false, admin: true }] };
  const { api, calls } = fakeApi({ forget: left });
  const changed = [];
  const guest = start({ userId: "g1", registrationOpen: true, guest: true, name: "Guest 1" }, api);
  guest.actor.send({ type: "removal.settled", kind: "guest", id: "a".repeat(32) });
  const admin = start({ userId: "u1", registrationOpen: false, admin: true, name: "Admin" }, api);
  admin.actor.on("people.changed", (e) => changed.push(e));
  admin.actor.send({ type: "removal.settled", kind: "evaluator", id: "01K7TEST00000000000000EV00" });
  await flush();
  assert.equal(calls.forget, 0, "only the admin, and only a guest's removal");
  admin.actor.send({ type: "removal.settled", kind: "guest", id: "a".repeat(32) });
  await flush();
  assert.equal(calls.forget, 1);
  assert.deepEqual(changed, [{ type: "people.changed", ...left }]);
});

test("Can sync reaches the server from the admin only and announces the new list; a failure says so and reads the list again (3.4)", async () => {
  const list = { people: [{ userId: "u1", name: "Admin", guest: false, admin: true, sync: true }] };
  const ok = fakeApi({ allowSync: list });
  const guest = start({ userId: "g1", registrationOpen: true, guest: true, name: "Guest 1" }, ok.api);
  guest.actor.send({ type: "sync.allowed", user: "u1", allowed: true });
  await flush();
  assert.equal(ok.calls.allowSync, 0);
  const admin = start({ userId: "u1", registrationOpen: false, admin: true, name: "Admin" }, ok.api);
  const changed = [];
  admin.actor.on("people.changed", (e) => changed.push(e));
  admin.actor.send({ type: "sync.allowed", user: "u1", allowed: true });
  await flush();
  assert.equal(ok.calls.allowSync, 1);
  assert.deepEqual(changed, [{ type: "people.changed", ...list }]);

  const down = fakeApi({ allowSync: { error: "unavailable" } });
  const failing = start({ userId: "u1", registrationOpen: false, admin: true, name: "Admin" }, down.api);
  const seen = [];
  failing.actor.on("people.changed", (e) => seen.push(e));
  failing.actor.send({ type: "sync.allowed", user: "u1", allowed: false });
  await flush();
  assert.deepEqual(failing.events.at(-1), { type: "session.refused", reason: "unavailable" });
  assert.deepEqual(seen, []);
});

test("connect? and connectCode? ask the server only for a signed-in account (3.4)", async () => {
  const { api, calls } = fakeApi({ connect: { allowed: true }, connectCode: { code: "c0de" } });
  const nobody = start(null, api);
  assert.deepEqual(await ask(nobody.actor, "connect?"), { allowed: false });
  assert.deepEqual(await ask(nobody.actor, "connectCode?", { challenge: "x".repeat(43) }), { error: "signed-out" });
  const guest = start({ userId: "g1", registrationOpen: true, guest: true, name: "Guest 1" }, api);
  assert.deepEqual(await ask(guest.actor, "connect?"), { allowed: false });
  assert.equal(calls.connect + calls.connectCode, 0);
  const own = start({ userId: "u1", registrationOpen: false, admin: true, name: "Admin" }, api);
  assert.deepEqual(await ask(own.actor, "connect?"), { allowed: true });
  assert.deepEqual(await ask(own.actor, "connectCode?", { challenge: "x".repeat(43) }), { code: "c0de" });
  assert.deepEqual([calls.connect, calls.connectCode], [1, 1]);
});

test("revalidate announces the account becoming the admin (3.4)", async () => {
  const { api } = fakeApi({ me: { userId: "u1", registrationOpen: false, guest: false, admin: true, name: "Admin" }, logout: { userId: null } });
  const { actor, events } = start({ userId: "u1", registrationOpen: false, logoutOwed: false }, api);
  actor.send({ type: "_revalidate" });
  await flush();
  assert.deepEqual(events, [{ type: "session.changed", userId: "u1", registrationOpen: false, admin: true, name: "Admin" }]);
  // Signing out forgets what the account was.
  actor.send({ type: "signout.requested" });
  assert.deepEqual(events.at(-1), { type: "session.changed", userId: null, registrationOpen: false });
});

// Changing who the browser belongs to (12), with a simulated clock: `pending` says
// whether an outbox still holds a row, `go` stands for opening the other account's page.
function handing(stored, impl, pendingAnswers = [false]) {
  let t = 0;
  const went = [];
  const saved = [];
  const events = [];
  const calls = { viewAs: [], back: 0 };
  const api = {
    viewAs: async (user) => (calls.viewAs.push(user), impl.viewAs),
    back: async () => (calls.back++, impl.back),
    me: async () => ({ error: "unavailable" }),
  };
  const actor = createActor(machine, {
    input: {
      stored: JSON.stringify(stored),
      save: (v) => saved.push(JSON.parse(v)),
      api,
      pending: async () => (pendingAnswers.length > 1 ? pendingAnswers.shift() : pendingAnswers[0]),
      sleep: async (ms) => void (t += ms),
      now: () => t,
      go: (picture) => went.push(picture),
      waitMs: 1000,
    },
  });
  actor.on("session.changed", (e) => events.push(e));
  actor.on("session.refused", (e) => events.push(e));
  actor.start();
  return { actor, went, saved, events, calls };
}

const ADMIN = { userId: "a1", registrationOpen: false, admin: true, name: "Admin" };
const GUEST_VIEW = { userId: "g14", registrationOpen: false, guest: true, name: "Guest 14", viewingAs: "Guest 14" };

test("View as tells the facts the browser is leaving, waits for the outboxes, then opens the guest's page", async () => {
  const h = handing(ADMIN, { viewAs: GUEST_VIEW }, [true, true, false]);
  h.actor.send({ type: "viewas.requested", user: "g14" });
  await flush(12);
  assert.deepEqual(h.events, [{ type: "session.changed", ...ADMIN, leaving: true }], "leaving, and nothing more is announced");
  assert.deepEqual(h.calls.viewAs, ["g14"], "the cookie changes only once no outbox holds a row");
  assert.deepEqual(h.went, [{ userId: "g14", registrationOpen: false, guest: true, name: "Guest 14", viewingAs: "Guest 14" }]);
  assert.equal(h.saved.at(-1).viewingAs, "Guest 14", "the reloaded page starts as the guest");
});

test("an outbox that cannot be emptied in time changes nothing and says so (12)", async () => {
  const h = handing(ADMIN, { viewAs: GUEST_VIEW }, [true]);
  h.actor.send({ type: "viewas.requested", user: "g14" });
  await flush(40);
  assert.deepEqual(h.calls.viewAs, [], "the server is never asked");
  assert.deepEqual(h.went, []);
  assert.deepEqual(h.events, [
    { type: "session.changed", ...ADMIN, leaving: true },
    { type: "session.changed", ...ADMIN },
    { type: "session.refused", reason: "unsaved" },
  ]);
  assert.equal(context(h.actor).userId, "a1");
});

test("a server that refuses the change leaves the admin where they were", async () => {
  const h = handing(ADMIN, { viewAs: { error: "unavailable" } });
  h.actor.send({ type: "viewas.requested", user: "g14" });
  await flush(12);
  assert.deepEqual(h.events.at(-1), { type: "session.refused", reason: "unavailable" });
  assert.deepEqual(h.went, []);
});

test("Back to you needs no passkey and opens the admin's own page", async () => {
  const h = handing(GUEST_VIEW, { back: ADMIN });
  h.actor.send({ type: "viewas.requested", user: null });
  await flush(12);
  assert.equal(h.calls.back, 1);
  assert.deepEqual(h.went, [ADMIN]);
  assert.equal(h.saved.at(-1).viewingAs, null);
});

test("only the admin may view as someone, and Back to you only while viewing", async () => {
  for (const [stored, user] of [
    [{ userId: "g1", registrationOpen: false, guest: true, name: "Guest 1" }, "g2"],
    [ADMIN, "a1"],
    [GUEST_VIEW, "g2"],
    [ADMIN, null],
  ]) {
    const h = handing(stored, {});
    h.actor.send({ type: "viewas.requested", user });
    await flush(6);
    assert.deepEqual(h.events, [], `${stored.userId} → ${user} is not allowed`);
  }
});

test("read? says whom the admin is viewing as, and never that they are the admin", () => {
  const h = handing(GUEST_VIEW, {});
  let reply;
  h.actor.send({ type: "read?", cid: "c", payload: {}, reply: (v) => (reply = v) });
  assert.deepEqual(reply, GUEST_VIEW);
});

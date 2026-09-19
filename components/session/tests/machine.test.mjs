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
  const calls = { me: 0, register: 0, login: 0, logout: 0 };
  const api = {};
  for (const name of Object.keys(calls)) {
    api[name] = async () => {
      calls[name] += 1;
      return impl[name];
    };
  }
  return { api, calls, impl };
}

function start(stored, api) {
  const saved = [];
  const events = [];
  const actor = createActor(machine, {
    input: { stored: JSON.stringify(stored), save: (v) => saved.push(JSON.parse(v)), api },
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

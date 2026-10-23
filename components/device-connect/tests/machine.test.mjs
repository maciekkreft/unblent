import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, paramsOf, finishUrl, MAC_PORT } from "../machine.js";

// The decisions of the connect page (3.4), with session's answers faked: which state
// it shows, what it asks, and where the browser goes.
const flush = async (n = 4) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const SEARCH = `?challenge=${CHALLENGE}&state=st4te-123&port=47321`;

function start(answers, search = SEARCH) {
  const asked = [];
  const went = [];
  const emitted = [];
  const actor = createActor(machine, {
    input: {
      ask: async (target, name, payload) => (asked.push([target, name, payload]), answers[name]),
      search,
      go: (url) => went.push(url),
    },
  });
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  return { actor, asked, went, emitted };
}

test("the address must carry the Mac's challenge and state, and a port from 1 to 65535", () => {
  assert.deepEqual(paramsOf(SEARCH), { challenge: CHALLENGE, state: "st4te-123", port: 47321 });
  assert.equal(paramsOf(`?challenge=${CHALLENGE}&state=st4te-123`).port, MAC_PORT);
  for (const bad of [
    "",
    `?state=st4te-123`,
    `?challenge=short&state=st4te-123`,
    `?challenge=${CHALLENGE}`,
    `?challenge=${CHALLENGE}&state=st4te-123&port=0`,
    `?challenge=${CHALLENGE}&state=st4te-123&port=70000`,
    `?challenge=${CHALLENGE}&state=st4te-123&port=80@evil.example`,
    `?challenge=${CHALLENGE}&state=st4te-123&port=-1`,
  ]) {
    assert.equal(paramsOf(bad), null, bad);
  }
});

test("the code goes only to the Mac's own server on the loopback address", () => {
  const url = new URL(finishUrl(paramsOf(SEARCH), { code: "a b&c" }));
  assert.equal(url.origin, "http://127.0.0.1:47321");
  assert.equal(url.pathname, "/api/session/connect/finish");
  assert.deepEqual([url.searchParams.get("code"), url.searchParams.get("state")], ["a b&c", "st4te-123"]);
});

test("a broken link asks nothing", async () => {
  const { actor, asked } = start({}, "?port=1");
  await flush();
  assert.equal(actor.getSnapshot().value, "broken");
  assert.deepEqual(asked, []);
});

test("signed out it offers sign-in, and follows session once signed in", async () => {
  const { actor, emitted } = start({ read: { userId: null, registrationOpen: false }, connect: { allowed: true } });
  await flush();
  assert.equal(actor.getSnapshot().value, "signedOut");
  actor.send({ type: "_signIn" });
  assert.deepEqual(emitted, [{ type: "signin.requested" }]);
  actor.send({ type: "session.changed", userId: "u1", registrationOpen: false, admin: true, name: "Admin" });
  await flush();
  assert.equal(actor.getSnapshot().value, "ready");
  assert.equal(actor.getSnapshot().context.name, "Admin");
});

test("Connect asks for a code bound to the challenge and leaves for the Mac with it", async () => {
  const { actor, asked, went } = start({ read: { userId: "u1", registrationOpen: false, name: "Admin" }, connect: { allowed: true }, connectCode: { code: "c0de" } });
  await flush();
  actor.send({ type: "_connect" });
  await flush();
  assert.deepEqual(asked.at(-1), ["session", "connectCode", { challenge: CHALLENGE }]);
  assert.equal(actor.getSnapshot().value, "leaving");
  assert.deepEqual(went, ["http://127.0.0.1:47321/api/session/connect/finish?code=c0de&state=st4te-123"]);
});

test("Cancel tells the Mac nothing was connected", async () => {
  const { actor, went } = start({ read: { userId: "u1", registrationOpen: false, name: "Admin" }, connect: { allowed: true } });
  await flush();
  actor.send({ type: "_cancel" });
  assert.deepEqual(went, ["http://127.0.0.1:47321/api/session/connect/finish?error=cancelled&state=st4te-123"]);
});

test("with Can sync off, or as a guest, there is no Connect; a code refused for it says the same", async () => {
  const off = start({ read: { userId: "u1", registrationOpen: false }, connect: { allowed: false } });
  await flush();
  assert.equal(off.actor.getSnapshot().value, "off");
  off.actor.send({ type: "_connect" });
  assert.equal(off.actor.getSnapshot().value, "off");

  const guest = start({ read: { userId: "g1", registrationOpen: false, guest: true } });
  await flush();
  assert.equal(guest.actor.getSnapshot().value, "off");
  assert.deepEqual(guest.asked.map((a) => a[1]), ["read"]);

  const late = start({ read: { userId: "u1", registrationOpen: false }, connect: { allowed: true }, connectCode: { error: "sync-off" } });
  await flush();
  late.actor.send({ type: "_connect" });
  await flush();
  assert.equal(late.actor.getSnapshot().value, "off");
  assert.deepEqual(late.went, []);
});

test("an unreachable server keeps Connect, saying so", async () => {
  const { actor, went } = start({ read: { userId: "u1", registrationOpen: false }, connect: { allowed: true }, connectCode: { error: "unavailable" } });
  await flush();
  actor.send({ type: "_connect" });
  await flush();
  assert.equal(actor.getSnapshot().value, "ready");
  assert.equal(actor.getSnapshot().context.problem, "unavailable");
  assert.deepEqual(went, []);
});

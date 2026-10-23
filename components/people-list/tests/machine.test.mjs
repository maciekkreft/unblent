import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, whenOf, moneyOf, spaceOf, whereOf, deviceOf, tilesOf, rowsOf, shownOf } from "../machine.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

// Local times, so the test reads the same in any time zone.
const NOW = new Date(2026, 9, 17, 9, 45).getTime();
const at = (...a) => new Date(...a).getTime();

const PEOPLE = [
  { userId: "a", name: "Admin", guest: false, admin: true, firstSeen: at(2026, 5, 2), lastSeen: NOW - 1000, country: "PL", city: "Warsaw", browser: "Safari", system: "macOS", device: "desk", space: 41 * 1024 * 1024 },
  { userId: "g14", name: "Guest 14", guest: true, admin: false, firstSeen: at(2026, 9, 17, 9, 12), lastSeen: at(2026, 9, 17, 9, 40), country: "DE", city: "Berlin", browser: "Chrome", system: "Android", device: "phone", space: 12 * 1024 },
  { userId: "g13", name: "Guest 13", guest: true, admin: false, firstSeen: at(2026, 9, 16, 20), lastSeen: at(2026, 9, 16, 21), country: "US", city: "", browser: "Firefox", system: "Windows", device: "desk", space: 0 },
  { userId: "g9", name: "Guest 9", guest: true, admin: false, firstSeen: at(2025, 9, 12), lastSeen: at(2025, 9, 12), country: "", city: "", space: 4096 },
];
const SPENDING = {
  allGuests: { spent: 2.5, limit: 10 },
  guest: 1,
  providers: [
    { id: "jev", label: "Jev by typesafe.ai", spent: 0.12, limit: null, guestKeySet: true, price: "" },
    { id: "anthropic", label: "Anthropic", spent: 3.3, limit: 5, guestKeySet: true, price: "" },
  ],
  guests: [
    { userId: "g13", spent: 1, blocked: false },
    { userId: "g14", spent: 0.32, blocked: false },
    { userId: "g9", spent: 0.001, blocked: true },
  ],
};

test("moments, money, space, place and device read as people say them", () => {
  assert.deepEqual(
    [NOW - 1000, at(2026, 9, 17, 9, 12), at(2026, 9, 16, 23), at(2026, 9, 12), at(2025, 5, 2), 0].map((t) => whenOf(t, NOW)),
    ["now", "today 09:12", "yesterday", "Oct 12", "Jun 2025", "—"],
  );
  assert.deepEqual([0, 0.001, 0.32, 1].map(moneyOf), ["$0.00", "<$0.01", "$0.32", "$1.00"]);
  assert.deepEqual([0, 500, 12 * 1024, 2.5 * 1024 * 1024, 41 * 1024 * 1024].map(spaceOf), ["0 KB", "500 B", "12 KB", "2.5 MB", "41 MB"]);
  assert.deepEqual(PEOPLE.map(whereOf), ["Warsaw, PL", "Berlin, DE", "US", "—"]);
  assert.deepEqual(PEOPLE.map(deviceOf), ["Safari · macOS · desk", "Chrome · Android · phone", "Firefox · Windows · desk", "—"]);
});

test("the tiles: all guests of their limit, each provider's guest key, and the guests", () => {
  assert.deepEqual(tilesOf(SPENDING, PEOPLE, NOW), [
    { title: "All guests", big: "$2.50", of: "of $10.00", share: 0.25 },
    { title: "Jev by typesafe.ai", big: "$0.12", sub: "on the guest key" },
    { title: "Anthropic", big: "$3.30", sub: "of $5.00, on the guest key" },
    { title: "Guests", big: "3", sub: "1 today · 1 blocked" },
  ]);
  assert.deepEqual(tilesOf(null, PEOPLE, NOW), [{ title: "Guests", big: "3", sub: "1 today" }]);
});

test("the rows: you first on your own keys, then each guest's use against its limit", () => {
  const rows = rowsOf(PEOPLE, SPENDING, NOW);
  assert.deepEqual(rows.map((r) => [r.who, r.look]), [
    ["You · admin", "you"],
    ["Guest 14", "plain"],
    ["Guest 13", "plain"],
    ["Guest 9 · blocked", "blocked"],
  ]);
  assert.deepEqual(rows.map((r) => r.used), [
    { own: true },
    { spent: "$0.32", share: 0.32, out: false },
    { spent: "$1.00", share: 1, out: true },
    { spent: "<$0.01", share: 0.001, out: false },
  ]);
  assert.deepEqual(rows.map((r) => r.space), ["41 MB", "12 KB", "0 KB", "4 KB"]);
  assert.equal(rowsOf(PEOPLE, null, NOW)[1].used, null, "without the spending a guest's use is unknown");
});

test("it asks only once shown, again each time, and follows both events after", async () => {
  const asked = [];
  const answers = { "session people": { people: PEOPLE }, "llm spending": SPENDING };
  const actor = createActor(machine, { input: { ask: async (t, n) => (asked.push(t + " " + n), answers[t + " " + n]) } }).start();
  await flush();
  assert.deepEqual(asked, [], "nobody asks while the part is not shown");
  actor.send({ type: "_shown" });
  await flush();
  assert.deepEqual(asked, ["session people", "llm spending"]);
  assert.equal(actor.getSnapshot().context.people.length, 4);
  actor.send({ type: "_shown" });
  await flush();
  assert.equal(asked.length, 4, "each opening reads the latest");

  actor.send({ type: "people.changed", people: PEOPLE.slice(0, 2) });
  actor.send({ type: "spending.changed", ...SPENDING, guest: 2 });
  assert.equal(actor.getSnapshot().context.people.length, 2);
  assert.equal(actor.getSnapshot().context.spending.guest, 2);
});

test("a refusal leaves the part saying the people could not be read", async () => {
  const actor = createActor(machine, { input: { ask: async () => ({ error: "not-admin" }) } }).start();
  actor.send({ type: "_shown" });
  await flush();
  assert.equal(actor.getSnapshot().context.people, null);
  assert.equal(actor.getSnapshot().context.failed, true);
});

test("a guest row offers its actions, and each is the admin's gesture on the bus (12)", () => {
  const rows = rowsOf(PEOPLE, SPENDING, NOW);
  assert.deepEqual(rows.map((r) => r.guest), PEOPLE.map((p) => Boolean(p.guest) && !p.admin));
  const out = [];
  const actor = createActor(machine, { input: { ask: async () => ({ error: "not-admin" }) } });
  for (const type of ["viewas.requested", "use.reset", "guest.blocked"]) actor.on(type, (e) => out.push(e));
  actor.start();
  actor.send({ type: "_viewAs", user: "g14" });
  actor.send({ type: "_reset", user: "g14" });
  actor.send({ type: "_block", user: "g14", blocked: true });
  assert.deepEqual(out, [
    { type: "viewas.requested", user: "g14" },
    { type: "use.reset", user: "g14" },
    { type: "guest.blocked", user: "g14", blocked: true },
  ]);
});

test("Delete hides the guest at once and waits out its Undo; Undo brings the row back (12)", () => {
  const emitted = [];
  const actor = createActor(machine, { input: { ask: async () => ({ error: "no" }) } });
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  actor.send({ type: "people.changed", people: PEOPLE });
  actor.send({ type: "_delete", user: "g14", name: "Guest 14" });
  assert.deepEqual(emitted, [{ type: "removal.started", kind: "guest", id: "g14", name: "Guest 14" }]);
  const { people, deleting } = actor.getSnapshot().context;
  const shown = shownOf(people, deleting);
  assert.deepEqual(shown.map((p) => p.userId), ["a", "g13", "g9"]);
  assert.equal(tilesOf(null, shown, NOW).at(-1).big, "2", "the Guests count leaves it out");
  actor.send({ type: "removal.undone", kind: "evaluator", id: "g14" });
  assert.equal(shownOf(actor.getSnapshot().context.people, actor.getSnapshot().context.deleting).length, 3);
  actor.send({ type: "removal.undone", kind: "guest", id: "g14" });
  assert.equal(shownOf(actor.getSnapshot().context.people, actor.getSnapshot().context.deleting).length, 4);
});

test("Can sync is a switch on every passkey account, yours included, never a guest's; it moves at once and says so on the bus (3.4)", () => {
  const people = [{ ...PEOPLE[0], sync: false }, { userId: "k", name: "Account", guest: false, admin: false, sync: true }, PEOPLE[1]];
  assert.deepEqual(rowsOf(people, SPENDING, NOW).map((r) => r.sync), [false, true, null]);
  assert.equal(rowsOf([PEOPLE[0]], SPENDING, NOW)[0].sync, false, "off when the server says nothing");
  const emitted = [];
  const actor = createActor(machine, { input: { ask: async () => ({ error: "no" }) } });
  actor.on("sync.allowed", (e) => emitted.push(e));
  actor.start();
  actor.send({ type: "people.changed", people });
  actor.send({ type: "_sync", user: "a", allowed: true });
  assert.equal(actor.getSnapshot().context.people[0].sync, true);
  actor.send({ type: "_sync", user: "a", allowed: false });
  assert.equal(actor.getSnapshot().context.people[0].sync, false, "pressing it again undoes it");
  assert.deepEqual(emitted, [
    { type: "sync.allowed", user: "a", allowed: true },
    { type: "sync.allowed", user: "a", allowed: false },
  ]);
  // session's news carries no Can sync, so each row keeps the switch it shows.
  actor.send({ type: "people.changed", people: people.map(({ sync, ...p }) => p) });
  assert.deepEqual(actor.getSnapshot().context.people.map((p) => p.sync), [false, true, undefined]);
});

test("a refused gesture reads the list again, so the switches show what the registry holds", async () => {
  const asked = [];
  const answers = { "session people": { people: PEOPLE }, "llm spending": SPENDING };
  const actor = createActor(machine, { input: { ask: async (t, n) => (asked.push(t + " " + n), answers[t + " " + n]) } }).start();
  actor.send({ type: "session.refused", reason: "unavailable" });
  await flush();
  assert.deepEqual(asked, [], "nothing to correct before the list was read");
  actor.send({ type: "_shown" });
  await flush();
  actor.send({ type: "session.refused", reason: "unavailable" });
  await flush();
  assert.equal(asked.length, 4);
});

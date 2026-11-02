import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the first part of the People tab (12). It owns no fact: the
// accounts belong to `session` and what guests spent to `llm`, each reached by one query
// for the starting picture and its event after (4.3, fourth rule). It asks only once it
// is shown (`_shown`, sent by the view), so nobody but the admin, the one account the
// sheet shows it to, ever asks, and each opening of the tab reads the latest. The ask
// arrives through `input`, so the machine imports in Node.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 24 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");
const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// A moment as people read it, against now: "now", "today 09:12", "yesterday", "Oct 12",
// or "Jun 2025" for an earlier year. Local time, the admin's own.
export const whenOf = (ms, now) => {
  if (!ms) return "—";
  if (now - ms < 2 * 60 * 1000) return "now";
  const at = new Date(ms);
  const today = new Date(now);
  if (sameDay(at, today)) return `today ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (sameDay(at, new Date(now - DAY))) return "yesterday";
  if (at.getFullYear() === today.getFullYear()) return `${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return `${MONTHS[at.getMonth()]} ${at.getFullYear()}`;
};

// Dollars with cents; a use too small to show as a cent still reads as something.
export const moneyOf = (dollars) => (dollars > 0 && dollars < 0.005 ? "<$0.01" : `$${(dollars || 0).toFixed(2)}`);

// Bytes as people read them.
export const spaceOf = (bytes) => {
  if (!bytes) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
};

export const whereOf = (p) => [p.city, p.country].filter(Boolean).join(", ") || "—";
export const deviceOf = (p) => [p.browser, p.system, p.device].filter(Boolean).join(" · ") || "—";

const share = (spent, limit) => (limit > 0 ? Math.min(1, spent / limit) : spent > 0 ? 1 : 0);

// The tiles over the table: all guests against their limit, each provider's guest key,
// and the number of guests, with how many came today and how many are blocked.
export const tilesOf = (spending, people, now) => {
  const tiles = [];
  if (spending) {
    const { spent, limit } = spending.allGuests;
    tiles.push({ title: "All guests", big: moneyOf(spent), of: `of ${moneyOf(limit)}`, share: share(spent, limit) });
    for (const p of spending.providers) {
      const sub = !p.guestKeySet
        ? "no guest key"
        : p.limit == null
          ? "on the guest key"
          : `of ${moneyOf(p.limit)}, on the guest key`;
      tiles.push({ title: p.label, big: moneyOf(p.spent), sub });
    }
  }
  if (people) {
    const guests = people.filter((p) => p.guest);
    const today = guests.filter((p) => sameDay(new Date(p.firstSeen), new Date(now))).length;
    // A deleted guest still on the spending list until its delete can no longer be
    // undone (3.4) is not one of the guests counted.
    const blocked = (spending?.guests ?? []).filter((g) => g.blocked && guests.some((p) => p.userId === g.userId)).length;
    tiles.push({ title: "Guests", big: String(guests.length), sub: `${today} today` + (blocked ? ` · ${blocked} blocked` : "") });
  }
  return tiles;
};

// One table row per account, in the order session gives (the admin first, then guests
// newest first). An account with a passkey spends on its own keys; a guest's use is shown
// against the limit for each guest, full and in the danger colour once it is reached.
export const rowsOf = (people, spending, now) =>
  (people ?? []).map((p) => {
    const g = spending?.guests.find((x) => x.userId === p.userId);
    const blocked = Boolean(g?.blocked);
    let used;
    if (!p.guest) used = { own: true };
    else if (!spending) used = null;
    else {
      const spent = g?.spent ?? 0;
      const s = share(spent, spending.guest);
      used = { spent: moneyOf(spent), share: s, out: s >= 1 };
    }
    return {
      userId: p.userId,
      // Only a guest row offers View as, Reset use, and Block or Unblock (12).
      guest: Boolean(p.guest) && !p.admin,
      // Every passkey account, the admin's own included, has a Can sync switch (3.4);
      // a guest has none.
      sync: p.guest ? null : Boolean(p.sync),
      blocked,
      who: p.admin ? "You · admin" : blocked ? `${p.name} · blocked` : p.name,
      look: p.admin ? "you" : blocked ? "blocked" : "plain",
      firstSeen: whenOf(p.firstSeen, now),
      lastSeen: whenOf(p.lastSeen, now),
      where: whereOf(p),
      device: deviceOf(p),
      used,
      space: spaceOf(p.space),
    };
  });

const ok = (reply) => reply && !reply.error;

// The guest's name as the row shows it rides Block and Reset use, so Undo can name it.
const named = (event) => (typeof event.name === "string" && event.name ? { name: event.name } : {});

// The accounts to show: a guest being deleted is left out until session's new list
// says it is gone, so the row and the Guests count read as gone at once (12).
export const shownOf = (people, deleting) => people && people.filter((p) => !deleting.includes(p.userId));

export const machine = setup({
  actors: {
    read: fromPromise(({ input }) =>
      Promise.all([input.ask("session", "people", {}), input.ask("llm", "spending", {})]),
    ),
  },
}).createMachine({
  id: "people-list",
  meta: {
    description:
      "The first part of the People tab of the gear's sheet, shown only to the admin. At the top, tiles " +
      "show what all guests spent of their limit, what each provider's guest key spent, " +
      "and how many guests there are. Below, a table lists every account: you as admin " +
      "first, then guests newest first, each with when they were first and last seen, " +
      "where they are, their browser, system and phone or desk, what they used as a " +
      "small bar and in dollars, and the space their work takes. Each guest row offers " +
      "View as, Reset use, Block or Unblock, and Delete, each at once. Delete hides the row, " +
      "signs the guest out and shows the short notice with Undo, which brings the guest back " +
      "as it was; its account, work and spending are removed only once that delete can no " +
      "longer be undone. Reset use, Block, Unblock, Delete and the Can sync switch are each a " +
      "step Undo takes back, and View as is reversed by Back to you. Every account with a " +
      "passkey, yours included, has a Can sync switch, off at first, which says whether that " +
      "account may connect a Mac app to its work on the web; it moves at once when pressed, " +
      "and pressing it again undoes it too. Turning it " +
      "off stops the account's connected Macs from syncing. The table scrolls sideways " +
      "on a narrow screen, and the Who column stays in view while it does.",
    kind: "view",
    emits: ["viewas.requested", "guest.blocked", "use.reset", "removal.settled", "sync.allowed"],
    attributes: [],
    asks: ["session: people", "llm: spending"],
  },
  context: ({ input }) => ({ ask: input.ask, people: null, spending: null, failed: false, deleting: [] }),
  initial: "hidden",
  states: {
    hidden: { on: { _shown: "reading" } },
    reading: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "ready",
          actions: assign(({ event }) => {
            const [people, spending] = event.output;
            return {
              people: ok(people) ? people.people : null,
              spending: ok(spending) ? spending : null,
              failed: !ok(people),
            };
          }),
        },
        onError: { target: "ready", actions: assign({ failed: true }) },
      },
    },
    ready: { on: { _shown: "reading" } },
  },
  on: {
    // The admin's actions on a guest row (12), each the admin's own gesture (4.3, fifth
    // rule): session hands the browser over or deletes, llm blocks or resets, and the fact
    // records each as a step (12, Undo); View as is reversed by Back to you.
    _viewAs: { actions: emit(({ event }) => ({ type: "viewas.requested", user: event.user })) },
    _reset: { actions: emit(({ event }) => ({ type: "use.reset", user: event.user, ...named(event) })) },
    _block: { actions: emit(({ event }) => ({ type: "guest.blocked", user: event.user, blocked: event.blocked, ...named(event) })) },
    // Can sync (3.4): the switch moves at once, and session's new list confirms it or,
    // if the change could not be saved, puts it back. Pressing it again is the undo.
    _sync: {
      actions: [
        assign({
          people: ({ context, event }) =>
            context.people && context.people.map((p) => (p.userId === event.user ? { ...p, sync: event.allowed } : p)),
        }),
        emit(({ event }) => ({ type: "sync.allowed", user: event.user, allowed: event.allowed })),
      ],
    },
    // Delete happens at once (12, Undo): session marks the guest deleted and records the
    // step; its new list brings the row back after an Undo.
    _delete: {
      actions: [
        assign({ deleting: ({ context, event }) => [...context.deleting, event.user] }),
        emit(({ event }) => ({ type: "removal.settled", kind: "guest", id: event.user })),
      ],
    },
    "people.changed": { actions: assign({ people: ({ event }) => event.people, failed: false, deleting: [] }) },
    // A gesture session could not honour, Can sync or a Delete among them: read the list
    // again, so the rows and switches show what the registry holds.
    "session.refused": { guard: ({ context }) => context.people !== null, target: ".reading", actions: assign({ deleting: [] }) },
    "spending.changed": {
      actions: assign({
        spending: ({ event }) => ({
          allGuests: event.allGuests,
          guest: event.guest,
          providers: event.providers,
          guests: event.guests,
        }),
      }),
    },
  },
});

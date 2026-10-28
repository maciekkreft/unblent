import { setup, assign, enqueueActions, fromPromise } from "xstate";

// The local-only fact that owns the steps Undo and Redo walk (12, Undo). The fact that
// owns a record records each step (step.recorded), because only it knows the state
// before; this fact only keeps them in order and says which one to apply next
// (step.undone, step.redone), moving its place once the owner says it applied
// (step.settled). One list per account in this browser, since a step names one account's
// record; it asks session: read and follows session.changed. The store, the ask and the
// word to other tabs arrive through `input`, so the machine is importable in Node.

// The steps kept per account (12): older ones are dropped, and their owner told.
export const MAX_STEPS = 100;
// How long an owner has to answer before the step counts as unreachable: an owner on the
// page answers at once, so silence means it is not on this page.
export const WAIT_MS = 2000;
// The key of the steps made while no one is signed in.
const SIGNED_OUT = "";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const OWNER = /^[a-z][a-z0-9-]*$/;
const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

const stepOf = (s) =>
  isObject(s) && ULID.test(s.id) && OWNER.test(s.owner) && typeof s.label === "string" && s.label && isObject(s.undo) && isObject(s.redo)
    ? { id: s.id, owner: s.owner, label: s.label, undo: s.undo, redo: s.redo }
    : null;
const stepsOf = (list) => (Array.isArray(list) ? list.map(stepOf).filter(Boolean) : []);

// What the store holds for an account, read defensively: a damaged record is no steps
// rather than a failed fact.
export const listsOf = (stored) => ({ undo: stepsOf(stored?.undo).slice(-MAX_STEPS), redo: stepsOf(stored?.redo) });

const EMPTY = { undo: [], redo: [] };

// The top of each list (the last item) as Undo and Redo name it.
const top = (list) => (list.length ? { id: list.at(-1).id, label: list.at(-1).label } : null);
export const pictureOf = (lists) => ({ undo: top(lists.undo), redo: top(lists.redo) });

const accountOf = (picture) => (typeof picture?.userId === "string" && picture.userId ? picture.userId : SIGNED_OUT);

// A step recorded. An id already in the undo list keeps its place and its undo and takes
// the new label and redo: one stretch of typing is one step, and it does not empty the
// redo list. Any other step is new: it goes on top and empties the redo list, and the
// oldest step past MAX_STEPS is dropped.
export function recorded(lists, step) {
  const at = lists.undo.findIndex((s) => s.id === step.id);
  if (at >= 0) {
    const undo = lists.undo.map((s, i) => (i === at ? { ...s, label: step.label, redo: step.redo } : s));
    return { lists: { undo, redo: lists.redo }, dropped: [] };
  }
  const undo = [...lists.undo, step];
  const dropped = undo.length > MAX_STEPS ? undo.splice(0, undo.length - MAX_STEPS) : [];
  return { lists: { undo, redo: [] }, dropped };
}

// The owner's answer for the step on top of `direction`'s list. Applied moves it to the
// top of the other list; refused drops it, so the next Undo goes on to the one before.
export function settled(lists, direction, id, outcome) {
  const from = direction === "undo" ? "undo" : "redo";
  const to = from === "undo" ? "redo" : "undo";
  const step = lists[from].at(-1);
  if (!step || step.id !== id) return lists;
  if (outcome === "applied") return { [from]: lists[from].slice(0, -1), [to]: [...lists[to], step] };
  if (outcome === "refused") return { [from]: lists[from].slice(0, -1), [to]: lists[to] };
  return lists;
}

// Keeps, writes and announces a changed list; the other tabs are told to read it again.
function keep(context, lists, enqueue) {
  const account = context.account;
  enqueue.assign({ lists, seq: context.seq + 1 });
  enqueue(() =>
    Promise.resolve(context.store.write(account, lists))
      .then(() => context.tell?.(account))
      .catch(() => {}),
  );
  announce(context, lists, enqueue);
}

// undo.changed only when what Undo or Redo would name changes.
function announce(context, lists, enqueue) {
  const picture = pictureOf(lists);
  if (JSON.stringify(picture) === JSON.stringify(context.shown)) return;
  enqueue.assign({ shown: picture });
  enqueue.emit({ type: "undo.changed", ...picture });
}

function record(context, event, enqueue) {
  const step = stepOf(event);
  if (!step) return;
  const { lists, dropped } = recorded(context.lists, step);
  keep(context, lists, enqueue);
  for (const s of dropped) enqueue.emit({ type: "step.dropped", id: s.id, owner: s.owner, payload: s.redo });
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });
const QUEUED = Object.fromEntries(["read?", "step.recorded", "step.requested"].map((t) => [t, { actions: queue }]));

// Another account holds the browser now; the news that it is about to (leaving) is not it.
const switches = ({ context, event }) => event.leaving !== true && accountOf(event) !== context.account;

export const machine = setup({
  actors: {
    // A page without session is answered no-answerer, and its steps are the signed-out ones.
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
    // `seq` rides along so a read that started before a local change is not adopted over it.
    read: fromPromise(async ({ input }) => ({ lists: listsOf(await input.store.read(input.account)), seq: input.seq })),
  },
  delays: {
    wait: ({ context }) => context.waitMs,
  },
}).createMachine({
  id: "undo",
  meta: {
    description:
      "Owns the steps Undo and Redo walk: the last 100 changes the user made to their own " +
      "data, per account, in this browser. A step is recorded by the fact that owns the " +
      "record (step.recorded), since only it knows the state before; recording an id already " +
      "in the list replaces its label and redo and keeps its undo and its place, which is how " +
      "one stretch of typing stays one step, and any other step goes on top and empties the " +
      "redo list. The oldest step past 100 is dropped and its owner told (step.dropped). " +
      "Asked to undo or redo (step.requested), it reads the list again, since another tab may " +
      "have changed it, and names the step on top to its owner (step.undone, step.redone), " +
      "one at a time; the owner answers (step.settled). Applied moves the step to the other " +
      "list; refused, because the record changed since, drops it, so the next Undo goes on " +
      "to the one before; with no answer within 2 seconds the owner is not on this page, and " +
      "it says so itself (unreachable) and leaves the step where it was. `undo: read` and " +
      "undo.changed say what Undo and Redo would name now. The steps are kept in IndexedDB, " +
      "one list per account and one for signed out, shared by every tab of the browser, " +
      "which re-reads it when another tab changes it, and kept across a reload; the browser " +
      "changing account switches to that account's list.",
    kind: "fact",
    shape: "local-only",
    emits: ["step.undone", "step.redone", "step.settled", "step.dropped", "undo.changed"],
    asks: ["session: read"],
    owns: "the steps Undo and Redo walk, per account in this browser",
  },
  context: ({ input }) => ({
    store: input.store,
    ask: input.ask,
    tell: input.tell,
    waitMs: input.waitMs ?? WAIT_MS,
    account: SIGNED_OUT,
    lists: EMPTY,
    // What undo.changed last said, so a change that names the same steps says nothing.
    shown: pictureOf(EMPTY),
    // Counts local changes, so a read that began before one is not adopted over it.
    seq: 0,
    // Messages that arrived before the list was read, handled after.
    queued: [],
    // Requests waiting while one step is out with its owner.
    requests: [],
    // The step out with its owner: { id, owner, direction }.
    pending: null,
  }),
  initial: "starting",
  states: {
    starting: {
      invoke: {
        src: "session",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: { target: "loading", actions: assign({ account: ({ event }) => accountOf(event.output) }) },
        onError: { target: "loading" },
      },
      on: {
        ...QUEUED,
        "session.changed": { guard: switches, actions: assign({ account: ({ event }) => accountOf(event) }) },
      },
    },
    loading: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ store: context.store, account: context.account, seq: context.seq }),
        onDone: {
          target: "ready",
          actions: enqueueActions(({ context, event, enqueue }) => {
            enqueue.assign({ lists: event.output.lists });
            announce(context, event.output.lists, enqueue);
          }),
        },
        onError: {
          target: "ready",
          actions: enqueueActions(({ context, enqueue }) => {
            enqueue.assign({ lists: EMPTY });
            announce(context, EMPTY, enqueue);
          }),
        },
      },
      on: {
        ...QUEUED,
        "session.changed": { guard: switches, target: "loading", reenter: true, actions: assign({ account: ({ event }) => accountOf(event) }) },
      },
    },
    ready: {
      entry: enqueueActions(({ context, enqueue }) => {
        for (const message of context.queued) enqueue.raise(message);
        enqueue.assign({ queued: [] });
      }),
      on: {
        "read?": { actions: ({ context, event }) => event.reply(pictureOf(context.lists)) },
        "step.recorded": { actions: enqueueActions(({ context, event, enqueue }) => record(context, event, enqueue)) },
        "step.requested": {
          guard: ({ event }) => event.direction === "undo" || event.direction === "redo",
          actions: assign({ requests: ({ context, event }) => [...context.requests, event.direction] }),
        },
        // The browser changed account: that account's list, and nothing left out with an owner.
        "session.changed": {
          guard: switches,
          target: "loading",
          actions: assign({ account: ({ event }) => accountOf(event), requests: [], pending: null, lists: EMPTY }),
        },
      },
      initial: "idle",
      states: {
        idle: {
          always: { guard: ({ context }) => context.requests.length > 0, target: "reading" },
          // Another tab changed the list.
          on: { _reread: { target: "refreshing" } },
        },
        refreshing: {
          invoke: {
            src: "read",
            input: ({ context }) => ({ store: context.store, account: context.account, seq: context.seq }),
            onDone: {
              target: "idle",
              actions: enqueueActions(({ context, event, enqueue }) => {
                if (event.output.seq !== context.seq) return;
                enqueue.assign({ lists: event.output.lists });
                announce(context, event.output.lists, enqueue);
              }),
            },
            onError: { target: "idle" },
          },
        },
        // The list is read again before a step is applied, since another tab may have
        // moved it; then the step on top goes to its owner.
        reading: {
          invoke: {
            src: "read",
            input: ({ context }) => ({ store: context.store, account: context.account, seq: context.seq }),
            onDone: {
              target: "choosing",
              actions: enqueueActions(({ context, event, enqueue }) => {
                if (event.output.seq !== context.seq) return;
                enqueue.assign({ lists: event.output.lists });
                announce(context, event.output.lists, enqueue);
              }),
            },
            onError: { target: "choosing" },
          },
        },
        choosing: {
          always: [
            {
              guard: ({ context }) => context.lists[context.requests[0]].length > 0,
              target: "waiting",
              actions: enqueueActions(({ context, enqueue }) => {
                const [direction, ...rest] = context.requests;
                const step = context.lists[direction].at(-1);
                enqueue.assign({ requests: rest, pending: { id: step.id, owner: step.owner, direction } });
                enqueue.emit({
                  type: direction === "undo" ? "step.undone" : "step.redone",
                  id: step.id,
                  owner: step.owner,
                  payload: direction === "undo" ? step.undo : step.redo,
                });
              }),
            },
            // Nothing to undo or redo: the request is spent.
            { target: "idle", actions: assign({ requests: ({ context }) => context.requests.slice(1) }) },
          ],
        },
        waiting: {
          on: {
            "step.settled": {
              guard: ({ context, event }) => event.id === context.pending?.id && event.outcome !== "unreachable",
              target: "idle",
              actions: enqueueActions(({ context, event, enqueue }) => {
                const { direction, id } = context.pending;
                enqueue.assign({ pending: null });
                keep(context, settled(context.lists, direction, id, event.outcome), enqueue);
              }),
            },
          },
          // No owner answered: the step stays, and the requests made after it are dropped,
          // since each would wait on the same step again.
          after: {
            wait: {
              target: "idle",
              actions: enqueueActions(({ context, enqueue }) => {
                const { id, owner } = context.pending;
                enqueue.assign({ pending: null, requests: [] });
                enqueue.emit({ type: "step.settled", id, owner, outcome: "unreachable" });
              }),
            },
          },
        },
      },
    },
  },
});

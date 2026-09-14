// The bus (architecture.md 3.3, 4): the one shared infrastructure that routes
// events and queries between component actors and validates their names. It
// keeps no log; facts live in fact components. Pure module — no `document` — so
// it imports in Node as well as the browser. Machines never import this; a fact
// component's `fact.js` mounts its actor here, so `machine.js` stays importable
// anywhere (3.2).
import { createActor } from "xstate";
import { ulid } from "ulid";

const mounted = new Map(); // id → actor, so a second mount of an id can be refused
const machines = new Map(); // id → machine, so `ask` can read the target's kind and handlers
const registry = new Map(); // event name → schema, so every emit is validated (3.3)
const queryRegistry = new Map(); // "target: name" → { payload, reply }, so every query is validated (3.3, 7.2)
const subscribers = new Map();

// Section 3.3, 10: the bus's one tap. A listener is called synchronously with a
// record of every routing decision. The bus still keeps nothing; the `trace` fact
// component keeps the records. `seq` orders records within this tab (its module).
const taps = new Set();
let nextSeq = 0;
const UNANSWERED_MS = 5000;

export function tap(listener) {
  taps.add(listener);
  return () => taps.delete(listener);
}

// A record's place in the transcript is the moment its routing decision was made,
// so `seq` and `at` are reserved before delivery, while the rest (each recipient's
// resulting state) is known only after. A recipient that emits while handling a
// message makes a nested decision: it completes first, but it is the consequence,
// so records finished inside a delivery wait until the outermost delivery is done
// and then reach the taps in `seq` order (section 10: an ordered transcript).
let depth = 0;
const pending = [];

function reserve() {
  return { seq: nextSeq++, at: Date.now() };
}

// Fills the defaults for anything a caller leaves out and the reserved place (or
// reserves one now, for a decision with no delivery), then hands the record to
// every tap once no delivery is open. A record is never mutated after.
function record(partial, place = reserve()) {
  pending.push({ ignored: [], reason: null, cid: null, ...partial, ...place });
  if (depth > 0) return;
  const batch = pending.splice(0).sort((a, b) => a.seq - b.seq);
  for (const full of batch) for (const listener of taps) listener(full);
}

// Runs `deliver` as one open delivery, so records made inside it are held.
function delivering(deliver) {
  depth++;
  try {
    deliver();
  } finally {
    depth--;
  }
}

// The id a mounted actor answers to (4.1), for a record's `to`. Only mounted
// actors reach a tap, so the lookup always resolves.
function idOf(actor) {
  for (const [id, a] of mounted) if (a === actor) return id;
  return null;
}

// The sender's kind (3.1), for a record's `fromKind` (7.1): it lets the trace tell
// a view's gesture from a fact's fact without asking the manifest (4.3, fifth rule).
function kindOf(machine) {
  return machine.config.meta?.kind;
}

function subscribe(name, actor) {
  let set = subscribers.get(name);
  if (!set) subscribers.set(name, (set = new Set()));
  set.add(actor);
}

// Runs inside the emitter's `actor.on("*")` listener. A throw here surfaces as an
// uncaught error (XState rethrows listener errors asynchronously), which is the
// point: an undeclared or unknown emit must fail loudly, not pass silently.
function forward(machine, emitter, event) {
  const name = event.type;
  const from = machine.config.id;
  const emits = machine.config.meta?.emits ?? [];
  // A refused emit is recorded before it throws (section 10: refusals are traffic
  // too), so the transcript shows the failure the same way it shows a delivery.
  const fromKind = kindOf(machine);
  if (!emits.includes(name)) {
    record({ kind: "event", name, from, fromKind, to: [], outcome: "refused", reason: "undeclared emit", payload: event });
    throw new Error(`undeclared emit: ${machine.config.id} emitted "${name}", not in meta.emits`);
  }
  if (!registry.has(name)) {
    record({ kind: "event", name, from, fromKind, to: [], outcome: "refused", reason: "unknown event", payload: event });
    throw new Error(`unknown event: "${name}" is not in the registry`);
  }
  // Section 4.1: an event names no target; it reaches every subscriber but never
  // returns to the one that emitted it. A recipient whose current state does not
  // handle the event is `ignored` (its `can` is false); the bus still sends it, so
  // the actor, not the bus, decides (section 4, fourth rule).
  const set = subscribers.get(name);
  const recipients = set ? [...set].filter((a) => a !== emitter) : [];
  const ignored = recipients.filter((a) => !a.getSnapshot().can(event));
  const outcome =
    recipients.length === 0 ? "dropped" : ignored.length === recipients.length ? "ignored" : "delivered";
  const reason = outcome === "dropped" ? "no subscriber" : outcome === "ignored" ? "no recipient handles it" : null;
  // The record is completed after delivery, so it can carry each recipient's
  // resulting state (section 10). A throw inside a recipient must not lose it: the
  // finally writes the record, then the throw propagates so a failing handler still
  // fails loudly.
  const place = reserve();
  try {
    delivering(() => {
      for (const actor of recipients) actor.send(event);
    });
  } finally {
    record(
      {
        kind: "event",
        name,
        from,
        fromKind,
        to: recipients.map(idOf),
        ignored: ignored.map(idOf),
        outcome,
        reason,
        payload: event,
        states: Object.fromEntries(recipients.map((a) => [idOf(a), JSON.stringify(a.getSnapshot().value)])),
      },
      place,
    );
  }
}

export function mount(machine, { input, events = {}, queries = {} } = {}) {
  const id = machine.config.id;
  if (mounted.has(id)) throw new Error(`already mounted: ${id}`);
  // A declared emit reaches the bus with its schema, so the registry is complete
  // before the actor can emit anything.
  for (const name of machine.config.meta?.emits ?? []) {
    if (!(name in events)) throw new Error(`mount ${id}: no schema passed for declared emit "${name}"`);
    registry.set(name, events[name]);
  }
  // Every query the machine answers (a `name?` handler, 7.2) reaches the bus with
  // its `{ payload, reply }` schema, the same way an emit does, so a query schema
  // cannot go stale (7.2). Only a fact component answers, so only a fact registers.
  for (const type of machine.events) {
    if (!type.endsWith("?") || type.startsWith("xstate.")) continue;
    const name = type.slice(0, -1);
    const schema = queries[name];
    if (!schema || typeof schema !== "object" || !("payload" in schema) || !("reply" in schema))
      throw new Error(`mount ${id}: no { payload, reply } schema passed for answered query "${name}"`);
    queryRegistry.set(`${id}: ${name}`, schema);
  }
  const actor = createActor(machine, { input });
  // Subscriptions are derived by the 7.2 key convention: a dotted message type the
  // machine handles in any state is a bus event name; the other types are
  // commands, queries, or internal messages. XState's own `xstate.*` types are skipped.
  for (const name of machine.events) {
    if (name.includes(".") && !name.startsWith("xstate.")) subscribe(name, actor);
  }
  actor.on("*", (event) => forward(machine, actor, event));
  actor.start();
  mounted.set(id, actor);
  machines.set(id, machine);
  return actor;
}

export function unmount(actor) {
  actor.stop();
  for (const [id, a] of mounted) {
    if (a === actor) {
      mounted.delete(id);
      machines.delete(id);
    }
  }
  for (const set of subscribers.values()) set.delete(actor);
}

// A query (4.2): addressed to one fact component, always answered. The promise
// settles when the reply reaches the asker, so a machine consumes it through
// `fromPromise`, the function arriving through `input`. Two cases are programming
// errors and throw, like an undeclared emit: an ask the asker did not declare in
// `meta.asks`, and a query aimed at a view (4.3, rule two). Two cases are honest
// replies, because a reply always comes: nobody mounted under the target's name,
// or a target that does not handle the query.
export function ask(machine, target, name, payload = {}) {
  const asks = machine.config.meta?.asks ?? [];
  const key = `${target}: ${name}`;
  const from = machine.config.id;
  const fromKind = kindOf(machine);
  const to = [target];
  // The correlation id is a ULID (section 10), so a later trace can order and tell
  // apart queries from several tabs; the first reply wins. It is minted up front so
  // every record about this query, even a refusal, carries it.
  const cid = ulid();
  if (!asks.includes(key)) {
    record({ kind: "query", name, from, fromKind, to, outcome: "refused", reason: "undeclared ask", cid, payload });
    throw new Error(`undeclared ask: ${machine.config.id} asked "${key}", not in meta.asks`);
  }
  const answerer = mounted.get(target);
  if (!answerer) {
    record({ kind: "query", name, from, fromKind, to, outcome: "no-answerer", cid, payload });
    return Promise.resolve({ error: "no-answerer" });
  }
  const targetMachine = machines.get(target);
  if (targetMachine.config.meta?.kind !== "fact") {
    record({ kind: "query", name, from, fromKind, to, outcome: "refused", reason: "query to a view", cid, payload });
    throw new Error(`only a fact component answers queries: ${target} is a ${targetMachine.config.meta?.kind}`);
  }
  const type = `${name}?`;
  if (!targetMachine.events.includes(type)) {
    record({ kind: "query", name, from, fromKind, to, outcome: "unknown-query", cid, payload });
    return Promise.resolve({ error: "unknown-query" });
  }
  // The query's schema is registered (`queryRegistry.get(key)`); payload and reply
  // validation against it lands with the JSON Schema validator (7.2, section 10),
  // the same task that adds payload validation to events. Registration now is what
  // lets both kinds be validated together then.
  const message = { type, cid, payload };
  const handled = answerer.getSnapshot().can({ ...message, reply: () => {} });
  return new Promise((resolve) => {
    let answered = false;
    // A reply always comes back to the asker (4.2); the trace records it as a
    // `reply`. If none arrives within UNANSWERED_MS the trace notes `unanswered`
    // and leaves the promise pending, as today; a late reply still settles it and
    // records `replied`, reason "late".
    let timedOut = false;
    const timer = setTimeout(() => {
      if (answered) return;
      timedOut = true;
      record({ kind: "reply", name, from: target, fromKind: "fact", to: [from], outcome: "unanswered", reason: "no reply in 5s", cid, payload: null });
    }, UNANSWERED_MS);
    const reply = (value) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      record({ kind: "reply", name, from: target, fromKind: "fact", to: [from], outcome: "replied", reason: timedOut ? "late" : null, cid, payload: value });
      resolve(value);
    };
    // Completed after delivery, so it carries the answerer's resulting state
    // (section 10); its place is reserved before, so a synchronous answerer's reply,
    // made inside the send, follows the question in the transcript.
    const place = reserve();
    delivering(() => answerer.send({ ...message, reply }));
    record(
      {
        kind: "query",
        name,
        from,
        fromKind,
        to,
        ignored: handled ? [] : to,
        outcome: handled ? "asked" : "ignored",
        reason: handled ? null : `state ${JSON.stringify(answerer.getSnapshot().value)} does not handle it`,
        cid,
        payload,
        states: { [target]: JSON.stringify(answerer.getSnapshot().value) },
      },
      place,
    );
  });
}

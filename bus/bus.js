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
  const emits = machine.config.meta?.emits ?? [];
  if (!emits.includes(name))
    throw new Error(`undeclared emit: ${machine.config.id} emitted "${name}", not in meta.emits`);
  if (!registry.has(name))
    throw new Error(`unknown event: "${name}" is not in the registry`);
  const set = subscribers.get(name);
  if (!set) return;
  // Section 4.1: an event names no target; it reaches every subscriber but never
  // returns to the one that emitted it.
  for (const actor of set) {
    if (actor !== emitter) actor.send(event);
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
  if (!asks.includes(key))
    throw new Error(`undeclared ask: ${machine.config.id} asked "${key}", not in meta.asks`);
  const answerer = mounted.get(target);
  if (!answerer) return Promise.resolve({ error: "no-answerer" });
  const targetMachine = machines.get(target);
  if (targetMachine.config.meta?.kind !== "fact")
    throw new Error(`only a fact component answers queries: ${target} is a ${targetMachine.config.meta?.kind}`);
  const type = `${name}?`;
  if (!targetMachine.events.includes(type)) return Promise.resolve({ error: "unknown-query" });
  // The query's schema is registered (`queryRegistry.get(key)`); payload and reply
  // validation against it lands with the JSON Schema validator (7.2, section 10),
  // the same task that adds payload validation to events. Registration now is what
  // lets both kinds be validated together then.
  return new Promise((resolve) => {
    let answered = false;
    // The correlation id is a ULID (section 10), so a later trace can order and
    // tell apart queries from several tabs; the first reply wins.
    const cid = ulid();
    const reply = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
    };
    answerer.send({ type, cid, payload, reply });
  });
}

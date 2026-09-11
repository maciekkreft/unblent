// The bus (architecture.md 3.3, 4): the one shared infrastructure that routes
// events between component actors and validates their names. It keeps no log;
// facts live in fact components. Pure module — no `document` — so it imports in
// Node as well as the browser. Machines never import this; a fact component's
// `fact.js` mounts its actor here, so `machine.js` stays importable anywhere (3.2).
import { createActor } from "xstate";

const mounted = new Map(); // id → actor, so a second mount of an id can be refused
const registry = new Map(); // event name → schema, so every emit is validated (3.3)
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

export function mount(machine, { input, events = {} } = {}) {
  const id = machine.config.id;
  if (mounted.has(id)) throw new Error(`already mounted: ${id}`);
  // A declared emit reaches the bus with its schema, so the registry is complete
  // before the actor can emit anything.
  for (const name of machine.config.meta?.emits ?? []) {
    if (!(name in events)) throw new Error(`mount ${id}: no schema passed for declared emit "${name}"`);
    registry.set(name, events[name]);
  }
  const actor = createActor(machine, { input });
  // Subscriptions are derived: a dotted key of `on` is a bus event name; an
  // internal, camelCase key is the actor's own business.
  for (const name of Object.keys(machine.config.on ?? {})) {
    if (name.includes(".")) subscribe(name, actor);
  }
  actor.on("*", (event) => forward(machine, actor, event));
  actor.start();
  mounted.set(id, actor);
  return actor;
}

export function unmount(actor) {
  actor.stop();
  for (const [id, a] of mounted) if (a === actor) mounted.delete(id);
  for (const set of subscribers.values()) set.delete(actor);
}

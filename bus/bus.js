// The bus (architecture.md 3.3, 4): the one shared infrastructure that routes
// events, commands and queries between component actors and validates their names. It
// keeps no log; facts live in fact components. Pure module — no `document` — so
// it imports in Node as well as the browser. Machines never import this; a fact
// component's `fact.js` mounts its actor here, so `machine.js` stays importable
// anywhere (3.2).
import { createActor } from "xstate";
import { ulid } from "ulid";
import { compile } from "./validate.js";

const mounted = new Map(); // id → actor, so a second mount of an id can be refused
const machines = new Map(); // id → machine, so `ask` can read the target's kind and handlers
const registry = new Map(); // event name → schema, so every emit is validated (3.3)
const queryRegistry = new Map(); // "target: name" → { payload, reply, supersededBy }, so every query is validated (3.3, 7.2)
// Compiled validators (bus/validate.js), built once per mount beside the schemas above,
// so every message is checked with no per-message setup (3.3, 7.2). Keyed as the
// registries are: an event by name, a query's payload and reply by "target: name".
const eventValidators = new Map();
const queryPayloadValidators = new Map();
const queryReplyValidators = new Map();
// "<component>: <command>" → compiled validator for a command's payload (4.4), keyed by
// the component, not the instance, because the schema belongs to the component.
const commandValidators = new Map();
const subscribers = new Map();
// Section 4.2: while an asker's query is open, the events its schema declares as
// superseding the answer are held for that asker alone, so it sees the starting
// picture before anything that follows it. Keyed by asker id, because `ask` only
// sees `machine.config.id` and `forward` matches through `idOf`. Transient routing
// state, not an event log (3.3): a hold ends at the reply or at `unanswered`.
const holds = new Map(); // asker id → { open: Map<cid, string[]>, queue: [{ event, name, from, fromKind }] }

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

// A component's address (4.1): its name, plus `#<instance>` when a page holds more
// than one instance of a view. The instance is the page's tag `id`. A fact has one
// owner (4.3), so it cannot be instanced; the id must be a plain word so it reads in
// an address and a stored layout unambiguously.
function addressOf(machine, instance) {
  const id = machine.config.id;
  if (instance === undefined || instance === null || instance === "") return id;
  if (!/^[A-Za-z][\w-]*$/.test(instance)) throw new Error(`mount ${id}: bad instance "${instance}"`);
  if (kindOf(machine) === "fact") throw new Error(`mount ${id}: a fact has one owner, so it cannot be instanced`);
  return `${id}#${instance}`;
}

// XState hands an event as `{ type, ...fields }`; the schemas describe the fields and
// close the object without a `type`, so a copy without `type` is what is validated. The
// delivered event is never touched.
function withoutType(event) {
  const { type, ...fields } = event;
  return fields;
}

// Section 3.3, 7.2: a copy of a payload for the trace in which the value of every
// top-level property the schema marks `"x-secret": true` is replaced by a fixed
// marker. The delivered event or reply is never touched, so the receiver still gets
// the real value (7.2); only what reaches the taps — and through them the trace, the
// console and other tabs — is redacted, which is how an API key travels to `llm`
// without appearing anywhere (3.3). With no schema (an undeclared or unknown message)
// the value is left as it is, because a secret only ever rides a declared message of
// a mounted owner. A shallow copy is made lazily, so a payload with no secret field
// (the common case) is passed through untouched.
const SECRET = "[secret]";
function redact(schema, value) {
  const properties = schema?.properties;
  if (!properties || !value || typeof value !== "object") return value;
  let copy = value;
  for (const [key, sub] of Object.entries(properties)) {
    if (sub?.["x-secret"] === true && key in value) {
      if (copy === value) copy = { ...value };
      copy[key] = SECRET;
    }
  }
  return copy;
}

// A message whose shape does not match its schema, recorded as refused with a value-free
// reason: the location and the failing keyword only, never the value, so a wrong number
// or a secret (7.2) is not carried into the trace or another tab (3.3). The malformed
// payload itself is not recorded, for the same reason. `refused` is an outcome the trace
// already has, so the record's key set is unchanged. `fromKind` is passed in, as the
// caller already has it (an asker's machine need not be mounted). Printing is left to the
// call site, because an invalid emit fails by throwing instead (as an undeclared emit does).
function invalid(kind, name, from, fromKind, to, cid, error) {
  const prefix = kind === "reply" ? "invalid reply" : "invalid payload";
  record({
    kind,
    name,
    from,
    fromKind,
    to,
    outcome: "refused",
    reason: `${prefix}: ${error}`,
    cid,
    payload: null,
  });
}

// Compile one schema at mount, naming the component and the schema's key if it cannot be
// resolved, so a broken schema fails at mount rather than on the first message it meets.
function compileFor(schema, id, what) {
  try {
    return compile(schema);
  } catch (err) {
    throw new Error(`mount ${id}: cannot compile schema for ${what}: ${err.message}`);
  }
}

// The 7.2 key convention: a command is a handled message type that is neither a
// consumed event (dotted), an answered query (`?`), nor internal (`_`).
function isCommand(type) {
  return !type.includes(".") && !type.endsWith("?") && !type.startsWith("_");
}

function subscribe(name, actor) {
  let set = subscribers.get(name);
  if (!set) subscribers.set(name, (set = new Set()));
  set.add(actor);
}

// Section 4.2, the hold. `holdersOf` gives the open correlation ids under which
// `askerId` is holding event `name` (empty when none); `openHold` opens one for a
// query; `release` closes one and delivers what no other open cid still holds, in
// order; `deliverReleased` delivers one held event and records it; `dropHolds`
// discards an unmounted asker's queue.
function holdRec(askerId) {
  let h = holds.get(askerId);
  if (!h) holds.set(askerId, (h = { open: new Map(), queue: [] }));
  return h;
}

function holdersOf(askerId, name) {
  const h = holds.get(askerId);
  const cids = [];
  if (h) for (const [cid, names] of h.open) if (names.includes(name)) cids.push(cid);
  return cids;
}

function openHold(askerId, cid, names) {
  holdRec(askerId).open.set(cid, names);
}

function deliverReleased(askerId, entry, cid) {
  const actor = mounted.get(askerId);
  const can = actor ? actor.getSnapshot().can(entry.event) : false;
  const place = reserve();
  try {
    if (actor) delivering(() => actor.send(entry.event));
  } finally {
    record(
      {
        kind: "event",
        name: entry.name,
        from: entry.from,
        fromKind: entry.fromKind,
        to: [askerId],
        ignored: can ? [] : [askerId],
        outcome: can ? "delivered" : "ignored",
        reason: `released after reply ${cid}`,
        payload: redact(registry.get(entry.name), entry.event),
        states: actor ? { [askerId]: JSON.stringify(actor.getSnapshot().value) } : {},
      },
      place,
    );
  }
}

// Idempotent: a cid never opened, or already released, is a no-op. The queue is
// walked in place so an entry still held under another open cid stays and order is
// preserved.
function release(askerId, cid) {
  const h = holds.get(askerId);
  if (!h || !h.open.has(cid)) return;
  h.open.delete(cid);
  let i = 0;
  while (i < h.queue.length) {
    const entry = h.queue[i];
    if (holdersOf(askerId, entry.name).length) {
      i++;
      continue;
    }
    h.queue.splice(i, 1);
    deliverReleased(askerId, entry, cid);
  }
  if (h.open.size === 0 && h.queue.length === 0) holds.delete(askerId);
}

function dropHolds(askerId) {
  const h = holds.get(askerId);
  if (!h) return;
  for (const entry of h.queue)
    record({
      kind: "event",
      name: entry.name,
      from: entry.from,
      fromKind: entry.fromKind,
      to: [askerId],
      outcome: "dropped",
      reason: "asker unmounted while held",
      payload: redact(registry.get(entry.name), entry.event),
    });
  holds.delete(askerId);
}

// Runs inside the emitter's `actor.on("*")` listener. A throw here surfaces as an
// uncaught error (XState rethrows listener errors asynchronously), which is the
// point: an undeclared or unknown emit must fail loudly, not pass silently.
function forward(machine, emitter, event) {
  const name = event.type;
  // 4.1: the emitter's address, so an instanced view's emits carry `#<id>` and the
  // trace, the subscribers and the holds tell one instance from another.
  const from = idOf(emitter);
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
  // Section 3.3, 7.2: the payload must match the event's schema. A wrong one is refused,
  // exactly as an undeclared emit is, by recording then throwing so it fails loudly and
  // reaches no subscriber.
  const evError = eventValidators.get(name)(withoutType(event));
  if (evError) {
    invalid("event", name, from, fromKind, [], null, evError);
    throw new Error(`invalid payload: ${from} emitted "${name}": ${evError}`);
  }
  // Section 4.1: an event names no target; it reaches every subscriber but never
  // returns to the one that emitted it. A recipient whose current state does not
  // handle the event is `ignored` (its `can` is false); the bus still sends it, so
  // the actor, not the bus, decides (section 4, fourth rule). A recipient holding
  // this event (4.2) is not sent it now: it is queued and released after the reply,
  // so `ignored`, `outcome`, and `states` are computed over `sent` alone.
  const set = subscribers.get(name);
  const recipients = set ? [...set].filter((a) => a !== emitter) : [];
  const held = recipients.filter((a) => holdersOf(idOf(a), name).length);
  const sent = recipients.filter((a) => !held.includes(a));
  const ignored = sent.filter((a) => !a.getSnapshot().can(event));
  const outcome =
    recipients.length === 0 ? "dropped" : sent.length > 0 && ignored.length === sent.length ? "ignored" : "delivered";
  const base = outcome === "dropped" ? "no subscriber" : outcome === "ignored" ? "no recipient handles it" : null;
  const heldClauses = held.flatMap((a) => holdersOf(idOf(a), name).map((cid) => `held for ${idOf(a)} until reply ${cid}`));
  const reason = [base, ...heldClauses].filter(Boolean).join("; ") || null;
  for (const a of held) holdRec(idOf(a)).queue.push({ event, name, from, fromKind });
  // The record is completed after delivery, so it can carry each recipient's
  // resulting state (section 10). A throw inside a recipient must not lose it: the
  // finally writes the record, then the throw propagates so a failing handler still
  // fails loudly.
  const place = reserve();
  try {
    delivering(() => {
      for (const actor of sent) actor.send(event);
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
        payload: redact(registry.get(name), event),
        states: Object.fromEntries(sent.map((a) => [idOf(a), JSON.stringify(a.getSnapshot().value)])),
      },
      place,
    );
  }
}

export function mount(machine, { input, events = {}, queries = {}, commands = {}, instance } = {}) {
  const id = machine.config.id;
  // 4.1: the address, not the bare name, is the routing key, so two instances of one
  // view have separate mailboxes, emits and holds. Schemas below stay keyed by name
  // and by "<id>: <name>": they belong to the component, not the instance.
  const address = addressOf(machine, instance);
  if (mounted.has(address)) throw new Error(`already mounted: ${address}`);
  // A declared emit reaches the bus with its schema, so the registry is complete
  // before the actor can emit anything.
  for (const name of machine.config.meta?.emits ?? []) {
    if (!(name in events)) throw new Error(`mount ${id}: no schema passed for declared emit "${name}"`);
    registry.set(name, events[name]);
    eventValidators.set(name, compileFor(events[name], id, `event "${name}"`));
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
    // Section 4.2: each superseding event must be one this fact emits, so a hold can
    // only ever release what the fact would have announced anyway. Absent key is [].
    const superseded = schema.supersededBy ?? [];
    if (!Array.isArray(superseded))
      throw new Error(`mount ${id}: supersededBy for query "${name}" must be an array`);
    for (const ev of superseded)
      if (!(machine.config.meta?.emits ?? []).includes(ev))
        throw new Error(`mount ${id}: query "${name}" is superseded by "${ev}", not in meta.emits`);
    queryRegistry.set(`${id}: ${name}`, schema);
    queryPayloadValidators.set(`${id}: ${name}`, compileFor(schema.payload, id, `query "${name}" payload`));
    queryReplyValidators.set(`${id}: ${name}`, compileFor(schema.reply, id, `query "${name}" reply`));
  }
  // Section 4.4: the acceptor hands the bus the schema of each command it wants sent to
  // it, so every send is validated. A command whose schema is not passed is never
  // delivered, so a component that accepts commands only from its own view need pass none.
  for (const [name, schema] of Object.entries(commands)) {
    if (!isCommand(name) || !machine.events.includes(name))
      throw new Error(`mount ${id}: schema passed for command "${name}", which the machine does not accept`);
    commandValidators.set(`${id}: ${name}`, compileFor(schema, id, `command "${name}"`));
  }
  const actor = createActor(machine, { input });
  // Subscriptions are derived by the 7.2 key convention: a dotted message type the
  // machine handles in any state is a bus event name; the other types are
  // commands, queries, or internal messages. XState's own `xstate.*` types are skipped.
  for (const name of machine.events) {
    if (name.includes(".") && !name.startsWith("xstate.")) subscribe(name, actor);
  }
  actor.on("*", (event) => forward(machine, actor, event));
  // Keyed by address before start, so an event emitted during entry finds the
  // emitter's address through `idOf` (4.1), the same as one emitted afterwards.
  mounted.set(address, actor);
  machines.set(address, machine);
  actor.start();
  return actor;
}

export function unmount(actor) {
  actor.stop();
  for (const [id, a] of mounted) {
    if (a === actor) {
      dropHolds(id); // 4.2: a held event whose asker is gone is dropped, not delivered.
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
// or a target that does not handle the query. While the ask is open the bus holds
// the events the query's schema names as superseding its answer, for this asker
// alone, and releases them after the reply lands (4.2).
export function ask(machine, target, name, payload = {}, instance) {
  const asks = machine.config.meta?.asks ?? [];
  const key = `${target}: ${name}`;
  // 4.1: the asker's address, so a reply and the events held for this ask (4.2) go
  // to the instance that asked. The target is a fact and never carries an instance.
  const from = addressOf(machine, instance);
  const fromKind = kindOf(machine);
  const to = [target];
  // The correlation id is a ULID (section 10), so a later trace can order and tell
  // apart queries from several tabs; the first reply wins. It is minted up front so
  // every record about this query, even a refusal, carries it.
  const cid = ulid();
  const declared = asks.includes(key);
  // A tool ask (7.7): an asker holding the wildcard `*: tool` may ask any query whose
  // registered schema carries a `tool` entry. The input comes from a model, so a wrong
  // one is expected traffic, not a defect — its invalid-payload refusal is quiet (below).
  const viaTool = !declared && asks.includes("*: tool");
  if (!declared && !viaTool) {
    record({ kind: "query", name, from, fromKind, to, outcome: "refused", reason: "undeclared ask", cid, payload });
    throw new Error(`undeclared ask: ${machine.config.id} asked "${key}", not in meta.asks`);
  }
  const answerer = mounted.get(target);
  if (!answerer) {
    record({ kind: "query", name, from, fromKind, to, outcome: "no-answerer", cid, payload });
    return Promise.resolve({ error: "no-answerer" });
  }
  // A wildcard ask reaches a query only when that query's registered schema is a tool
  // (7.7). Any other target — a view, or an unmarked or unknown query — is an undeclared
  // ask, exactly as if the wildcard were not held; queryRegistry holds a schema only for
  // a mounted fact's answered queries, so its absence covers both cases.
  if (viaTool && !queryRegistry.get(key)?.tool) {
    record({ kind: "query", name, from, fromKind, to, outcome: "refused", reason: "undeclared ask", cid, payload });
    throw new Error(`undeclared ask: ${machine.config.id} asked "${key}", which is not a tool`);
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
  // Section 3.3, 7.2: past the exits that do not deliver, the payload must match the
  // query's schema. A wrong one is not delivered and the asker gets a reply saying so,
  // because a query always gets a reply (4.2); no hold opens for it.
  const payloadError = queryPayloadValidators.get(key)(payload);
  if (payloadError) {
    invalid("query", name, from, fromKind, to, cid, payloadError);
    // A model's proposed tool input is expected to be wrong sometimes (7.7); only a
    // component's own miswired ask is a defect worth shouting about.
    if (!viaTool) console.error(`bus: invalid query ${name}: ${payloadError}`);
    return Promise.resolve({ error: "invalid-payload" });
  }
  // Section 4.2: the hold opens only past the four non-holding exits, so a refused or
  // unanswerable query holds nothing, and it opens before the answerer is sent to,
  // so an event the answerer emits while handling this query is inside the window.
  const superseded = queryRegistry.get(key).supersededBy ?? [];
  if (superseded.length) openHold(from, cid, superseded);
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
      release(from, cid); // 4.2: no reply is coming for now, so stop holding; the promise stays pending.
    }, UNANSWERED_MS);
    const reply = (value) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      // Section 3.3, 7.2: the reply must match the query's schema. A wrong one does not
      // reach the asker, which gets `invalid-reply` instead. The answerer is never thrown
      // into, so one bad reply cannot take its actor down (4.2).
      const replyError = queryReplyValidators.get(key)(value);
      if (replyError) {
        invalid("reply", name, target, "fact", [from], cid, replyError);
        console.error(`bus: invalid reply ${name}: ${replyError}`);
        resolve({ error: "invalid-reply" });
        setTimeout(() => release(from, cid), 0);
        return;
      }
      record({ kind: "reply", name, from: target, fromKind: "fact", to: [from], outcome: "replied", reason: timedOut ? "late" : null, cid, payload: redact(queryRegistry.get(key)?.reply, value) });
      resolve(value);
      // 4.2: a macrotask always runs after XState's `fromPromise` continuation (one
      // microtask), so the asker's onDone adopts the reply before the held events
      // land. Anything emitted between resolve and here is still held until release.
      setTimeout(() => release(from, cid), 0);
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
        payload: redact(queryRegistry.get(key)?.payload, payload),
        states: { [target]: JSON.stringify(answerer.getSnapshot().value) },
      },
      place,
    );
  });
}

// A command (4.4): an instruction addressed to one mounted instance, never replied to.
// The target is an address (4.1), a bare name or `name#instance`; the declaration in
// `meta.sends` names the component, so it covers every instance of it. An undeclared
// send is a programming error and throws, like an undeclared emit or ask. Every other
// way a command can fail to arrive is recorded and dropped, because no reply is
// waiting to carry the news: nobody mounted at the address, a type the target does not
// accept, no schema passed for it at the target's mount, or a payload that does not
// match that schema (which also prints, like an invalid query payload).
export function send(machine, target, name, payload = {}, instance) {
  const sends = machine.config.meta?.sends ?? [];
  const component = target.split("#")[0];
  const key = `${component}: ${name}`;
  const from = addressOf(machine, instance);
  const fromKind = kindOf(machine);
  const to = [target];
  if (!sends.includes(key)) {
    record({ kind: "command", name, from, fromKind, to, outcome: "refused", reason: "undeclared send", payload });
    throw new Error(`undeclared send: ${machine.config.id} sent "${key}", not in meta.sends`);
  }
  const actor = mounted.get(target);
  if (!actor) {
    record({ kind: "command", name, from, fromKind, to, outcome: "dropped", reason: "nobody mounted at this address", payload });
    return;
  }
  if (!isCommand(name) || !machines.get(target).events.includes(name)) {
    record({ kind: "command", name, from, fromKind, to, outcome: "dropped", reason: "the target does not accept it", payload });
    return;
  }
  const validator = commandValidators.get(key);
  if (!validator) {
    record({ kind: "command", name, from, fromKind, to, outcome: "dropped", reason: "no schema passed for it at mount", payload });
    return;
  }
  const error = validator(payload);
  if (error) {
    invalid("command", name, from, fromKind, to, null, error);
    console.error(`bus: invalid command ${name}: ${error}`);
    return;
  }
  // `type` last, so a payload can never turn a command into a different message.
  const message = { ...payload, type: name };
  const handled = actor.getSnapshot().can(message);
  const place = reserve();
  try {
    delivering(() => actor.send(message));
  } finally {
    record(
      {
        kind: "command",
        name,
        from,
        fromKind,
        to,
        ignored: handled ? [] : to,
        outcome: handled ? "delivered" : "ignored",
        reason: handled ? null : `state ${JSON.stringify(actor.getSnapshot().value)} does not handle it`,
        payload,
        states: { [target]: JSON.stringify(actor.getSnapshot().value) },
      },
      place,
    );
  }
}

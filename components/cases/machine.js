import { setup, assign, emit, fromPromise } from "xstate";

// A local-only fact component (3.1): headless owner of the Judge cases and of the open
// case of each project. case-editor, where the user writes, emits the whole case as
// case.saved; case-list and decision-results emit case.selected; whoever shows a delete
// emits removal.started, and notice-stack emits removal.undone or removal.settled when
// the undo window ends (4.3, fifth rule). This fact keeps the cases, saves them and
// announces them whole as case.changed, and answers cases: read for the starting
// picture. It follows project.changed and drops the cases of a project that no longer
// exists; at start it asks projects: read once, which sweeps the cases of a project
// whose removal settled at load before this fact heard of it. The store and the ask
// arrive through `input`, so the machine is a pure definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);

// The example projects, copied as literals from `projects`: components never import
// each other (11.2).
const GOALS = "01K6SEED00000000000000PJ01";
const REPLIES = "01K6SEED00000000000000PJ02";

// The question and option ids the seed answers, copied as literals from `rubrics` (11.2).
const PICK = "01K6SEED00000000000000RQ01";
const GOAL = "01K6SEED00000000000000RC01";
const VALUE = "01K6SEED00000000000000RC02";
const OTHER = "01K6SEED00000000000000RC03";
const IS_GOAL = "01K6SEED00000000000000RQ02";
const IS_VALUE = "01K6SEED00000000000000RQ03";
const REPLYABLE = "01K6SEED00000000000000G6QH";

// Right answers keep only valid keys and values. One whose question or option no longer
// exists is kept, so an Undo of that removal finds it again; views ignore what does not fit.
const answersOf = (a) =>
  Object.fromEntries(
    Object.entries(a && typeof a === "object" && !Array.isArray(a) ? a : {}).filter(
      ([k, v]) => isId(k) && (v === "yes" || v === "no" || isId(v)),
    ),
  );

// A candidate in the contract shape, or null when it has no valid id or project.
export const normalise = (c) => {
  if (!c || !isId(c.id) || !isId(c.project)) return null;
  return {
    id: c.id,
    project: c.project,
    text: typeof c.text === "string" ? c.text : "",
    answers: answersOf(c.answers),
    removing: c.removing === true,
  };
};

// The example cases a first visit starts with, in the order the list shows them. `since`
// is the seed version that added a case; it stays in this file and the catch-up.
export const SEED_VERSION = 1;
const seedId = (n) => `01K6SEED00000000000000CS${String(n).padStart(2, "0")}`;

const GROUPS = [
  [GOAL, ["To have a big house.", "To win the match.", "To get good marks.", "To win friends.",
    "To lose five kilograms in weight.", "To win the race."]],
  [VALUE, ["Caring for and protecting your family.", "Playing fairly, enthusiastically and skilfully.",
    "Applying yourself fully to your studies, and exploring new ideas.",
    "To be warm, friendly, outgoing, supportive and genuine.",
    "Looking after, strengthening and maintaining your body.", "To run to the best of your ability."]],
  [OTHER, ["Paris is the capital of France.", "The kitchen tap is dripping again.",
    "What time does the train leave?", "It rained all weekend.", "Bananas are rich in potassium.",
    "The book has 312 pages."]],
];

const REPLY_CASES = [
  ["What is one tool you could not do your job without? Mine is a paper notebook.", "yes"],
  ["Our office is closed on Monday for the bank holiday.", "no"],
  ["Hot take: no meeting should ever be longer than 25 minutes.", "yes"],
  ["Here is the full list of all 40 settings and what each one does.", "no"],
];

const SOURCE = [
  ...GROUPS.flatMap(([pick, texts]) =>
    texts.map((text) => ({
      project: GOALS,
      text,
      answers: { [PICK]: pick, [IS_GOAL]: pick === GOAL ? "yes" : "no", [IS_VALUE]: pick === VALUE ? "yes" : "no" },
    })),
  ),
  ...REPLY_CASES.map(([text, right]) => ({ project: REPLIES, text, answers: { [REPLYABLE]: right } })),
].map((c, i) => ({ ...c, id: seedId(i + 1), since: 1, removing: false }));

const firstOf = (cases, project) => cases.find((c) => c.project === project && !c.removing)?.id;
const seedOpen = (cases) =>
  Object.fromEntries([GOALS, REPLIES].map((p) => [p, firstOf(cases, p)]).filter(([, id]) => id));

export const SEED = Object.freeze({ cases: SOURCE.map(normalise), open: seedOpen(SOURCE) });
const fresh = () => structuredClone(SEED);

// A list stored by an older seed version gains only the seed cases a newer version
// added, unless their id is already there; a seed case the user deleted is not brought back.
export const catchUp = (cases, version) => {
  const have = new Set(cases.map((c) => c.id));
  return [...cases, ...SOURCE.filter((s) => s.since > version && !have.has(s.id)).map(normalise)];
};

const live = (cases, project) => cases.filter((c) => c.project === project && !c.removing);

// The case that takes over from `id` in its project: the nearest one before it that is
// not itself being removed, or else the nearest after it.
const neighbour = (cases, id) => {
  const at = cases.findIndex((c) => c.id === id);
  const project = cases[at]?.project;
  return (live(cases.slice(0, at), project).at(-1) ?? live(cases.slice(at + 1), project)[0])?.id;
};

const without = (map, key) => {
  const { [key]: _, ...rest } = map;
  return rest;
};

// The open map with the case `id` moved off to its neighbour, or no open case for that
// project when it has none left.
const moveOff = (cases, open, id) => {
  const c = cases.find((x) => x.id === id);
  if (!c || open[c.project] !== id) return open;
  const next = neighbour(cases, id);
  return next ? { ...open, [c.project]: next } : without(open, c.project);
};

// What the store held, as { cases, open }: the seed when nothing is stored or it does not
// parse; an empty list stays empty, because the user deleted every case. A case still
// flagged `removing` is one whose tab closed while its undo notice showed; nothing can
// undo it now, so it is settled here, and the open case moves off it first.
export const parse = (stored) => {
  if (stored == null || stored === "") return fresh();
  try {
    const value = JSON.parse(stored);
    if (!Array.isArray(value?.cases)) return fresh();
    const seen = new Set();
    let cases = value.cases.map(normalise).filter((c) => c && !seen.has(c.id) && seen.add(c.id));
    const raw = value.open && typeof value.open === "object" ? value.open : {};
    let open = Object.fromEntries(Object.entries(raw).filter(([p, id]) => isId(p) && isId(id)));
    for (const c of cases.filter((x) => x.removing)) open = moveOff(cases, open, c.id);
    cases = cases.filter((c) => !c.removing);
    const version = Number.isInteger(value.version) ? value.version : 0;
    return { cases: catchUp(cases, version), open };
  } catch {
    return fresh();
  }
};

const body = (context) => ({ cases: context.cases, open: context.open });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Each event becomes a candidate { cases, open, wasOpen }; only one whose cases or open
// differ is saved and announced, so a repeat stores and emits nothing. `wasOpen`
// remembers which removed cases were open, so Undo can reopen them; it lives only in
// memory, because a reload settles every removal (parse above).
const change = (next) => ({
  guard: ({ context, event }) => !same(body(next(context, event)), body(context)),
  actions: [
    assign(({ context, event }) => next(context, event)),
    ({ context }) => context.save(JSON.stringify({ version: SEED_VERSION, ...body(context) })),
    emit(({ context }) => ({ type: "case.changed", ...body(context) })),
  ],
});

// A new case goes first in its project, where the list shows it; a known one is replaced
// in place and keeps its removing flag.
const saved = (context, event) => {
  const was = context.cases.find((c) => c.id === event.id);
  const c = normalise({ ...event, removing: was?.removing });
  if (!c) return context;
  if (!was) return { ...context, cases: [c, ...context.cases] };
  return { ...context, cases: context.cases.map((x) => (x.id === c.id ? c : x)) };
};

// The id may be a new case not saved yet; a case of another project, or one being
// removed, cannot be opened.
const selected = (context, { id, project }) => {
  const c = context.cases.find((x) => x.id === id);
  if (!isId(id) || !isId(project) || (c && (c.project !== project || c.removing))) return context;
  return { ...context, open: { ...context.open, [project]: id } };
};

const started = (context, { kind, id }) => {
  const c = context.cases.find((x) => x.id === id);
  if (kind !== "case" || !c || c.removing) return context;
  const wasOpen = context.open[c.project] === id;
  const cases = context.cases.map((x) => (x.id === id ? { ...x, removing: true } : x));
  return {
    cases,
    open: moveOff(context.cases, context.open, id),
    wasOpen: { ...context.wasOpen, [id]: wasOpen },
  };
};

const undone = (context, { kind, id }) => {
  const c = context.cases.find((x) => x.id === id);
  if (kind !== "case" || !c?.removing) return context;
  return {
    cases: context.cases.map((x) => (x.id === id ? { ...x, removing: false } : x)),
    open: context.wasOpen[id] ? { ...context.open, [c.project]: id } : context.open,
    wasOpen: without(context.wasOpen, id),
  };
};

const settled = (context, { kind, id }) => {
  const c = context.cases.find((x) => x.id === id);
  if (kind !== "case" || !c?.removing) return context;
  return { ...context, cases: context.cases.filter((x) => x.id !== id), wasOpen: without(context.wasOpen, id) };
};

// A project being removed is still in the list, so its cases stay until it settles.
const projectChanged = (context, { projects }) => {
  const ids = new Set(projects.map((p) => p.id));
  return {
    ...context,
    cases: context.cases.filter((c) => ids.has(c.project)),
    open: Object.fromEntries(Object.entries(context.open).filter(([p]) => ids.has(p))),
  };
};

// The start read's reply, swept like project.changed; an error reply sweeps nothing.
const projectsRead = (context, { output }) =>
  Array.isArray(output?.projects) ? projectChanged(context, output) : context;

export const machine = setup({
  actors: {
    projects: fromPromise(({ input }) => (input.ask ? input.ask("projects", "read", {}) : Promise.resolve(null))),
  },
}).createMachine({
  id: "cases",
  meta: {
    description:
      "Owns the Judge cases of every project, kept on this device. A case is a text to judge and " +
      "its right answers, one per question at most: yes or no for a yes / no question, or one of " +
      "the options for a pick-one question. A question with no right answer is judged but not " +
      "counted. A right answer is kept when its question or option is removed, so undoing the " +
      "removal brings it back. Each project remembers which case is open, which may be a new " +
      "case not yet written; a new case is kept once something is written in it, and goes first " +
      "in its project. A deleted case waits out the undo window, and while it waits its " +
      "neighbour in the list is open; Undo opens it again. The cases of a project that no " +
      "longer exists are dropped. A first visit starts with example cases and their right " +
      "answers in each example project, the first case of each open.",
    kind: "fact",
    shape: "local-only",
    owns: "the Judge cases, their right answers and the open case of each project",
    emits: ["case.changed"],
    asks: ["projects: read"],
  },
  context: ({ input }) => ({ ...parse(input.stored), wasOpen: {}, save: input.save, ask: input.ask }),
  initial: "starting",
  states: {
    starting: {
      invoke: {
        src: "projects",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [{ target: "ready", ...change(projectsRead) }, { target: "ready" }],
        onError: { target: "ready" },
      },
    },
    ready: {},
  },
  on: {
    "case.saved": change(saved),
    "case.selected": change(selected),
    "removal.started": change(started),
    "removal.undone": change(undone),
    "removal.settled": change(settled),
    "project.changed": change(projectChanged),
    "read?": {
      actions: ({ context, event }) => event.reply(body(context)),
    },
  },
});

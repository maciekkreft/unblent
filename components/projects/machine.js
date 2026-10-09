import { setup, assign, emit } from "xstate";

// A local-only fact component (3.1): headless owner of the Judge projects and of which
// one is current. project-bar, where the user acts, emits project.saved and
// project.selected; whoever shows the delete emits removal.started, and notice-stack
// emits removal.undone or removal.settled when the undo window ends (4.3, fifth rule).
// This fact keeps the list, saves it and announces it whole as project.changed, and
// answers projects: read for the starting picture. The store arrives through `input`,
// so the machine is a pure definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);

// The two projects a first visit starts with. The ids are fixed and exported, because
// rubrics and cases seed their records under the same projects; they copy these ids as
// literals, since components never import each other (11.2).
export const GOALS = "01K6SEED00000000000000PJ01";
export const REPLIES = "01K6SEED00000000000000PJ02";
export const SEED_VERSION = 1;
export const SEED = Object.freeze({
  projects: [
    { id: GOALS, name: "Goals and values", removing: false },
    { id: REPLIES, name: "Replies", removing: false },
  ],
  current: GOALS,
});
const fresh = () => ({ projects: SEED.projects.map((p) => ({ ...p })), current: SEED.current });

const live = (projects) => projects.filter((p) => !p.removing);

// The project that takes over from `id`: the nearest one before it that is not itself
// being removed, or else the nearest after it.
const neighbour = (projects, id) => {
  const at = projects.findIndex((p) => p.id === id);
  const before = live(projects.slice(0, at)).at(-1);
  return (before ?? live(projects.slice(at + 1))[0])?.id;
};

// A current id that names a live project, or the first live one.
const settleCurrent = (projects, current) =>
  live(projects).some((p) => p.id === current) ? current : live(projects)[0]?.id;

// What the store held, as { projects, current }: the seed when nothing is stored, it does
// not parse, or it holds no project. A project still flagged `removing` is one whose tab
// closed while its undo notice showed; nothing can undo it now, so it is settled here.
export const parse = (stored) => {
  if (stored == null || stored === "") return fresh();
  try {
    const value = JSON.parse(stored);
    if (!Array.isArray(value?.projects)) return fresh();
    const seen = new Set();
    const projects = value.projects
      .filter((p) => p && isId(p.id) && !p.removing && !seen.has(p.id) && seen.add(p.id))
      .map((p) => ({ id: p.id, name: typeof p.name === "string" ? p.name : "", removing: false }));
    if (!projects.length) return fresh();
    return { projects, current: settleCurrent(projects, value.current) };
  } catch {
    return fresh();
  }
};

const body = (context) => ({ projects: context.projects, current: context.current });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Each gesture becomes a candidate { projects, current, wasCurrent }; only one whose
// projects or current differ is saved and announced, so a repeat stores and emits nothing. `wasCurrent`
// remembers which project was current when its removal started, so Undo can restore it;
// it lives only in memory, because a reload settles every removal (parse above).
const change = (next) => ({
  guard: ({ context, event }) => !same(body(next(context, event)), body(context)),
  actions: [
    assign(({ context, event }) => next(context, event)),
    ({ context }) => context.save(JSON.stringify({ version: SEED_VERSION, ...body(context) })),
    emit(({ context }) => ({ type: "project.changed", ...body(context) })),
  ],
});

const saved = (context, { id, name }) => {
  if (!isId(id) || typeof name !== "string") return context;
  if (context.projects.some((p) => p.id === id))
    return { ...context, projects: context.projects.map((p) => (p.id === id ? { ...p, name } : p)) };
  return { ...context, projects: [...context.projects, { id, name, removing: false }], current: id };
};

const selected = (context, { id }) =>
  live(context.projects).some((p) => p.id === id) ? { ...context, current: id } : context;

// The last project that is not being removed cannot be removed.
const started = (context, { kind, id }) => {
  if (kind !== "project" || live(context.projects).length < 2) return context;
  if (!live(context.projects).some((p) => p.id === id)) return context;
  const wasCurrent = context.current === id;
  return {
    projects: context.projects.map((p) => (p.id === id ? { ...p, removing: true } : p)),
    current: wasCurrent ? neighbour(context.projects, id) : context.current,
    wasCurrent: { ...context.wasCurrent, [id]: wasCurrent },
  };
};

const forget = (wasCurrent, id) => {
  const { [id]: _, ...rest } = wasCurrent;
  return rest;
};

const undone = (context, { kind, id }) => {
  const p = context.projects.find((x) => x.id === id);
  if (kind !== "project" || !p?.removing) return context;
  return {
    projects: context.projects.map((x) => (x.id === id ? { ...x, removing: false } : x)),
    current: context.wasCurrent[id] ? id : context.current,
    wasCurrent: forget(context.wasCurrent, id),
  };
};

const settled = (context, { kind, id }) => {
  const p = context.projects.find((x) => x.id === id);
  if (kind !== "project" || !p?.removing) return context;
  return { ...context, projects: context.projects.filter((x) => x.id !== id), wasCurrent: forget(context.wasCurrent, id) };
};

export const machine = setup({}).createMachine({
  id: "projects",
  meta: {
    description:
      "Owns the Judge projects, kept on this device: each project has a name and its own tools, " +
      "cases and results, and one project is the current one. There is always at least one " +
      "project, so deleting the last one is refused. A deleted project waits out the undo window " +
      "before it is gone, and still exists until then, so Undo brings it back with everything in " +
      "it; while it waits, its neighbour in the list becomes the current project. A new project " +
      "becomes the current one. A first visit starts with two example projects, \"Goals and " +
      "values\" and \"Replies\".",
    kind: "fact",
    shape: "local-only",
    owns: "the projects and which one is current",
    emits: ["project.changed"],
  },
  context: ({ input }) => ({ ...parse(input.stored), wasCurrent: {}, save: input.save }),
  on: {
    "project.saved": change(saved),
    "project.selected": change(selected),
    "removal.started": change(started),
    "removal.undone": change(undone),
    "removal.settled": change(settled),
    "read?": {
      actions: ({ context, event }) => event.reply(body(context)),
    },
  },
});

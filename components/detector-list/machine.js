import { setup, assign, emit, enqueueActions, fromPromise } from "xstate";

// The view component that lists one journal project's detectors (6.4), the list of the
// Detectors dock's inner list-then-item. It owns only UI state — which project it shows,
// the row last opened, and a draft id for New detector — and points at one fact: it asks
// journal: read for the starting picture and follows journal.changed after (4.3, fourth
// rule). The project arrives as detector-project.selected; a tick, a pick, a rename and a
// delete leave as gestures (4.3, fifth rule). The ask, the id minting and the device
// memory arrive through input, so this stays a pure definition importable in Node.
//
// New detector is always the first row and always names a minted id no detector has yet,
// so picking it opens an empty editor under that id;
// once the editor saves, journal.changed brings the real row and a fresh draft is minted.

export const UNTITLED = "Untitled project";
export const UNTITLED_DETECTOR = "Untitled detector";
// The name detector-projects gives a new project: one still called this opens with its
// name selected, ready to write.
export const NEW_NAME = "New project";

const live = (items) => items.filter((x) => !x.removing);

// The rows under New detector: the project's detectors in their stored order, leaving
// out any whose deletion can still be undone.
export const rows = (detectors, project) => live(detectors).filter((d) => d.project === project);

// The line under a detector's name: its questions, leaving out any being removed, and
// "· off" when its own tick is off.
export const subtitle = (detector) => {
  const n = live(detector.questions).length;
  return `${n} question${n === 1 ? "" : "s"}${detector.on ? "" : " · off"}`;
};

// The line under the rows: a detector reads only while it and its project are ticked,
// so an unticked project says its detectors' ticks are kept but not used.
export const hint = (project) =>
  project.on
    ? "Ticked detectors read your writing."
    : "This project is unticked, so none of its detectors read your writing; their own ticks are kept.";

// What a typed name becomes: trimmed, and never empty, so a blank field keeps the name
// it replaces.
export const named = (typed, fallback) => (typeof typed === "string" && typed.trim()) || fallback;

// The project shown, flagged or not, or undefined when the journal has none by that id.
export const projectOf = (context) => context.projects.find((p) => p.id === context.project);

const liveProject = (context) => {
  const p = projectOf(context);
  return p && !p.removing ? p : null;
};

const remint = (context, detectors) => (detectors.some((d) => d.id === context.draft) ? context.mint() : context.draft);

const shownHas = (context, id) => rows(context.detectors, context.project).some((d) => d.id === id);

const picture = (output) => Array.isArray(output?.projects) && Array.isArray(output?.detectors);

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("journal", "read", {})),
  },
}).createMachine({
  id: "detector-list",
  meta: {
    description:
      "The detectors of the journal project picked in the Detectors dock, the second level. At " +
      "the top the project can be renamed or deleted; deleting waits out the undo window, with " +
      "Undo in a notice. New detector is the first row and opens an empty editor; the detector " +
      "appears in the list once something is written in it. Each row has a tick box that " +
      "switches the detector on or off, its name, greyed when off, and how many questions it " +
      "has. A line says a detector reads the writing only when it and its project are both " +
      "ticked.",
    kind: "view",
    emits: ["detector.selected", "detector.switched", "detector-project.saved", "removal.started"],
    attributes: [],
    asks: ["journal: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    remember: input.remember ?? (() => {}),
    // The project shown, kept on this device (3.1) because list-then-item keeps this list
    // shown across a reload.
    project: input.project ?? null,
    projects: [],
    detectors: [],
    // The row last opened; UI state, so the list marks what the editor was opened on.
    open: null,
    draft: input.mint(),
    // How many projects were picked; the view selects a new project's name once per pick.
    picks: 0,
  }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => picture(event.output),
            target: "ready",
            actions: assign(({ context, event }) => ({
              projects: event.output.projects,
              detectors: event.output.detectors,
              draft: remint(context, event.output.detectors),
            })),
          },
          // The fact could not answer: an honest failure rather than an empty list.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      on: {
        // The gestures (7.2: internal messages from the view). A pick names a shown
        // detector or the draft; a tick names a shown detector and changes it.
        _pick: {
          guard: ({ context, event }) => !!liveProject(context) && (event.id === context.draft || shownHas(context, event.id)),
          actions: [
            assign(({ event }) => ({ open: event.id })),
            emit(({ context, event }) => ({ type: "detector.selected", id: event.id, project: context.project })),
          ],
        },
        _switch: {
          guard: ({ context, event }) =>
            typeof event.on === "boolean" && rows(context.detectors, context.project).some((d) => d.id === event.id && d.on !== event.on),
          actions: emit(({ event }) => ({ type: "detector.switched", id: event.id, on: event.on })),
        },
        _rename: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const project = liveProject(context);
            if (!project) return;
            const name = named(event.name, project.name || NEW_NAME);
            if (name !== project.name) enqueue.emit({ type: "detector-project.saved", id: project.id, name });
          }),
        },
        _delete: {
          guard: ({ context }) => !!liveProject(context),
          actions: emit(({ context }) => {
            const project = liveProject(context);
            return { type: "removal.started", kind: "project", id: project.id, name: project.name.trim() };
          }),
        },
      },
    },
    failed: {},
  },
  on: {
    "detector-project.selected": {
      actions: [
        assign(({ context, event }) => ({ project: event.id, open: null, picks: context.picks + 1 })),
        ({ context, event }) => context.remember(event.id),
      ],
    },
    "journal.changed": {
      actions: assign(({ context, event }) => ({
        projects: event.projects,
        detectors: event.detectors,
        draft: remint(context, event.detectors),
      })),
    },
  },
});

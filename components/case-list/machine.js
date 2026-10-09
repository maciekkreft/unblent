import { setup, assign, enqueueActions, fromPromise } from "xstate";

// The view component that lists the Judge cases (6.4), in the Cases dock. It owns only UI
// state — the pictures it shows and a draft id for New case — and points at four facts:
// it asks projects: read, cases: read, rubrics: read and decisions: read for the starting
// picture and follows their .changed events after (4.3, fourth rule). A pick and Judge
// all leave as gestures (4.3, fifth rule); `decisions` runs the judging. The ask and mint
// arrive through input, so this stays a pure definition importable in Node.
//
// New case is always the first row and always names a minted id no case has yet, as
// rubric-list's New tool does: picking it opens an empty case under that id; once the
// editor saves it, case.changed brings the real row and a fresh draft is minted.

const live = (items) => items.filter((x) => !x.removing);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The rows under New case: the current project's cases in stored order, leaving out any
// whose deletion can still be undone.
export const rows = (cases, project) => live(cases).filter((c) => c.project === project);

// The switched-on tools of the project, as Judge uses them: tools and questions being
// removed are left out.
export const onTools = (rubrics, project) =>
  live(rubrics)
    .filter((r) => r.project === project && r.on)
    .map((r) => ({ ...r, questions: live(r.questions) }));

// A row's first line, as the user wrote it.
export const firstLine = (text) => (text.split("\n")[0] ?? "").trim();

// A right answer that still fits its question, as the user reads it: Yes or No for a
// yes / no question, the option's name for a pick question; null when it no longer fits
// (the question changed kind, or the option is gone or being removed).
export const answerName = (q, value) => {
  if (value == null) return null;
  if (q.kind === "yesno") return value === "yes" ? "Yes" : value === "no" ? "No" : null;
  const o = live(q.options).find((x) => x.id === value);
  return o ? o.name.trim() || "Untitled option" : null;
};

// The line under a case: its right answers for the switched-on tools, in tool and
// question order.
export const answersLine = (c, tools) => {
  const names = tools.flatMap((t) => t.questions.map((q) => answerName(q, c.answers[q.id])).filter(Boolean));
  if (!names.length) return "No right answer";
  return `${names.length === 1 ? "Right answer" : "Right answers"}: ${names.join(", ")}`;
};

// Whether Jev's answer to one question matches the right answer: a yes / no answer counts
// as Yes at p ≥ 0.5; a pick answer matches when it picked the right option.
export const isRight = (q, value, answer) =>
  q.kind === "yesno" ? (answer.p >= 0.5 ? "yes" : "no") === value : answer.choice === value;

// The mark on a row: true when every switched-on question with a right answer that Jev
// has answered was answered right, false when one was not, null when there is nothing to
// compare yet (no right answer, or not judged).
export const verdict = (c, tools, decisions) => {
  let compared = 0;
  for (const t of tools) {
    const d = decisions.find((x) => x.case === c.id && x.rubric === t.id);
    for (const q of t.questions) {
      const value = c.answers[q.id];
      if (answerName(q, value) == null) continue;
      const a = d?.answers.find((x) => x.id === q.id);
      if (!a) continue;
      if (!isRight(q, value, a)) return false;
      compared += 1;
    }
  }
  return compared ? true : null;
};

// A question of the snapshot can be asked: decisions and llm: decide refuse a blank one,
// and a pick question with fewer than two options.
const askable = (q) => q.text.trim() !== "" && (q.kind !== "pick" || live(q.options).length >= 2);

// The judging.requested payload for Judge all: every live case of the project with text,
// in order, and every switched-on tool with its live questions and options, in the
// contract shape (no removing flags). A tool with no live question is left out, since the
// contract needs at least one.
export const snapshot = (cases, rubrics, project) => ({
  project,
  cases: rows(cases, project)
    .filter((c) => c.text.trim() !== "")
    .map((c) => ({ id: c.id, text: c.text })),
  rubrics: onTools(rubrics, project)
    .filter((r) => r.questions.length > 0)
    .map((r) => ({
      id: r.id,
      name: r.name,
      questions: r.questions.map((q) => ({
        id: q.id,
        kind: q.kind,
        text: q.text,
        yes: q.yes,
        no: q.no,
        options: live(q.options).map((o) => ({ id: o.id, name: o.name, description: o.description })),
      })),
    })),
});

// The run of decisions, if it belongs to this project.
const runHere = (run, project) => (run && run.project === project ? run : null);

// Why Judge all cannot run now, in the words of the line beside it, or null when it can.
// Signed out and no Jev key are known only once a run stops on them (case-list does not
// ask llm), so they show as a run's error instead.
export const blocked = ({ cases, rubrics, run, current }) => {
  if (run?.running) return run.project === current ? "Judge all is running." : "Judge all is running in another project.";
  const tools = onTools(rubrics, current);
  if (!tools.length) return "Switch on a tool to judge.";
  if (!tools.some((t) => t.questions.some(askable))) return "Add a question to a tool to judge.";
  if (!rows(cases, current).some((c) => c.text.trim() !== "")) return "Add a case to judge.";
  return null;
};

// The line beside Judge all when it can run: how much a Judge all judges.
export const counts = ({ cases, rubrics, current }) =>
  `${plural(rows(cases, current).length, "case", "cases")}, ${plural(onTools(rubrics, current).length, "tool", "tools")} on`;

// The progress of this project's run while it is going, as "Judging N of M…" and the
// share done, or null.
export const progress = (run, project) => {
  const r = runHere(run, project);
  if (!r?.running) return null;
  const total = r.cases.length;
  return { text: `Judging ${Math.min(r.done + 1, total)} of ${total}…`, share: total ? r.done / total : 0 };
};

// Whether a case is still waiting in this project's run that is going.
export const waiting = (run, project, id) => {
  const r = runHere(run, project);
  return Boolean(r?.running && r.cases.indexOf(id) >= r.done);
};

// What a run that stopped early says, by its reason; gauge-post's words, said of judging.
export const errorText = (code) => {
  switch (code) {
    case "signed-out":
      return "Sign in to judge.";
    case "no-key":
      return "Add your Jev key in Settings.";
    case "bad-key":
      return "Jev did not accept the key. Replace it in Settings.";
    case "rate-limited":
      return "Jev is rate-limiting; try again in a moment.";
    case "overloaded":
      return "Jev is overloaded; try again in a moment.";
    case "invalid":
      return "Jev refused the questions.";
    case "busy":
      return "Jev is still answering another request.";
    default:
      return "Jev is unavailable.";
  }
};

// The reason this project's last run stopped early, or null.
export const stopped = (run, project) => {
  const r = runHere(run, project);
  return r && !r.running && r.error ? r.error : null;
};

const remint = (context, cases) => (cases.some((c) => c.id === context.draft) ? context.mint() : context.draft);

const shownHas = (context, id) => rows(context.cases, context.current).some((c) => c.id === id);

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) =>
      Promise.all(["projects", "cases", "rubrics", "decisions"].map((target) => input.ask(target, "read", {}))),
    ),
  },
}).createMachine({
  id: "case-list",
  meta: {
    description:
      "Lists the cases of the current project, in the Cases dock. New case is always the first " +
      "row and opens an empty case. Each row shows the case's first line and its right answers " +
      "for the tools that are on, with a tick or a cross once Jev's answers are in: a tick when " +
      "every right answer matches. Judge all, above the list, judges every case with the tools " +
      "that are on and shows the Results tab, and a line under it says \"Judging 3 of 18…\" " +
      "while it runs; it is greyed out while a run is going or no tool is on, and the line beside " +
      "it says why. A line says cases are kept on this device.",
    kind: "view",
    emits: ["case.selected", "judging.requested", "results.selected"],
    attributes: [],
    asks: ["projects: read", "cases: read", "rubrics: read", "decisions: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    current: null,
    cases: [],
    open: {},
    rubrics: [],
    decisions: [],
    run: null,
    draft: input.mint(),
  }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => {
              const [p, c, r, d] = event.output;
              return typeof p?.current === "string" && Array.isArray(c?.cases) && Array.isArray(r?.rubrics) && Array.isArray(d?.decisions);
            },
            target: "ready",
            actions: assign(({ context, event }) => {
              const [p, c, r, d] = event.output;
              return {
                current: p.current,
                cases: c.cases,
                open: c.open,
                rubrics: r.rubrics,
                decisions: d.decisions,
                run: d.run,
                draft: remint(context, c.cases),
              };
            }),
          },
          // A fact could not answer: an honest failure rather than an empty list.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      on: {
        // The gestures (7.2: internal messages from the view). A pick names a shown
        // case or the draft.
        _pick: {
          guard: ({ context, event }) => event.id === context.draft || shownHas(context, event.id),
          actions: enqueueActions(({ context, event, enqueue }) =>
            enqueue.emit({ type: "case.selected", id: event.id, project: context.current }),
          ),
        },
        // Judge all hands the snapshot to decisions, and the Results tab comes forward.
        _judge: {
          guard: ({ context }) => blocked(context) === null,
          actions: enqueueActions(({ context, enqueue }) => {
            enqueue.emit({ type: "judging.requested", ...snapshot(context.cases, context.rubrics, context.current) });
            enqueue.emit({ type: "results.selected" });
          }),
        },
      },
    },
    failed: {},
  },
  on: {
    "project.changed": { actions: assign(({ event }) => ({ current: event.current })) },
    "case.changed": {
      actions: assign(({ context, event }) => ({ cases: event.cases, open: event.open, draft: remint(context, event.cases) })),
    },
    "rubric.changed": { actions: assign(({ event }) => ({ rubrics: event.rubrics })) },
    "decision.changed": { actions: assign(({ event }) => ({ decisions: event.decisions, run: event.run })) },
  },
});

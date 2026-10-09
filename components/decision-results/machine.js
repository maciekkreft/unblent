import { setup, assign, enqueueActions, fromPromise } from "xstate";

// The view component that shows how well Jev did (6.4), the Results tab on the stage. It
// owns no fact and no UI state worth keeping: it asks projects: read, cases: read,
// rubrics: read and decisions: read for the starting picture and follows their .changed
// events after (4.3, fourth rule), and works out every count from them with the pure
// functions below. Clicking a miss leaves as case.selected, the same gesture as a pick in
// Cases (4.3, fifth rule). The ask arrives through input, so the machine is importable in
// Node.

const live = (items) => items.filter((x) => !x.removing);

const pct = (p) => Math.round(p * 100);

export const firstLine = (text) => (text.split("\n")[0] ?? "").trim();

// The switched-on tools of the project: tools and questions being removed are left out.
// Copied from case-editor, because components never import each other (11.2).
export const onTools = (rubrics, project) =>
  live(rubrics)
    .filter((r) => r.project === project && r.on)
    .map((r) => ({ ...r, questions: live(r.questions) }));

// The answers a question can have, as the user reads them: Yes and No for a yes / no
// question, the live options for a pick question. `value` is what a right answer and
// Jev's answer store.
export const choices = (q) =>
  q.kind === "yesno"
    ? [
        { value: "yes", name: "Yes" },
        { value: "no", name: "No" },
      ]
    : live(q.options).map((o) => ({ value: o.id, name: o.name.trim() || "Untitled option" }));

// What Jev answered, as a choice value: a yes / no answer counts as Yes at p ≥ 0.5.
export const said = (q, answer) => (q.kind === "yesno" ? (answer.p >= 0.5 ? "yes" : "no") : answer.choice);

// The words of a miss after the right answer, as the mockup writes them.
const missLine = (q, answer, pickName) =>
  q.kind === "yesno" ? `Jev said ${pct(answer.p)}% yes` : `Jev picked ${pickName}, ${pct(answer.p)}% sure`;

// The results of one question over the project's cases: the cases with a right answer
// that still fits and an answer from Jev that fits, how many Jev got right, the same per
// right answer, the table of right answer (rows) against Jev's answer (columns), and the
// misses in case order. Null when no case counts.
export const block = (tool, q, cases, decisions) => {
  const names = choices(q);
  const index = new Map(names.map((c, i) => [c.value, i]));
  const judged = [];
  for (const c of cases) {
    const right = c.answers[q.id];
    if (!index.has(right)) continue;
    const answer = decisions.find((d) => d.case === c.id && d.rubric === tool.id)?.answers.find((a) => a.id === q.id);
    if (!answer) continue;
    const pick = said(q, answer);
    if (!index.has(pick)) continue;
    judged.push({ c, right, pick, answer });
  }
  if (!judged.length) return null;
  const grid = names.map(() => names.map(() => 0));
  for (const j of judged) grid[index.get(j.right)][index.get(j.pick)] += 1;
  return {
    tool: tool.name.trim() || "Untitled tool",
    question: q.text.trim() || "Untitled question",
    id: q.id,
    right: judged.filter((j) => j.pick === j.right).length,
    total: judged.length,
    groups: names
      .map((n, i) => ({ name: n.name, right: grid[i][i], total: grid[i].reduce((a, b) => a + b, 0) }))
      .filter((g) => g.total > 0),
    names: names.map((n) => n.name),
    grid,
    misses: judged
      .filter((j) => j.pick !== j.right)
      .map((j) => ({
        id: j.c.id,
        text: firstLine(j.c.text) || "Empty case",
        line: `Right answer ${names[index.get(j.right)].name} · ${missLine(q, j.answer, names[index.get(j.pick)].name)}`,
      })),
  };
};

// One block per question of each switched-on tool of the project, in tool and question
// order, leaving out a question no case counts for.
export const blocks = ({ rubrics, cases, decisions, current }) => {
  const here = live(cases).filter((c) => c.project === current);
  return onTools(rubrics, current)
    .flatMap((t) => t.questions.map((q) => block(t, q, here, decisions)))
    .filter(Boolean);
};

// The progress of this project's run while it is going, as "Judging N of M…" and the
// share done, or null. The same words as case-list's line under Judge all.
export const progress = (run, project) => {
  if (!run?.running || run.project !== project) return null;
  const total = run.cases.length;
  return { text: `Judging ${Math.min(run.done + 1, total)} of ${total}…`, share: total ? run.done / total : 0 };
};

// What the tab says when there is nothing to show, or null when there are blocks.
export const emptyLine = (context, shown) => {
  const { rubrics, cases, current } = context;
  const hasTool = live(rubrics).some((r) => r.project === current);
  const hasCase = live(cases).some((c) => c.project === current);
  if (!hasTool || !hasCase) return "Results appear here after the first Judge all. Add a tool and some cases with right answers first.";
  if (!onTools(rubrics, current).length) return "Switch on a tool in Tools to see its results.";
  if (!shown.length) return "Results appear here after the first Judge all, for every question where a case has a right answer.";
  return null;
};

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) =>
      Promise.all(["projects", "cases", "rubrics", "decisions"].map((target) => input.ask(target, "read", {}))),
    ),
  },
}).createMachine({
  id: "decision-results",
  meta: {
    description:
      "The Results tab: for every question of a tool that is on, over the cases that have a " +
      "right answer for it and an answer from Jev, how many Jev got right (\"16 of 18 right\"), " +
      "how many it got right for each right answer, a table of what Jev picked against the right " +
      "answer, and the misses. Clicking a miss opens its case. While a run is going the results " +
      "are dimmed under its progress line. With no tool on, no case or nothing judged yet, it " +
      "says what to do first.",
    kind: "view",
    emits: ["case.selected"],
    attributes: [],
    asks: ["projects: read", "cases: read", "rubrics: read", "decisions: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    current: null,
    cases: [],
    rubrics: [],
    decisions: [],
    run: null,
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
            actions: assign(({ event }) => {
              const [p, c, r, d] = event.output;
              return { current: p.current, cases: c.cases, rubrics: r.rubrics, decisions: d.decisions, run: d.run };
            }),
          },
          // A fact could not answer: an honest failure rather than empty results.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      on: {
        // Only a miss on screen opens: a case of this project that still exists.
        _open: {
          guard: ({ context, event }) => context.cases.some((c) => c.id === event.id && c.project === context.current && !c.removing),
          actions: enqueueActions(({ context, event, enqueue }) =>
            enqueue.emit({ type: "case.selected", id: event.id, project: context.current }),
          ),
        },
      },
    },
    failed: {},
  },
  // The facts' news (4.3, fourth rule). Each read is superseded by its fact's event
  // (4.2), so none arrives before the starting picture it updates.
  on: {
    "project.changed": { actions: assign(({ event }) => ({ current: event.current })) },
    "case.changed": { actions: assign(({ event }) => ({ cases: event.cases })) },
    "rubric.changed": { actions: assign(({ event }) => ({ rubrics: event.rubrics })) },
    "decision.changed": { actions: assign(({ event }) => ({ decisions: event.decisions, run: event.run })) },
  },
});

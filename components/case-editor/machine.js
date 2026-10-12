import { setup, assign, enqueueActions, fromPromise } from "xstate";

// The view component that edits the open Judge case (6.4), the Case tab on the stage. It
// owns only UI state — the case being edited as a draft, and whether typing is waiting to
// be saved — and points at five facts: it asks projects: read, cases: read, rubrics:
// read, decisions: read and llm: read for the starting picture and follows their
// .changed events after (4.3, fourth rule). Which case is open is `cases`' fact (its
// `open` per project), so a pick in Cases, a reload or a project switch all arrive as
// case.changed or project.changed. Every edit leaves as the whole case, case.saved, at a
// throttle while typing and at once on blur or a menu choice (4.3, third rule); Judge,
// Delete case and New case leave as gestures (4.3, fifth rule). The ask, the id minting
// and the throttle arrive through input, so the machine is importable in Node.

const live = (items) => items.filter((x) => !x.removing);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const pct = (p) => Math.round(p * 100);

// The switched-on tools of the project, as Judge uses them: tools and questions being
// removed are left out.
export const onTools = (rubrics, project) =>
  live(rubrics)
    .filter((r) => r.project === project && r.on)
    .map((r) => ({ ...r, questions: live(r.questions) }));

// A right answer that still fits its question, as the user reads it: Yes or No for a
// yes / no question, the option's name for a pick question; null when it no longer fits.
export const answerName = (q, value) => {
  if (value == null) return null;
  if (q.kind === "yesno") return value === "yes" ? "Yes" : value === "no" ? "No" : null;
  const o = live(q.options).find((x) => x.id === value);
  return o ? o.name.trim() || "Untitled option" : null;
};

// The choices of a question's right-answer menu, after "No right answer".
export const choices = (q) =>
  q.kind === "yesno"
    ? [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ]
    : live(q.options).map((o) => ({ value: o.id, label: o.name.trim() || "Untitled option" }));

// One right-answer menu per question of each switched-on tool, in tool and question
// order. A stored answer that no longer fits shows as "No right answer" but stays in the
// case, as do the answers of tools that are off.
export const menus = (tools, answers) =>
  tools.flatMap((t) =>
    t.questions.map((q) => ({
      tool: t.name.trim() || "Untitled detector",
      question: q.text.trim() || "Untitled question",
      id: q.id,
      choices: choices(q),
      value: answerName(q, answers[q.id]) == null ? "" : answers[q.id],
    })),
  );

// Whether Jev's answer matches the right answer: a yes / no answer counts as Yes at
// p ≥ 0.5; a pick answer matches when it picked the right option.
export const isRight = (q, value, answer) =>
  q.kind === "yesno" ? (answer.p >= 0.5 ? "yes" : "no") === value : answer.choice === value;

// The mark beside an answer: null without a right answer that fits, else whether it is
// right and, when not, the right answer's name.
export const mark = (q, value, answer) => {
  const name = answerName(q, value);
  if (name == null) return null;
  return isRight(q, value, answer) ? { right: true } : { right: false, answer: name };
};

const optionName = (q, id) => {
  const o = q.options.find((x) => x.id === id);
  return o ? o.name.trim() || "Untitled option" : "Removed option";
};

// A pick question's block on a verdict card: the pick and how sure Jev is of it, then
// every other live option in the tool's order with its share.
export const pickBlock = (q, answer, value) => {
  const share = Object.fromEntries((answer.probabilities ?? []).map((x) => [x.id, x.p]));
  return {
    pick: optionName(q, answer.choice),
    sure: pct(answer.p),
    others: live(q.options)
      .filter((o) => o.id !== answer.choice)
      .map((o) => ({ name: o.name.trim() || "Untitled option", pct: pct(share[o.id] ?? 0) })),
    mark: mark(q, value, answer),
  };
};

// A yes / no question's row on a verdict card: the chance of yes, coloured yes at 60% or
// more, no at 40% or less, and neither in between.
export const yesnoRow = (q, answer, value) => {
  const p = pct(answer.p);
  return { pct: p, tone: p >= 60 ? "yes" : p <= 40 ? "no" : "", mark: mark(q, value, answer) };
};

// The verdict cards of a case: one per switched-on tool, its pick questions first, then
// its yes / no questions together, as the mockup draws them; a question Jev has not
// answered says so. Null when no switched-on tool has an answer for the case yet.
export const cards = (tools, decisions, c) => {
  const found = tools.map((t) => decisions.find((d) => d.case === c.id && d.rubric === t.id));
  if (!found.some(Boolean)) return null;
  return tools.map((t, i) => {
    const answerOf = (q) => found[i]?.answers.find((a) => a.id === q.id);
    return {
      id: t.id,
      name: t.name.trim() || "Untitled detector",
      picks: t.questions
        .filter((q) => q.kind === "pick")
        .map((q) => ({ id: q.id, text: q.text, block: answerOf(q) ? pickBlock(q, answerOf(q), c.answers[q.id]) : null })),
      yesnos: t.questions
        .filter((q) => q.kind === "yesno")
        .map((q) => ({ id: q.id, text: q.text, row: answerOf(q) ? yesnoRow(q, answerOf(q), c.answers[q.id]) : null })),
    };
  });
};

// The judging.requested payload for Judge: this one case, and every switched-on tool
// with its live questions and options, in the contract shape. The same snapshot as
// case-list's Judge all, copied because components never import each other (11.2).
export const snapshot = (draft, rubrics, project) => ({
  project,
  cases: [{ id: draft.id, text: draft.text }],
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

// A question decisions and llm: decide accept: not blank, and a pick question with at
// least two options.
const askable = (q) => q.text.trim() !== "" && (q.kind !== "pick" || live(q.options).length >= 2);

// Whether this case is waiting in a run of its project that is going.
export const judging = (run, project, id) =>
  Boolean(run?.running && run.project === project && run.cases.indexOf(id) >= run.done);

// The line beside Judge once a new account has used its starter requests (architecture.md 12).
const USED_UP = "The 100 starter requests are used up. Add your Jev key in Settings.";

// Why Judge cannot run now, in the words of the line beside it, or null when it can.
export const blocked = ({ draft, rubrics, run, current, signedIn, keySet, usedUp }) => {
  if (judging(run, current, draft.id)) return "Judging this case…";
  if (run?.running) return run.project === current ? "Judge all is running." : "Judge all is running in another project.";
  if (!signedIn) return "Sign in to judge.";
  if (!keySet) return usedUp ? USED_UP : "Add your Jev key in Settings.";
  if (!live(rubrics).some((r) => r.project === current)) return "Make a detector in Detectors to judge.";
  const tools = onTools(rubrics, current);
  if (!tools.length) return "Switch on a detector in Detectors to judge.";
  if (!tools.some((t) => t.questions.some(askable))) return "Add a question to a detector to judge.";
  if (!draft.text.trim()) return "Write the text to judge.";
  return null;
};

const listed = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

// The line beside Judge when it can run: which tools judge the case.
export const uses = (rubrics, project) => {
  const names = onTools(rubrics, project).map((t) => t.name.trim() || "Untitled detector");
  return `Judges this case with ${names.length > 3 ? plural(names.length, "detector", "detectors") + " that are on" : listed(names)}.`;
};

// What a run that stopped early says, by its reason, in the user's words.
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

// The reason the last run stopped early, when this case was in it, or null.
export const stopped = (run, project, id) =>
  run && !run.running && run.error && run.project === project && run.cases.includes(id) ? run.error : null;

// The draft as case.saved carries it.
export const wire = (d) => ({ id: d.id, project: d.project, text: d.text, answers: d.answers });

// Nothing written in it and no right answer chosen: a New case opened and left adds no row.
export const isEmpty = (d) => !d.text.trim() && Object.keys(d.answers).length === 0;

const known = (context, id) => context.cases.some((c) => c.id === id);

// The empty rule holds for a case `cases` has never had; a stored case the user clears
// is still saved, so clearing it is kept.
const savable = (context) => Boolean(context.draft) && (known(context, context.draft.id) || !isEmpty(context.draft));

// The draft for the project's open case: a copy of the stored case, or an empty one for
// a new id no case has yet; null when the project has no open case.
const opened = (cases, open, current) => {
  const id = open?.[current];
  if (!id) return null;
  const found = cases.find((c) => c.id === id && !c.removing);
  return found
    ? { id, project: found.project, text: found.text, answers: { ...found.answers } }
    : { id, project: current, text: "", answers: {} };
};

const save = enqueueActions(({ context, enqueue }) => {
  if (savable(context)) enqueue.emit({ type: "case.saved", ...wire(context.draft) });
});

// The open case after case.changed. While typing waits to be saved, the same case keeps
// what is on screen; another open case, from a pick or a delete, replaces it after the
// typing is saved.
const follow = (dirty) =>
  enqueueActions(({ context, event, enqueue }) => {
    const id = event.open[context.current];
    if (dirty && context.draft && id !== context.draft.id && savable(context))
      enqueue.emit({ type: "case.saved", ...wire(context.draft) });
    const keep = dirty && context.draft && id === context.draft.id;
    enqueue.assign(() => ({
      cases: event.cases,
      open: event.open,
      draft: keep ? context.draft : opened(event.cases, event.open, context.current),
    }));
  });

const moved = (context, id) => !context.draft || id !== context.draft.id;

// Another project has its own open case; while typing waits, the one being left is saved
// first.
const switched = (dirty) => ({
  guard: ({ context, event }) => event.current !== context.current,
  target: "clean",
  actions: [
    ...(dirty ? [save] : []),
    assign(({ context, event }) => ({ current: event.current, draft: opened(context.cases, context.open, event.current) })),
  ],
});

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) =>
      Promise.all(["projects", "cases", "rubrics", "decisions", "llm"].map((target) => input.ask(target, "read", {}))),
    ),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "case-editor",
  meta: {
    description:
      "The Case tab: the open case's text, and its right answers, one menu per question of the " +
      "detectors that are on, grouped by detector, each starting at \"No right answer\"; the answers of " +
      "detectors that are off are kept. Every edit is saved as the whole case a short time into " +
      "typing, when a field loses focus and when a right answer is chosen, and a new case is " +
      "kept once something is written in it. Judge judges this case with the detectors that are " +
      "on; a line beside it names them, or says why it cannot run (signed out, no Jev key, no " +
      "detector on, no text), and says \"Judging this case…\" while it runs. Below, one card per " +
      "detector shows Jev's answers: for a pick-one question the pick, large, how sure Jev is, and " +
      "a bar per other option; for yes / no questions a bar each with the chance of yes, green " +
      "at 60% or more and red at 40% or less; and a tick, or a cross with the right answer, " +
      "wherever a right answer is set. Delete case waits out the undo window. With no case " +
      "open, a large New case button starts one.",
    kind: "view",
    emits: ["case.saved", "case.selected", "judging.requested", "removal.started"],
    attributes: [],
    asks: ["projects: read", "cases: read", "rubrics: read", "decisions: read", "llm: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    throttleMs: input.throttleMs ?? 200,
    current: null,
    cases: [],
    open: {},
    rubrics: [],
    decisions: [],
    run: null,
    signedIn: false,
    keySet: false,
    usedUp: false, // the starter requests are used up (architecture.md 12)
    draft: null,
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
              const [p, c, r, d, l] = event.output;
              return {
                current: p.current,
                cases: c.cases,
                open: c.open,
                rubrics: r.rubrics,
                decisions: d.decisions,
                run: d.run,
                signedIn: l?.signedIn === true,
                keySet: l?.jev?.keySet === true,
                usedUp: l?.jev?.starterLeft === 0,
                draft: opened(c.cases, c.open, p.current),
              };
            }),
          },
          // A fact could not answer: an honest failure rather than an empty case.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      initial: "clean",
      states: {
        clean: {
          on: {
            _edit: {
              guard: ({ context }) => Boolean(context.draft),
              target: "dirty",
              actions: assign(({ context, event }) => ({ draft: { ...context.draft, text: event.text } })),
            },
            "case.changed": { actions: follow(false) },
            "project.changed": switched(false),
          },
        },
        // Typing within the window joins the one save at its end: a throttle, not a
        // debounce, so the targetless edits below never restart the timer.
        dirty: {
          on: {
            _edit: { actions: assign(({ context, event }) => ({ draft: { ...context.draft, text: event.text } })) },
            _blur: { target: "clean", actions: save },
            "case.changed": [
              { guard: ({ context, event }) => moved(context, event.open[context.current]), target: "clean", actions: follow(true) },
              { actions: follow(true) },
            ],
            "project.changed": switched(true),
          },
          after: { throttle: { target: "clean", actions: save } },
        },
      },
      on: {
        // A menu choice is one gesture, saved at once; "" clears the right answer.
        _answer: {
          guard: ({ context }) => Boolean(context.draft),
          target: ".clean",
          actions: [
            assign(({ context, event }) => {
              const { [event.id]: _, ...rest } = context.draft.answers;
              return { draft: { ...context.draft, answers: event.value ? { ...rest, [event.id]: event.value } : rest } };
            }),
            save,
          ],
        },
        // Judge first saves the case as it stands, so what is judged is what is kept.
        _judge: {
          guard: ({ context }) => Boolean(context.draft) && blocked(context) === null,
          target: ".clean",
          actions: [
            save,
            enqueueActions(({ context, enqueue }) =>
              enqueue.emit({ type: "judging.requested", ...snapshot(context.draft, context.rubrics, context.current) }),
            ),
          ],
        },
        // Only a case the fact holds can be deleted; a new case with nothing in it
        // offers no Delete, because leaving it already keeps nothing.
        _delete: {
          guard: ({ context }) => Boolean(context.draft) && known(context, context.draft.id),
          target: ".clean",
          actions: [
            save,
            enqueueActions(({ context, enqueue }) =>
              enqueue.emit({
                type: "removal.started",
                kind: "case",
                id: context.draft.id,
                name: (context.draft.text.split("\n")[0] ?? "").trim(),
              }),
            ),
          ],
        },
        // The empty state's New case: a fresh id becomes the open case.
        _new: {
          guard: ({ context }) => !context.draft,
          actions: enqueueActions(({ context, enqueue }) =>
            enqueue.emit({ type: "case.selected", id: context.mint(), project: context.current }),
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
    "case.changed": { actions: assign(({ event }) => ({ cases: event.cases, open: event.open })) },
    "rubric.changed": { actions: assign(({ event }) => ({ rubrics: event.rubrics })) },
    "decision.changed": { actions: assign(({ event }) => ({ decisions: event.decisions, run: event.run })) },
    "llm.changed": { actions: assign(({ event }) => ({ signedIn: event.signedIn === true, keySet: event.jev?.keySet === true, usedUp: event.jev?.starterLeft === 0 })) },
  },
});

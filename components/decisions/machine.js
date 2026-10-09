import { setup, enqueueActions, fromPromise } from "xstate";

// A local-only fact component (3.1): headless owner of Jev's latest answers for each case
// and tool (a rubric inside the system, 7.7 already uses "tool"), and of the latest run.
// case-list and case-editor emit judging.requested with a snapshot of the cases and the
// tools that are on (4.3, fifth rule); this fact runs Judge itself, as conversations runs
// the chat's tool loop (6.3), so closing a panel stops nothing. It asks llm: decide once
// per case, in order, because llm answers "busy" while a decide is open. It follows
// case.changed and rubric.changed to drop answers that no longer say anything about what
// is written. Each stored decision keeps the case text and the questions as they were
// asked, so staleness is decided from the next event alone, without a starting read of
// cases or rubrics. The store, the ask and the clock arrive through `input`, so the
// machine is a pure definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const unit = (v) => typeof v === "number" && v >= 0 && v <= 1;

// The envelope's format; a newer shape would bump it.
export const VERSION = 1;

const REASONS = ["signed-out", "no-key", "bad-key", "rate-limited", "overloaded", "invalid", "busy", "unavailable"];

// A reply's error as one of decide's reasons. The bus's own refusals (no-answerer,
// invalid-payload, invalid-reply) mean Jev could not be asked, which is "unavailable".
export const reason = (error) => (REASONS.includes(error) ? error : "unavailable");

// What a question was asked as. Only what Jev is sent counts (llm: decide): a yes / no
// question's text and criteria, or a pick question's text and options; the options a
// yes / no question keeps, and the criteria a pick question keeps, are not sent.
export const signature = (q, options = q.options) =>
  q.kind === "pick"
    ? JSON.stringify(["pick", q.text, options.map((o) => [o.id, o.name, o.description])])
    : JSON.stringify(["yesno", q.text, q.yes, q.no]);

const live = (list) => list.filter((x) => !x.removing);

// A question of the snapshot can be asked: it has text, and a pick question has the two
// options llm: decide needs at least.
const askable = (q) => q.text.trim() !== "" && (q.kind !== "pick" || q.options.length >= 2);

// The one llm: decide payload for one case: every askable question of every tool in the
// snapshot, each under "<rubric>/<question>" so the answers split back per tool. Criteria
// and descriptions are passed as written; llm leaves out an empty one.
export const payload = (text, rubrics) => ({
  state: { text },
  questions: rubrics.flatMap((r) =>
    r.questions.filter(askable).map((q) =>
      q.kind === "pick"
        ? {
            id: `${r.id}/${q.id}`,
            kind: "pick",
            instructions: q.text,
            options: q.options.map((o) => ({ id: o.id, name: o.name, description: o.description })),
          }
        : { id: `${r.id}/${q.id}`, kind: "yesno", instructions: q.text, yes: q.yes, no: q.no },
    ),
  ),
});

// One answer in the contract shape: p always, and for a pick question the choice, every
// option's probability and how sure Jev is.
const answerOf = (a, id) => {
  const out = { id, p: a.p };
  if (isId(a.choice)) out.choice = a.choice;
  if (Array.isArray(a.probabilities))
    out.probabilities = a.probabilities.filter((x) => isId(x?.id) && unit(x.p)).map((x) => ({ id: x.id, p: x.p }));
  if (unit(a.confidence)) out.confidence = a.confidence;
  return out;
};

// Jev's reply for one case back into one stored decision per tool that was answered.
// Each keeps the case's text and every answered question's signature, which staleness
// compares against later.
export const decisionsOf = ({ id, text }, rubrics, answers, at) => {
  const asked = new Map(rubrics.flatMap((r) => r.questions.map((q) => [`${r.id}/${q.id}`, { r, q }])));
  const byRubric = new Map();
  for (const a of answers) {
    const hit = asked.get(a?.id);
    if (!hit || !unit(a.p)) continue;
    const d = byRubric.get(hit.r.id) ?? { case: id, rubric: hit.r.id, at, answers: [], text, asked: {} };
    d.answers.push(answerOf(a, hit.q.id));
    d.asked[hit.q.id] = signature(hit.q);
    byRubric.set(hit.r.id, d);
  }
  return [...byRubric.values()];
};

// One stored decision measured against the cases and tools as they now are, either list
// null when not known yet. It is gone with its case or tool, and gone when the case's
// text changed; an answer is dropped when its question is gone or now asks something
// else, and the decision with its last answer. Anything still pending removal counts as
// there, so Undo finds the answers again; a question is unchanged if it matches either
// with its pending options or without them, because the snapshot leaves pending options
// out (judging.requested).
export const fresh = (d, cases, rubrics) => {
  if (cases) {
    const c = cases.find((x) => x.id === d.case);
    if (!c || c.text !== d.text) return null;
  }
  if (!rubrics) return d;
  const r = rubrics.find((x) => x.id === d.rubric);
  if (!r) return null;
  const answers = d.answers.filter((a) => {
    const q = r.questions.find((x) => x.id === a.id);
    return q && [signature(q), signature(q, live(q.options))].includes(d.asked[a.id]);
  });
  if (!answers.length) return null;
  if (answers.length === d.answers.length) return d;
  const asked = Object.fromEntries(answers.map((a) => [a.id, d.asked[a.id]]));
  return { ...d, answers, asked };
};

export const prune = (decisions, cases, rubrics) =>
  decisions.map((d) => fresh(d, cases, rubrics)).filter(Boolean);

// Puts each new decision in place of the one for the same case and tool.
const replace = (decisions, added) => {
  const key = (d) => `${d.case}/${d.rubric}`;
  const keys = new Set(added.map(key));
  return [...decisions.filter((d) => !keys.has(key(d))), ...added];
};

const answerValid = (a) => a && isId(a.id) && unit(a.p);

const storedDecision = (d) =>
  d &&
  isId(d.case) &&
  isId(d.rubric) &&
  Number.isInteger(d.at) &&
  typeof d.text === "string" &&
  d.asked &&
  typeof d.asked === "object" &&
  Array.isArray(d.answers) &&
  d.answers.length > 0 &&
  d.answers.every(answerValid)
    ? { case: d.case, rubric: d.rubric, at: d.at, answers: d.answers.map((a) => answerOf(a, a.id)), text: d.text, asked: d.asked }
    : null;

const storedRun = (r) =>
  r && isId(r.project) && Array.isArray(r.cases) && r.cases.every(isId) && Number.isInteger(r.done)
    ? {
        project: r.project,
        cases: r.cases,
        done: Math.min(Math.max(r.done, 0), r.cases.length),
        // A run that was going when its tab closed stopped there; it keeps how far it got.
        running: false,
        error: r.error == null ? null : reason(r.error),
      }
    : null;

// What the store held, as { decisions, run }; empty when nothing is stored or it does not parse.
export const parse = (stored) => {
  const empty = { decisions: [], run: null };
  if (stored == null || stored === "") return empty;
  try {
    const value = JSON.parse(stored);
    if (!Array.isArray(value?.decisions)) return empty;
    return { decisions: value.decisions.map(storedDecision).filter(Boolean), run: storedRun(value.run) };
  } catch {
    return empty;
  }
};

// The contract body (decision.changed, decisions: read): the stored text and signatures
// stay in this fact.
export const body = (context) => ({
  decisions: context.decisions.map(({ text, asked, ...d }) => d),
  run: context.run,
});

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Each change is saved and announced whole; one that changes nothing stores and emits
// nothing, though the cases and tools it heard of are still remembered.
const commit = (next) => ({
  actions: enqueueActions(({ context, event, enqueue }) => {
    const n = next(context, event);
    // A function, because an object's function values (ask, save, now) would be read
    // by XState as property assigners and called.
    enqueue.assign(() => n);
    if (same(n.decisions, context.decisions) && same(n.run, context.run)) return;
    enqueue(() => context.save(JSON.stringify({ version: VERSION, decisions: n.decisions, run: n.run })));
    enqueue.emit({ type: "decision.changed", ...body(n) });
  }),
});

// The cases and tools as last announced, kept in memory so a case edited while its
// answers were on the way is caught when they land.
const caseChanged = (context, { cases }) => ({
  ...context,
  cases,
  decisions: prune(context.decisions, cases, context.rubrics),
});

const rubricChanged = (context, { rubrics }) => ({
  ...context,
  rubrics,
  decisions: prune(context.decisions, context.cases, rubrics),
});

const current = (context) => context.snapshot.cases[context.run.done];
const asking = (context) => payload(current(context).text, context.snapshot.rubrics);

const begin = (context, { project, cases, rubrics }) => {
  const snapshot = { cases, rubrics };
  const run = { project, cases: cases.map((c) => c.id), done: 0, running: true, error: null };
  // Nothing to ask (every question blank, or a pick question short of two options):
  // llm: decide would refuse it, so the run stops at once with decide's own reason.
  if (!payload(cases[0].text, rubrics).questions.length) return { ...context, snapshot: null, run: { ...run, running: false, error: "invalid" } };
  return { ...context, snapshot, run };
};

const answered = ({ event }) => Array.isArray(event.output?.answers);

const progressed = (context, { output }) => {
  const c = current(context);
  const added = decisionsOf(c, context.snapshot.rubrics, output.answers, context.now());
  const done = context.run.done + 1;
  const running = done < context.run.cases.length;
  return {
    ...context,
    decisions: prune(replace(context.decisions, added), context.cases, context.rubrics),
    run: { ...context.run, done, running },
    snapshot: running ? context.snapshot : null,
  };
};

// The first error ends the run and keeps what came back before it.
const failed = (error) => (context) => ({ ...context, run: { ...context.run, running: false, error }, snapshot: null });

export const machine = setup({
  actors: {
    decide: fromPromise(({ input }) => input.ask("llm", "decide", input.payload)),
  },
}).createMachine({
  id: "decisions",
  meta: {
    description:
      "Owns what Jev answered, kept on this device: the latest answers for each case and tool, " +
      "and the latest run of Judge or Judge all with how far it got. Judge and Judge all arrive " +
      "with the cases and the switched-on tools as they were when the button was pressed, and " +
      "this fact asks Jev about one case at a time, in order, because only one request may be " +
      "open at a time. A run stops at the first error and keeps the reason, so the user sees " +
      "why. Answers are dropped once the case's text or a question they answer changes, " +
      "because they no longer say anything about what is written, and with the case or tool " +
      "they belong to once it is gone. For a yes / no question an answer is how likely yes is; " +
      "for a pick-one question it is the option Jev picked, how likely each option is, and how " +
      "sure Jev is.",
    kind: "fact",
    shape: "local-only",
    owns: "Jev's latest answers for each case and tool, and the latest run",
    emits: ["decision.changed"],
    asks: ["llm: decide"],
  },
  context: ({ input }) => ({
    ...parse(input.stored),
    save: input.save,
    ask: input.ask,
    now: input.now,
    // The cases and tools as last announced, or null until the first event.
    cases: null,
    rubrics: null,
    // The cases and tools of the run that is going, as they were requested.
    snapshot: null,
  }),
  initial: "idle",
  states: {
    idle: {
      on: {
        "judging.requested": [
          {
            guard: ({ event }) => payload(event.cases[0].text, event.rubrics).questions.length > 0,
            target: "judging",
            ...commit(begin),
          },
          commit(begin),
        ],
      },
    },
    // A Judge pressed while a run is going is ignored: the views grey the buttons out
    // while it runs, and a queue would judge a snapshot the user can no longer see.
    judging: {
      invoke: {
        src: "decide",
        input: ({ context }) => ({ ask: context.ask, payload: asking(context) }),
        onDone: [
          {
            guard: ({ context, event }) => answered({ event }) && context.run.done + 1 < context.run.cases.length,
            target: "judging",
            reenter: true,
            ...commit(progressed),
          },
          { guard: answered, target: "idle", ...commit(progressed) },
          { target: "idle", ...commit((context, event) => failed(reason(event.output?.error))(context)) },
        ],
        onError: { target: "idle", ...commit(failed("unavailable")) },
      },
    },
  },
  on: {
    "case.changed": commit(caseChanged),
    "rubric.changed": commit(rubricChanged),
    "read?": { actions: ({ context, event }) => event.reply(body(context)) },
  },
});

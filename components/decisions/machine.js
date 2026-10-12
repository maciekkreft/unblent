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
//
// case-journal emits passages.requested with the finished pieces of the open case. Their
// answers are kept by the piece's text and not by case, so a sentence judged once is not
// sent again from any case while its questions stay the same. Pieces share llm: decide
// with the runs, so they wait in a queue behind a run, and a run waits for the one piece
// being asked.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const unit = (v) => typeof v === "number" && v >= 0 && v <= 1;

// The envelope's format; a newer shape would bump it. Version 1 had no passages.
export const VERSION = 2;

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
  return freshTool(d, rubrics);
};

// The tool half of fresh, shared by a case's decision and a piece's answer.
const freshTool = (d, rubrics) => {
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

// A piece's text still says something while some case, even one pending removal (so
// Undo finds it), still holds it; cases null when not known yet.
const written = (text, cases) => !cases || cases.some((c) => c.text.includes(text));

// The stored answers for pieces, as `prune` does for cases' decisions.
export const prunePassages = (passages, cases, rubrics) =>
  passages.filter((p) => written(p.text, cases)).map((p) => freshTool(p, rubrics)).filter(Boolean);

// A piece needs no request when every askable question of every requested tool has an
// answer asked as it is now. The request leaves pending options out, so its own
// signature is the one to match.
export const answeredPiece = (passages, text, rubrics) =>
  rubrics.every((r) =>
    r.questions.filter(askable).every((q) =>
      passages.some((p) => p.text === text && p.rubric === r.id && p.asked[q.id] === signature(q)),
    ),
  );

// Jev's reply for one piece, as one stored answer per tool.
const passagesOf = (text, rubrics, answers, at) =>
  decisionsOf({ id: null, text }, rubrics, answers, at).map(({ case: _, ...p }) => p);

const replacePassages = (passages, added) => {
  const key = (p) => `${p.rubric}/${p.text}`;
  const keys = new Set(added.map(key));
  return [...passages.filter((p) => !keys.has(key(p))), ...added];
};

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

const storedPassage = (p) =>
  p &&
  typeof p.text === "string" &&
  isId(p.rubric) &&
  Number.isInteger(p.at) &&
  p.asked &&
  typeof p.asked === "object" &&
  Array.isArray(p.answers) &&
  p.answers.length > 0 &&
  p.answers.every(answerValid)
    ? { text: p.text, rubric: p.rubric, at: p.at, answers: p.answers.map((a) => answerOf(a, a.id)), asked: p.asked }
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

// What the store held, as { decisions, run, passages }; empty when nothing is stored or
// it does not parse. A version-1 store has no passages and reads with none.
export const parse = (stored) => {
  const empty = { decisions: [], run: null, passages: [] };
  if (stored == null || stored === "") return empty;
  try {
    const value = JSON.parse(stored);
    if (!Array.isArray(value?.decisions)) return empty;
    return {
      decisions: value.decisions.map(storedDecision).filter(Boolean),
      run: storedRun(value.run),
      passages: Array.isArray(value.passages) ? value.passages.map(storedPassage).filter(Boolean) : [],
    };
  } catch {
    return empty;
  }
};

// The contract body (decision.changed, decisions: read): the stored text and signatures
// stay in this fact.
export const body = (context) => ({
  decisions: context.decisions.map(({ text, asked, ...d }) => d),
  run: context.run,
  passages: {
    answers: context.passages.map(({ asked, ...p }) => p),
    waiting: [...(context.asking ? [context.asking.text] : []), ...context.queue.map((q) => q.text)],
    error: context.passageError,
  },
});

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The queue and the passage error are not stored: a reload asks again for what the
// journal still shows, as a run that was going stops where it got to.
const envelope = (c) => JSON.stringify({ version: VERSION, decisions: c.decisions, run: c.run, passages: c.passages });

// Each change is saved and announced whole; one that changes nothing stores and emits
// nothing, though the cases and tools it heard of are still remembered.
const commit = (next) => ({
  actions: enqueueActions(({ context, event, enqueue }) => {
    const n = next(context, event);
    // A function, because an object's function values (ask, save, now) would be read
    // by XState as property assigners and called.
    enqueue.assign(() => n);
    const stored = envelope(n);
    if (stored !== envelope(context)) enqueue(() => context.save(stored));
    if (!same(body(n), body(context))) enqueue.emit({ type: "decision.changed", ...body(n) });
  }),
});

// The cases and tools as last announced, kept in memory so a case edited while its
// answers were on the way is caught when they land.
// The piece being asked stays: its answer is measured against the cases when it lands.
const caseChanged = (context, { cases }) => ({
  ...context,
  cases,
  decisions: prune(context.decisions, cases, context.rubrics),
  passages: prunePassages(context.passages, cases, context.rubrics),
  queue: context.queue.filter((q) => written(q.text, cases)),
});

const rubricChanged = (context, { rubrics }) => ({
  ...context,
  rubrics,
  decisions: prune(context.decisions, context.cases, rubrics),
  passages: prunePassages(context.passages, context.cases, rubrics),
});

// Queues each piece not answered for every requested tool and not already waiting. A
// piece already waiting takes the newer tools, which are what the user now has on; the
// one being asked keeps its own. A request clears the last error, so the queue resumes.
const requested = (context, { rubrics, passages }) => {
  // Nothing askable: llm: decide would refuse it, so say so with decide's own reason.
  if (!payload("", rubrics).questions.length) return { ...context, passageError: "invalid" };
  const queue = [...context.queue];
  for (const text of passages) {
    if (context.asking?.text === text) continue;
    const i = queue.findIndex((q) => q.text === text);
    if (i >= 0) queue[i] = { text, rubrics };
    else if (!answeredPiece(context.passages, text, rubrics)) queue.push({ text, rubrics });
  }
  return { ...context, queue, passageError: null };
};

const take = (context) => ({ ...context, asking: context.queue[0], queue: context.queue.slice(1) });

const pieceAnswered = (context, { output }) => {
  const added = passagesOf(context.asking.text, context.asking.rubrics, output.answers, context.now());
  return {
    ...context,
    passages: prunePassages(replacePassages(context.passages, added), context.cases, context.rubrics),
    asking: null,
  };
};

// An error stops the queue and keeps the reason; the pieces left go back to the journal,
// which asks for them again with its next request.
const pieceFailed = (error) => (context) => ({ ...context, asking: null, queue: [], passageError: error });

// A Judge pressed while a piece was asked starts now, from the snapshot it was pressed with.
const beginPending = (context) => begin({ ...context, pending: null }, context.pending);

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
      "Owns what Jev answered, kept on this device: the latest answers for each case and detector, " +
      "and the latest run of Judge or Judge all with how far it got. Judge and Judge all arrive " +
      "with the cases and the switched-on detectors as they were when the button was pressed, and " +
      "this fact asks Jev about one case at a time, in order, because only one request may be " +
      "open at a time. A run stops at the first error and keeps the reason, so the user sees " +
      "why. Answers are dropped once the case's text or a question they answer changes, " +
      "because they no longer say anything about what is written, and with the case or detector " +
      "they belong to once it is gone. For a yes / no question an answer is how likely yes is; " +
      "for a pick-one question it is the option Jev picked, how likely each option is, and how " +
      "sure Jev is. Pieces of a case's text, sentences or paragraphs from the Journal tab, are " +
      "asked one at a time between runs and kept by their text, so a piece already judged in " +
      "any case is not sent again while its questions stay the same; a piece's answers are " +
      "dropped once no case holds its text.",
    kind: "fact",
    shape: "local-only",
    owns: "Jev's latest answers for each case and detector, and the latest run",
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
    // Pieces waiting for Jev, each with the tools it was requested with; the one being
    // asked; and why the last piece could not be judged.
    queue: [],
    asking: null,
    passageError: null,
    // A judging.requested that arrived while a piece was asked.
    pending: null,
  }),
  initial: "idle",
  states: {
    idle: {
      always: [
        {
          guard: ({ context }) =>
            context.pending != null && payload(context.pending.cases[0].text, context.pending.rubrics).questions.length > 0,
          target: "judging",
          ...commit(beginPending),
        },
        { guard: ({ context }) => context.pending != null, ...commit(beginPending) },
        { guard: ({ context }) => context.queue.length > 0, target: "passage", ...commit(take) },
      ],
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
    // One piece asked; idle then starts a waiting run first, then the next piece.
    passage: {
      invoke: {
        src: "decide",
        input: ({ context }) => ({ ask: context.ask, payload: payload(context.asking.text, context.asking.rubrics) }),
        onDone: [
          { guard: answered, target: "idle", ...commit(pieceAnswered) },
          { target: "idle", ...commit((context, event) => pieceFailed(reason(event.output?.error))(context)) },
        ],
        onError: { target: "idle", ...commit(pieceFailed("unavailable")) },
      },
      on: {
        "judging.requested": commit((context, event) => ({ ...context, pending: event })),
      },
    },
  },
  on: {
    "passages.requested": commit(requested),
    "case.changed": commit(caseChanged),
    "rubric.changed": commit(rubricChanged),
    "read?": { actions: ({ context, event }) => event.reply(body(context)) },
  },
});

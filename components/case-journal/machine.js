import { setup, assign, enqueueActions, fromPromise } from "xstate";

// The view component that judges the open Judge case piece by piece (6.4), the Journal
// tab on the stage. It owns only UI state — the case being edited as a draft, whether
// typing is waiting to be saved, whether the box has the keyboard, and Sentences or
// Paragraphs — and points at five facts: it asks projects: read, cases: read, rubrics:
// read, decisions: read and llm: read for the starting picture and follows their
// .changed events after (4.3, fourth rule). It edits the same case as the Case tab, saved
// the same way (case.saved at a throttle while typing and at once on blur, 4.3, third
// rule); after each save, on blur and on opening a case it emits passages.requested with
// the finished pieces, and `decisions` asks Jev for any it has not answered. The open
// case, the draft and the saving are copied from case-editor, because components never
// import each other (11.2). The ask, the id minting, the throttle and the starting mode
// arrive through input, so the machine is importable in Node.

const live = (items) => items.filter((x) => !x.removing);

const pct = (p) => Math.round(p * 100);

export const MODES = ["sentences", "paragraphs"];

// A sentence ends at . ! ? or …, with any closing quotes or brackets after it, when
// whitespace or the end of the line follows; "3.5" and "e.g.x" do not end one.
const END = /[.!?…]+["'”’»)\]]*(?=\s|$)/gu;

// The pieces of a case's text, in order, trimmed, so each is a substring of the text
// (decisions keeps an answer only while some case contains its text). A line break ends
// a piece in both modes. While the box is being typed in, the piece at the end of the
// text is unfinished unless a sentence there ends in its punctuation; otherwise every
// piece is finished.
export const pieces = (text, mode, editing) => {
  const out = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const open = i === lines.length - 1;
    const parts = [];
    if (mode === "paragraphs") parts.push({ text: line, closed: !open });
    else {
      let start = 0;
      for (const m of line.matchAll(END)) {
        const end = m.index + m[0].length;
        parts.push({ text: line.slice(start, end), closed: true });
        start = end;
      }
      parts.push({ text: line.slice(start), closed: !open });
    }
    for (const p of parts) {
      const t = p.text.trim();
      if (t) out.push({ text: t, finished: !editing || p.closed });
    }
  });
  return out;
};

// The switched-on tools of the project, as Judge uses them: tools and questions being
// removed are left out.
export const onTools = (rubrics, project) =>
  live(rubrics)
    .filter((r) => r.project === project && r.on)
    .map((r) => ({ ...r, questions: live(r.questions) }));

// The tools as passages.requested carries them: every switched-on tool with its live
// questions and options, in the contract shape — the same snapshot as case-editor's
// Judge.
export const tools = (rubrics, project) =>
  onTools(rubrics, project)
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
    }));

// A question decisions and llm: decide accept: not blank, and a pick question with at
// least two options.
const askable = (q) => q.text.trim() !== "" && (q.kind !== "pick" || live(q.options).length >= 2);

// Why no piece can be judged now, in the Case tab's words, or null when they can. A
// Judge run going does not stop pieces: decisions lets them wait for it.
export const blocked = ({ draft, rubrics, current, signedIn, keySet }) => {
  if (!signedIn) return "Sign in to judge.";
  if (!keySet) return "Add your Jev key in Settings.";
  if (!live(rubrics).some((r) => r.project === current)) return "Make a tool in Tools to judge.";
  const on = onTools(rubrics, current);
  if (!on.length) return "Switch on a tool in Tools to judge.";
  if (!on.some((t) => t.questions.some(askable))) return "Add a question to a tool to judge.";
  if (!draft?.text.trim()) return "Write the text to judge.";
  return null;
};

// What stopped the pieces, by decisions' reason, in the Case tab's words.
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

const optionName = (q, id) => {
  const o = q.options.find((x) => x.id === id);
  return o ? o.name.trim() || "Untitled option" : "Removed option";
};

// One piece's row: its text, and while finished either "Judging…" or one line per
// switched-on tool, each with an entry per answered question: a pick question's pick and
// how sure Jev is, as the Case tab shows it; a yes / no question's chance of yes, toned
// yes at 60% or more and no at 40% or less. `judged` is false when no tool has an answer.
export const rows = (list, on, passages) =>
  list.map((p) => {
    if (!p.finished) return { text: p.text, finished: false };
    if (passages.waiting.includes(p.text)) return { text: p.text, finished: true, waiting: true, tools: [] };
    const lines = on.map((t) => {
      const found = passages.answers.find((a) => a.text === p.text && a.rubric === t.id);
      const entries = t.questions.flatMap((q) => {
        const a = found?.answers.find((x) => x.id === q.id);
        if (!a) return [];
        if (q.kind === "pick") return [{ id: q.id, kind: "pick", pick: optionName(q, a.choice), sure: pct(a.p) }];
        const n = pct(a.p);
        return [{ id: q.id, kind: "yesno", text: q.text.trim() || "Untitled question", pct: n, tone: n >= 60 ? "yes" : n <= 40 ? "no" : "" }];
      });
      return { id: t.id, name: t.name.trim() || "Untitled tool", entries };
    });
    return { text: p.text, finished: true, waiting: false, judged: lines.some((l) => l.entries.length > 0), tools: lines };
  });

const NONE = { answers: [], waiting: [], error: null };

// The pieces part of decisions' picture; a store written before pieces has none.
const passagesOf = (body) => body?.passages ?? NONE;

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

// The passages.requested payload for the draft as it stands, or null when nothing can be
// judged or no piece is finished. A piece written twice is asked once.
export const request = (context, editing) => {
  if (!context.draft || blocked(context) !== null) return null;
  const rubrics = tools(context.rubrics, context.current);
  const passages = [...new Set(pieces(context.draft.text, context.mode, editing).filter((p) => p.finished).map((p) => p.text))];
  if (!rubrics.length || !passages.length) return null;
  return { project: context.current, rubrics, passages };
};

const ask = (editing) =>
  enqueueActions(({ context, enqueue }) => {
    const payload = request(context, editing);
    if (payload) enqueue.emit({ type: "passages.requested", ...payload });
  });

const save = enqueueActions(({ context, enqueue }) => {
  if (savable(context)) enqueue.emit({ type: "case.saved", ...wire(context.draft) });
});

// The open case after case.changed. While typing waits to be saved, the same case keeps
// what is on screen; another open case, from a pick or a delete, replaces it after the
// typing is saved, and its pieces are asked for.
const follow = (dirty) =>
  enqueueActions(({ context, event, enqueue }) => {
    const id = event.open[context.current];
    if (dirty && context.draft && id !== context.draft.id && savable(context))
      enqueue.emit({ type: "case.saved", ...wire(context.draft) });
    const keep = dirty && context.draft && id === context.draft.id;
    const draft = keep ? context.draft : opened(event.cases, event.open, context.current);
    const other = draft?.id !== context.draft?.id;
    enqueue.assign(() => ({ cases: event.cases, open: event.open, draft, ...(other ? { editing: false } : {}) }));
    if (other) enqueue(ask(false));
  });

const moved = (context, id) => !context.draft || id !== context.draft.id;

// Another project has its own open case; while typing waits, the one being left is saved
// first.
const switched = (dirty) => ({
  guard: ({ context, event }) => event.current !== context.current,
  target: "clean",
  actions: [
    ...(dirty ? [save] : []),
    assign(({ context, event }) => ({ current: event.current, editing: false, draft: opened(context.cases, context.open, event.current) })),
    ask(false),
  ],
});

const edit = assign(({ context, event }) => ({ draft: { ...context.draft, text: event.text }, editing: true }));

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
  id: "case-journal",
  meta: {
    description:
      "The Journal tab: the open case's text, split into pieces, each judged by Jev on its own " +
      "with every tool that is on. A switch at the top chooses Sentences or Paragraphs and is " +
      "remembered on this device. The text box edits the same case text as the Case tab and is " +
      "saved the same way; with no case open, a large New case button starts one, as in the " +
      "Case tab. Under the box, one row per piece in order, with the piece's text and one line " +
      "per tool that is on: a pick-one question shows the pick and how sure Jev is, a yes / no " +
      "question the chance of yes in the Case tab's colours, a piece waiting for Jev says " +
      "\"Judging…\", and a piece not finished yet is dimmed and not judged. A sentence is " +
      "finished at . ! ? or … (closing quotes or brackets allowed) or a line break; a paragraph " +
      "at a line break; and every non-empty piece when a case is opened or the box loses focus. " +
      "Finished pieces are sent to be judged after each save, on blur and when a case is " +
      "opened; a piece already judged with the same tools is never sent again, so editing one " +
      "sentence re-judges only that one. One line says why nothing is judged (signed out, no " +
      "Jev key, no tool on, no text) in the Case tab's words, or why judging stopped. There are " +
      "no ticks or crosses: right answers belong to the whole case.",
    kind: "view",
    emits: ["case.saved", "case.selected", "passages.requested"],
    attributes: [],
    asks: ["projects: read", "cases: read", "rubrics: read", "decisions: read", "llm: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    throttleMs: input.throttleMs ?? 200,
    mode: MODES.includes(input.mode) ? input.mode : "sentences",
    current: null,
    cases: [],
    open: {},
    rubrics: [],
    passages: NONE,
    signedIn: false,
    keySet: false,
    draft: null,
    editing: false,
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
            actions: [
              assign(({ event }) => {
                const [p, c, r, d, l] = event.output;
                return {
                  current: p.current,
                  cases: c.cases,
                  open: c.open,
                  rubrics: r.rubrics,
                  passages: passagesOf(d),
                  signedIn: l?.signedIn === true,
                  keySet: l?.jev?.keySet === true,
                  draft: opened(c.cases, c.open, p.current),
                };
              }),
              ask(false),
            ],
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
            _edit: { guard: ({ context }) => Boolean(context.draft), target: "dirty", actions: edit },
            _blur: { actions: [assign({ editing: false }), ask(false)] },
            "case.changed": { actions: follow(false) },
            "project.changed": switched(false),
          },
        },
        // Typing within the window joins the one save at its end: a throttle, not a
        // debounce, so the targetless edits below never restart the timer.
        dirty: {
          on: {
            _edit: { actions: edit },
            _blur: { target: "clean", actions: [assign({ editing: false }), save, ask(false)] },
            "case.changed": [
              { guard: ({ context, event }) => moved(context, event.open[context.current]), target: "clean", actions: follow(true) },
              { actions: follow(true) },
            ],
            "project.changed": switched(true),
          },
          after: { throttle: { target: "clean", actions: [save, ask(true)] } },
        },
      },
      on: {
        // Sentences or Paragraphs: the new pieces of the text as it stands are asked for.
        _mode: {
          guard: ({ context, event }) => MODES.includes(event.mode) && event.mode !== context.mode,
          actions: [assign(({ event }) => ({ mode: event.mode })), ask(false)],
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
    "decision.changed": { actions: assign(({ event }) => ({ passages: passagesOf(event) })) },
    "llm.changed": { actions: assign(({ event }) => ({ signedIn: event.signedIn === true, keySet: event.jev?.keySet === true })) },
  },
});

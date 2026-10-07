import { setup, assign, emit, fromPromise } from "xstate";

// The stage of the Gauge app (a view, 3.1): the post, the Score button and one card per
// gauge. It owns only UI state — the post being typed, kept on the device (3.1), and how
// the last Score went — and points at two facts: `gauge` for the gauges and their
// readings, `llm` for whether Jev can be asked and for the asking itself. A Score sends
// every question of every gauge, with the post, in one `llm: decide`, and announces
// Jev's answers as gauge.read (4.3, fifth rule); `gauge` scores them and announces the
// cards' new picture as gauge.changed. The ask and the device storage arrive through
// input, so the machine is a pure definition importable in Node.

// The band a score falls in. `gauge` keeps the same rule for the list; components never
// import each other (11.2), so the two copies are a known duplication.
export const band = (s) => (s == null ? null : s > 0.7 ? "high" : s >= 0.4 ? "mixed" : "low");

// Which way an answer leans, in a word. Unsure sits in the middle fifth.
export const leaning = (p) => {
  if (p >= 0.8) return { word: "Yes", side: "yes" };
  if (p >= 0.6) return { word: "Leans yes", side: "yes" };
  if (p > 0.4) return { word: "Unsure", side: "unsure" };
  if (p > 0.2) return { word: "Leans no", side: "no" };
  return { word: "No", side: "no" };
};

// What a failed Score says, by the reply's error code.
export const errorText = (code) => {
  switch (code) {
    case "signed-out":
      return "Sign in to score.";
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
      return "A score is still running.";
    default:
      return "Jev is unavailable.";
  }
};

const DIRECT = "direct";

// One llm: decide payload for every gauge: an item per written question, named
// "<gauge>/<question>", and one "<gauge>/direct" for a written headline, so the post
// travels once. Criteria are passed as written; `llm` leaves out an empty pair.
export const payload = (gauges, text) => {
  const questions = [];
  for (const g of gauges) {
    for (const q of g.questions) {
      if (q.text.trim()) questions.push({ id: `${g.id}/${q.id}`, instructions: q.text, yes: q.yes, no: q.no });
    }
    if (g.question.trim()) questions.push({ id: `${g.id}/${DIRECT}`, instructions: g.question });
  }
  return { state: { post: text }, questions };
};

// Jev's answers back into one reading per gauge that was asked.
export const readings = (answers) => {
  const byGauge = new Map();
  for (const { id, p } of answers) {
    const cut = id.indexOf("/");
    if (cut < 0) continue;
    const gauge = id.slice(0, cut);
    const question = id.slice(cut + 1);
    if (!byGauge.has(gauge)) byGauge.set(gauge, { id: gauge, answers: [], direct: null });
    const r = byGauge.get(gauge);
    if (question === DIRECT) r.direct = p;
    else r.answers.push({ id: question, p });
  }
  return [...byGauge.values()];
};

// Why Score cannot run now, in the words the line under it shows, or null when it can.
export const blocked = (context) => {
  if (!context.signedIn) return "Sign in to score.";
  if (!context.keySet) return "Add your Jev key in Settings.";
  if (!context.text.trim()) return "Paste a post to score.";
  if (!payload(context.gauges, context.text).questions.length) return "Add a question to a tool to score.";
  return null;
};

const adoptLlm = (picture) => ({ signedIn: picture?.signedIn === true, keySet: picture?.jev?.keySet === true });

// Typing keeps the post on the device; after a failure it also clears the error, so
// the line under Score speaks about the post as it now is.
const typing = (target) => ({
  _type: {
    target,
    actions: [assign({ text: ({ event }) => event.text, error: null }), ({ context }) => context.remember(context.text)],
  },
});

export const machine = setup({
  actors: {
    gauges: fromPromise(({ input }) => input.ask("gauge", "read", {})),
    llm: fromPromise(({ input }) => input.ask("llm", "read", {})),
    decide: fromPromise(({ input }) => input.ask("llm", "decide", input.payload)),
  },
  guards: {
    canScore: ({ context }) => blocked(context) === null,
  },
}).createMachine({
  id: "gauge-post",
  meta: {
    kind: "view",
    emits: ["gauge.read"],
    attributes: ["height"],
    asks: ["gauge: read", "llm: read", "llm: decide"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    remember: input.remember,
    text: input.recall() ?? "",
    gauges: [],
    signedIn: false,
    keySet: false,
    // The last Score that came back: how many tools and questions went, and Jev's time.
    last: null,
    error: null,
  }),
  initial: "loadingGauges",
  states: {
    loadingGauges: {
      invoke: {
        src: "gauges",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: { target: "loadingLlm", actions: assign({ gauges: ({ event }) => event.output.gauges ?? [] }) },
        onError: "loadingLlm",
      },
    },
    loadingLlm: {
      invoke: {
        src: "llm",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: { target: "ready", actions: assign(({ event }) => adoptLlm(event.output)) },
        onError: "ready",
      },
    },
    ready: {
      on: { ...typing(undefined), _score: { guard: "canScore", target: "scoring" } },
    },
    scoring: {
      on: { _type: { actions: [assign({ text: ({ event }) => event.text }), ({ context }) => context.remember(context.text)] } },
      invoke: {
        src: "decide",
        input: ({ context }) => ({ ask: context.ask, payload: payload(context.gauges, context.text) }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output.answers),
            target: "ready",
            actions: [
              emit(({ event }) => ({ type: "gauge.read", readings: readings(event.output.answers) })),
              assign({
                last: ({ event }) => {
                  const asked = readings(event.output.answers);
                  return { tools: asked.length, questions: event.output.answers.length, ms: event.output.ms, inputTokens: event.output.inputTokens };
                },
                error: null,
              }),
            ],
          },
          { target: "failed", actions: assign({ error: ({ event }) => event.output.error ?? "unavailable" }) },
        ],
        onError: { target: "failed", actions: assign({ error: "unavailable" }) },
      },
    },
    failed: {
      on: { ...typing("ready"), _score: { guard: "canScore", target: "scoring" } },
    },
  },
  on: {
    "gauge.changed": { actions: assign({ gauges: ({ event }) => event.gauges }) },
    "llm.changed": { actions: assign(({ event }) => adoptLlm(event)) },
  },
});

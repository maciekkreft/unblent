import { setup, assign, emit, fromPromise } from "xstate";

// The stage of the Gauge app (a view, 3.1): the post, the Score button and one card per
// gauge. It owns only UI state — the post being typed, kept on the device (3.1), how the
// last Score went, and which scoring is on the stage — and points at three facts: `gauge`
// for the gauges, `llm` for whether Jev can be asked and for the asking itself, and
// `scorings` for the scorings kept. A Score sends every question of every gauge, with the
// post, in one `llm: decide`, and announces Jev's answers twice (4.3, fifth rule): as
// gauge.read, which keeps each tool's last reading for the Tools list, and as post.scored,
// the whole record `scorings` keeps. The cards draw that record, not the gauges, so an
// old scoring picked in History reads as it was. The ask, the clock, the id minting and
// the device storage arrive through input, so the machine is a pure definition
// importable in Node.

// The band a score falls in. `gauge` keeps the same rule for the list; components never
// import each other (11.2), so the two copies are a known duplication.
export const band = (s) => (s == null ? null : s > 0.7 ? "high" : s >= 0.4 ? "mixed" : "low");

// A question's short name on the card: its own, or its first clause.
export const short = (q) => q.label?.trim() || q.text.split(/[,:]/)[0].trim() || "Untitled question";

// The headline question's short name under the dial, found the same way.
export const headline = (g) => g.label?.trim() || g.question.split(/[,:?]/)[0].trim() || "Untitled tool";

// Which way an answer leans, in a word. Unsure sits in the middle fifth.
export const leaning = (p) => {
  if (p >= 0.8) return { word: "Yes", side: "yes" };
  if (p >= 0.6) return { word: "Leans yes", side: "yes" };
  if (p > 0.4) return { word: "Unsure", side: "unsure" };
  if (p > 0.2) return { word: "Leans no", side: "no" };
  return { word: "No", side: "no" };
};

// Jev's price, from typesafe.ai on 2026-10-07: $42 per billion input tokens. Jev bills
// input only, so the reply's input tokens are the whole cost.
const DOLLARS_PER_TOKEN = 42 / 1e9;

// What a Score cost, in dollars to two significant figures, since one costs a small
// fraction of a cent.
export const cost = (tokens) => {
  const c = tokens * DOLLARS_PER_TOKEN;
  if (!(c > 0)) return "$0";
  return `$${c.toFixed(Math.max(2, 1 - Math.floor(Math.log10(c))))}`;
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
    if (g.question.trim())
      questions.push({ id: `${g.id}/${DIRECT}`, instructions: g.question, yes: g.yes ?? "", no: g.no ?? "" });
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

// The record of one Score, self-contained so a later edit of a tool never changes it:
// each asked gauge's name and short names as the card showed them, its headline answer,
// and the answers to questions it still has.
export const record = ({ id, at, text, gauges, answers }) => ({
  id,
  at,
  text,
  gauges: readings(answers).flatMap((r) => {
    const g = gauges.find((x) => x.id === r.id);
    if (!g) return [];
    const questions = r.answers.flatMap((a) => {
      const q = g.questions.find((x) => x.id === a.id);
      return q ? [{ id: q.id, label: short(q), p: a.p }] : [];
    });
    return [{ id: g.id, name: g.name, label: headline(g), direct: r.direct, questions }];
  }),
});

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
    scorings: fromPromise(({ input }) => input.ask("scorings", "list", {})),
    scoring: fromPromise(({ input }) => input.ask("scorings", "read", { id: input.id })),
  },
  guards: {
    canScore: ({ context }) => blocked(context) === null,
  },
}).createMachine({
  id: "gauge-post",
  meta: {
    description:
      "The stage of the Gauge app: a box for the text to judge, a Score button, and one card " +
      "per gauge. A card's dial shows Jev's answer to the tool's own question, as High, Mixed " +
      "or Low with no number, and its rows show how Jev answered each of the tool's other " +
      "questions, which explain the reading. Score sends every question of every gauge with " +
      "the text in one request to Jev and keeps the result as a scoring; the stage shows the " +
      "newest scoring, or the one picked in History, whose post comes back into the box. The " +
      "text being typed is kept on this device. When Score cannot run, for example while " +
      "signed out or without a Jev key, the line under the button says why.",
    kind: "view",
    emits: ["gauge.read", "post.scored"],
    attributes: ["height"],
    asks: ["gauge: read", "llm: read", "llm: decide", "scorings: list", "scorings: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    remember: input.remember,
    mint: input.mint,
    now: input.now,
    text: input.recall() ?? "",
    gauges: [],
    signedIn: false,
    keySet: false,
    // The last Score that came back: how many tools and questions went, and Jev's time.
    last: null,
    error: null,
    // The scoring on the stage, in full, or null before any.
    shown: null,
  }),
  initial: "loadingGauges",
  states: {
    loadingGauges: {
      tags: "loading",
      invoke: {
        src: "gauges",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: { target: "loadingLlm", actions: assign({ gauges: ({ event }) => event.output.gauges ?? [] }) },
        onError: "loadingLlm",
      },
    },
    loadingLlm: {
      tags: "loading",
      invoke: {
        src: "llm",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: { target: "loadingScorings", actions: assign(({ event }) => adoptLlm(event.output)) },
        onError: "loadingScorings",
      },
    },
    // The stage opens on the newest scoring, as History marks it.
    loadingScorings: {
      tags: "loading",
      invoke: {
        src: "scorings",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.scorings?.length), target: "loadingShown", actions: assign({ shown: ({ event }) => ({ id: event.output.scorings[0].id }) }) },
          { target: "ready" },
        ],
        onError: "ready",
      },
    },
    loadingShown: {
      tags: "loading",
      invoke: {
        src: "scoring",
        input: ({ context }) => ({ ask: context.ask, id: context.shown.id }),
        onDone: { target: "ready", actions: assign({ shown: ({ event }) => event.output.scoring ?? null }) },
        onError: { target: "ready", actions: assign({ shown: null }) },
      },
    },
    ready: {
      on: { ...typing(undefined), _score: { guard: "canScore", target: "scoring" }, "scoring.selected": "recalling" },
    },
    // A scoring picked in History: its record comes onto the stage and its post into the
    // box, so it can be read in full or scored again.
    recalling: {
      on: {
        ...typing(undefined),
        "scoring.selected": { target: "recalling", reenter: true },
      },
      invoke: {
        src: "scoring",
        input: ({ context, event }) => ({ ask: context.ask, id: event.id }),
        onDone: [
          {
            guard: ({ event }) => event.output.scoring != null,
            target: "ready",
            actions: [
              assign({ shown: ({ event }) => event.output.scoring, text: ({ event }) => event.output.scoring.text, error: null }),
              ({ context }) => context.remember(context.text),
            ],
          },
          { target: "ready" },
        ],
        onError: "ready",
      },
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
                shown: ({ context, event }) =>
                  record({ id: context.mint(), at: context.now(), text: context.text, gauges: context.gauges, answers: event.output.answers }),
              }),
              emit(({ context }) => ({ type: "post.scored", ...context.shown })),
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
      on: { ...typing("ready"), _score: { guard: "canScore", target: "scoring" }, "scoring.selected": "recalling" },
    },
  },
  on: {
    "gauge.changed": { actions: assign({ gauges: ({ event }) => event.gauges }) },
    "llm.changed": { actions: assign(({ event }) => adoptLlm(event)) },
    // The scoring on the stage was deleted in History: the stage empties rather than
    // showing what is gone.
    "scoring.changed": {
      guard: ({ context, event }) => context.shown != null && !event.scorings.some((s) => s.id === context.shown.id),
      actions: assign({ shown: null }),
    },
  },
});

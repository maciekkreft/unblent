import { setup, assign, emit } from "xstate";

// A local-only fact component (3.1): headless owner of the scorings, each post scored on
// this device with every answer per gauge. gauge-post, where the user pressed Score,
// emits the whole record as post.scored; scoring-list, where the user deleted one, emits
// scoring.discarded once its undo window ran out (4.3, fifth rule). This fact keeps them,
// announces their headers as scoring.changed, and answers scorings: list for the headers
// and scorings: read for one record in full. The store arrives through `input`, so the
// machine is a pure definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const str = (v) => (typeof v === "string" ? v : "");
const isP = (p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;

// The newest are kept and the oldest dropped, so the store and every scoring.changed stay
// small on a device that scores every day.
export const CAP = 200;

// A header's text is the post's first line, cut, because the trace keeps and bridges
// every scoring.changed and the whole post on every row would be the heavy case.
const FIRST_LINE = 200;

// The band a score falls in. `gauge` and `gauge-post` keep the same thresholds; components
// never import each other (11.2), so this third copy is a known duplication.
export const band = (s) => (s == null ? null : s > 0.7 ? "high" : s >= 0.4 ? "mixed" : "low");

const answer = (q) => (q && isId(q.id) && isP(q.p) ? { id: q.id, label: str(q.label), p: q.p } : null);

const gauge = (g) =>
  g && isId(g.id)
    ? {
        id: g.id,
        name: str(g.name),
        label: str(g.label),
        direct: isP(g.direct) ? g.direct : null,
        questions: (Array.isArray(g.questions) ? g.questions : []).map(answer).filter(Boolean),
      }
    : null;

// A scoring in the post.scored shape, or null when it has no valid id or time.
export const normalise = (value) => {
  if (!value || !isId(value.id) || !Number.isInteger(value.at)) return null;
  return {
    id: value.id,
    at: value.at,
    text: str(value.text),
    gauges: (Array.isArray(value.gauges) ? value.gauges : []).map(gauge).filter(Boolean),
  };
};

export const header = (s) => ({
  id: s.id,
  at: s.at,
  text: s.text.split("\n")[0].slice(0, FIRST_LINE),
  gauges: s.gauges.map((g) => ({ id: g.id, name: g.name, band: band(g.direct) })),
});

// What the store held, as scorings newest first; nothing or garbage is an empty history.
export const parse = (stored) => {
  if (stored == null || stored === "") return [];
  try {
    const value = JSON.parse(stored);
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.map(normalise).filter((s) => s && !seen.has(s.id) && seen.add(s.id)).slice(0, CAP);
  } catch {
    return [];
  }
};

const headers = (context) => context.scorings.map(header);

const change = (next) => ({
  actions: [
    assign({ scorings: ({ context, event }) => next(context.scorings, event) }),
    ({ context }) => context.save(JSON.stringify(context.scorings)),
    emit(({ context }) => ({ type: "scoring.changed", scorings: headers(context) })),
  ],
});

export const machine = setup({}).createMachine({
  id: "scorings",
  meta: {
    description:
      "Owns the scorings, kept on this device: every time a post is scored in Gauge, the post, " +
      "when it was scored, and each tool's name, its headline answer and its questions' answers, " +
      "as they were at that moment, so a later edit of a tool never changes what was recorded. " +
      "The newest 200 are kept; an older one is dropped when a new one arrives. A scoring the " +
      "user deletes is removed once its undo window has run out.",
    kind: "fact",
    shape: "local-only",
    emits: ["scoring.changed"],
    owns: "the scorings: each post scored on this device and every answer per gauge",
  },
  context: ({ input }) => ({ scorings: parse(input.stored), save: input.save }),
  on: {
    "post.scored": {
      guard: ({ event }) => normalise(event) !== null,
      ...change((scorings, event) => {
        const s = normalise(event);
        return [s, ...scorings.filter((x) => x.id !== s.id)].slice(0, CAP);
      }),
    },
    "scoring.discarded": {
      guard: ({ context, event }) => context.scorings.some((s) => s.id === event.id),
      ...change((scorings, event) => scorings.filter((s) => s.id !== event.id)),
    },
    "list?": {
      actions: ({ context, event }) => event.reply({ scorings: headers(context) }),
    },
    "read?": {
      actions: ({ context, event }) =>
        event.reply({ scoring: context.scorings.find((s) => s.id === event.payload?.id) ?? null }),
    },
  },
});

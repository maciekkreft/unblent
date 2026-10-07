import { setup, assign, emit } from "xstate";

// A local-only fact component (3.1): headless owner of the gauges. A gauge is a tool of
// yes/no questions with a rule that turns Jev's answers into one score, and the last
// reading of it. gauge-editor, where the user edits, emits the whole gauge as
// gauge.saved; gauge-post, where the user pressed Score, emits Jev's answers as
// gauge.read (4.3, fifth rule). This fact keeps them, saves them and announces the whole
// list as gauge.changed, and answers gauge: read for the starting picture. The store and
// the clock arrive through `input`, so the machine is a pure definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const str = (v) => (typeof v === "string" ? v : "");
const isP = (p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;

// A zero answer under "every question must hold" would make the log -Infinity; flooring
// it keeps the geometric mean a number that is still effectively zero.
const FLOOR = 1e-6;

// The rule's score from the answers: "adds" is the average, "holds" the geometric mean,
// so one answer near zero sinks a "holds" gauge and only lowers an "adds" one.
export const score = (rule, answers) => {
  if (!answers.length) return null;
  const ps = answers.map((a) => a.p);
  if (rule === "holds") return Math.exp(ps.reduce((s, p) => s + Math.log(Math.max(p, FLOOR)), 0) / ps.length);
  return ps.reduce((s, p) => s + p, 0) / ps.length;
};

// The band a score falls in. gauge-post keeps its own copy for the dial: components
// never import each other (11.2).
export const band = (s) => (s == null ? null : s > 0.7 ? "high" : s >= 0.4 ? "mixed" : "low");

const question = (q) => {
  if (!q || !isId(q.id) || typeof q.text !== "string") return null;
  const out = { id: q.id, text: q.text, yes: str(q.yes), no: str(q.no) };
  if (typeof q.label === "string") out.label = q.label;
  return out;
};

// A reading kept against the gauge's current questions and rule: answers to questions
// since removed are dropped and the score is recomputed, so a rule change re-scores
// without asking Jev again.
const reading = (value, questions, rule) => {
  if (!value || !Number.isInteger(value.at)) return null;
  const ids = new Set(questions.map((q) => q.id));
  const answers = (Array.isArray(value.answers) ? value.answers : [])
    .filter((a) => a && ids.has(a.id) && isP(a.p))
    .map((a) => ({ id: a.id, p: a.p }));
  const s = score(rule, answers);
  return { at: value.at, answers, direct: isP(value.direct) ? value.direct : null, score: s, band: band(s) };
};

// Sanitise a candidate into the contract shape, or null when it has no valid id.
export const normalise = (value) => {
  if (!value || !isId(value.id)) return null;
  const rule = value.rule === "holds" ? "holds" : "adds";
  const questions = (Array.isArray(value.questions) ? value.questions : []).map(question).filter(Boolean);
  return {
    id: value.id,
    name: str(value.name),
    question: str(value.question),
    rule,
    questions,
    reading: reading(value.reading, questions, rule),
  };
};

const q = (id, label, text, yes, no) => ({ id, text, yes, no, label });

// The four tools a first visit starts with (the plan's seed). The ids are fixed, so the
// seed is the same in every browser and in the tests.
export const SEED = Object.freeze([
  {
    id: "01K6SEED00000000000000G1Q0",
    name: "Followability",
    question: "Does this post give someone a reason to want more from this account?",
    rule: "adds",
    questions: [
      q("01K6SEED00000000000000G1Q1", "Signals more in this area",
        "Does this post signal that the account will keep producing content in this area?",
        "it reads as one of a series, names a practice or a project the author returns to, or refers to earlier or coming posts",
        "it is a one-off reaction with no sign the author writes about this again"),
      q("01K6SEED00000000000000G1Q2", "Future posts are predictable",
        "After reading, is it clear what kind of future posts this account produces?",
        "a reader could describe the next post's likely topic and form",
        "the post could have come from any account about anything"),
      q("01K6SEED00000000000000G1Q3", "Expertise or a point of view",
        "Does the post demonstrate expertise or a distinct point of view?",
        "it takes a position or uses first-hand specifics a generalist would not have",
        "it states a truism anyone could write"),
      q("01K6SEED00000000000000G1Q4", "Would miss out by not following",
        "Would someone interested in this topic feel they would miss something by not following?",
        "it holds something hard to get elsewhere that a reader of this topic would want more of",
        "the same thing is said everywhere"),
    ],
  },
  {
    id: "01K6SEED00000000000000G2Q0",
    name: "Shareability",
    question: "Does this post give someone a reason to send it to another specific person?",
    rule: "adds",
    questions: [
      q("01K6SEED00000000000000G2Q1", "A line that stands alone",
        "Does the post contain a single idea or line that stands on its own outside context?",
        "one sentence can be quoted alone and still make its point",
        "the point depends on the thread, an image or the reply it answers"),
      q("01K6SEED00000000000000G2Q2", "Reminds me of someone",
        "Is there a clear 'this reminds me of someone' trigger?",
        "it describes a situation or a type of person a reader is likely to know by name",
        "it is about the author alone, or about no one in particular"),
      q("01K6SEED00000000000000G2Q3", "Strong reaction",
        "Does the post provoke a reaction strong enough to prompt sharing?",
        "it surprises, amuses, validates or outrages",
        "it is neutral information, however useful"),
      q("01K6SEED00000000000000G2Q4", "Reflects well on the sharer",
        "Does sharing this reflect well on the sharer?",
        "passing it on makes the sender look informed, funny or early",
        "sharing it would look like promotion, bragging or noise"),
    ],
  },
  {
    id: "01K6SEED00000000000000G3Q0",
    name: "Likeability",
    question: "Does this post give someone a reason to signal quick agreement or approval?",
    rule: "adds",
    questions: [
      q("01K6SEED00000000000000G3Q1", "Grasped in five seconds",
        "Can the core point be grasped and agreed or disagreed with in under five seconds?",
        "the point is in the first line and needs no re-reading",
        "it needs the whole post or outside context"),
      q("01K6SEED00000000000000G3Q2", "Affirms a held belief",
        "Does the post affirm a belief or value the target reader likely already holds?",
        "it says something the reader already thinks, said well",
        "it argues against the reader or stays neutral"),
      q("01K6SEED00000000000000G3Q3", "Low effort to react to",
        "Is the tone or format low-effort to react to?",
        "a clear statement, a one-liner or a short list",
        "a long argument, data or a question needing thought"),
      q("01K6SEED00000000000000G3Q4", "Not too niche",
        "Does it avoid being so niche or complex that most readers could not form an opinion quickly?",
        "most readers of the account's topic can form an opinion at once",
        "it needs specialist knowledge"),
    ],
  },
  {
    id: "01K6SEED00000000000000G4Q0",
    name: "Saveability",
    question: "Does this post give someone a reason to come back to it later?",
    rule: "adds",
    questions: [
      q("01K6SEED00000000000000G4Q1", "Reusable information",
        "Does the post contain reusable information: a list, framework, template, resource or reference?",
        "it holds a list, a framework, a template, a resource or a reference",
        "it is an opinion or a story with nothing to reuse"),
      q("01K6SEED00000000000000G4Q2", "Too dense for one read",
        "Is the information dense enough that a reader could not fully absorb or use it in one read?",
        "there is more than a reader can use in one read",
        "one idea, absorbed at once"),
      q("01K6SEED00000000000000G4Q3", "Needed again later",
        "Would a reader plausibly need this again in a different context later?",
        "a reader can name a future moment they would want it, 'next time I…'",
        "it is only interesting now"),
      q("01K6SEED00000000000000G4Q4", "Easy to scan back through",
        "Is the format structured so it is easy to scan back through?",
        "numbered or bulleted, with a structure to jump back into",
        "a narrative that must be re-read start to finish"),
    ],
  },
].map(normalise));

// What the store held, as gauges, or the seed when nothing is stored or it does not
// parse. An empty stored list stays empty: the user deleted every tool.
export const parse = (stored) => {
  if (stored == null || stored === "") return SEED.map((g) => ({ ...g }));
  try {
    const value = JSON.parse(stored);
    if (!Array.isArray(value)) return SEED.map((g) => ({ ...g }));
    const seen = new Set();
    return value.map(normalise).filter((g) => g && !seen.has(g.id) && seen.add(g.id));
  } catch {
    return SEED.map((g) => ({ ...g }));
  }
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The list after a gesture: the saved gauge in place of the one with its id (keeping and
// re-scoring that one's reading), or appended when it is new.
const saved = (gauges, event) => {
  const next = normalise({ ...event, reading: null });
  if (!next) return gauges;
  const old = gauges.find((g) => g.id === next.id);
  if (!old) return [...gauges, next];
  const kept = { ...next, reading: reading(old.reading, next.questions, next.rule) };
  return gauges.map((g) => (g.id === next.id ? kept : g));
};

const read = (gauges, readings, at) =>
  gauges.map((g) => {
    const r = readings.find((x) => x && x.id === g.id);
    return r ? { ...g, reading: reading({ at, answers: r.answers, direct: r.direct }, g.questions, g.rule) } : g;
  });

// Every gesture becomes a candidate list; only a list that differs is saved and
// announced, so a repeat stores and emits nothing.
const change = (next) => ({
  guard: ({ context, event }) => !same(next(context, event), context.gauges),
  actions: [
    assign({ gauges: ({ context, event }) => next(context, event) }),
    ({ context }) => context.save(JSON.stringify(context.gauges)),
    emit(({ context }) => ({ type: "gauge.changed", gauges: context.gauges })),
  ],
});

export const machine = setup({}).createMachine({
  id: "gauge",
  meta: {
    kind: "fact",
    shape: "local-only",
    emits: ["gauge.changed"],
    owns: "the gauges: tools of yes/no questions and their last readings",
  },
  context: ({ input }) => ({ gauges: parse(input.stored), save: input.save, now: input.now }),
  on: {
    "gauge.saved": change((context, event) => saved(context.gauges, event)),
    "gauge.discarded": change((context, event) => context.gauges.filter((g) => g.id !== event.id)),
    "gauge.read": change((context, event) =>
      read(context.gauges, Array.isArray(event.readings) ? event.readings : [], context.now()),
    ),
    "read?": {
      actions: ({ context, event }) => event.reply({ gauges: context.gauges }),
    },
  },
});

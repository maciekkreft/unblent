import { setup, assign, emit } from "xstate";

// A local-only fact component (3.1): headless owner of the gauges. A gauge is a tool of
// yes/no questions, a headline question whose answer is the score, and the last reading
// of it. gauge-editor, where the user edits, emits the whole gauge as
// gauge.saved; gauge-post, where the user pressed Score, emits Jev's answers as
// gauge.read (4.3, fifth rule). This fact keeps them, saves them and announces the whole
// list as gauge.changed, and answers gauge: read for the starting picture. The store and
// the clock arrive through `input`, so the machine is a pure definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const str = (v) => (typeof v === "string" ? v : "");
const isP = (p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;

// The band a score falls in. gauge-post keeps its own copy for the dial: components
// never import each other (11.2).
export const band = (s) => (s == null ? null : s > 0.7 ? "high" : s >= 0.4 ? "mixed" : "low");

const question = (q) => {
  if (!q || !isId(q.id) || typeof q.text !== "string") return null;
  const out = { id: q.id, text: q.text, yes: str(q.yes), no: str(q.no) };
  if (typeof q.label === "string") out.label = q.label;
  return out;
};

// A reading kept against the gauge's current questions: answers to questions since
// removed are dropped. The score is Jev's answer to the headline question, because that
// answer is the honest reading; the questions' answers only explain it.
const reading = (value, questions) => {
  if (!value || !Number.isInteger(value.at)) return null;
  const ids = new Set(questions.map((q) => q.id));
  const answers = (Array.isArray(value.answers) ? value.answers : [])
    .filter((a) => a && ids.has(a.id) && isP(a.p))
    .map((a) => ({ id: a.id, p: a.p }));
  const direct = isP(value.direct) ? value.direct : null;
  return { at: value.at, answers, direct, score: direct, band: band(direct) };
};

// Sanitise a candidate into the contract shape, or null when it has no valid id.
export const normalise = (value) => {
  if (!value || !isId(value.id)) return null;
  // The rule no longer counts, but stored gauges and the contract still carry it.
  const rule = value.rule === "holds" ? "holds" : "adds";
  const questions = (Array.isArray(value.questions) ? value.questions : []).map(question).filter(Boolean);
  return {
    id: value.id,
    name: str(value.name),
    question: str(value.question),
    label: str(value.label),
    yes: str(value.yes),
    no: str(value.no),
    rule,
    questions,
    reading: reading(value.reading, questions),
  };
};

const q = (id, label, text, yes, no) => ({ id, text, yes, no, label });

// The tools a first visit starts with (the plan's seed). The ids are fixed, so the seed
// is the same in every browser and in the tests. `since` is the seed version that added a
// tool; it stays in this file and the store's catch-up, never on the bus. A browser
// that already holds a list is never reset to this seed, because the list is the user's
// and may be edited: it only catches up once on what a newer seed version added
// (`catchUp` below).
export const SEED_VERSION = 3;

const SOURCE = [
  {
    id: "01K6SEED00000000000000G5Q0",
    name: "Viewability",
    since: 2,
    question: "Does this post give someone a reason to stop scrolling and read it?",
    label: "Reason to stop and read",
    yes: "a reader scanning a feed would pause on it",
    no: "a reader would pass it without noticing what it said",
    rule: "adds",
    questions: [
      q("01K6SEED00000000000000G5Q1", "Stops the scroll",
        "Does the first line stop the scroll on its own?",
        "the opening line carries a surprise, a claim, a number or a name a reader cannot pass over",
        "the opening is setup that only pays off later"),
      q("01K6SEED00000000000000G5Q2", "Opens a gap",
        "Does the post open a gap the reader wants closed?",
        "it promises something not yet said, such as an outcome, a reveal or a reason",
        "the first line already gives everything away, or promises nothing"),
      q("01K6SEED00000000000000G5Q3", "Known subject",
        "Is the subject one a broad audience already knows?",
        "it names a widely known person, event, product or experience",
        "it needs context only insiders have"),
      q("01K6SEED00000000000000G5Q4", "Taken in at a glance",
        "Is the post easy to take in at a glance?",
        "it is short, or its shape is visible at once: a list, a quote, a before and after",
        "it is a dense block that must be read from the top"),
    ],
  },
  {
    id: "01K6SEED00000000000000G1Q0",
    name: "Followability",
    since: 1,
    question: "Does this post give someone a reason to want more from this account?",
    label: "Reason to want more from this account",
    yes: "a reader of this topic would want the next post from this author",
    no: "nothing suggests the author will say anything more worth reading",
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
    since: 1,
    question: "Does this post give someone a reason to send it to another specific person?",
    label: "Reason to send it to someone",
    yes: "a reader could name the person they would send it to and why",
    no: "it is read, maybe liked, and left",
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
    since: 1,
    question: "Does this post give someone a reason to signal quick agreement or approval?",
    label: "Reason to tap like",
    yes: "a reader would tap like without thinking twice",
    no: "a reader would have to think before reacting, or would not react",
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
    since: 1,
    question: "Does this post give someone a reason to come back to it later?",
    label: "Reason to come back to it",
    yes: "a reader would bookmark it to use again",
    no: "once read it is done with",
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
];

export const SEED = Object.freeze(SOURCE.map(normalise));
const fresh = () => SEED.map((g) => ({ ...g }));

// A list stored by an older seed version catches up once: the seed's wording fills only
// what is empty on the seed's own tools and questions, so nothing the user wrote, renamed,
// added or chose is touched; and a tool a newer seed added appears, unless its id is
// already there. A seed tool the user deleted is not brought back, because it was added
// by a version the list already had.
export const catchUp = (gauges, version) => {
  if (version >= SEED_VERSION) return gauges;
  const fill = (mine, seed) => (mine.trim() ? mine : seed);
  const filled = gauges.map((g) => {
    const seed = SEED.find((s) => s.id === g.id);
    if (!seed) return g;
    return {
      ...g,
      label: fill(g.label, seed.label),
      yes: fill(g.yes, seed.yes),
      no: fill(g.no, seed.no),
      questions: g.questions.map((q) => {
        const sq = seed.questions.find((x) => x.id === q.id);
        return sq ? { ...q, yes: fill(q.yes, sq.yes), no: fill(q.no, sq.no) } : q;
      }),
    };
  });
  const have = new Set(gauges.map((g) => g.id));
  const added = SOURCE.filter((s) => s.since > version && !have.has(s.id)).map(normalise);
  return [...added, ...filled];
};

// What the store held, as gauges at the current seed version: the seed when nothing is
// stored or it does not parse. The store holds { version, gauges }; a bare list is what
// seed version 1 wrote. An empty stored list stays empty: the user deleted every tool.
export const parse = (stored) => {
  if (stored == null || stored === "") return fresh();
  try {
    const value = JSON.parse(stored);
    const list = Array.isArray(value) ? value : value?.gauges;
    if (!Array.isArray(list)) return fresh();
    const version = Array.isArray(value) ? 1 : Number.isInteger(value.version) ? value.version : 1;
    const seen = new Set();
    const gauges = list.map(normalise).filter((g) => g && !seen.has(g.id) && seen.add(g.id));
    return catchUp(gauges, version);
  } catch {
    return fresh();
  }
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The list after a gesture: the saved gauge in place of the one with its id (keeping that
// one's reading, less answers to removed questions), or appended when it is new.
const saved = (gauges, event) => {
  const next = normalise({ ...event, reading: null });
  if (!next) return gauges;
  const old = gauges.find((g) => g.id === next.id);
  if (!old) return [...gauges, next];
  const kept = { ...next, reading: reading(old.reading, next.questions) };
  return gauges.map((g) => (g.id === next.id ? kept : g));
};

const read = (gauges, readings, at) =>
  gauges.map((g) => {
    const r = readings.find((x) => x && x.id === g.id);
    return r ? { ...g, reading: reading({ at, answers: r.answers, direct: r.direct }, g.questions) } : g;
  });

// Every gesture becomes a candidate list; only a list that differs is saved and
// announced, so a repeat stores and emits nothing.
const change = (next) => ({
  guard: ({ context, event }) => !same(next(context, event), context.gauges),
  actions: [
    assign({ gauges: ({ context, event }) => next(context, event) }),
    // The caught-up list is written with the next change, not at load: catching up is
    // idempotent (it fills only what is empty and adds only what is missing), so a load
    // that writes nothing simply catches up again, and loading never writes.
    ({ context }) => context.save(JSON.stringify({ version: SEED_VERSION, gauges: context.gauges })),
    emit(({ context }) => ({ type: "gauge.changed", gauges: context.gauges })),
  ],
});

export const machine = setup({}).createMachine({
  id: "gauge",
  meta: {
    description:
      "Owns the gauges, kept on this device: tools that judge a piece of text with yes-or-no " +
      "questions Jev answers. A gauge's score is Jev's answer to its headline question; its " +
      "other questions, each with optional yes and no criteria and a short name, explain that " +
      "reading and do not change the score. The last reading of each tool is kept. A first " +
      "visit starts with a set of example tools; a later version of that set only adds what is " +
      "new or fills what is empty, never changing what the user wrote and never bringing back a " +
      "tool the user deleted.",
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

import { setup, assign, emit, fromPromise } from "xstate";

// A local-only fact component (3.1): headless owner of the Judge tools. "Tool" already
// names a chat lookup (7.7), so the Judge tool the user sees is a rubric inside the
// system. rubric-editor, where the user edits, emits the whole tool as rubric.saved;
// rubric-list emits rubric.switched; whoever shows a delete emits removal.started, and
// notice-stack emits removal.undone or removal.settled when the undo window ends (4.3,
// fifth rule). This fact keeps the tools, saves them and announces them whole as
// rubric.changed, and answers rubrics: read for the starting picture. It follows
// project.changed and drops the tools of a project that no longer exists; at start it
// asks projects: read once, which sweeps the tools of a project whose removal settled at
// load before this fact heard of it. The store and the ask arrive through `input`, so
// the machine is a pure definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const str = (v) => (typeof v === "string" ? v : "");

// The example projects, copied as literals from `projects`: components never import
// each other (11.2).
const GOALS = "01K6SEED00000000000000PJ01";
const REPLIES = "01K6SEED00000000000000PJ02";
const DISTORTION = "01M4H15KF9MDNCZAKREGYD2J2G";

const option = (o) => (o && isId(o.id) ? { id: o.id, name: str(o.name), description: str(o.description), removing: o.removing === true } : null);

const question = (q) => {
  if (!q || !isId(q.id)) return null;
  return {
    id: q.id,
    kind: q.kind === "pick" ? "pick" : "yesno",
    text: str(q.text),
    yes: str(q.yes),
    no: str(q.no),
    options: (Array.isArray(q.options) ? q.options : []).map(option).filter(Boolean),
    removing: q.removing === true,
  };
};

// A candidate in the contract shape, or null when it has no valid id or project.
export const normalise = (r) => {
  if (!r || !isId(r.id) || !isId(r.project)) return null;
  return {
    id: r.id,
    project: r.project,
    name: str(r.name),
    on: r.on !== false,
    questions: (Array.isArray(r.questions) ? r.questions : []).map(question).filter(Boolean),
    removing: r.removing === true,
  };
};

// The example tools a first visit starts with. The ids are fixed and exported, because
// `cases` keys its right answers by question id and option id; it copies them as
// literals. Cognitive Distortion's tool keeps the ids it had in the browser it was
// written in, so that browser does not gain a copy. `since` is the seed version that
// added a tool; it stays in this file and the catch-up, never on the bus.
export const SEED_VERSION = 2;
export const IDS = Object.freeze({
  goalOrValue: "01K6SEED00000000000000RB01",
  goalOrValuePick: "01K6SEED00000000000000RQ01",
  goal: "01K6SEED00000000000000RC01",
  value: "01K6SEED00000000000000RC02",
  other: "01K6SEED00000000000000RC03",
  goalOrValueYesNo: "01K6SEED00000000000000RB02",
  isGoal: "01K6SEED00000000000000RQ02",
  isValue: "01K6SEED00000000000000RQ03",
});

const yn = (id, text, yes, no) => ({ id, kind: "yesno", text, yes, no, options: [], removing: false });
const opt = (id, name, description) => ({ id, name, description, removing: false });

// Each Replies tool's main question, with its yes and no, is question 1; its id is
// the tool's own with H for headline in place of 0.
const reply = (n, name, on, headline, yes, no, questions) => ({
  id: `01K6SEED00000000000000G${n}Q0`,
  project: REPLIES,
  name,
  on,
  since: 1,
  removing: false,
  questions: [
    yn(`01K6SEED00000000000000G${n}QH`, headline, yes, no),
    ...questions.map(([text, y, nn], i) => yn(`01K6SEED00000000000000G${n}Q${i + 1}`, text, y, nn)),
  ],
});

const SOURCE = [
  {
    id: IDS.goalOrValue,
    project: GOALS,
    name: "Goal or value",
    on: true,
    since: 1,
    removing: false,
    questions: [
      {
        id: IDS.goalOrValuePick,
        kind: "pick",
        text: "Is this a goal, a value, or neither?",
        yes: "",
        no: "",
        options: [
          opt(IDS.goal, "Goal", "Something you can achieve and then it is finished."),
          opt(IDS.value, "Value", "An ongoing way of acting that is never finished."),
          opt(IDS.other, "Other", "Neither a goal nor a value."),
        ],
        removing: false,
      },
    ],
  },
  {
    id: IDS.goalOrValueYesNo,
    project: GOALS,
    name: "Goal or value (yes / no)",
    on: false,
    since: 1,
    removing: false,
    questions: [
      yn(IDS.isGoal, "Is this a goal?", "it is something you can achieve and then it is finished", "it is never finished, or it is not something to achieve"),
      yn(IDS.isValue, "Is this a value?", "it is an ongoing way of acting that is never finished", "it can be finished, or it is not a way of acting"),
    ],
  },
  reply(6, "Replyability", true,
    "Does this post give someone a reason to reply to it?",
    "a reader would have something of their own to add and would write it",
    "a reader would agree, disagree or move on without writing anything", [
      ["Does the post ask the reader something they can answer from their own experience?",
        "it asks a question a reader can answer in a line or two",
        "it asks nothing, or only asks rhetorically"],
      ["Does the post take a position a thoughtful reader could argue with?",
        "a reader could disagree and say why",
        "it is too obvious or too hedged to dispute"],
      ["Does the post leave something unsaid that a reader could add?",
        "an example, a counter-case, a tip or a story of the reader's own fits naturally under it",
        "it is complete, and anything added would repeat it"],
      ["Can a reader reply without first reading anything else?",
        "the post carries all the context a reply needs",
        "a reply needs a thread, a link or insider knowledge first"],
    ]),
  reply(5, "Viewability", false,
    "Does this post give someone a reason to stop scrolling and read it?",
    "a reader scanning a feed would pause on it",
    "a reader would pass it without noticing what it said", [
      ["Does the first line stop the scroll on its own?",
        "the opening line carries a surprise, a claim, a number or a name a reader cannot pass over",
        "the opening is setup that only pays off later"],
      ["Does the post open a gap the reader wants closed?",
        "it promises something not yet said, such as an outcome, a reveal or a reason",
        "the first line already gives everything away, or promises nothing"],
      ["Is the subject one a broad audience already knows?",
        "it names a widely known person, event, product or experience",
        "it needs context only insiders have"],
      ["Is the post easy to take in at a glance?",
        "it is short, or its shape is visible at once: a list, a quote, a before and after",
        "it is a dense block that must be read from the top"],
    ]),
  reply(1, "Followability", false,
    "Does this post give someone a reason to want more from this account?",
    "a reader of this topic would want the next post from this author",
    "nothing suggests the author will say anything more worth reading", [
      ["Does this post signal that the account will keep producing content in this area?",
        "it reads as one of a series, names a practice or a project the author returns to, or refers to earlier or coming posts",
        "it is a one-off reaction with no sign the author writes about this again"],
      ["After reading, is it clear what kind of future posts this account produces?",
        "a reader could describe the next post's likely topic and form",
        "the post could have come from any account about anything"],
      ["Does the post demonstrate expertise or a distinct point of view?",
        "it takes a position or uses first-hand specifics a generalist would not have",
        "it states a truism anyone could write"],
      ["Would someone interested in this topic feel they would miss something by not following?",
        "it holds something hard to get elsewhere that a reader of this topic would want more of",
        "the same thing is said everywhere"],
    ]),
  reply(2, "Shareability", false,
    "Does this post give someone a reason to send it to another specific person?",
    "a reader could name the person they would send it to and why",
    "it is read, maybe liked, and left", [
      ["Does the post contain a single idea or line that stands on its own outside context?",
        "one sentence can be quoted alone and still make its point",
        "the point depends on the thread, an image or the reply it answers"],
      ["Is there a clear 'this reminds me of someone' trigger?",
        "it describes a situation or a type of person a reader is likely to know by name",
        "it is about the author alone, or about no one in particular"],
      ["Does the post provoke a reaction strong enough to prompt sharing?",
        "it surprises, amuses, validates or outrages",
        "it is neutral information, however useful"],
      ["Does sharing this reflect well on the sharer?",
        "passing it on makes the sender look informed, funny or early",
        "sharing it would look like promotion, bragging or noise"],
    ]),
  reply(3, "Likeability", false,
    "Does this post give someone a reason to signal quick agreement or approval?",
    "a reader would tap like without thinking twice",
    "a reader would have to think before reacting, or would not react", [
      ["Can the core point be grasped and agreed or disagreed with in under five seconds?",
        "the point is in the first line and needs no re-reading",
        "it needs the whole post or outside context"],
      ["Does the post affirm a belief or value the target reader likely already holds?",
        "it says something the reader already thinks, said well",
        "it argues against the reader or stays neutral"],
      ["Is the tone or format low-effort to react to?",
        "a clear statement, a one-liner or a short list",
        "a long argument, data or a question needing thought"],
      ["Does it avoid being so niche or complex that most readers could not form an opinion quickly?",
        "most readers of the account's topic can form an opinion at once",
        "it needs specialist knowledge"],
    ]),
  reply(4, "Saveability", false,
    "Does this post give someone a reason to come back to it later?",
    "a reader would bookmark it to use again",
    "once read it is done with", [
      ["Does the post contain reusable information: a list, framework, template, resource or reference?",
        "it holds a list, a framework, a template, a resource or a reference",
        "it is an opinion or a story with nothing to reuse"],
      ["Is the information dense enough that a reader could not fully absorb or use it in one read?",
        "there is more than a reader can use in one read",
        "one idea, absorbed at once"],
      ["Would a reader plausibly need this again in a different context later?",
        "a reader can name a future moment they would want it, 'next time I…'",
        "it is only interesting now"],
      ["Is the format structured so it is easy to scan back through?",
        "numbered or bulleted, with a structure to jump back into",
        "a narrative that must be re-read start to finish"],
    ]),
  {
    id: "01M4H1GZTFKV5071GZP20X6ZM6",
    project: DISTORTION,
    name: "Cognitive Distortion",
    on: true,
    since: 2,
    removing: false,
    questions: [{
      id: "01M4H1HFNYE3GGNNGVVQ6G5S40",
      kind: "pick",
      text: "What cognitive distortion it is, if any?",
      yes: "",
      no: "",
      options: [
        opt("01M4H1HV1MCTRQSYVBEQ92FDVK", "All-or-nothing thinking",
          "Seeing things in extremes, with no middle ground."),
        opt("01M4H1M5387PE1Q8B2DS7JPS7Z", "Overgeneralization",
          "Drawing a broad conclusion from a single event or a small number of events."),
        opt("01M4H1NX3YAQ0Q40Z6RTRNC12E", "Mind reading",
          "Assuming you know what other people are thinking, usually negatively."),
        opt("01M4H1Q1DWQ6J4ZR4YBV2MW244", "Fortune telling",
          "Predicting that something bad will happen and treating the prediction as fact."),
        opt("01M4H1Q9Y9PK2348V9ZX8P1KC0", "Catastrophizing",
          "Expecting the worst possible outcome and struggling to consider more likely alternatives."),
        opt("01M4H1QD70BFBTY7AP9AA6XRQ9", "Emotional reasoning",
          "Treating feelings as proof that something is true."),
        opt("01M4H1SSVHXAAS13QHTKNDB4KK", "Should statements",
          "Rigid rules about how you or other people must behave."),
        opt("01M4H1SWTF13DM6JF3TGNMW0SQ", "Labeling",
          "Defining yourself or another person by a single characteristic or behavior."),
        opt("01M4H1T1398QM5RSEMWBJWYWPY", "Personalization",
          "Taking excessive responsibility for events that are not entirely within your control."),
        opt("01M4H4HTZ8RHK76SRTEZZJR2Y3", "Mental filtering",
          "Focusing exclusively on negative details while ignoring positive ones."),
      ],
      removing: false,
    }],
  },
];

export const SEED = Object.freeze(SOURCE.map(normalise));
const fresh = () => structuredClone(SEED);

// A list stored by an older seed version gains only the seed tools a newer version
// added, unless their id is already there; a seed tool the user deleted was added by a
// version the list already had, so it is not brought back.
export const catchUp = (rubrics, version) => {
  const have = new Set(rubrics.map((r) => r.id));
  const added = SOURCE.filter((s) => s.since > version && !have.has(s.id)).map(normalise);
  return [...rubrics, ...added];
};

// What survives a removal that can no longer be undone: everything still flagged is
// purged. At load that is every flag, because the tab that showed its undo notice closed.
const purge = (rubrics) =>
  rubrics
    .filter((r) => !r.removing)
    .map((r) => ({
      ...r,
      questions: r.questions.filter((q) => !q.removing).map((q) => ({ ...q, options: q.options.filter((o) => !o.removing) })),
    }));

// What the store held: the seed when nothing is stored or it does not parse. An empty
// list stays empty, because the user deleted every tool.
export const parse = (stored) => {
  if (stored == null || stored === "") return fresh();
  try {
    const value = JSON.parse(stored);
    if (!Array.isArray(value?.rubrics)) return fresh();
    const seen = new Set();
    const rubrics = value.rubrics.map(normalise).filter((r) => r && !seen.has(r.id) && seen.add(r.id));
    const version = Number.isInteger(value.version) ? value.version : 0;
    return catchUp(purge(rubrics), version);
  } catch {
    return fresh();
  }
};

// The incoming list with every flagged item of the old list that it left out put back
// after the nearest item before it that is still there, so a save never drops what is
// still in its undo window. An incoming item that is flagged in the old list stays flagged.
export const keepFlagged = (old, incoming) => {
  const flagged = new Set(old.filter((x) => x.removing).map((x) => x.id));
  const out = incoming.map((x) => (flagged.has(x.id) ? { ...x, removing: true } : x));
  old.forEach((x, i) => {
    if (!x.removing || out.some((y) => y.id === x.id)) return;
    const before = old.slice(0, i).reverse().find((p) => out.some((y) => y.id === p.id));
    out.splice(before ? out.findIndex((y) => y.id === before.id) + 1 : 0, 0, x);
  });
  return out;
};

const body = (context) => ({ rubrics: context.rubrics });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Each event becomes a candidate list; only one that differs is saved and announced, so
// a repeat stores and emits nothing.
const change = (next) => ({
  guard: ({ context, event }) => !same(next(context.rubrics, event), context.rubrics),
  actions: [
    assign(({ context, event }) => ({ rubrics: next(context.rubrics, event) })),
    ({ context }) => context.save(JSON.stringify({ version: SEED_VERSION, ...body(context) })),
    emit(({ context }) => ({ type: "rubric.changed", ...body(context) })),
  ],
});

const saved = (rubrics, event) => {
  const was = rubrics.find((r) => r.id === event.id);
  const r = normalise({ ...event, on: was ? was.on : true, removing: was?.removing });
  if (!r) return rubrics;
  if (!was) return [...rubrics, r];
  const questions = keepFlagged(
    was.questions,
    r.questions.map((q) => {
      const old = was.questions.find((x) => x.id === q.id);
      return { ...q, options: keepFlagged(old ? old.options : [], q.options) };
    }),
  );
  return rubrics.map((x) => (x.id === r.id ? { ...r, questions } : x));
};

const switched = (rubrics, { id, on }) => rubrics.map((r) => (r.id === id ? { ...r, on: on === true } : r));

// Sets `removing` on the one item of `kind` named by `id`, wherever it sits.
const flag = (removing) => (rubrics, { kind, id }) => {
  const set = (x) => (x.id === id ? { ...x, removing } : x);
  if (kind === "rubric") return rubrics.map(set);
  if (kind === "question") return rubrics.map((r) => ({ ...r, questions: r.questions.map(set) }));
  if (kind === "option")
    return rubrics.map((r) => ({ ...r, questions: r.questions.map((q) => ({ ...q, options: q.options.map(set) })) }));
  return rubrics;
};

// Purges only the named item, and only while it is flagged: a settle for something that
// was undone, or never removed, changes nothing.
const settled = (rubrics, { kind, id }) => {
  const keep = (x) => !(x.id === id && x.removing);
  if (kind === "rubric") return rubrics.filter(keep);
  if (kind === "question") return rubrics.map((r) => ({ ...r, questions: r.questions.filter(keep) }));
  if (kind === "option")
    return rubrics.map((r) => ({ ...r, questions: r.questions.map((q) => ({ ...q, options: q.options.filter(keep) })) }));
  return rubrics;
};

// A project being removed is still in the list, so its tools stay until it settles.
const projectChanged = (rubrics, { projects }) => {
  const ids = new Set(projects.map((p) => p.id));
  return rubrics.filter((r) => ids.has(r.project));
};

// The start read's reply, swept like project.changed; an error reply sweeps nothing.
const projectsRead = (rubrics, { output }) => (Array.isArray(output?.projects) ? projectChanged(rubrics, output) : rubrics);

export const machine = setup({
  actors: {
    projects: fromPromise(({ input }) => (input.ask ? input.ask("projects", "read", {}) : Promise.resolve(null))),
  },
}).createMachine({
  id: "rubrics",
  meta: {
    description:
      "Owns the Judge detectors of every project, kept on this device. A detector is a name, whether it " +
      "is switched on for judging, and a list of questions. A question is either yes / no, with " +
      "optional words for what yes means and what no means, or pick one, with options that each " +
      "have a name and an optional description; a question keeps its options while it is yes / " +
      "no, so switching its kind back loses nothing. A new detector starts switched on. Deleting a " +
      "detector, or removing a question or an option, waits out the undo window and is marked until " +
      "then, so the editor can show it and Judge leaves it out. The detectors of a project that no " +
      "longer exists are dropped. A first visit starts with example detectors in each example " +
      "project; a later version of the examples only adds what is new and never brings back a " +
      "detector the user deleted.",
    kind: "fact",
    shape: "local-only",
    owns: "the Judge detectors of every project and their questions",
    emits: ["rubric.changed"],
    asks: ["projects: read"],
  },
  context: ({ input }) => ({ rubrics: parse(input.stored), save: input.save, ask: input.ask }),
  initial: "starting",
  states: {
    starting: {
      invoke: {
        src: "projects",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [{ target: "ready", ...change(projectsRead) }, { target: "ready" }],
        onError: { target: "ready" },
      },
    },
    ready: {},
  },
  on: {
    "rubric.saved": change(saved),
    "rubric.switched": change(switched),
    "removal.started": change(flag(true)),
    "removal.undone": change(flag(false)),
    "removal.settled": change(settled),
    "project.changed": change(projectChanged),
    "read?": {
      actions: ({ context, event }) => event.reply(body(context)),
    },
  },
});

import { setup, assign, emit, fromPromise, enqueueActions } from "xstate";

// The view component that lists the open book's evaluators (6.4), the list of the
// Evaluators tab's list-then-item. It owns only UI state — the book it shows, the rows,
// the row the editor shows, and a draft id for New evaluator — and points at three facts: it
// asks subject: read for what is open and follows subject.changed, asks evaluators: list
// for the open book and follows evaluator.changed / evaluator.deleted, asks session: read
// for whether anyone is signed in and follows session.changed, asks books: list
// for what each book is called and follows book.changed /
// book.deleted, and asks settings: read for the "Vim keys" preference (12) and follows
// settings.changed (4.3, fourth rule), and asks pins: read for the book the tab is pinned
// to and follows pins.changed. Its pin, beside the line naming the book, emits the same
// gesture as the editor's, pin.toggled, so `pins` stays the one place the pin lives and
// the hold is visible without opening an evaluator. Which row is open it learns only from the editor's
// evaluator.opened, never from its own pick, because the editor also opens evaluators by
// itself (another book, a reload, a pin) and one source keeps the mark right. A pick and a tick leave as gestures (4.3, fifth rule). The
// ask and the id minting arrive through input, so this stays importable in Node.
//
// New evaluator is always the first row and always names a minted id no evaluator has
// yet, so picking it opens an empty editor under that id; once the editor saves,
// evaluator.changed brings the real row and a fresh draft is minted.
//
// The box asks llm: decide once per finished line of the text, for every askable question
// of the switched-on evaluators that has no answer remembered for it, one line after
// another: the decide slot takes one request at a time and tells a second asker "busy".
// Its answers are UI state: remembered by the view in this browser, never emitted, never
// saved on the account.
//
// The rows are in the order `evaluators` keeps (5); a cut, a paste, a delete counting down
// on a row, its end (evaluator.discarded) and its hand-off to the corner notice when the
// keyboard leaves mid-countdown (removal.started) are the list's own.

export const UNTITLED = "Untitled evaluator";

const live = (items) => items.filter((x) => !x.removing);

// The rows under New evaluator: the book's evaluators, in the order the user set them,
// leaving out any whose deletion can still be undone in the corner notice.
export const rows = (evaluators) => live(evaluators);

// A question switched off in the editor is kept but not asked; one without `on` is on.
const switchedOn = (question) => question.on !== false;


// An evaluator is kept with a book, so only a subject that is a book has evaluators.
export const bookOf = (subject) => (subject?.kind === "book" ? subject.id : null);

const filled = (s) => typeof s === "string" && s.trim() !== "";

// A pick question needs two live options with distinct names, because Jev knows an
// option by its name (llm: decide).
const pickable = (question) => {
  const names = live(question.options ?? []).map((o) => o.name.trim());
  return names.length >= 2 && names.every((n) => n !== "") && new Set(names).size === names.length;
};

const askableQuestion = (question) =>
  !question.removing && switchedOn(question) && filled(question.text) && (question.kind !== "pick" || pickable(question));

// The line under an evaluator's name: how many questions Run would ask (written,
// switched on, and for a pick question two named options), and "· off" when its tick is
// off.
export const subtitle = (evaluator) => {
  const n = evaluator.questions.filter(askableQuestion).length;
  return `${n} question${n === 1 ? "" : "s"}${evaluator.on ? "" : " · off"}`;
};

// What a run asks: each shown, switched-on evaluator with its askable, switched-on
// questions, so only those are asked; one with none is not run.
export const askable = (evaluators) =>
  rows(evaluators)
    .filter((e) => e.on)
    .map((e) => ({ id: e.id, questions: e.questions.filter(askableQuestion) }))
    .filter((e) => e.questions.length > 0);

const toQuestion = (evaluatorId, question) => {
  const asked = { id: `${evaluatorId}:${question.id}`, instructions: question.text };
  if (question.kind === "pick") {
    asked.kind = "pick";
    asked.options = live(question.options).map((o) => ({
      id: o.id,
      name: o.name,
      ...(filled(o.description) ? { description: o.description } : {}),
    }));
  } else {
    if (filled(question.yes)) asked.yes = question.yes;
    if (filled(question.no)) asked.no = question.no;
  }
  return asked;
};

// The llm: decide payload for one line, from the evaluators as a run took them.
const payload = (text, asked) => ({
  state: { text },
  questions: asked.flatMap((e) => e.questions.map((q) => toQuestion(e.id, q))),
});

// The llm: decide payload for a text and the evaluators shown.
export const request = (text, evaluators) => payload(text, askable(evaluators));

// The lines a run judges, each on its own: blank ones are skipped, and each keeps its
// line number in the text.
export const lines = (text) =>
  text
    .split("\n")
    .map((line, i) => ({ at: i + 1, line: line.trim() }))
    .filter((l) => l.line !== "");

// --- The answers, in words ---------------------------------------------------------
// A line's answers are told in words, never as numbers: how sure Jev is shows in the
// wording, so a reader need not weigh a probability (Norman: one conceptual model).

// A pick answer from every option's probability, highest first (names as written): sure
// from 0.75 up; two close options are both named; otherwise how sure the top one is.
export const sayPick = (ranked) => {
  const [top, second] = ranked;
  if (!top) return "";
  if (top.p >= 0.75) return top.name;
  if (second && top.p - second.p <= 0.15) return `Between: ${top.name} and ${second.name}`;
  if (top.p >= 0.5) return `Probably: ${top.name}`;
  return `Not clear, maybe: ${top.name}`;
};

// A yes / no answer from the probability of yes; an even chance is said to be one.
export const sayYesNo = (p) =>
  p >= 0.45 && p <= 0.55 ? "Not clear" : p >= 0.75 ? "Yes" : p >= 0.5 ? "Probably yes" : p >= 0.25 ? "Probably no" : "No";

// The answer a question expects, while it names one still offered, as the choice point
// marks read it: yes or no for a yes / no question, a live option's id for a pick one.
export const expectOf = (question) => {
  const want = question.expect;
  if (question.kind === "pick") return live(question.options ?? []).some((o) => o.id === want) ? want : null;
  return want === "yes" || want === "no" ? want : null;
};

// Right or wrong against what is expected, or null when nothing is; "Between" and "Not
// clear" are compared by the top answer. The glyph is the top option's icon, else, only
// when something is expected, a check or a warning, as on a choice point's marks.
export const toneOf = (expect, top) => (expect == null ? null : top === expect ? "right" : "wrong");
export const glyphOf = (icon, tone) => icon || (tone === "right" ? "check" : tone === "wrong" ? "warning" : null);

// One question's answer for one line. A pick ranks every option by the probabilities Jev
// gave (only the picked one when it gave none); a yes / no answer's top is yes from an
// even chance up. The question's text is shown before a yes / no answer, and before a
// pick when its evaluator asked more than one question, since a lone pick names itself.
// `sure` is whether the words are the plain answer ("<Option>", "Yes", "No"), which a mark
// shows solid and any other faded; `also` is the second option a Between or Not clear
// answer leaves open; `meaning` the first line of the picked option's description, its
// summary, as owners write a longer explanation for Jev under it; `expected` the name of
// the answer expected, for the line that says whether Jev gave it.
export const answerOf = (question, answer, asked = 1) => {
  if (question.kind === "pick") {
    const options = live(question.options ?? []);
    const given = Array.isArray(answer.probabilities) && answer.probabilities.length ? answer.probabilities : [{ id: answer.choice, p: answer.p }];
    const ranked = given
      .map((g) => ({ ...g, option: options.find((o) => o.id === g.id) }))
      .filter((g) => g.option)
      .sort((a, b) => b.p - a.p)
      .map((g) => ({ id: g.id, name: g.option.name, icon: g.option.icon ?? null, description: g.option.description ?? "", p: g.p }));
    if (!ranked.length) return null;
    const expect = expectOf(question);
    const tone = toneOf(expect, ranked[0].id);
    const words = sayPick(ranked);
    const sure = words === ranked[0].name;
    return {
      id: question.id,
      kind: "pick",
      question: asked > 1 ? question.text : null,
      top: ranked[0].id,
      words,
      tone,
      glyph: glyphOf(ranked[0].icon, tone),
      sure,
      also: ranked[1] && (words.startsWith("Between") || words.startsWith("Not clear")) ? ranked[1].name : null,
      meaning: filled(ranked[0].description) ? ranked[0].description.trim().split("\n")[0].trim() : null,
      expected: expect == null ? null : options.find((o) => o.id === expect).name,
      probabilities: ranked.map(({ id, p }) => ({ id, p })),
    };
  }
  const top = answer.p >= 0.5 ? "yes" : "no";
  const expect = expectOf(question);
  const tone = toneOf(expect, top);
  const words = sayYesNo(answer.p);
  return {
    id: question.id,
    kind: "yesno",
    question: question.text,
    top,
    words,
    tone,
    glyph: glyphOf(null, tone),
    sure: words === "Yes" || words === "No",
    also: null,
    meaning: null,
    expected: expect == null ? null : expect === "yes" ? "Yes" : "No",
    p: answer.p,
  };
};

// The line under an answer that says whether Jev gave the one expected, or null when
// none is: "<Option>, as expected" when it did, "<Option> is expected" when not.
export const sayExpect = (answer) =>
  answer.expected == null || answer.tone == null
    ? null
    : { text: answer.tone === "right" ? `${answer.expected}, as expected` : `${answer.expected} is expected`, tone: answer.tone };

// The answers mapped back onto the evaluators asked, keyed by evaluator id.
export const results = (asked, answers) => {
  const byAnswer = new Map(answers.map((a) => [a.id, a]));
  const out = {};
  for (const e of asked) {
    const questions = [];
    for (const q of e.questions) {
      const a = byAnswer.get(`${e.id}:${q.id}`);
      const said = a && answerOf(q, a, e.questions.length);
      if (said) questions.push(said);
    }
    if (questions.length > 0) out[e.id] = { questions };
  }
  return out;
};


// What the user sees (7.3), shown by `show.py components` and the components page.
const DESCRIPTION =
  "Lists the evaluators kept with the open book and checks a text with them. At the top a box labelled \"Write one sentence per line\" takes a text, an editor that grows with it, where Enter starts a new line after a small gap, a pasted text keeps its lines, and with Vim keys on the box takes Vim's keys, where p pastes text or a link copied in the reader with Vim keys, paragraphs kept. There is no button: a line is checked once the user has finished it, by pressing Enter, by moving the cursor to another line, or by leaving the box; a paste finishes every line it brings. Each line is checked on its own with the switched-on evaluators, asking only their switched-on questions; blank lines are skipped. Finished lines wait their turn and each is one request to Jev, sent one after another, never two at once; a small Stop shows only while more than one line waits, and lets the line being asked be answered and asks no more until another line is finished. Answers are remembered in this browser, by evaluator, what it asks and the line's text, so a reload or coming back to the book shows the marks again without asking Jev, and nothing is asked when the page opens; a line typed but never finished is not asked. At most 1000 answers are kept; when there are more, the oldest are forgotten, and their lines are asked again only when finished again. A change to what an evaluator asks (a question, an option, a question's or the evaluator's tick) removes its marks and, two seconds after the last change, checks every line again, one at a time; a rename or a move asks nothing. Deleting a line removes its marks with it, and so does editing it, until it is finished again. The line being asked has a pulsing dot at its end and is scrolled into view, so a long text follows along. Each answered line gets, at its end, one mark per answer: the option's icon, or a check, or a warning when the answer is not the one expected; green when Jev gave the answer the question expects, red when not, plain when nothing is expected, judged by the top answer for Between and Not clear; solid when the answer is plain (the option's name, Yes or No) and faded when it is not. A mark is not text: the cursor and Vim pass it by, and it reads aloud as its answer. Under the box, a panel tells about one line: while lines are being checked the line answered last, otherwise the line the user clicks or puts the cursor on, when that line is answered; with nothing answered it is not shown. That line is tinted in the box. The panel's top row says \"Line 9 of 25\", a bar of how many lines are answered, and \"9 evaluated · 4 as expected\" (a line is as expected when every answer that expects one got it; the second half is left out when no question expects an answer). Then the line quoted, and each answer in words, never as a number, with its mark: a pick answer names the option when Jev is sure (75% or more), \"Between: A and B\" when the top two are within 15 points, \"Probably: A\" from an even chance, and \"Not clear, maybe: A\" below it; a yes / no answer is Yes, Probably yes, Probably no or No, split at 75%, 50% and 25%, and \"Not clear\" from 45% to 55%. Under a pick answer stands the first line of the option's description when it has one, and \"Also close: B\" for Between and Not clear. When the question expects an answer a line says \"Behavioral Goal, as expected\" in green or \"Behavioral Goal is expected\" in red (\"Yes is expected\" for a yes / no question). The question's text comes before an answer when the question is yes / no or its evaluator asks more than one; with more than one evaluator, each one's answers sit under its name. A failed line says why in the panel, in one sentence, and stops the checking: the lines already answered keep their marks, the ones waiting are not asked until finished again. Under the box a line says who evaluates: \"Evaluated by\" and the one or two switched-on evaluators by name, or how many when there are three or more, or \"No evaluator is on\" (\"No evaluator has a question yet\" when those on have none to ask); pressing it shows or hides the list of evaluators under it. With `folded` the list starts hidden, without it shown; the user's own showing or hiding is remembered in this browser and wins over the page. The list: New evaluator is the first row and opens an empty editor; the evaluator appears in the list once something is written in it. The evaluators are in the order the user set, kept on the account and the same on every device: a new evaluator goes to the top, an edit does not move one, and evaluators from before keep the order they had, oldest first, until moved. Each row has a tick box that switches the evaluator on or off, its name, greyed when off, and how many of its questions would be asked: those written and switched on. With `subject` it follows the book open on the stage, and another book shows that book's evaluators; while no book is open, or without `subject`, it says to open a book. The Journal, like any book, lists only its own evaluators; among them is Your values, built from the user's values, a row like any other that can be switched off and moved, and whose questions the Evaluate box asks like any evaluator's. The arrow keys move between the rows, and with Vim keys on so do j, k, gg and G; Enter opens the row. With Vim keys on, never while typing in a field: dd cuts the row, greyed and marked Cut with no countdown, and the keyboard stays in the list; p places it below the row the cursor is on and P above; u on the cut row puts it back. While a row is cut, Escape does not leave the list but starts the row's delete with its undo countdown on the row, and u, Enter or a click on a row counting down takes the delete back. When the countdown ends the evaluator is deleted, with no notice after it, as in Notes and Chats. If the keyboard leaves the list while a row is cut or counting down (a row opened, another panel, a click elsewhere), the delete moves instead to the dark notice in the corner with its Undo, as a delete from the editor does, and the evaluator is deleted when that notice's time runs out. o starts a new evaluator below the cursor row and O above it, opening its editor; it takes that place once something is written in it. cc opens the evaluator's editor with the keyboard in its name. New evaluator stays put: dd does nothing there, and a move from it goes to the top. Your values cannot be deleted, so dd does nothing on its row either. On a try page, when a guest has used all its free use nothing more is checked and under the box it says \"You have used all your free use.\"; while free trials are paused for every guest, or Jev cannot be asked on the guest's behalf, it says \"Free trials are paused for now.\"; a guest the admin blocked reads \"This trial has ended.\" The text is kept per book in this browser, so a reload or coming back to the book shows it again. With `subject`, a line at the top names the book shown, \"About: Journal\", with a pin at its right, the same pin as the editor's: it is off until the user presses it, so the list follows the book on the stage. Pressed, it turns the accent color and the list stays on that book when another comes on the stage; the line then also says \"Pinned · ACT made simple is open\" with the stage's book, so a list held on another book says so. Pressing the pin again, here or in the editor, brings the stage's book back at once. The pin is kept by `pins`, so it survives a reload. The row of the evaluator the editor shows is marked, whether the user picked it or the editor opened it by itself on another book, after a reload or a pin, and the keyboard starts from it. Signed out it shows no box, no \"Evaluated by\" line and no rows, only \"Sign in to run evaluators.\"; the evaluators stay kept in this browser and come back when the user signs in, without a reload. On a try page a visitor not yet signed in still sees the starters and has lines checked, since the first check makes the guest.";
// --- The Evaluate box ------------------------------------------------------------------
// A line is checked once the user has finished it (the view tells: Enter, the cursor on
// another line, a paste, the box losing the keyboard). Finished lines wait in a queue and
// are asked one at a time, never two at once. Each evaluator's answers about a line are
// remembered in this browser (the view's `memory`), keyed by the evaluator, what it asks
// (its signature) and the line's text, so a reload or coming back to the book shows the
// marks again without asking Jev, and a change to what an evaluator asks makes its old
// answers unused, so its marks go and every line is asked again.

// What one evaluator asks, as a short text: its questions as Jev is asked them. A rename,
// a move or an expected answer changes nothing Jev is asked, so it keeps the answers.
export const signature = (asked) => {
  const text = JSON.stringify(asked.questions.map((q) => toQuestion(asked.id, q)));
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
};

// The key one evaluator's answers about one line are remembered under.
export const memoryKey = (asked, line) => `${asked.id}|${signature(asked)}|${line}`;

// One line's remembered answers, by evaluator id as `results` gives them, and the
// evaluators shown that have none for it yet.
const recalled = (context, line) => {
  const out = {};
  const missing = [];
  for (const asked of askable(context.evaluators)) {
    const raw = context.memory.get(memoryKey(asked, line));
    const said = Array.isArray(raw) ? results([asked], raw)[asked.id] : null;
    if (said) out[asked.id] = said;
    else missing.push(asked);
  }
  return { results: out, missing };
};

// The lines of the box by their text, each once.
const texts = (text) => [...new Set(lines(text).map((l) => l.line))];

// The lines still to ask, in the order they were finished: in the box, and lacking an
// answer from some evaluator shown.
export const pending = (context) => {
  const present = new Set(texts(context.text));
  return context.queue.filter((line) => present.has(line) && recalled(context, line).missing.length > 0);
};

// The next request: the first line still to ask, with only the evaluators it lacks.
const nextJob = (context) => {
  const [line] = pending(context);
  return line == null ? null : { line, asked: recalled(context, line).missing };
};

// How many lines wait, the one being asked among them; Stop shows from two.
export const waiting = (context) => pending(context).length + (context.asking ? 1 : 0);
export const stoppable = (context) => waiting(context) > 1;

// Every line of the box as the marks and the panel show it: its number and text, whether
// it is being asked, waits, failed (and why), is answered, or is new, and the answers
// remembered for it from each evaluator shown.
export const runsOf = (context) => {
  const queued = new Set(pending(context));
  return lines(context.text).map((l) => {
    const { results: said } = recalled(context, l.line);
    const error = context.failures[l.line] ?? null;
    const status =
      l.line === context.asking ? "asking" : queued.has(l.line) ? "waiting" : error ? "failed" : Object.keys(said).length ? "done" : "new";
    return { ...l, status, results: said, error: status === "failed" ? error : null };
  });
};

// A line refused for free use is told once under the box (STOPS), not as a line.
const settled = (r) => r.status === "done" || (r.status === "failed" && !STOPS.includes(r.error));

// Every answer of one line, evaluator by evaluator in the order they are listed.
const answersOf = (run) => Object.values(run.results).flatMap((v) => v.questions);

// The marks at the end of one line of the box: a pulsing dot while Jev is asked about it,
// else one mark per answer remembered, the option's icon (else a check, or a warning when
// it is not the answer expected), coloured by its tone and faded when Jev is not sure. A
// line with no answer has none.
export const marksOf = (run) =>
  run.status === "asking"
    ? [{ pending: true, label: "Asking Jev" }]
    : answersOf(run).map((a) => ({ icon: a.glyph ?? "check", tone: a.tone, sure: a.sure, label: a.question ? `${a.question} ${a.words}` : a.words }));

// Whether a line came out as expected: at least one of its answers expects one, and every
// one that does got it.
export const asExpected = (run) => {
  const judged = answersOf(run).filter((a) => a.tone != null);
  return judged.length > 0 && judged.every((a) => a.tone === "right");
};

// The top row of the panel: how many lines are answered of how many the box holds, and of
// those how many came out as expected, said only when some question expects an answer.
export const tally = (runs) => {
  const done = runs.filter((r) => r.status === "done");
  const judged = done.some((r) => answersOf(r).some((a) => a.tone != null));
  const evaluated = `${done.length} evaluated`;
  return {
    done: done.length,
    total: runs.length,
    words: judged ? `${evaluated} · ${done.filter(asExpected).length} as expected` : evaluated,
  };
};

// The line the panel tells about, as an index into the lines, or -1 when no line is
// answered yet (the panel is hidden). While lines are being asked it is the last line
// answered; otherwise the line the user last clicked or put the cursor on, when that line
// is answered, else still the last one answered. A line is known by its text, as its
// marks are, and of two with the same text by the nearer one.
export const focusOf = ({ runs, running, picked }) => {
  let last = -1;
  runs.forEach((r, i) => settled(r) && (last = i));
  if (running || picked == null) return last;
  let best = -1;
  runs.forEach((r, i) => {
    if (!settled(r) || r.line !== picked.line) return;
    if (best < 0 || Math.abs(r.at - picked.at) < Math.abs(runs[best].at - picked.at)) best = i;
  });
  return best < 0 ? last : best;
};

// The fold line's words, as [text, bold] parts: who evaluates, by name up to two.
export const foldLine = (names, anyOn) => {
  if (names.length === 0) return [[anyOn ? "No evaluator has a question yet" : "No evaluator is on", false]];
  if (names.length === 1) return [["Evaluated by ", false], [names[0], true]];
  if (names.length === 2) return [["Evaluated by ", false], [names[0], true], [" and ", false], [names[1], true]];
  return [[`Evaluated by ${names.length} evaluators`, false]];
};

// Whether the list starts folded: the user's own last fold in this browser, stored as
// "true" or "false", wins over the page's `folded`.
export const foldedAtStart = (attribute, stored) => (stored === "true" ? true : stored === "false" ? false : Boolean(attribute));

// The reply's error, in the kinds the user is told apart. A guest has no key of their
// own and no Settings to add one in (8): a guest whose own allowance is spent is told
// so, a guest the admin blocked is told the trial has ended, and any other refusal about
// free use or the guest key is told as free trials being paused, which is true for them
// and asks nothing they cannot do.
export const errorKind = (error, guest = false) =>
  error === "used-up" || error === "blocked"
    ? error
    : error === "paused" || (guest && (error === "no-key" || error === "bad-key"))
      ? "paused"
      : error === "signed-out"
        ? "signed-out"
        : error === "no-key" || error === "bad-key"
          ? "key"
          : error === "rate-limited" || error === "overloaded" || error === "busy"
            ? "busy"
            : "failed";

// Why a guest cannot be checked now, from llm's freeUse (7.7), or null: blocked by the
// admin, used-up once its own allowance is spent, paused while Jev is paused for every guest.
export const freeStop = (freeUse) =>
  !freeUse
    ? null
    : freeUse.blocked
      ? "blocked"
      : freeUse.left <= 0
        ? "used-up"
        : freeUse.paused.includes("jev")
          ? "paused"
          : null;

// The message under the box (try-links screen 2): what the picture says, else what the
// last request was refused for.
export const notice = (context) => freeStop(context.freeUse) ?? context.refused ?? null;

// The refusals told once under the box rather than on each line.
export const STOPS = ["used-up", "paused", "blocked"];

// A session reply without a userId (no-answerer on a page or in a test without `session`)
// counts as signed in, so a page that cannot tell never hides the evaluators.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// What the panel shows of the account: "wait" until session answers, so neither the
// evaluators nor the sign-in line flash; "sign-in" signed out, since a check needs an
// account (3.4); "show" otherwise. A try page shows the starters to a visitor who is not
// yet a guest, because the first check makes the guest (8).
export const showing = ({ tryPage, signedIn }) => (tryPage ? "show" : signedIn === null ? "wait" : signedIn ? "show" : "sign-in");

// What every evaluator shown asks, one signature each, so a change to it is seen.
const askedBy = (evaluators) => askable(evaluators).map((a) => `${a.id}|${signature(a)}`);

const without = (map, id) => {
  if (!(id in map)) return map;
  const { [id]: _, ...rest } = map;
  return rest;
};

const withoutKey = (map, key) => {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
};

// A different book, or none, starts the box afresh: nothing waits and nothing is asked.
const fresh = { text: "", queue: [], asking: null, job: null, failures: {}, refused: null, picked: null, placing: null };

// The pause after an evaluator changes before its lines are asked again, so typing in the
// editor asks nothing until it stops.
export const RECHECK_MS = 2000;

// Lines finished by the user wait to be asked, each once, in the order finished; a line
// asked again forgets why it failed, and a refusal is no longer told.
const finish = (context, finished) => {
  const add = finished.map((t) => (typeof t === "string" ? t.trim() : "")).filter((t) => t !== "");
  if (!add.length) return {};
  const failures = { ...context.failures };
  for (const t of add) delete failures[t];
  return { queue: [...new Set([...context.queue, ...add])], failures, refused: null };
};

// --- The list ----------------------------------------------------------------------------

// The order the user set (5): by the place `evaluators` gives each, a key compared as
// plain text, id as the tiebreak, the same order the fact answers in. One without a place
// sorts as the fact orders one from before places: after the placed ones, oldest first.
const placeOf = (e) => (typeof e.position === "string" ? e.position : `z${e.id}V`);
const byPlace = (a, b) => {
  const pa = placeOf(a);
  const pb = placeOf(b);
  return pa < pb ? -1 : pa > pb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};
export const sorted = (evaluators) => [...evaluators].sort(byPlace);

// Where a pasted row shows until `evaluators` announces its real place: a key just after
// the row above it, or before the row below it. Only for this list's order.
const provisional = (evaluators, after, before) => {
  const above = evaluators.find((e) => e.id === after);
  const below = evaluators.find((e) => e.id === before);
  if (above) return placeOf(above) + "\u0000";
  if (below) return "";
  return null;
};

// An evaluator row the user can cut or delete: shown, not already going, and written by
// the user; one built from another fact (Your values) cannot be deleted, so dd ignores it (12).
const deletable = (context, id) =>
  shownHas(context, id) && !context.discarding.has(id) && context.cut?.id !== id && !context.evaluators.find((e) => e.id === id)?.derivedFrom;

const nameOf = (context, id) => context.evaluators.find((e) => e.id === id)?.name ?? "";

// Start a row's undo window on the row: nothing is emitted until it runs out.
function startDiscard(enqueue, id, name) {
  enqueue.assign({ discarding: ({ context }) => new Map(context.discarding).set(id, name) });
  enqueue.raise({ type: "_elapsed", id }, { delay: ({ context }) => context.undoMs, id: `undo:${id}` });
}

// The keyboard left the list while a row was cut or counting down (12, Vim keys): its
// delete goes to the corner notice, which keeps its Undo in sight, as the editor's delete
// does; `evaluators` marks it while the notice shows, and the list leaves it out.
function handOff(context, enqueue) {
  const going = [...context.discarding, ...(context.cut ? [[context.cut.id, context.cut.name]] : [])];
  if (!going.length) return;
  for (const [id] of context.discarding) enqueue.cancel(`undo:${id}`);
  for (const [id, name] of going) enqueue.emit({ type: "removal.started", kind: "evaluator", id, name });
  enqueue.assign({ discarding: new Map(), cut: null });
}

const remint = (context, evaluators) => (evaluators.some((e) => e.id === context.draft) ? context.mint() : context.draft);

const shownHas = (context, id) => rows(context.evaluators).some((e) => e.id === id);

// What books says about each book's title, for the line naming the book shown.
const fromList = (event) => {
  const books = Array.isArray(event.output?.books) ? event.output.books : [];
  return Object.fromEntries(books.map((b) => [b.id, b.title]));
};

// The book the list shows: the one the tab is pinned to, else the book on the stage.
export const wanted = ({ pin, subject }) => pin ?? bookOf(subject);

// A new subject or pin: `next` gives both. A different book is asked for afresh; no book
// shows the line that says to open one. While pinned the subject is only noted, and
// unpinning shows the book on the stage at once, because a list left on the pinned book
// would offer no way back to it.
// `first` runs before the change, while the context is still the one it was decided on.
const follow = (next, first = []) => [
  {
    guard: ({ context, event }) => wanted(next({ context, event })) === context.book,
    actions: [...first, assign(({ context, event }) => next({ context, event }))],
  },
  {
    guard: ({ context, event }) => wanted(next({ context, event })) != null,
    target: ".loading",
    actions: [
      ...first,
      assign(({ context, event }) => {
        const n = next({ context, event });
        const book = wanted(n);
        return { ...fresh, ...n, book, text: context.drafts.read(book), evaluators: [] };
      }),
    ],
  },
  {
    target: ".idle",
    actions: [...first, assign(({ context, event }) => ({ ...fresh, ...next({ context, event }), book: null, evaluators: [] }))],
  },
];

// A request ended: its line is no longer asked, and what came back is remembered, or why
// it failed is kept and nothing more is asked.
const answered = enqueueActions(({ context, event, enqueue }) => {
  const { line, asked } = context.job;
  for (const a of asked) {
    const prefix = `${a.id}:`;
    context.memory.put(memoryKey(a, line), event.output.answers.filter((x) => typeof x?.id === "string" && x.id.startsWith(prefix)));
  }
  enqueue.assign({ asking: null, job: null, remembered: context.remembered + 1 });
});

const failed = (kind) =>
  assign(({ context, event }) => {
    const error = kind ?? errorKind(event.output?.error, context.guest);
    return {
      asking: null,
      job: null,
      queue: [],
      failures: { ...context.failures, [context.job.line]: error },
      refused: STOPS.includes(error) ? error : context.refused,
    };
  });

// The memory when the view gives none (a test, a browser refusing storage): this page only.
const pageMemory = () => {
  const kept = new Map();
  return { get: (key) => kept.get(key), put: (key, value) => kept.set(key, value) };
};

export const machine = setup({
  actors: {
    // The starting picture: the pin, then the subject. pins.changed and subject.changed are
    // each held for this ask until their reply lands (supersededBy), so they are applied
    // after, in order.
    readSubject: fromPromise(async ({ input }) => {
      if (!input.following) return { subject: null, pin: null };
      const pins = await input.ask("pins", "read", {});
      const subject = await input.ask("subject", "read", {});
      return { subject: subject?.subject ?? null, pin: typeof pins?.evaluators === "string" ? pins.evaluators : null };
    }),
    // The book's evaluators; evaluator.changed / evaluator.deleted are held for this ask
    // until its reply lands, so a change that races it is applied after it.
    load: fromPromise(({ input }) => input.ask("evaluators", "list", { book: input.book })),
    // book.changed / book.deleted are held for this ask until its reply lands. A page
    // without books gets no-answerer, and then no book has a title.
    books: fromPromise(({ input }) => (input.following ? input.ask("books", "list", {}) : Promise.resolve({ books: [] }))),
    // The "Vim keys" device preference (12); on a page without a settings fact the ask
    // replies no-answerer and the letters stay off.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // A guest's free use (7.7); llm.changed is held for this ask until its reply lands.
    llm: fromPromise(({ input }) => input.ask("llm", "read", {})),
    // Whether anyone is signed in, and whether as a guest, which changes how a refusal
    // is told; session.changed is held for this ask until its reply lands.
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
    // decide is superseded by nothing, so nothing is held for it.
    decide: fromPromise(({ input }) => input.ask("llm", "decide", input.payload)),
  },
  guards: {
    // A line waits, nothing is being asked, and nothing stops it: the account shows, a
    // guest has free use left, and no evaluator was changed a moment ago.
    canAsk: ({ context }) =>
      showing(context) === "show" && freeStop(context.freeUse) == null && !context.settling && nextJob(context) != null,
  },
}).createMachine({
  id: "evaluator-list",
  meta: {
    description: DESCRIPTION,
    kind: "view",
    emits: ["evaluator.selected", "evaluator.switched", "evaluator.moved", "evaluator.discarded", "removal.started", "pin.toggled"],
    attributes: ["subject", "folded"],
    asks: ["evaluators: list", "subject: read", "settings: read", "llm: decide", "books: list", "pins: read", "llm: read", "session: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // Puts text copied in the reader in Vim's unnamed register, so p pastes it.
    pushRegister: input.pushRegister,
    mint: input.mint,
    // The box's text per book, kept by the view across reloads (3.1); without one the
    // text lives only for this page.
    drafts: input.drafts ?? { read: () => "", write: () => {} },
    // Each evaluator's answers about each line, kept by the view in this browser (3.1);
    // without one they live only for this page.
    memory: input.memory ?? pageMemory(),
    // How many answers were remembered in this page, so the view draws each one.
    remembered: 0,
    undoMs: input.undoMs ?? 3000,
    following: Boolean(input.following),
    subject: null,
    book: null,
    // The book `pins` holds for this tab, and whether pins.changed came before the start
    // reply, which is then the older picture.
    pin: null,
    pinsObserved: false,
    evaluators: [],
    // Each book's title by id, empty until books answers.
    titles: {},
    // The evaluator the editor shows, learned from evaluator.opened; the row marked.
    open: null,
    draft: input.mint(),
    vimKeys: false,
    guest: false,
    // Whether someone is signed in (3.4): null until session answers.
    signedIn: null,
    // Whether the page is a try page (8), from the view, so this stays importable in Node.
    tryPage: Boolean(input.tryPage),
    // llm's freeUse while the account is a guest (7.7), else null.
    freeUse: null,
    // An evaluator changed a moment ago (RECHECK_MS): its lines wait until it settles.
    settling: false,
    // The row cut with Vim's dd (12), { id, name }, waiting for p or P to place it, u to
    // put it back, or Escape to delete it; null when none. Greyed in place, no timer.
    cut: null,
    // The rows counting down to their delete, by id, with their names for the notice.
    discarding: new Map(),
    // The box (UI state): the text; the lines finished and waiting to be asked, by text;
    // the line being asked and the evaluators asked about it ({ line, asked }); why a line
    // failed, by text; the refusal told under the box; the line the user last pointed at
    // ({ at, line }) for the panel; and a new evaluator started with o or O, with where
    // it goes ({ id, after, before }).
    ...fresh,
  }),
  // The subject and settings reads run for the machine's whole life, so a book's load
  // never cancels them.
  invoke: [
    {
      src: "readSubject",
      input: ({ context }) => ({ ask: context.ask, following: context.following }),
      onDone: follow(({ context, event }) => ({
        subject: event.output?.subject ?? null,
        pin: context.pinsObserved ? context.pin : (event.output?.pin ?? null),
      })),
      onError: { actions: [] },
    },
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
    {
      src: "llm",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ freeUse: ({ event }) => event.output?.freeUse ?? null }) },
      onError: { actions: [] },
    },
    {
      src: "session",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        actions: assign({ guest: ({ event }) => event.output?.guest === true, signedIn: ({ event }) => signedIn(event.output) }),
      },
      onError: { actions: assign({ signedIn: true }) },
    },
    {
      src: "books",
      input: ({ context }) => ({ ask: context.ask, following: context.following }),
      onDone: { actions: assign({ titles: ({ event }) => fromList(event) }) },
      onError: { actions: [] },
    },
  ],
  initial: "idle",
  states: {
    idle: {},
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask, book: context.book }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output?.evaluators),
            target: "ready",
            actions: assign(({ context, event }) => {
              const evaluators = sorted(event.output.evaluators.filter((e) => e.book === context.book));
              return { evaluators, draft: remint(context, evaluators) };
            }),
          },
          // The fact could not answer: an honest failure rather than an empty list.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      initial: "waiting",
      states: {
        // Nothing is being asked; the next line waiting is asked as soon as nothing stops it.
        waiting: {
          always: { guard: "canAsk", target: "asking" },
        },
        // One line per entry, so two requests are never open at once. Typing meanwhile
        // changes nothing it asks; what comes back is remembered under the evaluators as
        // they were asked.
        asking: {
          entry: assign(({ context }) => {
            const job = nextJob(context);
            return { job, asking: job.line, queue: context.queue.filter((l) => l !== job.line) };
          }),
          invoke: {
            src: "decide",
            input: ({ context }) => ({ ask: context.ask, payload: payload(context.job.line, context.job.asked) }),
            onDone: [
              { guard: ({ event }) => Array.isArray(event.output?.answers), target: "waiting", actions: answered },
              { target: "waiting", actions: failed() },
            ],
            onError: { target: "waiting", actions: failed("failed") },
          },
        },
      },
      on: {
        _type: {
          actions: [
            assign({ text: ({ event }) => (typeof event.text === "string" ? event.text : "") }),
            ({ context }) => context.book != null && context.drafts.write(context.book, context.text),
          ],
        },
        // Lines the user finished (Enter, the cursor on another line, a paste), by text,
        // or every line when the box lost the keyboard.
        _finish: {
          guard: ({ event }) => Array.isArray(event.lines) || event.all === true,
          // The user is back in the box, so a change to an evaluator has settled.
          actions: assign(({ context, event }) => ({ ...finish(context, event.all === true ? texts(context.text) : event.lines), settling: false })),
        },
        // Stop: the line being asked is answered, since it is already paid for, and no
        // more are asked until the user finishes another line.
        _stop: { actions: assign({ queue: [] }) },
        // The line the user clicked or moved the cursor to, by its number and text.
        _point: {
          guard: ({ event }) => Number.isInteger(event.at) && typeof event.line === "string",
          actions: assign({ picked: ({ event }) => ({ at: event.at, line: event.line.trim() }) }),
        },
        // The gestures (7.2: internal messages from the view). A pick names a shown
        // evaluator or the draft; a tick names a shown evaluator and changes it. Opening a
        // row while another is cut or counting down hands that delete to the corner
        // notice, so it never goes out of sight (12).
        _pick: {
          guard: ({ context, event }) =>
            (event.id === context.draft || shownHas(context, event.id)) && !context.discarding.has(event.id) && context.cut?.id !== event.id,
          actions: [
            enqueueActions(({ context, enqueue }) => handOff(context, enqueue)),
            assign({ placing: null }),
            emit(({ context, event }) => ({ type: "evaluator.selected", id: event.id, book: context.book })),
          ],
        },
        _switch: {
          guard: ({ context, event }) =>
            typeof event.on === "boolean" && rows(context.evaluators).some((e) => e.id === event.id && e.on !== event.on),
          actions: emit(({ event }) => ({ type: "evaluator.switched", id: event.id, on: event.on })),
        },
        // Vim's dd on an evaluator row (12): the row is cut, greyed in place with no
        // timer, while the keyboard stays in the list. A row already cut is deleted with
        // its countdown, as Vim's register holds only the latest cut.
        _cut: {
          guard: ({ context, event }) => deletable(context, event.id),
          actions: enqueueActions(({ context, event, enqueue }) => {
            if (context.cut) startDiscard(enqueue, context.cut.id, context.cut.name);
            enqueue.assign({ cut: { id: event.id, name: nameOf(context, event.id) } });
          }),
        },
        // p or P: the cut evaluator goes between these neighbours, and is no longer cut.
        // The row shows there at once; evaluators' announcement of its place follows.
        _paste: {
          guard: ({ context }) => context.cut != null,
          actions: enqueueActions(({ context, event, enqueue }) => {
            const { id } = context.cut;
            const after = event.after ?? null;
            const before = event.before ?? null;
            enqueue.assign({ cut: null });
            if (after === id || before === id) return;
            const position = provisional(context.evaluators, after, before);
            if (position != null)
              enqueue.assign({ evaluators: ({ context }) => sorted(context.evaluators.map((e) => (e.id === id ? { ...e, position } : e))) });
            enqueue.emit({ type: "evaluator.moved", id, after, before });
          }),
        },
        // u on the cut row: it stays where it was.
        _uncut: { guard: ({ context }) => context.cut != null, actions: assign({ cut: null }) },
        // Escape while a row is cut: the cut becomes a delete, its countdown on the row.
        _escape: {
          guard: ({ context }) => context.cut != null,
          actions: enqueueActions(({ context, enqueue }) => {
            startDiscard(enqueue, context.cut.id, context.cut.name);
            enqueue.assign({ cut: null });
          }),
        },
        // u, a click or Enter on a row counting down: its delete is taken back.
        _undo: {
          guard: ({ context, event }) => context.discarding.has(event.id),
          actions: enqueueActions(({ event, enqueue }) => {
            enqueue.cancel(`undo:${event.id}`);
            enqueue.assign({ discarding: ({ context }) => withoutKey(context.discarding, event.id) });
          }),
        },
        // o or O (12): a new evaluator, opened like New evaluator, that goes between these
        // neighbours once something is written in it.
        _place: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            handOff(context, enqueue);
            enqueue.assign({ placing: { id: context.draft, after: event.after ?? null, before: event.before ?? null } });
            enqueue.emit({ type: "evaluator.selected", id: context.draft, book: context.book });
          }),
        },
      },
    },
    failed: {},
  },
  on: {
    // Text or a link copied in the reader: Vim's p reads Vim's own register, not the
    // system clipboard, so it goes there too, blocks a blank line apart as paragraphs are.
    "text.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "link.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "llm.changed": { actions: assign({ freeUse: ({ event }) => event.freeUse ?? null }) },
    "session.changed": { actions: assign({ guest: ({ event }) => event.guest === true, signedIn: ({ event }) => event.userId != null }) },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "evaluator.opened": { actions: assign({ open: ({ event }) => event.id }) },
    "subject.changed": follow(({ context, event }) => ({ subject: event.subject ?? null, pin: context.pin })),
    // The user pressed the pin: the gesture goes to `pins` (4.3, fifth rule), and the list
    // acts on it at once, as the editor does; pins.changed then confirms it.
    _togglePin: [
      { guard: ({ context }) => !context.following || context.book == null, actions: [] },
      ...follow(
        ({ context }) => ({ subject: context.subject, pin: context.pin != null ? null : context.book }),
        [emit(({ context }) => ({ type: "pin.toggled", what: "evaluators", id: context.pin != null ? null : context.book }))],
      ),
    ],
    // `pins`' news (4.3, fourth rule): the tab's book pinned, or unpinned.
    "pins.changed": [
      { guard: ({ context }) => !context.following, actions: [] },
      ...follow(({ context, event }) => ({ subject: context.subject, pin: event.evaluators ?? null, pinsObserved: true })),
    ],
    "book.changed": { actions: assign({ titles: ({ context, event }) => ({ ...context.titles, [event.id]: event.title }) }) },
    "book.deleted": { actions: assign({ titles: ({ context, event }) => without(context.titles, event.id) }) },
    // The fact's news (4.3, fourth rule), for the evaluators of the book shown only. When
    // what the evaluators shown ask changed (a question, a question's tick, or an
    // evaluator's own tick), every line of the box waits to be asked again, once the
    // change has settled; a line already answered by that evaluator as it now asks is not
    // asked. A rename, a move or the server's acknowledgement asks nothing. A new
    // evaluator started with o or O is moved, once it exists, to where it was started.
    "evaluator.changed": {
      guard: ({ context, event }) => event.evaluator.book === context.book,
      actions: enqueueActions(({ context, event, enqueue }) => {
        const evaluators = sorted([...context.evaluators.filter((e) => e.id !== event.evaluator.id), event.evaluator]);
        const before = new Set(askedBy(context.evaluators));
        const changed = askedBy(evaluators).some((s) => !before.has(s));
        enqueue.assign({ evaluators, draft: remint(context, evaluators) });
        if (changed) {
          enqueue.assign({ ...finish(context, texts(context.text)), settling: true });
          enqueue.cancel("recheck");
          enqueue.raise({ type: "_settled" }, { delay: RECHECK_MS, id: "recheck" });
        }
        const p = context.placing;
        if (p && p.id === event.evaluator.id && !context.evaluators.some((e) => e.id === p.id)) {
          enqueue.assign({ placing: null });
          if (p.after != null || p.before != null) enqueue.emit({ type: "evaluator.moved", id: p.id, after: p.after, before: p.before });
        }
      }),
    },
    _settled: { actions: assign({ settling: false }) },
    "evaluator.deleted": {
      actions: assign(({ context, event }) => ({
        evaluators: context.evaluators.filter((e) => e.id !== event.id),
        cut: context.cut?.id === event.id ? null : context.cut,
      })),
    },
    // The window on a row ran out while the keyboard stayed in the list: the user saw it
    // run out, so the delete is a fact now (evaluator.discarded), with no second Undo.
    _elapsed: {
      guard: ({ context, event }) => context.discarding.has(event.id),
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({ discarding: withoutKey(context.discarding, event.id) });
        enqueue.emit({ type: "evaluator.discarded", id: event.id });
      }),
    },
    // The keyboard left the list (the view tells): see handOff.
    _left: { actions: enqueueActions(({ context, enqueue }) => handOff(context, enqueue)) },
  },
});

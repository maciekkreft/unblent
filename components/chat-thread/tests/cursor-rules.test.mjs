import { test } from "node:test";
import assert from "node:assert/strict";
import { vimAction, followTop, answersText, finishedAnswers, answerAt, indexOfPlace, selectionOf, staysIn, offerOf, highlightAtPlace, step, charStep, passage, wordAround, fingerPassage, movedEnd, endsOf, linesOf, lineBoxes, charNear, lineStep, charAtY, firstChar, lastChar } from "../machine.js";

// The cursor's and the finger's decisions on plain text and measured boxes: what each key
// asks for, where each motion lands, and what a passage may become.

const FIRST = "# Plan\n\nA book was a path. He could **work** here!\n\n- one item\n- two item";
const SECOND = "Later words here.";
const turn = (id, text, extra = {}) => ({ id, role: "assistant", status: "done", text, ...extra });
const text = () => answersText([turn("A1", FIRST), turn("A2", SECOND)]);

// The letter at an index, and the index of a phrase's first letter.
const of = (t, phrase) => t.flat.indexOf(phrase);

test("each key on the conversation asks for its action, and its second press and modifiers count", () => {
  const key = (k, mods = {}, state = {}) => vimAction({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods }, state);
  for (const k of ["w", "b", ")", "(", "}", "{", "0", "$", "j", "k", "l", "h"]) assert.equal(key(k), "move", k);
  assert.equal(key("g"), "g");
  assert.equal(key("g", {}, { afterG: true }), "top");
  assert.equal(key("G"), "bottom");
  assert.equal(key("d"), "d");
  assert.equal(key("d", {}, { afterD: true }), "remove");
  assert.equal(key("v"), "visual");
  assert.equal(key("i"), "type");
  assert.equal(key("d", { ctrlKey: true }), "halfDown");
  assert.equal(key("u", { ctrlKey: true }), "halfUp");
  // u is the global Undo, and Enter and Escape are not the conversation's without a passage.
  for (const k of ["u", "Enter", "Escape", "x"]) assert.equal(key(k), null, k);
  // A letter with a modifier belongs to the browser or the desk (Ctrl+j is dock-desk's).
  assert.equal(key("j", { ctrlKey: true }), null);
  assert.equal(key("w", { metaKey: true }), null);
  assert.equal(key("d", { ctrlKey: true, altKey: true }), null);
});

test("while a passage is being marked, Enter makes it, Escape and v drop it, and d is nothing", () => {
  const key = (k) => vimAction({ key: k }, { visual: true });
  assert.equal(key("Enter"), "make");
  assert.equal(key("Escape"), "drop");
  assert.equal(key("v"), "drop");
  assert.equal(vimAction({ key: "d" }, { visual: true, afterD: true }), null);
  assert.equal(key("w"), "move");
});

test("the view moves only as far as it must to show a box, never past either end", () => {
  const view = { top: 100, height: 400, max: 1000 };
  assert.equal(followTop({ ...view, boxTop: 200, boxBottom: 220 }), 100, "in view");
  assert.equal(followTop({ ...view, boxTop: 40, boxBottom: 60 }), 40, "above");
  assert.equal(followTop({ ...view, boxTop: 600, boxBottom: 620 }), 220, "below");
  assert.equal(followTop({ ...view, boxTop: 110, boxBottom: 130, margin: 20 }), 90, "with room above");
  assert.equal(followTop({ ...view, boxTop: 480, boxBottom: 495, margin: 20 }), 115, "with room below");
  assert.equal(followTop({ ...view, boxTop: 5, boxBottom: 20, margin: 20 }), 0, "never above the top");
  assert.equal(followTop({ ...view, boxTop: 1390, boxBottom: 1400, margin: 20 }), 1000, "never past the end");
});

test("the text holds the answers as drawn, each letter knowing its offset in its own answer", () => {
  const t = text();
  assert.ok(!t.flat.includes("#") && !t.flat.includes("**") && !t.flat.includes("- "), "the markers are not drawn, so not walked");
  assert.deepEqual(t.answers.map((a) => a.id), ["A1", "A2"]);
  for (const phrase of ["Plan", "book", "work", "two item"]) {
    const i = of(t, phrase);
    assert.equal(answerAt(t, i).id, "A1");
    assert.equal(FIRST.slice(t.at[i], t.at[i] + phrase.length), phrase, phrase);
  }
  const later = of(t, "Later");
  assert.equal(answerAt(t, later).id, "A2");
  assert.equal(t.at[later], 0);
  assert.equal(indexOfPlace(t, "A2", 0), later);
  assert.equal(indexOfPlace(t, "A2", 9999), null);
  assert.equal(indexOfPlace(t, "gone", 0), null);
});

test("every kind of block is walked: a line break, inline code, a code block, a table, a quote", () => {
  const source = "one\ntwo `code` **b** _e_\n\n```\nlet x\n\ny\n```\n\n| H1 | H2 |\n|---|---|\n| c1 | |\n\n> said\n\n---\n\nend";
  const t = answersText([turn("A", source)]);
  for (const phrase of ["one", "two", "code", "let x", "y", "H1", "H2", "c1", "said", "end"]) {
    const i = of(t, phrase);
    assert.ok(i >= 0, phrase);
    assert.equal(source.slice(t.at[i], t.at[i] + phrase.length), phrase, phrase);
  }
  // A line break ends a block, so `}` stops before it.
  assert.equal(t.flat[of(t, "two") - 1], "\u0000");
});

test("without the markdown attribute each line of the plain text is a block", () => {
  const t = answersText([turn("A", "one\n\n# two")], false);
  assert.equal(t.at[of(t, "# two")], 5);
});

test("only finished answers with text are walked", () => {
  const chat = {
    turns: [
      { id: "Q", role: "user", text: "asked" },
      turn("A1", "kept"),
      turn("A2", "stopped", { status: "stopped" }),
      turn("A3", "", {}),
      turn("A4", "arriving", { status: "pending" }),
    ],
  };
  assert.deepEqual(finishedAnswers(chat).map((t) => t.id), ["A1"]);
  assert.deepEqual(finishedAnswers(null), []);
  assert.equal(answersText([]).flat, "");
});

test("each motion lands as in the book reader, and crosses from one answer into the next", () => {
  const t = text();
  const at = (i) => t.flat.slice(i, i + 4);
  const start = of(t, "book");
  assert.equal(at(step(t, start, "w")), "was ");
  assert.equal(at(step(t, start, "b")), "A bo");
  assert.equal(at(step(t, start, ")")), "He c");
  assert.equal(at(step(t, start, "(")), "A bo");
  assert.equal(t.flat[step(t, start, "}")], "!", "the paragraph's last letter");
  assert.equal(at(step(t, of(t, "He"), "{")), "A bo");
  assert.equal(at(charStep(t, start, 1)), "ook ");
  assert.equal(at(charStep(t, start, -1)), " boo");
  // Out of the first answer's last word and back, by word and by letter.
  const last = of(t, "item", of(t, "two"));
  const tail = t.flat.lastIndexOf("item");
  assert.ok(last);
  assert.equal(at(step(t, tail, "w")), "Late");
  assert.equal(at(step(t, of(t, "Later"), "b")), "item");
  const end = tail + "item".length - 1;
  assert.equal(at(charStep(t, end, 1)), "Late");
  assert.equal(charStep(t, of(t, "Later"), -1), end);
});

test("at both ends of the chat each motion stays", () => {
  const t = text();
  const first = firstChar(t);
  const final = lastChar(t);
  assert.equal(t.flat.slice(first, first + 4), "Plan");
  assert.equal(t.flat[final], ".");
  for (const key of ["b", "(", "{"]) assert.equal(step(t, first, key), first, key);
  assert.equal(charStep(t, first, -1), first);
  for (const key of ["w", ")", "}"]) assert.equal(step(t, final, key), final, key);
  assert.equal(charStep(t, final, 1), final);
});

// Lines of five letters across, one line per five characters of the flat text.
const fiveAcross = (t) => (i) => (t.at[i] < 0 ? null : { top: Math.floor(i / 5) * 20, height: 16, x: (i % 5) * 10 });

test("0 and $ go to the ends of the line, and j and k to the next and the previous line", () => {
  const t = answersText([turn("A", "abcdefghijklmnopqrst")]);
  const line = fiveAcross(t);
  assert.equal(lineStep(t, 7, "0", line), 5);
  assert.equal(lineStep(t, 7, "$", line), 9);
  assert.equal(lineStep(t, 7, "j", line), 12);
  assert.equal(lineStep(t, 7, "k", line), 2);
  // At either end a line motion stays.
  assert.equal(lineStep(t, 2, "k", line), 2);
  assert.equal(lineStep(t, 17, "j", line), 17);
  assert.equal(lineStep(t, 5, "0", line), 5);
  assert.equal(lineStep(t, 9, "$", line), 9);
});

test("j and k keep their column over a shorter line, so j then k comes back to the same letter", () => {
  const t = answersText([turn("A", "abcdefghij\n\nkl\n\nmnopqrstuv")]);
  // Each block its own line, ten letters across.
  const line = (i) => {
    if (t.at[i] < 0) return null;
    const block = t.flat.slice(0, i).split("\u0000").length - 1;
    const from = t.flat.lastIndexOf("\u0000", i - 1) + 1;
    return { top: block * 20, height: 16, x: (i - from) * 10 };
  };
  const want = line(8).x;
  const short = lineStep(t, 8, "j", line, want);
  assert.equal(t.flat[short], "l", "the nearest letter on the short line");
  const below = lineStep(t, short, "j", line, want);
  assert.equal(t.flat[below], "u", "back at the column on the long line");
  const up = lineStep(t, below, "k", line, want);
  assert.equal(lineStep(t, up, "k", line, want), 8, "and home");
});

test("a height names the start of the line there, or the last letter past the end", () => {
  const t = answersText([turn("A", "abcdefghijklmno"), turn("B", "pqrst")]);
  const bottomOf = (i) => (t.at[i] < 0 ? null : (Math.floor(i / 5) + 1) * 20);
  assert.equal(t.flat[charAtY(t, 0, bottomOf)], "a");
  assert.equal(charAtY(t, 21, bottomOf), 5);
  assert.equal(t.flat[charAtY(t, 100000, bottomOf)], "t");
});

test("a passage stays in its answer: a motion out of it stops on its edge", () => {
  const t = text();
  const start = of(t, "book");
  const inside = of(t, "work");
  assert.equal(staysIn(t, start, inside), inside);
  assert.equal(t.flat.slice(staysIn(t, start, of(t, "Later")) - 3, staysIn(t, start, of(t, "Later")) + 1), "item");
  const back = staysIn(t, of(t, "words"), of(t, "book"));
  assert.equal(t.flat.slice(back, back + 5), "Later");
});

test("a passage as _selected names its answer and its exact offsets, across a bold word", () => {
  const t = text();
  const from = of(t, "could");
  const to = of(t, "here") + 4;
  const made = selectionOf(t, from, to);
  assert.equal(made.answerId, "A1");
  assert.equal(FIRST.slice(made.start, made.end), "could **work** here");
  assert.equal(selectionOf(t, 5, 5), null, "nothing");
  assert.equal(selectionOf(t, of(t, "Plan") + 4, of(t, "Plan") + 5), null, "only a separator");
});

test("v w w covers two whole words, and v l covers two letters", () => {
  const t = text();
  const start = of(t, "book");
  const twice = step(t, step(t, start, "w"), "w");
  assert.equal(t.flat.slice(...passage(t, start, twice)), "book was");
  assert.equal(t.flat.slice(...passage(t, start, charStep(t, start, 1), true)), "bo");
});

test("a finger's passage has a fixed start, grows by whole words and never flips", () => {
  const t = text();
  const hold = of(t, "path");
  const word = wordAround(t, hold + 1);
  const words = (i) => t.flat.slice(...fingerPassage(t, word, i));
  assert.equal(t.flat.slice(...word), "path.");
  assert.equal(words(hold + 1), "path.");
  assert.equal(words(of(t, "could") + 2), "path. He could");
  assert.equal(words(of(t, "book") + 1), "book was a path.");
  // Over a blank the finger has reached the word behind it.
  assert.equal(words(of(t, "He") + 2), "path. He");
});

test("a finger's point names a letter on the nearest line, in a gap and in the margin too", () => {
  const chars = [
    { i: 0, left: 0, right: 10, top: 0, bottom: 20 },
    { i: 1, left: 10, right: 20, top: 0, bottom: 20 },
    { i: 2, left: 0, right: 10, top: 40, bottom: 60 },
    { i: 3, left: 10, right: 20, top: 40, bottom: 60 },
  ];
  const lines = linesOf(chars);
  assert.equal(lines.length, 2);
  assert.equal(charNear(lines, 15, 5), 1);
  assert.equal(charNear(lines, 500, 50), 3, "in the margin");
  assert.equal(charNear(lines, 5, 25), 0, "in the gap, the nearer line");
  assert.equal(charNear(lines, 5, 9999), 2, "past the end");
  assert.equal(charNear([], 0, 0), null);
  assert.deepEqual(lineBoxes(lines, 1, 3), [
    { left: 10, right: 20, top: 0, bottom: 20 },
    { left: 0, right: 10, top: 40, bottom: 60 },
  ]);
});

const chatOf = (extra = {}) => ({
  id: "C",
  turns: [
    { id: "Q1", role: "user", text: "first" },
    turn("A1", "An earlier answer here."),
    { id: "Q2", role: "user", text: "second" },
    turn("A2", "The last answer here."),
  ],
  ...extra,
});

test("a passage on the last answer offers Comment, on an earlier one Highlight, over a mark nothing", () => {
  const offer = (chat, answerId, start, end) => offerOf({ conversation: chat, draft: null }, { answerId, start, end });
  assert.equal(offer(chatOf(), "A2", 4, 8), "Comment");
  assert.equal(offer(chatOf(), "A1", 3, 10), "Highlight");
  const marked = chatOf({
    highlights: [{ id: "H1", answerId: "A1", start: 3, end: 10, quote: "earlier" }],
    marks: { answerId: "A2", marks: [{ id: "M1", start: 4, end: 8, quote: "last", comment: "why" }] },
  });
  assert.equal(offer(marked, "A1", 5, 7), null, "over a highlight");
  assert.equal(offer(marked, "A2", 6, 12), null, "over a comment");
  assert.equal(offer(marked, "A1", 11, 17), "Highlight", "beside a highlight");
});

test("dd finds the highlight holding the cursor, and only inside it", () => {
  const chat = chatOf({ highlights: [{ id: "H1", answerId: "A1", start: 3, end: 10, quote: "earlier" }] });
  assert.equal(highlightAtPlace(chat, "A1", 3).id, "H1");
  assert.equal(highlightAtPlace(chat, "A1", 9).id, "H1");
  assert.equal(highlightAtPlace(chat, "A1", 10), null, "past its end");
  assert.equal(highlightAtPlace(chat, "A1", 2), null, "before its start");
  assert.equal(highlightAtPlace(chat, "A2", 5), null, "in another answer");
});

test("a handle moves its end letter by letter, never past the other end, and never rests on a blank", () => {
  const t = text();
  const from = of(t, "book");
  const span = [from, from + 4];
  assert.deepEqual(movedEnd(t, span, "end", of(t, "was") + 1), [from, of(t, "was") + 2]);
  assert.deepEqual(movedEnd(t, span, "end", 0), [from, from + 1], "the end stops on the start's letter");
  assert.deepEqual(movedEnd(t, span, "start", t.flat.length - 1), [from + 3, from + 4], "the start stops on the end's letter");
  assert.deepEqual(movedEnd(t, span, "end", from + 4), span, "the space after it is not taken");
});

test("a passage's offsets find its letters in the text, also where its edge lies on markdown's own marks", () => {
  const t = text();
  const start = FIRST.indexOf("**work**");
  const [from, to] = endsOf(t, "A1", start, start + "**work**".length);
  assert.equal(t.flat.slice(from, to), "work");
  assert.equal(endsOf(t, "nobody", 0, 4), null);
  assert.equal(endsOf(t, "A1", start, start + 2), null, "only the marks");
});

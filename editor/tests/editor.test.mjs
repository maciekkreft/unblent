import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { undo, redo, undoDepth } from "@codemirror/commands";
import { Vim } from "@replit/codemirror-vim";
import {
  baseExtensions,
  setVim,
  paragraphs,
  enterAt,
  breakAt,
  backspaceAt,
  deleteAt,
  isGap,
  joinAt,
  pastGap,
  itemAt,
  nextItemAt,
  unbulletAt,
  indentAt,
  outdentAt,
  markerStop,
  openAt,
  paragraphsOpener,
  paragraphsJoiner,
  insertRun,
  sourceLinksIn,
  sourceLinks,
  missingLinks,
  toRegister,
  tickAt,
  renumber,
  webLinksIn,
  webLinkAt,
  webLinkDecorations,
} from "../editor.js";

// The kit can break every editor (architecture.md 10), so its rule is tested here
// without a browser: the pure text functions, and the extensions on an EditorState
// driven the way a keymap drives a view ({ state, dispatch }).

const run = (text, edit) => (edit ? text.slice(0, edit.from) + edit.insert + text.slice(edit.to) : text);

test("Enter starts a paragraph with one blank line; Shift+Enter breaks the line", () => {
  assert.equal(run("OneTwo", enterAt("OneTwo", 3)), "One\n\nTwo");
  assert.equal(enterAt("OneTwo", 3).cursor, 5);
  assert.equal(run("OneTwo", breakAt("OneTwo", 3)), "One\nTwo");
  assert.equal(breakAt("OneTwo", 3).cursor, 4);
  // A selection is replaced.
  assert.equal(run("One xx Two", enterAt("One xx Two", 3, 7)), "One\n\nTwo");
});

test("Backspace at a paragraph's start removes the whole gap and joins", () => {
  assert.equal(run("One\n\nTwo", backspaceAt("One\n\nTwo", 5)), "OneTwo");
  assert.equal(backspaceAt("One\n\nTwo", 5).cursor, 3);
  // A run of blank lines goes at once.
  assert.equal(run("One\n\n\n\nTwo", backspaceAt("One\n\n\n\nTwo", 7)), "OneTwo");
  // An empty paragraph being started joins back.
  assert.equal(run("One\n\n", backspaceAt("One\n\n", 5)), "One");
  // After a line break, or mid-line, it is an ordinary Backspace.
  assert.equal(backspaceAt("One\nTwo", 4), null);
  assert.equal(backspaceAt("One\n\nTwo", 6), null);
  assert.equal(backspaceAt("One", 0), null);
});

test("Delete at a paragraph's end removes the gap forwards", () => {
  assert.equal(run("One\n\nTwo", deleteAt("One\n\nTwo", 3)), "OneTwo");
  assert.equal(run("One\n\n\n\nTwo", deleteAt("One\n\n\n\nTwo", 3)), "OneTwo");
  assert.equal(deleteAt("One\nTwo", 3), null);
  assert.equal(deleteAt("One", 3), null);
});

test("a blank line after a paragraph is a gap unless the cursor is on it; one after a blank line is not", () => {
  assert.equal(isGap({ text: "", number: 2 }, 3, false), true);
  assert.equal(isGap({ text: "", number: 2 }, 2, false), false);
  assert.equal(isGap({ text: "One", number: 1 }, 3, false), false);
  assert.equal(isGap({ text: "", number: 3 }, 5, true), false);
  assert.equal(isGap({ text: "", number: 1 }, 3, false), false);
});

test("J joins the next line with one space, or the next paragraph across its gap", () => {
  assert.equal(run("One\n\nTwo", joinAt("One\n\nTwo", 1, true)), "One Two");
  assert.equal(joinAt("One\n\nTwo", 1, true).cursor, 3);
  assert.equal(run("One\n\n\n\nTwo", joinAt("One\n\n\n\nTwo", 0, true)), "One Two");
  // Without the gap rule, J is Vim's own: the blank line is the line joined.
  assert.equal(run("One\n\nTwo", joinAt("One\n\nTwo", 0)), "One\nTwo");
  assert.equal(run("One\n   two", joinAt("One\n   two", 0, true)), "One two");
  assert.equal(run("One \ntwo", joinAt("One \ntwo", 0, true)), "One two");
  // An extra blank line joins the line under it, as in Vim.
  assert.equal(run("One\n\n\nTwo", joinAt("One\n\n\nTwo", 5, true)), "One\n\nTwo");
  assert.equal(joinAt("One", 0, true), null);
  assert.equal(joinAt("One\n\n", 0, true), null);
});

test("a move landing on a gap carries on to text, or stops at the first or last line", () => {
  const lines = ["One", "", "", "Two", ""];
  const blank = (n) => lines[n] === "";
  assert.equal(pastGap(blank, lines.length, 1, 1), 3);
  assert.equal(pastGap(blank, lines.length, 2, -1), 0);
  assert.equal(pastGap(blank, lines.length, 4, 1), 4);
  assert.equal(pastGap(blank, lines.length, 3, 1), null);
  const top = ["", "", "One"];
  assert.equal(pastGap((n) => top[n] === "", top.length, 1, -1), 0);
});

test("a line beginning with \"- \" or \"* \" is an item; its text starts after the marker", () => {
  assert.deepEqual(itemAt("One\n- two", 6), { from: 4, to: 9, kind: "bullet", indent: 0, marker: "-", next: "-", textFrom: 6 });
  assert.equal(itemAt("  * a", 0).textFrom, 4);
  assert.equal(itemAt("-no space", 0), null);
  assert.equal(itemAt("text - not", 6), null);
  // The line start of a text that begins with a blank line.
  assert.equal(itemAt("\n- a", 0), null);
});

test("Enter on an item makes the next one; on an empty one it steps out or ends the list", () => {
  assert.equal(run("- one", nextItemAt("- one", 5)), "- one\n- ");
  assert.equal(nextItemAt("- one", 5).cursor, 8);
  // Split at the cursor, keeping the indent and the marker.
  assert.equal(run("  * onetwo", nextItemAt("  * onetwo", 7)), "  * one\n  * two");
  // An empty indented item steps out one level.
  assert.equal(run("- a\n  - ", nextItemAt("- a\n  - ", 8)), "- a\n- ");
  assert.equal(nextItemAt("- a\n  - ", 8).cursor, 6);
  // An empty top-level item ends the list with a new paragraph.
  const end = nextItemAt("- a\n- ", 6);
  assert.equal(run("- a\n- ", end), "- a\n\n");
  assert.equal(end.cursor, 5);
  // Ending it in the middle leaves a gap on both sides.
  assert.equal(run("- a\n- \n- b", nextItemAt("- a\n- \n- b", 6)), "- a\n\n\n\n- b");
  assert.equal(run("- ", nextItemAt("- ", 2)), "");
  // Not on an item.
  assert.equal(nextItemAt("one", 3), null);
});

test("an empty item after a gap ends the list or steps out the same way", () => {
  assert.equal(run("- a\n\n- ", nextItemAt("- a\n\n- ", 7)), "- a\n\n");
  assert.equal(run("- a\n\n  - ", nextItemAt("- a\n\n  - ", 9)), "- a\n\n- ");
  assert.equal(run("- a\n\n- \n\n- b", nextItemAt("- a\n\n- \n\n- b", 7)), "- a\n\n\n\n- b");
});

test("o and O open a paragraph a gap below or above the line, or the next or previous item", () => {
  // Below: what Enter at the line's end makes.
  assert.equal(run("Head\nBody", openAt("Head\nBody", 1, true)), "Head\n\n\nBody");
  assert.equal(openAt("Head\nBody", 1, true).cursor, 6);
  assert.equal(run("One", openAt("One", 0, true)), "One\n\n");
  // Between two paragraphs the new one is a gap apart from both.
  assert.equal(run("A\n\nB", openAt("A\n\nB", 0, true)), "A\n\n\n\nB");
  // Above: what Enter at the line's start makes, the cursor on the new line.
  assert.equal(run("A\n\nB", openAt("A\n\nB", 3, false)), "A\n\n\n\nB");
  assert.equal(openAt("A\n\nB", 3, false).cursor, 3);
  assert.equal(run("One", openAt("One", 2, false)), "\n\nOne");
  assert.equal(openAt("One", 2, false).cursor, 0);
  // On an item, the next or previous item directly below or above, at its indent and
  // with its marker.
  const t = "- a\n  * b";
  assert.equal(run(t, openAt(t, 8, true, itemAt(t, 8))), "- a\n  * b\n  * ");
  assert.equal(openAt(t, 8, true, itemAt(t, 8)).cursor, 14);
  assert.equal(run(t, openAt(t, 8, false, itemAt(t, 8))), "- a\n  * \n  * b");
  assert.equal(openAt(t, 8, false, itemAt(t, 8)).cursor, 8);
  // An empty item opens another; o never ends a list.
  assert.equal(run("- ", openAt("- ", 2, true, itemAt("- ", 2))), "- \n- ");
});

test("Backspace at the start of an item's text removes the bullet, keeping the text", () => {
  assert.equal(run("a\n  - b", unbulletAt("a\n  - b", 6)), "a\nb");
  assert.equal(unbulletAt("a\n  - b", 6).cursor, 2);
  assert.equal(unbulletAt("- b", 3), null);
  assert.equal(unbulletAt("b", 0), null);
});

test("Tab indents an item under the one above; Shift+Tab outdents", () => {
  const text = "- a\n- b\n- c";
  const once = indentAt(text, 6);
  assert.equal(run(text, once), "- a\n  - b\n- c");
  assert.equal(once.cursor, 8);
  // Not deeper than one level under the item above, and never the first item.
  assert.equal(indentAt(run(text, once), 8), null);
  assert.equal(indentAt(text, 2), null);
  assert.equal(indentAt("x\n- b", 4), null);
  assert.equal(indentAt("no", 1), null);
  // A selection moves every item it touches and keeps its text selected.
  const both = indentAt(text, 6, 11);
  assert.equal(run(text, both), "- a\n  - b\n  - c");
  assert.deepEqual([both.anchor, both.cursor], [8, 15]);
  assert.equal(run("- a\n  - b", outdentAt("- a\n  - b", 8)), "- a\n- b");
  assert.equal(outdentAt("- a\n  - b", 8).cursor, 6);
  assert.equal(outdentAt("- a", 2), null);
  assert.equal(outdentAt("a", 0), null);
  // A gap between items keeps them one list; a paragraph between them does not.
  assert.equal(run("- a\n\n- b", indentAt("- a\n\n- b", 7)), "- a\n\n  - b");
  assert.equal(run("- a\n\n- b\n\n- c", indentAt("- a\n\n- b\n\n- c", 7, 12)), "- a\n\n  - b\n\n  - c");
  assert.equal(indentAt("- a\n\nx\n\n- b", 10), null);
  assert.equal(indentAt("\n\n- b", 4), null);
});

test("a cursor never rests inside a marker", () => {
  const text = "One\n- two";
  // From another line, or by a click, it rests at the start of the text.
  assert.equal(markerStop(text, 4, 1, "key"), 6);
  assert.equal(markerStop(text, 5, 9, "pointer"), 6);
  // Home, or Vim's 0, from inside the text.
  assert.equal(markerStop(text, 4, 8, "key"), 6);
  assert.equal(markerStop(text, 4, 8, "other"), 6);
  // An arrow step back from the text's start goes on to the end of the line above;
  // Home stays.
  assert.equal(markerStop(text, 5, 6, "key"), 3);
  assert.equal(markerStop(text, 4, 6, "key"), 6);
  // Vim's h, 0, ^ and I stay; its b goes on to the last word above, past a gap.
  assert.equal(markerStop(text, 5, 6, "other"), 6);
  assert.equal(markerStop(text, 4, 6, "other"), 6);
  assert.equal(markerStop(text, 4, 6, "back"), 0);
  assert.equal(markerStop(text, 4, 8, "back"), 6);
  assert.equal(markerStop("a bc  \n- d", 7, 9, "back"), 2);
  assert.equal(markerStop("a\n\n- d", 3, 5, "back"), 0);
  // Past a gap, the arrow step goes on to the end of the text above.
  assert.equal(markerStop("One\n\n- two", 6, 7, "key"), 3);
  // The first line has nothing above.
  assert.equal(markerStop("- a", 1, 2, "key"), 2);
  // Outside a marker, nothing to do.
  assert.equal(markerStop(text, 7, 6, "key"), null);
  assert.equal(markerStop(text, 1, 6, "key"), null);
});

// --- On an EditorState ---------------------------------------------------------------

// A stand-in for a view: what a keymap's run and setVim read and write.
function target(doc, cursor, extensions) {
  const t = { dispatched: 0 };
  t.state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions });
  t.dispatch = (tr) => {
    t.dispatched++;
    t.state = tr.state ? tr.state : t.state.update(tr).state;
  };
  return t;
}

// A key as the view runs it: every binding for it, highest precedence first, until
// one handles it.
function press(t, key) {
  for (const binding of t.state.facet(keymap).flat()) {
    if (binding.key === key && binding.run?.(t)) return true;
  }
  return false;
}

const gapLines = (state) => {
  const found = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue;
    source.between(0, state.doc.length, (from, _to, deco) => {
      if (deco.spec.class === "cm-gap") found.push(state.doc.lineAt(from).number);
    });
  }
  return found;
};

const move = (t, head, userEvent = "select") => t.dispatch(t.state.update({ selection: EditorSelection.cursor(head), userEvent }));

test("blank lines are drawn as gaps except the cursor's and the ones kept blank", () => {
  const t = target("One\n\nTwo\n", 0, [...baseExtensions(), paragraphs()]);
  assert.deepEqual(gapLines(t.state), [2, 4]);
  move(t, t.state.doc.length);
  assert.deepEqual(gapLines(t.state), [2]);
  const kept = target("One\n\nTwo\n", 0, [paragraphs({ keepBlank: (_s, line) => line.number === 2 })]);
  assert.deepEqual(gapLines(kept.state), [4]);
});

test("a keyboard move steps over a gap onto an extra blank line; a click and a kept blank line stay", () => {
  const t = target("One\n\n\nTwo", 1, [paragraphs()]);
  move(t, 4); // onto line 2, a gap, so on to line 3, an extra blank line
  assert.equal(t.state.doc.lineAt(t.state.selection.main.head).number, 3);
  move(t, 7); // on to Two
  move(t, 5); // up onto the extra blank line, which holds the cursor
  assert.equal(t.state.doc.lineAt(t.state.selection.main.head).number, 3);
  move(t, 4); // up onto the gap, so on to One
  assert.equal(t.state.doc.lineAt(t.state.selection.main.head).number, 1);
  assert.deepEqual(gapLines(target("One\n\n\nTwo", 0, [paragraphs()]).state), [2]);
  // A paragraph opened between two others, the cursor on it: the gap under it stays one.
  assert.deepEqual(gapLines(target("One\n\n\n\nTwo", 5, [paragraphs()]).state), [2, 4]);
  move(t, 4, "select.pointer");
  assert.equal(t.state.selection.main.head, 4);
  const kept = target("One\n\n\nTwo", 1, [paragraphs({ keepBlank: (_s, line) => line.number === 2 })]);
  move(kept, 4);
  assert.equal(kept.state.selection.main.head, 4);
});

test("Enter and Shift+Enter outrank the standard keys; one Undo takes back a join", () => {
  const t = target("OneTwo", 3, [...baseExtensions(), paragraphs()]);
  assert.ok(press(t, "Enter"));
  assert.equal(t.state.doc.toString(), "One\n\nTwo");
  assert.ok(press(t, "Shift-Enter"));
  assert.equal(t.state.doc.toString(), "One\n\n\nTwo");
  const j = target("One\n\nTwo", 5, [...baseExtensions(), paragraphs()]);
  assert.ok(press(j, "Backspace"));
  assert.equal(j.state.doc.toString(), "OneTwo");
  assert.ok(undo(j));
  assert.equal(j.state.doc.toString(), "One\n\nTwo");
  // Anywhere else, Backspace falls through to the standard key.
  move(j, 4, "select.pointer");
  assert.ok(press(j, "Backspace"));
  assert.equal(j.state.doc.toString(), "One\nTwo");
});

test("enter: false leaves Enter to the editor; Shift+Enter still breaks the line", () => {
  const t = target("OneTwo", 3, [paragraphs({ enter: false })]);
  assert.equal(press(t, "Enter"), false);
  assert.ok(press(t, "Shift-Enter"));
  assert.equal(t.state.doc.toString(), "One\nTwo");
});

test("a join never removes a blank line that is kept", () => {
  const t = target("One\n\nTwo", 5, [paragraphs({ keepBlank: (_s, line) => line.number === 2 })]);
  assert.equal(press(t, "Backspace"), false);
  const d = target("One\n\nTwo", 3, [paragraphs({ keepBlank: (_s, line) => line.number === 2 })]);
  assert.equal(press(d, "Delete"), false);
  assert.equal(d.state.doc.toString(), "One\n\nTwo");
});

test("setVim switches in place and only on a change", () => {
  const t = target("One", 0, baseExtensions());
  setVim(t, false);
  assert.equal(t.dispatched, 0);
  setVim(t, true);
  assert.equal(t.dispatched, 1);
  setVim(t, true);
  assert.equal(t.dispatched, 1);
  setVim(t, false);
  assert.equal(t.dispatched, 2);
  assert.equal(t.state.doc.toString(), "One");
  // An editor built with Vim on starts on.
  const on = target("One", 0, baseExtensions({ vim: true }));
  setVim(on, true);
  assert.equal(on.dispatched, 0);
});

const items = (state) => {
  const found = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue;
    source.between(0, state.doc.length, (from, _to, deco) => {
      if (deco.spec.class === "cm-item") found.push(state.doc.lineAt(from).number);
    });
  }
  return found;
};

test("item lines are drawn as items, except the ones an editor names, and none with lists off", () => {
  const doc = "- a\nb\n  * c\n- d";
  assert.deepEqual(items(target(doc, 0, [paragraphs()]).state), [1, 3, 4]);
  const named = target(doc, 0, [paragraphs({ notList: (_s, line) => line.number === 4 })]);
  assert.deepEqual(items(named.state), [1, 3]);
  assert.deepEqual(items(target(doc, 0, [paragraphs({ lists: false })]).state), []);
});

test("Enter and Shift+Enter on an item make the next one, undone in one step", () => {
  const t = target("- one", 5, [...baseExtensions(), paragraphs()]);
  assert.ok(press(t, "Enter"));
  assert.equal(t.state.doc.toString(), "- one\n- ");
  assert.ok(press(t, "Enter"));
  assert.equal(t.state.doc.toString(), "- one\n\n");
  assert.ok(undo(t));
  assert.ok(undo(t));
  assert.equal(t.state.doc.toString(), "- one");
  const tight = target("- one", 5, [paragraphs()]);
  assert.ok(press(tight, "Shift-Enter"));
  assert.equal(tight.state.doc.toString(), "- one\n- ");
  const s = target("- one", 5, [paragraphs({ enter: false })]);
  assert.equal(press(s, "Enter"), false);
  assert.ok(press(s, "Shift-Enter"));
  assert.equal(s.state.doc.toString(), "- one\n- ");
  // Off a list, the paragraph keys as before.
  const p = target("one", 3, [paragraphs()]);
  assert.ok(press(p, "Enter"));
  assert.equal(p.state.doc.toString(), "one\n\n");
});

// Vim's o and O as the kit's action runs them: the focused editor's opener, dispatched.
// Vim itself needs a DOM, so the browser test of the keys is in an editor's own tests.
const openLine = (t, below) => {
  const edit = t.state.facet(paragraphsOpener)[0](t.state, below);
  t.dispatch(t.state.update({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: EditorSelection.cursor(edit.cursor) }));
};

test("o and O open a paragraph, an item on an item, but never on a named line or with lists off", () => {
  const t = target("Head\nBody", 2, [...baseExtensions(), paragraphs()]);
  openLine(t, true);
  assert.equal(t.state.doc.toString(), "Head\n\n\nBody");
  assert.equal(t.state.doc.lineAt(t.state.selection.main.head).number, 3);
  const item = target("- a", 3, [paragraphs()]);
  openLine(item, false);
  assert.equal(item.state.doc.toString(), "- \n- a");
  assert.equal(item.state.selection.main.head, 2);
  const named = target("- a", 3, [paragraphs({ notList: () => true })]);
  openLine(named, true);
  assert.equal(named.state.doc.toString(), "- a\n\n");
  const off = target("- a", 3, [paragraphs({ lists: false })]);
  openLine(off, true);
  assert.equal(off.state.doc.toString(), "- a\n\n");
  // An editor without paragraphs() has no opener, so Vim's own o runs there.
  assert.deepEqual(target("a", 0, baseExtensions()).state.facet(paragraphsOpener), []);
});

test("J's joiner joins across a gap, but never removes a blank line kept to type on", () => {
  const t = target("One\n\nTwo", 0, [...baseExtensions(), paragraphs()]);
  assert.equal(run("One\n\nTwo", t.state.facet(paragraphsJoiner)[0](t.state, 0)), "One Two");
  const kept = target("One\n\nTwo", 0, [paragraphs({ keepBlank: (_s, line) => line.number === 2 })]);
  assert.equal(kept.state.facet(paragraphsJoiner)[0](kept.state, 0), null);
  // An editor without paragraphs() has no joiner, so J joins as Vim's own does there.
  assert.deepEqual(target("a", 0, baseExtensions()).state.facet(paragraphsJoiner), []);
});

// A stand-in for Vim on the stand-in view: getCM reads `cm` off the view, and the kit
// reads whether Vim is inserting from it.
const inserting = (t, on) => {
  t.cm = { state: { vim: { insertMode: on } } };
  t.state.field(insertRun).view = t;
  t.state.field(insertRun).started = false;
};
// A typed character, a pause of two seconds after the one before. Counted from the real
// clock too, because press() stamps the real time and the check runs every node test file
// in one process, so this file can start long after it was loaded.
let clock = Date.now();
const type = (t, text) => {
  const at = t.state.selection.main.head;
  clock = Math.max(clock, Date.now()) + 2000;
  t.dispatch(
    t.state.update({
      changes: { from: at, insert: text },
      selection: EditorSelection.cursor(at + text.length),
      userEvent: "input.type",
      annotations: Transaction.time.of(clock),
    }),
  );
};
// Vim's o as the kit's action runs it: the opener's paragraph, then the session begins
// with that paragraph as its first change.
const vimOpen = (t, below) => {
  inserting(t, false);
  const edit = t.state.facet(paragraphsOpener)[0](t.state, below);
  t.dispatch(t.state.update({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: EditorSelection.cursor(edit.cursor), userEvent: "input" }));
  inserting(t, true);
  t.state.field(insertRun).started = true;
};

test("with Vim inserting, o, Enter and typing with pauses are one undo step, redone in one", () => {
  const t = target("Head", 4, [...baseExtensions(), paragraphs()]);
  vimOpen(t, true);
  type(t, "a");
  assert.ok(press(t, "Enter"));
  type(t, "b");
  assert.equal(t.state.doc.toString(), "Head\n\na\n\nb");
  assert.equal(undoDepth(t.state), 1);
  assert.ok(undo(t));
  assert.equal(t.state.doc.toString(), "Head");
  assert.ok(redo(t));
  assert.equal(t.state.doc.toString(), "Head\n\na\n\nb");

  // O on an item, the same.
  const item = target("- a", 3, [...baseExtensions(), paragraphs()]);
  vimOpen(item, false);
  type(item, "b");
  assert.equal(item.state.doc.toString(), "- b\n- a");
  assert.ok(undo(item));
  assert.equal(item.state.doc.toString(), "- a");

  // i, typing, Enter, typing: the whole session goes at once, and nothing before it.
  const i = target("One", 3, [...baseExtensions(), paragraphs()]);
  inserting(i, true);
  type(i, "x");
  assert.ok(press(i, "Enter"));
  type(i, "y");
  inserting(i, false);
  move(i, 2);
  inserting(i, true);
  type(i, "z");
  assert.equal(i.state.doc.toString(), "Onzex\n\ny");
  assert.ok(undo(i));
  assert.equal(i.state.doc.toString(), "Onex\n\ny");
  assert.ok(undo(i));
  assert.equal(i.state.doc.toString(), "One");
});

test("without Vim inserting, undo groups as CodeMirror does; a change the editor makes ends a session", () => {
  const t = target("Head", 4, [...baseExtensions(), paragraphs()]);
  assert.ok(press(t, "Enter"));
  type(t, "a");
  assert.ok(undo(t));
  assert.equal(t.state.doc.toString(), "Head\n\n");

  const s = target("", 0, [...baseExtensions(), paragraphs()]);
  inserting(s, true);
  type(s, "sent");
  s.dispatch(s.state.update({ changes: { from: 0, to: s.state.doc.length, insert: "" } }));
  type(s, "n");
  type(s, "w");
  assert.ok(undo(s));
  assert.equal(s.state.doc.toString(), "");
});

test("a named line or lists off keep the paragraph keys", () => {
  const named = target("- one", 5, [paragraphs({ notList: () => true })]);
  assert.ok(press(named, "Enter"));
  assert.equal(named.state.doc.toString(), "- one\n\n");
  const off = target("- one", 2, [paragraphs({ lists: false })]);
  assert.ok(press(off, "Backspace") === false);
  assert.equal(press(off, "Tab"), false);
});

test("Backspace unbullets in one Undo step; Tab indents only in a list", () => {
  const t = target("- a\n- b", 6, [...baseExtensions(), paragraphs()]);
  assert.ok(press(t, "Tab"));
  assert.equal(t.state.doc.toString(), "- a\n  - b");
  assert.ok(press(t, "Shift-Tab"));
  assert.equal(t.state.doc.toString(), "- a\n- b");
  assert.ok(press(t, "Backspace"));
  assert.equal(t.state.doc.toString(), "- a\nb");
  assert.ok(undo(t));
  assert.equal(t.state.doc.toString(), "- a\n- b");
  // Outside a list, or where the item cannot move, Tab is the browser's.
  assert.equal(press(target("text", 2, [paragraphs()]), "Tab"), false);
  assert.equal(press(target("- a", 2, [paragraphs()]), "Tab"), false);
  assert.equal(press(target("- a", 2, [paragraphs()]), "Shift-Tab"), false);
});

test("a move into a marker rests at the text; a click too", () => {
  const t = target("One\n- two", 1, [paragraphs()]);
  move(t, 4);
  assert.equal(t.state.selection.main.head, 6);
  move(t, 5, "select");
  assert.equal(t.state.selection.main.head, 3);
  move(t, 5, "select.pointer");
  assert.equal(t.state.selection.main.head, 6);
  // A named line is plain text, so the cursor may rest anywhere in it.
  const named = target("One\n- two", 1, [paragraphs({ notList: () => true })]);
  move(named, 4);
  assert.equal(named.state.selection.main.head, 4);
});

// What Vim's Ex line reads of its editor, with the view as cm6, so :q runs without a
// browser.
const exLine = (view) => ({
  cm6: view,
  state: { vim: { visualMode: false } },
  operation: (fn) => fn(),
  getCursor: () => ({ line: 0, ch: 0 }),
});

test(":q and :quit run the editor's own quit handler; one without a handler does nothing", () => {
  const quits = [];
  const one = target("One", 0, baseExtensions({ vim: true, quit: (view) => quits.push(view) }));
  const other = target("Two", 0, baseExtensions({ vim: true }));
  Vim.handleEx(exLine(one), "q");
  Vim.handleEx(exLine(one), "quit");
  assert.deepEqual(quits, [one, one]);
  Vim.handleEx(exLine(other), "q");
  assert.equal(quits.length, 2);
  // Switching Vim off and on keeps the handler.
  setVim(one, false);
  setVim(one, true);
  Vim.handleEx(exLine(one), "q");
  assert.equal(quits.length, 3);
});

test(":tabc and :tabclose run the same quit handler as :q", () => {
  const quits = [];
  const one = target("One", 0, baseExtensions({ vim: true, quit: (view) => quits.push(view) }));
  Vim.handleEx(exLine(one), "tabc");
  Vim.handleEx(exLine(one), "tabclose");
  assert.deepEqual(quits, [one, one]);
});

// --- Source links -------------------------------------------------------------------

const HL = "01K7TEST0000000000000H0001";
const LINK = `[A \\[b\\] c…](note:${HL})`;
const TEXT = `see ${LINK} end`;
const END = 4 + LINK.length;

test("source links are found with their ranges and their labels unescaped, never across lines", () => {
  assert.deepEqual(sourceLinksIn(TEXT), [{ from: 4, to: END, id: HL, label: "A [b] c…" }]);
  assert.deepEqual(sourceLinksIn(`[a](note:${HL})[b](note:${HL})`).map((l) => l.label), ["a", "b"]);
  assert.deepEqual(sourceLinksIn(`[a\nb](note:${HL})`), []);
});

// The tags drawn in a state, by range and whether each is grey.
const tags = (state) => {
  const found = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue;
    source.between(0, state.doc.length, (from, to, deco) => {
      if (deco.spec.widget?.id) found.push({ from, to, gone: deco.spec.widget.gone });
    });
  }
  return found;
};

test("a source link is one tag; a deletion into it takes it whole and text put inside goes after it", () => {
  const t = target(TEXT, 0, [sourceLinks({ follow: () => {} })]);
  assert.deepEqual(tags(t.state), [{ from: 4, to: END, gone: false }]);
  // Backspace just after the tag.
  t.dispatch(t.state.update({ changes: { from: END - 1, to: END }, userEvent: "delete.backward" }));
  assert.equal(t.state.doc.toString(), "see  end");
  assert.equal(t.state.selection.main.head, 4);
  // Text put inside a tag, as Vim's p on it, lands after it.
  const u = target(TEXT, 0, [sourceLinks({ follow: () => {} })]);
  u.dispatch(u.state.update({ changes: { from: 6, insert: "X" }, userEvent: "input.paste" }));
  assert.equal(u.state.doc.toString(), `see ${LINK}X end`);
});

test("a cursor never rests inside a tag: it goes to the edge it was heading for", () => {
  const t = target(TEXT, 4, [sourceLinks({ follow: () => {} })]);
  move(t, 5);
  assert.equal(t.state.selection.main.head, END);
  move(t, END - 1);
  assert.equal(t.state.selection.main.head, 4);
});

test("a tag is grey while its highlight is missing, and missingLinks redraws it", () => {
  const t = target(TEXT, 0, [sourceLinks({ follow: () => {}, missing: (id) => id === HL })]);
  assert.deepEqual(tags(t.state).map((x) => x.gone), [true]);
  missingLinks(t, () => false);
  assert.deepEqual(tags(t.state).map((x) => x.gone), [false]);
  assert.equal(t.state.doc.toString(), TEXT, "drawing never changes the text");
});

test("toRegister puts a text in Vim's unnamed register, which p pastes", () => {
  toRegister(LINK);
  assert.equal(Vim.getRegisterController().getRegister('"').toString(), LINK);
});


// --- Numbered lists, checklists and quotes ---------------------------------------------

test("numbers, checklist items and quotes are items too, each with the marker that follows it", () => {
  assert.deepEqual(itemAt("12. a", 0), { from: 0, to: 5, kind: "number", indent: 0, marker: "12.", next: "13.", number: 12, textFrom: 4 });
  const box = itemAt("  * [x] done", 0);
  assert.deepEqual([box.kind, box.ticked, box.next, box.textFrom], ["check", true, "* [ ]", 8]);
  assert.equal(itemAt("- [ ] todo", 0).ticked, false);
  assert.deepEqual([itemAt("> said", 0).kind, itemAt("> said", 0).textFrom], ["quote", 2]);
  // Without the space after the marker, plain text or a plain bullet.
  assert.equal(itemAt("1.a", 0), null);
  assert.equal(itemAt(">a", 0), null);
  assert.equal(itemAt("- [ ]x", 0).kind, "bullet");
});

test("Enter on a numbered item, a checklist item or a quote continues it; on an empty one it ends", () => {
  assert.equal(run("1. a", nextItemAt("1. a", 4)), "1. a\n2. ");
  assert.equal(run("- [x] a", nextItemAt("- [x] a", 7)), "- [x] a\n- [ ] ");
  assert.equal(run("> a", nextItemAt("> a", 3)), "> a\n> ");
  assert.equal(run("> a\n> ", nextItemAt("> a\n> ", 6)), "> a\n\n");
  assert.equal(run("- [ ] ", nextItemAt("- [ ] ", 6)), "");
  // Backspace at the start of the text takes the whole marker.
  assert.equal(run("3. a", unbulletAt("3. a", 3)), "a");
  assert.equal(run("- [ ] a", unbulletAt("- [ ] a", 6)), "a");
  assert.equal(run("> a", unbulletAt("> a", 2)), "a");
  // A quote never moves with Tab.
  assert.equal(indentAt("> a\n> b", 6), null);
  assert.equal(indentAt("- a\n> b", 6), null);
});

test("a box is ticked and emptied; anything but a checklist item is left alone", () => {
  assert.equal(run("- [ ] a", tickAt("- [ ] a", 6)), "- [x] a");
  assert.equal(run("  * [X] a", tickAt("  * [X] a", 0)), "  * [ ] a");
  assert.equal(tickAt("- a", 2), null);
});

const renumbered = (text, from, to, notList) => {
  let out = text;
  for (const c of renumber(text, from, to, notList).reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
};

test("a list is renumbered 1, 2, 3 at each level, across gaps, and only the list touched", () => {
  assert.equal(renumbered("1. a\n1. b\n7. c"), "1. a\n2. b\n3. c");
  // An indented level counts from 1 under each item.
  assert.equal(renumbered("1. a\n  4. x\n  9. y\n2. b\n  5. z"), "1. a\n  1. x\n  2. y\n2. b\n  1. z");
  // A gap keeps one list; a paragraph or a bullet at the level starts again.
  assert.equal(renumbered("1. a\n\n5. b\n\ntext\n\n4. c\n- d\n8. e"), "1. a\n\n2. b\n\ntext\n\n1. c\n- d\n1. e");
  // Only the list holding the lines from..to: here the second.
  const two = "3. a\n\ntext\n\n5. b\n6. c";
  assert.equal(renumbered(two, two.indexOf("5."), two.indexOf("5.")), "3. a\n\ntext\n\n1. b\n2. c");
  // From a paragraph typed between two lists, both are reached past the gaps.
  const mid = "1. a\n\nx\n\n3. b";
  assert.equal(renumbered(mid, 6, 7), "1. a\n\nx\n\n1. b");
  // A named line is never an item.
  assert.equal(renumbered("1. a\n5. b", 0, 0, (n) => n === 1), "1. a\n5. b");
  assert.equal(renumbered("9. a\n10. b"), "1. a\n2. b");
});

const marks = (state) => {
  const found = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue;
    source.between(0, state.doc.length, (from, _to, deco) => {
      const w = deco.spec.widget;
      if (w && "ticked" in w) found.push(w.kind === "check" ? (w.ticked ? "[x]" : "[ ]") : w.label);
      if (deco.spec.class === "cm-quote") found.push("bar " + state.doc.lineAt(from).number);
    });
  }
  return found;
};

test("a dash, a dot, a number, a box and a quote's bar are drawn, the bar across a gap in the quote", () => {
  const t = target("- a\n* b\n1. c\n- [x] d\n\n> e\n\n> f", 0, [paragraphs()]);
  assert.deepEqual(marks(t.state), ["\u2013", "\u2022", "1.", "[x]", "bar 6", "bar 7", "bar 8"]);
  assert.equal(t.state.doc.toString(), "- a\n* b\n1. c\n- [x] d\n\n> e\n\n> f", "drawing never changes the text");
});

test("Enter, o and Tab on a numbered list renumber it in the same undo step; a load is left as it is", () => {
  const t = target("1. a\n2. b", 4, [...baseExtensions(), paragraphs()]);
  assert.ok(press(t, "Enter"));
  assert.equal(t.state.doc.toString(), "1. a\n2. \n3. b");
  assert.ok(undo(t));
  assert.equal(t.state.doc.toString(), "1. a\n2. b");
  // Tab makes the second item the first of its own level.
  const tab = target("1. a\n2. b\n3. c", 9, [...baseExtensions(), paragraphs()]);
  assert.ok(press(tab, "Tab"));
  assert.equal(tab.state.doc.toString(), "1. a\n  1. b\n2. c");
  // O above an item.
  const o = target("1. a", 3, [paragraphs()]);
  vimOpen(o, false);
  assert.equal(o.state.doc.toString(), "1. \n2. a");
  // The editor's own change, as a load, keeps its numbers.
  const load = target("", 0, [paragraphs()]);
  load.dispatch(load.state.update({ changes: { from: 0, insert: "4. a\n4. b" } }));
  assert.equal(load.state.doc.toString(), "4. a\n4. b");
});

test("Ctrl+Enter ticks a checklist item in one undo step, never in an editor that takes no typing", () => {
  const t = target("x\n\n- [ ] a", 9, [...baseExtensions(), paragraphs()]);
  assert.ok(press(t, "Ctrl-Enter"));
  assert.equal(t.state.doc.toString(), "x\n\n- [x] a");
  assert.equal(t.state.selection.main.head, 9, "a tick is not a move");
  assert.ok(undo(t));
  assert.equal(t.state.doc.toString(), "x\n\n- [ ] a");
  const read = target("- [ ] a", 6, [paragraphs(), EditorState.readOnly.of(true)]);
  assert.equal(press(read, "Ctrl-Enter"), false);
  assert.equal(read.state.doc.toString(), "- [ ] a");
  assert.equal(press(target("text", 2, [paragraphs()]), "Ctrl-Enter"), false);
});

test("a cursor never rests inside a number, a box or a quote's marker", () => {
  for (const [doc, textFrom] of [["One\n12. two", 8], ["One\n- [ ] two", 10], ["One\n> two", 6]]) {
    const t = target(doc, 1, [paragraphs()]);
    move(t, 5);
    assert.equal(t.state.selection.main.head, textFrom, doc);
  }
});


// --- Web links -------------------------------------------------------------------------

test("bare addresses are links without the punctuation after them", () => {
  const urls = (text) => webLinksIn(text).map((l) => l.url);
  assert.deepEqual(urls("see https://a.com/x. and http://b.org, then"), ["https://a.com/x", "http://b.org"]);
  assert.deepEqual(urls("(at https://a.com/x) or https://a.com/y:"), ["https://a.com/x", "https://a.com/y"]);
  assert.deepEqual(urls("https://en.wikipedia.org/wiki/Foo_(bar)."), ["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  assert.deepEqual(urls("https:// and ftp://a.com and a.com"), []);
  assert.deepEqual(webLinksIn("go https://a.com now")[0], { from: 3, to: 16, url: "https://a.com" });
});

test("a markdown link is one link with its label; its address is never a bare link too", () => {
  const text = "x [The \\] site](https://a.com/p_(1)) https://b.com";
  const [md, bare] = webLinksIn(text);
  assert.deepEqual(md, { from: 2, to: 36, url: "https://a.com/p_(1)", label: "The ] site", labelFrom: 3, labelTo: 14 });
  assert.equal(bare.url, "https://b.com");
  assert.equal(webLinksIn(`[a](note:01K7TEST0000000000000H0001)`).length, 0, "a source link is not a web link");
  assert.equal(webLinkAt(text, 2)?.url, "https://a.com/p_(1)");
  assert.equal(webLinkAt(text, 36), null);
  assert.equal(webLinkAt(text, 40)?.url, "https://b.com");
});

// What the decorations draw: the marked text with its address, and the hidden ranges.
const drawn = (state, rawLine) => {
  const out = [];
  webLinkDecorations(state, rawLine).between(0, state.doc.length, (from, to, deco) => {
    const href = deco.spec.attributes?.["data-href"];
    out.push(href ? [state.sliceDoc(from, to), href] : ["hidden", state.sliceDoc(from, to)]);
  });
  return out;
};

test("a markdown link shows only its label, except on the raw line; a bare one stays as typed", () => {
  const state = EditorState.create({ doc: "[Site](https://a.com)\nhttps://b.com" });
  assert.deepEqual(drawn(state, 0), [
    ["hidden", "["],
    ["Site", "https://a.com"],
    ["hidden", "](https://a.com)"],
    ["https://b.com", "https://b.com"],
  ]);
  assert.deepEqual(drawn(state, 1), [
    ["[Site](https://a.com)", "https://a.com"],
    ["https://b.com", "https://b.com"],
  ]);
});

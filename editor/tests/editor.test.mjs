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
  pastGap,
  itemAt,
  nextItemAt,
  unbulletAt,
  indentAt,
  outdentAt,
  markerStop,
  openAt,
  paragraphsOpener,
  insertRun,
  sourceLinksIn,
  sourceLinks,
  missingLinks,
  toRegister,
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

test("a blank line is a gap unless the cursor is on it", () => {
  assert.equal(isGap({ text: "", number: 2 }, 3), true);
  assert.equal(isGap({ text: "", number: 2 }, 2), false);
  assert.equal(isGap({ text: "One", number: 1 }, 3), false);
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
  assert.deepEqual(itemAt("One\n- two", 6), { from: 4, to: 9, indent: 0, marker: "-", textFrom: 6 });
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

test("Enter on an item makes the next one a gap below; the line-break key one line below", () => {
  assert.equal(run("- one", nextItemAt("- one", 5, 5, true)), "- one\n\n- ");
  assert.equal(nextItemAt("- one", 5, 5, true).cursor, 9);
  assert.equal(run("  * onetwo", nextItemAt("  * onetwo", 7, 7, true)), "  * one\n\n  * two");
  // An empty item after a gap ends the list the same way, leaving the gap above.
  assert.equal(run("- a\n\n- ", nextItemAt("- a\n\n- ", 7, 7, true)), "- a\n\n");
  assert.equal(run("- a\n\n  - ", nextItemAt("- a\n\n  - ", 9, 9, true)), "- a\n\n- ");
  assert.equal(run("- a\n\n- \n\n- b", nextItemAt("- a\n\n- \n\n- b", 7, 7, true)), "- a\n\n\n\n- b");
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
  // On an item, the next or previous item at its indent and with its marker.
  const t = "- a\n  * b";
  assert.equal(run(t, openAt(t, 8, true, itemAt(t, 8))), "- a\n  * b\n\n  * ");
  assert.equal(openAt(t, 8, true, itemAt(t, 8)).cursor, 15);
  assert.equal(run(t, openAt(t, 8, false, itemAt(t, 8))), "- a\n  * \n\n  * b");
  assert.equal(openAt(t, 8, false, itemAt(t, 8)).cursor, 8);
  // An empty item opens another; o never ends a list.
  assert.equal(run("- ", openAt("- ", 2, true, itemAt("- ", 2))), "- \n\n- ");
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

test("a keyboard move steps over a gap; a click and a kept blank line stay", () => {
  const t = target("One\n\n\nTwo", 1, [paragraphs()]);
  move(t, 4); // onto line 2, a gap
  assert.equal(t.state.doc.lineAt(t.state.selection.main.head).number, 4);
  move(t, 4); // back up onto a gap
  assert.equal(t.state.doc.lineAt(t.state.selection.main.head).number, 1);
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
  assert.equal(t.state.doc.toString(), "- one\n\n- ");
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
  assert.equal(item.state.doc.toString(), "- \n\n- a");
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
  assert.equal(item.state.doc.toString(), "- b\n\n- a");
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


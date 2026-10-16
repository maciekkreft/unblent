import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { baseExtensions, setVim, paragraphs, enterAt, breakAt, backspaceAt, deleteAt, isGap, pastGap } from "../editor.js";

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

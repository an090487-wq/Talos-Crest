import assert from "node:assert/strict";
import test from "node:test";
import { redo, undo, history } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";

function createState(doc) {
  return EditorState.create({
    doc,
    extensions: [history(), EditorState.allowMultipleSelections.of(true)],
  });
}

function runCommand(state, command) {
  let nextState = state;
  const handled = command({
    state,
    dispatch: (transaction) => {
      nextState = transaction.state;
    },
  });
  return { handled, state: nextState };
}

test("selections map through edits without damaging Unicode text", () => {
  let state = createState("a😀cafe\u0301");
  state = state.update({
    selection: EditorSelection.create([
      EditorSelection.range(1, 3),
      EditorSelection.cursor(8),
    ]),
  }).state;
  state = state.update({ changes: { from: 0, insert: "λ" } }).state;

  assert.equal(state.doc.toString(), "λa😀cafe\u0301");
  assert.deepEqual(
    state.selection.ranges.map(({ anchor, head }) => [anchor, head]),
    [
      [2, 4],
      [9, 9],
    ]
  );
});

test("multiple selections can apply independent edits in one transaction", () => {
  let state = createState("one\ntwo\n");
  state = state.update({
    selection: EditorSelection.create([
      EditorSelection.cursor(0),
      EditorSelection.cursor(4),
    ]),
  }).state;
  state = state.update({
    changes: [
      { from: state.selection.ranges[0].from, insert: "> " },
      { from: state.selection.ranges[1].from, insert: "> " },
    ],
  }).state;

  assert.equal(state.doc.toString(), "> one\n> two\n");
});

test("undo and redo restore exact Unicode document contents", () => {
  let state = createState("a😀b\n");
  state = state.update({
    changes: { from: 3, insert: " café" },
    annotations: Transaction.userEvent.of("input.type"),
  }).state;
  assert.equal(state.doc.toString(), "a😀 caféb\n");

  const undone = runCommand(state, undo);
  assert.equal(undone.handled, true);
  assert.equal(undone.state.doc.toString(), "a😀b\n");

  const redone = runCommand(undone.state, redo);
  assert.equal(redone.handled, true);
  assert.equal(redone.state.doc.toString(), "a😀 caféb\n");
});

test("a replacement document starts with an independent undo history", () => {
  let state = createState("original");
  state = state.update({ changes: { from: 8, insert: " edited" } }).state;
  assert.equal(runCommand(state, undo).handled, true);

  state = createState("replacement");
  const result = runCommand(state, undo);
  assert.equal(result.handled, false);
  assert.equal(result.state.doc.toString(), "replacement");
});

test("large documents retain exact contents through edits and history", () => {
  for (const lineCount of [10_000, 50_000]) {
    const source = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`).join("\n");
    const original = createState(source);
    const midpoint = lineCount >> 1;
    const position = original.doc.line(midpoint).to;
    const edited = original.update({ changes: { from: position, insert: " ✓" } }).state;
    const undone = runCommand(edited, undo);

    assert.equal(edited.doc.line(1).text, "line 1");
    assert.equal(edited.doc.line(midpoint).text, `line ${midpoint} ✓`);
    assert.equal(undone.state.doc.toString(), source);
    assert.equal(runCommand(undone.state, redo).state.doc.toString(), edited.doc.toString());
  }
});

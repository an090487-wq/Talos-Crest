import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { EditorState } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";

const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/document-tabs.ts");
const source = await readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const tabsModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  createRequire(sourcePath),
  tabsModule,
  tabsModule.exports
);
const {
  DocumentTabRegistry,
  documentKey,
  findDocumentIndex,
  nextDocumentIndex,
  parseWindowTabsSession,
} = tabsModule.exports;

test("document paths are normalized for duplicate detection", () => {
  assert.equal(documentKey("/work/src/../src/main.ts"), "/work/src/main.ts");
  assert.equal(findDocumentIndex([{ path: "/work/main.ts" }], "/work/main.ts"), 0);
  assert.equal(findDocumentIndex([{ path: null }], "/work/main.ts"), -1);
});

test("tab navigation wraps in either direction and handles an empty tab list", () => {
  assert.equal(nextDocumentIndex(0, 3, -1), 2);
  assert.equal(nextDocumentIndex(2, 3, 1), 0);
  assert.equal(nextDocumentIndex(0, 0, 1), -1);
});

test("registry deduplicates files and reopens the exact closed document state", () => {
  const registry = new DocumentTabRegistry();
  const first = { path: "/work/a.ts", state: EditorState.create({ doc: "a" }) };
  const second = { path: "/work/b.ts", state: EditorState.create({ doc: "b" }) };
  assert.equal(registry.open(first).created, true);
  assert.equal(registry.open(second).created, true);
  assert.equal(registry.open({ path: "/work/./a.ts", state: null }).tab, first);
  assert.equal(registry.close(first), 0);
  assert.equal(registry.reopen(), first);
  assert.deepEqual(registry.openTabs, [second, first]);
});

test("tab state retains cursor and scroll positions when switching away and back", () => {
  const registry = new DocumentTabRegistry();
  const first = {
    path: "/work/a.ts",
    state: EditorState.create({ doc: "first document" }),
    scrollTop: 140,
  };
  const second = { path: "/work/b.ts", state: EditorState.create({ doc: "second" }) };
  first.state = first.state.update({ selection: { anchor: 6 } }).state;
  registry.open(first);
  registry.open(second);
  assert.equal(registry.close(first), 0);
  assert.equal(registry.reopen(), first);
  assert.equal(first.state.selection.main.head, 6);
  assert.equal(first.scrollTop, 140);
});

test("dirty state returns to clean when undo restores the saved document", () => {
  let state = EditorState.create({ doc: "saved", extensions: history() });
  const savedDocument = state.doc;
  assert.equal(savedDocument.eq(state.doc), true);
  state = state.update({ changes: { from: 5, insert: " edits" } }).state;
  assert.equal(savedDocument.eq(state.doc), false);
  assert.equal(undo({ state, dispatch: (transaction) => { state = transaction.state; } }), true);
  assert.equal(savedDocument.eq(state.doc), true);
});

test("closed tabs retain independent CodeMirror history across reopening", () => {
  const registry = new DocumentTabRegistry();
  const firstState = EditorState.create({ doc: "one", extensions: history() });
  const secondState = EditorState.create({ doc: "two", extensions: history() });
  const first = { path: "/work/one.ts", state: firstState };
  const second = { path: "/work/two.ts", state: secondState };
  registry.open(first);
  registry.open(second);

  first.state = first.state.update({ changes: { from: 3, insert: " edited" } }).state;
  registry.close(first);
  assert.equal(registry.reopen(), first);
  assert.equal(undo({ state: first.state, dispatch: (transaction) => { first.state = transaction.state; } }), true);
  assert.equal(first.state.doc.toString(), "one");
  assert.equal(redo({ state: first.state, dispatch: (transaction) => { first.state = transaction.state; } }), true);
  assert.equal(first.state.doc.toString(), "one edited");
  assert.equal(second.state.doc.toString(), "two");
});

test("session parser rejects invalid data and removes duplicate file tabs", () => {
  assert.equal(parseWindowTabsSession("{"), null);
  assert.equal(parseWindowTabsSession(JSON.stringify({ version: 3, documents: [] })), null);

  const session = parseWindowTabsSession(
    JSON.stringify({
      version: 1,
      activeIndex: 8,
      documents: [
        { path: "/work/a.ts", suggestedName: null, anchor: -3, head: 5, scrollTop: 12 },
        { path: "/work/a.ts", suggestedName: null, anchor: 0, head: 0, scrollTop: 0 },
        { path: "/work/b.ts", suggestedName: "b.ts", anchor: 2, head: 4, scrollTop: 0 },
        { path: 4, suggestedName: null, anchor: 0, head: 0, scrollTop: 0 },
      ],
    }),
  );
  assert.deepEqual(session.documents.map(({ path }) => path), ["/work/a.ts", "/work/b.ts"]);
  assert.equal(session.documents[0].anchor, 0);
  assert.equal(session.activeIndex, 1);
});

import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

export interface OutlineSymbol {
  name: string;
  kind: "class" | "function" | "method" | "interface" | "type" | "variable";
  from: number;
  to: number;
  depth: number;
}

export interface OutlineResult {
  supported: boolean;
  complete: boolean;
  symbols: OutlineSymbol[];
}

const supportedLanguages = new Set(["Python", "JavaScript", "JSX", "TypeScript", "TSX"]);

function symbolFromNode(
  node: SyntaxNode,
  state: EditorState,
  language: string,
  depth: number
): OutlineSymbol | null {
  let kind: OutlineSymbol["kind"] | null = null;
  let nameNode: SyntaxNode | null = null;
  if (language === "Python") {
    if (node.name === "ClassDefinition") {
      kind = "class";
      nameNode = node.getChild("VariableName");
    } else if (node.name === "FunctionDefinition") {
      kind = "function";
      nameNode = node.getChild("VariableName");
    }
  } else {
    switch (node.name) {
      case "ClassDeclaration":
        kind = "class";
        nameNode = node.getChild("VariableDefinition");
        break;
      case "FunctionDeclaration":
        kind = "function";
        nameNode = node.getChild("VariableDefinition");
        break;
      case "MethodDeclaration":
        kind = "method";
        nameNode = node.getChild("PropertyDefinition");
        break;
      case "InterfaceDeclaration":
        kind = "interface";
        nameNode = node.getChild("TypeDefinition");
        break;
      case "TypeAliasDeclaration":
      case "EnumDeclaration":
      case "ModuleDeclaration":
      case "NamespaceDeclaration":
        kind = "type";
        nameNode = node.getChild("TypeDefinition") ?? node.getChild("VariableDefinition");
        break;
      case "VariableDeclaration": {
        nameNode = node.getChild("VariableDefinition");
        if (nameNode) {
          kind = node.getChild("ArrowFunction") || node.getChild("FunctionExpression")
            ? "function"
            : "variable";
        }
        break;
      }
    }
  }
  if (!kind || !nameNode) return null;
  const name = state.doc.sliceString(nameNode.from, nameNode.to).trim();
  if (!name) return null;
  return { name, kind, from: nameNode.from, to: nameNode.to, depth };
}

export function collectOutline(
  state: EditorState,
  language: string,
  timeout = 8
): OutlineResult {
  if (!supportedLanguages.has(language)) {
    return { supported: false, complete: false, symbols: [] };
  }
  // Prefer the tree the editor already parsed. Only nudge the parser with a
  // small time budget when the document is not covered yet, and fall back to
  // the partial tree instead of blocking the UI waiting for a full parse.
  let tree = syntaxTree(state);
  if (!syntaxTreeAvailable(state, state.doc.length)) {
    tree = ensureSyntaxTree(state, state.doc.length, timeout) ?? tree;
  }

  const symbols: OutlineSymbol[] = [];
  const limit = 2000;
  const visit = (node: SyntaxNode, depth: number, functionDepth: number) => {
    if (symbols.length >= limit) return;
    let symbol = symbolFromNode(node, state, language, depth);
    if (symbol?.kind === "variable" && functionDepth > 0) symbol = null;
    if (symbol) symbols.push(symbol);
    const nextDepth = symbol ? depth + 1 : depth;
    const nextFunctionDepth =
      functionDepth + (symbol?.kind === "function" || symbol?.kind === "method" ? 1 : 0);
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (symbols.length >= limit) break;
      visit(child, nextDepth, nextFunctionDepth);
    }
  };
  visit(tree.topNode, 0, 0);
  return {
    supported: true,
    complete: syntaxTreeAvailable(state, state.doc.length),
    symbols,
  };
}

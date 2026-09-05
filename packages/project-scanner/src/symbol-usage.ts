import {
  Node,
  SyntaxKind,
  type Identifier,
  type SourceFile,
} from "ts-morph";

import type { SymbolUsage, SymbolUsageKind } from "./types.js";

export interface ImportedSymbolBinding {
  dependency: string;
  importedSymbol?: string;
  localBinding: string;
  usageBase: string;
  declaration: Identifier;
  validFrom?: number;
}

interface BindingOrigin {
  dependency: string;
  importedSymbol?: string;
  localBinding: string;
  usageBase: string;
  declaration: Identifier;
  validFrom: number;
  invalidAfter?: number;
  imported: boolean;
}

interface StaticAccessPath {
  root: Identifier;
  members: string[];
}

function symbolFor(identifier: Identifier): object | undefined {
  return identifier.getSymbol()?.compilerSymbol;
}

function staticElementName(node: Node): string | undefined {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }
  if (Node.isNumericLiteral(node)) {
    return node.getLiteralValue().toString();
  }
  return undefined;
}

function staticAccessPath(node: Node): StaticAccessPath | undefined {
  if (Node.isIdentifier(node)) {
    return { root: node, members: [] };
  }
  if (Node.isPropertyAccessExpression(node)) {
    const path = staticAccessPath(node.getExpression());
    return path === undefined
      ? undefined
      : { root: path.root, members: [...path.members, node.getName()] };
  }
  if (Node.isElementAccessExpression(node)) {
    const path = staticAccessPath(node.getExpression());
    const argument = node.getArgumentExpression();
    const member = argument === undefined ? undefined : staticElementName(argument);
    return path === undefined || member === undefined
      ? undefined
      : { root: path.root, members: [...path.members, member] };
  }
  return undefined;
}

function isSameNode(left: Node, right: Node): boolean {
  return left.compilerNode === right.compilerNode;
}

function isAssignmentOperator(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
}

function isDirectWrite(identifier: Identifier): boolean {
  const parent = identifier.getParent();
  if (
    parent !== undefined
    && Node.isBinaryExpression(parent)
    && isSameNode(parent.getLeft(), identifier)
    && isAssignmentOperator(parent.getOperatorToken().getKind())
  ) {
    return true;
  }

  return parent !== undefined
    && (Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent))
    && (parent.getOperatorToken() === SyntaxKind.PlusPlusToken
      || parent.getOperatorToken() === SyntaxKind.MinusMinusToken);
}

function markReassignments(
  sourceFile: SourceFile,
  originsBySymbol: Map<object, BindingOrigin>,
): void {
  for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const symbol = symbolFor(identifier);
    const origin = symbol === undefined ? undefined : originsBySymbol.get(symbol);
    if (origin === undefined || !isDirectWrite(identifier)) {
      continue;
    }

    const position = identifier.getStart();
    if (origin.invalidAfter === undefined || position < origin.invalidAfter) {
      origin.invalidAfter = position;
    }
  }
}

function collectConstructorInstances(
  sourceFile: SourceFile,
  originsBySymbol: Map<object, BindingOrigin>,
): void {
  const declarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .sort((left, right) => left.getStart() - right.getStart());

  for (const declaration of declarations) {
    const nameNode = declaration.getNameNode();
    const initializer = declaration.getInitializer();
    if (!Node.isIdentifier(nameNode) || initializer === undefined || !Node.isNewExpression(initializer)) {
      continue;
    }

    const constructorPath = staticAccessPath(initializer.getExpression());
    const constructorSymbol = constructorPath === undefined
      ? undefined
      : symbolFor(constructorPath.root);
    const constructorOrigin = constructorSymbol === undefined
      ? undefined
      : originsBySymbol.get(constructorSymbol);
    if (
      constructorOrigin === undefined
      || !constructorOrigin.imported
      || initializer.getStart() < constructorOrigin.validFrom
      || (constructorOrigin.invalidAfter !== undefined
        && initializer.getStart() >= constructorOrigin.invalidAfter)
    ) {
      continue;
    }

    const instanceSymbol = symbolFor(nameNode);
    if (instanceSymbol === undefined) {
      continue;
    }

    originsBySymbol.set(instanceSymbol, {
      dependency: constructorOrigin.dependency,
      ...(constructorOrigin.importedSymbol === undefined
        ? {}
        : { importedSymbol: constructorOrigin.importedSymbol }),
      localBinding: nameNode.getText(),
      usageBase: nameNode.getText(),
      declaration: nameNode,
      validFrom: initializer.getEnd(),
      imported: false,
    });
  }
}

function isTypePosition(identifier: Identifier): boolean {
  return identifier.getAncestors().some((ancestor) => Node.isTypeNode(ancestor));
}

function usageForReference(
  sourceFile: SourceFile,
  file: string,
  identifier: Identifier,
  origin: BindingOrigin,
): SymbolUsage | undefined {
  const position = identifier.getStart();
  if (
    isSameNode(identifier, origin.declaration)
    || position < origin.validFrom
    || (origin.invalidAfter !== undefined && position >= origin.invalidAfter)
    || isDirectWrite(identifier)
    || isTypePosition(identifier)
  ) {
    return undefined;
  }

  let current: Node = identifier;
  const members: string[] = [];

  while (true) {
    const parent = current.getParent();
    if (
      parent !== undefined
      && Node.isPropertyAccessExpression(parent)
      && isSameNode(parent.getExpression(), current)
    ) {
      members.push(parent.getName());
      current = parent;
      continue;
    }
    if (
      parent !== undefined
      && Node.isElementAccessExpression(parent)
      && isSameNode(parent.getExpression(), current)
    ) {
      const argument = parent.getArgumentExpression();
      const member = argument === undefined ? undefined : staticElementName(argument);
      if (member !== undefined) {
        members.push(member);
        current = parent;
        continue;
      }
    }
    break;
  }

  const parent = current.getParent();
  let kind: SymbolUsageKind;
  if (parent !== undefined && Node.isCallExpression(parent) && isSameNode(parent.getExpression(), current)) {
    kind = "call";
  } else if (
    parent !== undefined
    && Node.isNewExpression(parent)
    && isSameNode(parent.getExpression(), current)
  ) {
    kind = "constructor";
  } else {
    kind = members.length > 0 ? "member-access" : "reference";
  }

  const location = sourceFile.getLineAndColumnAtPos(position);
  return {
    dependency: origin.dependency,
    file,
    ...(origin.importedSymbol === undefined ? {} : { importedSymbol: origin.importedSymbol }),
    localBinding: origin.localBinding,
    usagePath: [origin.usageBase, ...members].join("."),
    kind,
    line: location.line,
    column: location.column,
  };
}

function repeatedBindingSymbols(bindings: ImportedSymbolBinding[]): Set<object> {
  const bindingsByScope = new Map<object, Map<string, object[]>>();

  for (const binding of bindings) {
    const symbol = symbolFor(binding.declaration);
    const scope = binding.declaration.getFirstAncestor((ancestor) =>
      Node.isBlock(ancestor) || Node.isSourceFile(ancestor));
    if (symbol === undefined || scope === undefined) {
      continue;
    }

    const bindingsByName = bindingsByScope.get(scope.compilerNode) ?? new Map<string, object[]>();
    const symbols = bindingsByName.get(binding.localBinding) ?? [];
    symbols.push(symbol);
    bindingsByName.set(binding.localBinding, symbols);
    bindingsByScope.set(scope.compilerNode, bindingsByName);
  }

  const repeated = new Set<object>();
  for (const bindingsByName of bindingsByScope.values()) {
    for (const symbols of bindingsByName.values()) {
      if (symbols.length > 1) {
        symbols.forEach((symbol) => repeated.add(symbol));
      }
    }
  }
  return repeated;
}

export function analyzeSymbolUsages(
  sourceFile: SourceFile,
  file: string,
  bindings: ImportedSymbolBinding[],
): SymbolUsage[] {
  const originsBySymbol = new Map<object, BindingOrigin>();
  const ambiguousSymbols = repeatedBindingSymbols(bindings);

  for (const binding of bindings) {
    const bindingSymbol = binding.declaration.getSymbol();
    const symbol = bindingSymbol?.compilerSymbol;
    if (bindingSymbol === undefined || symbol === undefined || ambiguousSymbols.has(symbol)) {
      continue;
    }
    if (bindingSymbol.getDeclarations().length > 1 || originsBySymbol.has(symbol)) {
      originsBySymbol.delete(symbol);
      ambiguousSymbols.add(symbol);
      continue;
    }
    originsBySymbol.set(symbol, {
      dependency: binding.dependency,
      ...(binding.importedSymbol === undefined
        ? {}
        : { importedSymbol: binding.importedSymbol }),
      localBinding: binding.localBinding,
      usageBase: binding.usageBase,
      declaration: binding.declaration,
      validFrom: binding.validFrom ?? 0,
      imported: true,
    });
  }

  markReassignments(sourceFile, originsBySymbol);
  collectConstructorInstances(sourceFile, originsBySymbol);
  markReassignments(sourceFile, originsBySymbol);

  const usages: SymbolUsage[] = [];
  for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const symbol = symbolFor(identifier);
    const origin = symbol === undefined ? undefined : originsBySymbol.get(symbol);
    if (origin === undefined) {
      continue;
    }
    const usage = usageForReference(sourceFile, file, identifier, origin);
    if (usage !== undefined) {
      usages.push(usage);
    }
  }

  return usages.sort((left, right) =>
    left.line - right.line
    || left.column - right.column
    || left.usagePath.localeCompare(right.usagePath));
}

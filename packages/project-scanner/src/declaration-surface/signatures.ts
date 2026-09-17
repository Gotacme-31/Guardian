import { ts } from "ts-morph";

import type {
  DeclarationSurfaceIssue,
  PublicApiDeclarationKind,
  PublicApiMember,
} from "./types.js";

export interface AnalysisBudget {
  declarations: number;
  members: number;
  maxDeclarations: number;
  maxMembers: number;
}

export interface InternalDeclaration {
  originId: string;
  sourceOrder: number;
  exportedName: string;
  kind: PublicApiDeclarationKind;
  sourceFile: string;
  defaultExport: boolean;
  exportEquals: boolean;
  typeOnly: boolean;
  references: string[];
  importTypeReferences: InternalImportTypeReference[];
  signatures: string[];
  deprecated: boolean;
  members?: PublicApiMember[];
  namespaceExports?: InternalDeclaration[];
  externalModule?: string;
  importedName?: string;
}

export interface InternalImportTypeReference {
  specifier: string;
  importedName: string;
}

export interface ExportBinding {
  exportedName: string;
  localName: string;
  exportEquals: boolean;
  typeOnly: boolean;
  originId?: string;
}

export interface ImportBinding {
  specifier: string;
  importedName: string;
  namespace: boolean;
  typeOnly: boolean;
}

export interface NamedReexportBinding {
  exportedName: string;
  importedName: string;
  typeOnly: boolean;
}

export type ReexportDirective =
  | {
    mode: "named";
    originId: string;
    sourceFile: string;
    specifier: string;
    typeOnly: boolean;
    bindings: NamedReexportBinding[];
  }
  | {
    mode: "star";
    originId: string;
    sourceFile: string;
    specifier: string;
    typeOnly: boolean;
  }
  | {
    mode: "namespace";
    originId: string;
    sourceFile: string;
    specifier: string;
    exportedName: string;
    typeOnly: boolean;
  };

export interface FileDeclarationModel {
  locals: Map<string, InternalDeclaration[]>;
  exportBindings: ExportBinding[];
  immediateExports: InternalDeclaration[];
  imports: Map<string, ImportBinding>;
  reexports: ReexportDirective[];
}

type AddIssue = (issue: DeclarationSurfaceIssue) => void;

const printer = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: true,
});

function printNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).trim();
}

function modifiers(node: ts.Node): readonly ts.Modifier[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return modifiers(node).some((modifier) => modifier.kind === kind);
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isDefaultExport(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function isDeprecated(node: ts.Node): boolean {
  return ts.getJSDocDeprecatedTag(node) !== undefined;
}

function entityNameText(name: ts.EntityName): string {
  return ts.isIdentifier(name)
    ? name.text
    : `${entityNameText(name.left)}.${name.right.text}`;
}

function declarationReferences(node: ts.Node): {
  references: string[];
  importTypeReferences: InternalImportTypeReference[];
} {
  const references = new Set<string>();
  const boundNames = new Set<string>();
  const importTypeReferences = new Map<string, InternalImportTypeReference>();
  const skippedNodes = new Set<ts.Node>();
  if (ts.isClassDeclaration(node)) {
    for (const member of node.members) {
      const privateName = "name" in member && member.name !== undefined
        && ts.isPrivateIdentifier(member.name);
      if (memberVisibility(member) === undefined || privateName) {
        skippedNodes.add(member);
      }
    }
  }

  function visit(current: ts.Node): void {
    if (skippedNodes.has(current)) {
      return;
    }
    if (ts.isImportTypeNode(current)) {
      const argument = current.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        const reference = {
          specifier: argument.literal.text,
          importedName: current.qualifier === undefined
            ? "*"
            : entityNameText(current.qualifier),
        };
        importTypeReferences.set(
          `${reference.specifier}\0${reference.importedName}`,
          reference,
        );
      }
      current.typeArguments?.forEach(visit);
      return;
    }
    if (ts.isTypeParameterDeclaration(current)) {
      boundNames.add(current.name.text);
    }
    if (ts.isIdentifier(current)) {
      const parent = current.parent as ts.Node & { name?: ts.Node };
      if (parent.name !== current) {
        references.add(current.text);
      }
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  for (const boundName of boundNames) {
    references.delete(boundName);
  }
  return {
    references: [...references]
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    importTypeReferences: [...importTypeReferences.values()]
      .sort((left, right) => {
        const leftKey = `${left.specifier}\0${left.importedName}`;
        const rightKey = `${right.specifier}\0${right.importedName}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  };
}

function typeParameters(
  nodes: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  sourceFile: ts.SourceFile,
): string {
  return nodes === undefined || nodes.length === 0
    ? ""
    : `<${nodes.map((node) => printNode(node, sourceFile)).join(", ")}>`;
}

function parameters(
  nodes: ts.NodeArray<ts.ParameterDeclaration>,
  sourceFile: ts.SourceFile,
): string {
  return nodes.map((node) => printNode(node, sourceFile)).join(", ");
}

function returnType(type: ts.TypeNode | undefined, sourceFile: ts.SourceFile): string {
  return type === undefined ? "" : `: ${printNode(type, sourceFile)}`;
}

function declarationName(name: ts.DeclarationName | undefined, sourceFile: ts.SourceFile): string {
  return name === undefined ? "[anonymous]" : printNode(name, sourceFile);
}

function memberVisibility(node: ts.Node): "public" | "protected" | undefined {
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) {
    return undefined;
  }
  return hasModifier(node, ts.SyntaxKind.ProtectedKeyword) ? "protected" : "public";
}

function consumeDeclaration(
  budget: AnalysisBudget,
  sourceFile: string,
  addIssue: AddIssue,
): boolean {
  if (budget.declarations >= budget.maxDeclarations) {
    addIssue({
      code: "analysis-limit-exceeded",
      message: `Declaration analysis exceeds maxDeclarations (${budget.maxDeclarations}).`,
      sourceFile,
      limit: "maxDeclarations",
    });
    return false;
  }
  budget.declarations += 1;
  return true;
}

function consumeMember(
  budget: AnalysisBudget,
  sourceFile: string,
  addIssue: AddIssue,
): boolean {
  if (budget.members >= budget.maxMembers) {
    addIssue({
      code: "analysis-limit-exceeded",
      message: `Declaration analysis exceeds maxMembers (${budget.maxMembers}).`,
      sourceFile,
      limit: "maxMembers",
    });
    return false;
  }
  budget.members += 1;
  return true;
}

function memberKey(member: PublicApiMember): string {
  return [
    member.name,
    member.kind,
    member.visibility,
    member.static,
    member.optional,
    member.readonly,
    member.abstract,
  ].join("\0");
}

function addMember(
  members: Map<string, PublicApiMember>,
  member: PublicApiMember,
  budget: AnalysisBudget,
  sourceFile: string,
  addIssue: AddIssue,
): void {
  const key = memberKey(member);
  const existing = members.get(key);
  if (existing !== undefined) {
    members.set(key, {
      ...existing,
      signatures: [...existing.signatures, ...member.signatures],
      deprecated: existing.deprecated || member.deprecated,
    });
    return;
  }
  if (consumeMember(budget, sourceFile, addIssue)) {
    members.set(key, member);
  }
}

function propertySignature(
  type: ts.TypeNode | undefined,
  initializer: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
): string {
  if (type !== undefined) {
    return `: ${printNode(type, sourceFile)}`;
  }
  return initializer === undefined ? "" : `= ${printNode(initializer, sourceFile)}`;
}

function classMembers(
  node: ts.ClassDeclaration,
  sourcePath: string,
  sourceFile: ts.SourceFile,
  budget: AnalysisBudget,
  addIssue: AddIssue,
): PublicApiMember[] {
  const members = new Map<string, PublicApiMember>();
  for (const member of node.members) {
    const visibility = memberVisibility(member);
    const privateName = "name" in member && member.name !== undefined
      && ts.isPrivateIdentifier(member.name);
    if (visibility === undefined || privateName) {
      continue;
    }
    const common = {
      visibility,
      static: hasModifier(member, ts.SyntaxKind.StaticKeyword),
      optional: "questionToken" in member && member.questionToken !== undefined,
      readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
      abstract: hasModifier(member, ts.SyntaxKind.AbstractKeyword),
      deprecated: isDeprecated(member),
    } as const;

    if (ts.isConstructorDeclaration(member)) {
      addMember(members, {
        ...common,
        name: "constructor",
        kind: "constructor",
        static: false,
        optional: false,
        readonly: false,
        abstract: false,
        signatures: [`constructor(${parameters(member.parameters, sourceFile)})`],
      }, budget, sourcePath, addIssue);

      for (const parameter of member.parameters) {
        const parameterVisibility = memberVisibility(parameter);
        const isParameterProperty = modifiers(parameter).some((modifier) =>
          modifier.kind === ts.SyntaxKind.PublicKeyword
          || modifier.kind === ts.SyntaxKind.PrivateKeyword
          || modifier.kind === ts.SyntaxKind.ProtectedKeyword
          || modifier.kind === ts.SyntaxKind.ReadonlyKeyword);
        if (!isParameterProperty || parameterVisibility === undefined) {
          continue;
        }
        addMember(members, {
          name: declarationName(parameter.name, sourceFile),
          kind: "property",
          visibility: parameterVisibility,
          static: false,
          optional: parameter.questionToken !== undefined,
          readonly: hasModifier(parameter, ts.SyntaxKind.ReadonlyKeyword),
          abstract: false,
          signatures: [propertySignature(parameter.type, parameter.initializer, sourceFile)],
          deprecated: isDeprecated(parameter),
        }, budget, sourcePath, addIssue);
      }
      continue;
    }
    if (ts.isMethodDeclaration(member)) {
      addMember(members, {
        ...common,
        name: declarationName(member.name, sourceFile),
        kind: "method",
        signatures: [
          `method${typeParameters(member.typeParameters, sourceFile)}(${parameters(member.parameters, sourceFile)})${returnType(member.type, sourceFile)}`,
        ],
      }, budget, sourcePath, addIssue);
      continue;
    }
    if (ts.isPropertyDeclaration(member)) {
      addMember(members, {
        ...common,
        name: declarationName(member.name, sourceFile),
        kind: "property",
        signatures: [propertySignature(member.type, member.initializer, sourceFile)],
      }, budget, sourcePath, addIssue);
      continue;
    }
    if (ts.isIndexSignatureDeclaration(member)) {
      addMember(members, {
        ...common,
        name: "[index]",
        kind: "index-signature",
        static: false,
        optional: false,
        signatures: [
          `index(${parameters(member.parameters, sourceFile)})${returnType(member.type, sourceFile)}`,
        ],
      }, budget, sourcePath, addIssue);
      continue;
    }
    if (ts.isGetAccessorDeclaration(member)) {
      addMember(members, {
        ...common,
        name: declarationName(member.name, sourceFile),
        kind: "getter",
        optional: false,
        readonly: true,
        signatures: [`get${returnType(member.type, sourceFile)}`],
      }, budget, sourcePath, addIssue);
      continue;
    }
    if (ts.isSetAccessorDeclaration(member)) {
      addMember(members, {
        ...common,
        name: declarationName(member.name, sourceFile),
        kind: "setter",
        optional: false,
        readonly: false,
        signatures: [`set(${parameters(member.parameters, sourceFile)})`],
      }, budget, sourcePath, addIssue);
    }
  }
  return [...members.values()];
}

function interfaceMembers(
  node: ts.InterfaceDeclaration,
  sourcePath: string,
  sourceFile: ts.SourceFile,
  budget: AnalysisBudget,
  addIssue: AddIssue,
): PublicApiMember[] {
  const members = new Map<string, PublicApiMember>();
  for (const member of node.members) {
    const common = {
      visibility: "public" as const,
      static: false,
      optional: "questionToken" in member && member.questionToken !== undefined,
      readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
      abstract: false,
      deprecated: isDeprecated(member),
    };
    if (ts.isPropertySignature(member)) {
      addMember(members, {
        ...common,
        name: declarationName(member.name, sourceFile),
        kind: "property",
        signatures: [propertySignature(member.type, undefined, sourceFile)],
      }, budget, sourcePath, addIssue);
    } else if (ts.isMethodSignature(member)) {
      addMember(members, {
        ...common,
        name: declarationName(member.name, sourceFile),
        kind: "method",
        readonly: false,
        signatures: [
          `method${typeParameters(member.typeParameters, sourceFile)}(${parameters(member.parameters, sourceFile)})${returnType(member.type, sourceFile)}`,
        ],
      }, budget, sourcePath, addIssue);
    } else if (ts.isCallSignatureDeclaration(member)) {
      addMember(members, {
        ...common,
        name: "[call]",
        kind: "call-signature",
        optional: false,
        readonly: false,
        signatures: [
          `call${typeParameters(member.typeParameters, sourceFile)}(${parameters(member.parameters, sourceFile)})${returnType(member.type, sourceFile)}`,
        ],
      }, budget, sourcePath, addIssue);
    } else if (ts.isConstructSignatureDeclaration(member)) {
      addMember(members, {
        ...common,
        name: "[new]",
        kind: "construct-signature",
        optional: false,
        readonly: false,
        signatures: [
          `new${typeParameters(member.typeParameters, sourceFile)}(${parameters(member.parameters, sourceFile)})${returnType(member.type, sourceFile)}`,
        ],
      }, budget, sourcePath, addIssue);
    } else if (ts.isIndexSignatureDeclaration(member)) {
      addMember(members, {
        ...common,
        name: "[index]",
        kind: "index-signature",
        optional: false,
        signatures: [
          `index(${parameters(member.parameters, sourceFile)})${returnType(member.type, sourceFile)}`,
        ],
      }, budget, sourcePath, addIssue);
    }
  }
  return [...members.values()];
}

function heritage(
  clauses: ts.NodeArray<ts.HeritageClause> | undefined,
  sourceFile: ts.SourceFile,
): string {
  if (clauses === undefined || clauses.length === 0) {
    return "";
  }
  return clauses.map((clause) => {
    const keyword = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
    return `${keyword} ${clause.types.map((type) => printNode(type, sourceFile)).join(", ")}`;
  }).join(" ");
}

function cloneWithIdentity(
  declaration: InternalDeclaration,
  exportedName: string,
  options: { exportEquals?: boolean; typeOnly?: boolean } = {},
): InternalDeclaration {
  return {
    ...declaration,
    exportedName,
    defaultExport: exportedName === "default",
    exportEquals: options.exportEquals ?? false,
    typeOnly: options.typeOnly ?? declaration.typeOnly,
    signatures: [...declaration.signatures],
    ...(declaration.members === undefined ? {} : { members: [...declaration.members] }),
    ...(declaration.namespaceExports === undefined
      ? {}
      : { namespaceExports: declaration.namespaceExports.map((item) => ({ ...item })) }),
  };
}

function resolveInlineExports(model: FileDeclarationModel): InternalDeclaration[] {
  const declarations = [...model.immediateExports];
  for (const binding of model.exportBindings) {
    const locals = model.locals.get(binding.localName) ?? [];
    const candidates = binding.originId === undefined
      ? locals
      : locals.filter((declaration) => declaration.originId === binding.originId);
    for (const declaration of candidates) {
      declarations.push(cloneWithIdentity(declaration, binding.exportedName, binding));
    }
  }
  return declarations;
}

function addLocal(
  model: FileDeclarationModel,
  localName: string,
  declaration: InternalDeclaration,
): InternalDeclaration {
  const existing = model.locals.get(localName) ?? [];
  if (declaration.kind === "function") {
    const overload = existing.find((item) => item.kind === "function");
    if (overload !== undefined) {
      overload.signatures.push(...declaration.signatures);
      overload.references = [...new Set([
        ...overload.references,
        ...declaration.references,
      ])].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      const importReferences = new Map(overload.importTypeReferences.map((reference) => [
        `${reference.specifier}\0${reference.importedName}`,
        reference,
      ]));
      for (const reference of declaration.importTypeReferences) {
        importReferences.set(`${reference.specifier}\0${reference.importedName}`, reference);
      }
      overload.importTypeReferences = [...importReferences.values()]
        .sort((left, right) => {
          const leftKey = `${left.specifier}\0${left.importedName}`;
          const rightKey = `${right.specifier}\0${right.importedName}`;
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        });
      overload.deprecated ||= declaration.deprecated;
      return overload;
    }
  }
  existing.push(declaration);
  model.locals.set(localName, existing);
  return declaration;
}

function addDeclaration(
  model: FileDeclarationModel,
  localName: string,
  declaration: InternalDeclaration,
  exportedName: string | undefined,
): void {
  const storedDeclaration = addLocal(model, localName, declaration);
  if (exportedName !== undefined) {
    model.exportBindings.push({
      exportedName,
      localName,
      exportEquals: false,
      typeOnly: storedDeclaration.typeOnly,
      originId: storedDeclaration.originId,
    });
  }
}

function baseDeclaration(
  node: ts.Node,
  sourcePath: string,
  exportedName: string,
  kind: PublicApiDeclarationKind,
  signatures: string[],
): InternalDeclaration {
  const references = declarationReferences(node);
  return {
    originId: `${sourcePath}:${node.pos}:${node.end}:${kind}`,
    sourceOrder: node.pos,
    exportedName,
    kind,
    sourceFile: sourcePath,
    defaultExport: exportedName === "default",
    exportEquals: false,
    typeOnly: kind === "interface" || kind === "type",
    references: references.references,
    importTypeReferences: references.importTypeReferences,
    signatures,
    deprecated: isDeprecated(node),
  };
}

function emptyModel(): FileDeclarationModel {
  return {
    locals: new Map(),
    exportBindings: [],
    immediateExports: [],
    imports: new Map(),
    reexports: [],
  };
}

function extractStatements(
  statements: readonly ts.Statement[],
  sourcePath: string,
  sourceFile: ts.SourceFile,
  budget: AnalysisBudget,
  addIssue: AddIssue,
  implicitExports = false,
): FileDeclarationModel {
  const model = emptyModel();
  for (const statement of statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.name !== undefined) {
        model.imports.set(clause.name.text, {
          specifier: statement.moduleSpecifier.text,
          importedName: "default",
          namespace: false,
          typeOnly: clause.isTypeOnly,
        });
      }
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        model.imports.set(bindings.name.text, {
          specifier: statement.moduleSpecifier.text,
          importedName: "*",
          namespace: true,
          typeOnly: clause?.isTypeOnly ?? false,
        });
      } else if (bindings !== undefined) {
        for (const element of bindings.elements) {
          model.imports.set(element.name.text, {
            specifier: statement.moduleSpecifier.text,
            importedName: element.propertyName?.text ?? element.name.text,
            namespace: false,
            typeOnly: (clause?.isTypeOnly ?? false) || element.isTypeOnly,
          });
        }
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement)) {
      if (!consumeDeclaration(budget, sourcePath, addIssue)) {
        continue;
      }
      const localName = statement.name?.text;
      const exportedName = isDefaultExport(statement)
        ? "default"
        : (isExported(statement) || implicitExports)
          ? localName
          : undefined;
      const declaration = baseDeclaration(
        statement,
        sourcePath,
        localName ?? "default",
        "function",
        [
          `function${statement.asteriskToken === undefined ? "" : "*"}${typeParameters(statement.typeParameters, sourceFile)}(${parameters(statement.parameters, sourceFile)})${returnType(statement.type, sourceFile)}`,
        ],
      );
      if (localName === undefined) {
        if (exportedName !== undefined) {
          model.immediateExports.push(copyDeclaration(declaration, exportedName));
        } else {
          addIssue({
            code: "unsupported-declaration",
            message: "Anonymous non-default function declaration cannot be normalized.",
            sourceFile: sourcePath,
          });
        }
      } else {
        addDeclaration(model, localName, declaration, exportedName);
      }
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      if (!consumeDeclaration(budget, sourcePath, addIssue)) {
        continue;
      }
      const localName = statement.name?.text;
      const exportedName = isDefaultExport(statement)
        ? "default"
        : (isExported(statement) || implicitExports)
          ? localName
          : undefined;
      const header = [
        `${hasModifier(statement, ts.SyntaxKind.AbstractKeyword) ? "abstract " : ""}class${typeParameters(statement.typeParameters, sourceFile)}${statement.members.some((member) => ts.isConstructorDeclaration(member) && hasModifier(member, ts.SyntaxKind.PrivateKeyword)) ? " private-constructor" : ""}`,
        heritage(statement.heritageClauses, sourceFile),
      ].filter(Boolean).join(" ");
      const declaration = {
        ...baseDeclaration(statement, sourcePath, localName ?? "default", "class", [header]),
        members: classMembers(statement, sourcePath, sourceFile, budget, addIssue),
      };
      if (localName === undefined) {
        if (exportedName !== undefined) {
          model.immediateExports.push(cloneWithIdentity(declaration, exportedName));
        }
      } else {
        addDeclaration(model, localName, declaration, exportedName);
      }
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      if (!consumeDeclaration(budget, sourcePath, addIssue)) {
        continue;
      }
      const localName = statement.name.text;
      const declaration = {
        ...baseDeclaration(statement, sourcePath, localName, "interface", [
          [
            `interface${typeParameters(statement.typeParameters, sourceFile)}`,
            heritage(statement.heritageClauses, sourceFile),
          ].filter(Boolean).join(" "),
        ]),
        members: interfaceMembers(statement, sourcePath, sourceFile, budget, addIssue),
      };
      addDeclaration(
        model,
        localName,
        declaration,
        isDefaultExport(statement)
          ? "default"
          : (isExported(statement) || implicitExports)
            ? localName
            : undefined,
      );
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      if (!consumeDeclaration(budget, sourcePath, addIssue)) {
        continue;
      }
      const localName = statement.name.text;
      const declaration = baseDeclaration(statement, sourcePath, localName, "type", [
        `type${typeParameters(statement.typeParameters, sourceFile)} = ${printNode(statement.type, sourceFile)}`,
      ]);
      addDeclaration(
        model,
        localName,
        declaration,
        isExported(statement) || implicitExports ? localName : undefined,
      );
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      if (!consumeDeclaration(budget, sourcePath, addIssue)) {
        continue;
      }
      const localName = statement.name.text;
      const enumMembers: PublicApiMember[] = [];
      for (const member of statement.members) {
        if (!consumeMember(budget, sourcePath, addIssue)) {
          continue;
        }
        enumMembers.push({
          name: declarationName(member.name, sourceFile),
          kind: "enum-member",
          visibility: "public",
          static: false,
          optional: false,
          readonly: true,
          abstract: false,
          signatures: member.initializer === undefined
            ? []
            : [`= ${printNode(member.initializer, sourceFile)}`],
          deprecated: isDeprecated(member),
        });
      }
      const declaration = {
        ...baseDeclaration(statement, sourcePath, localName, "enum", [
          hasModifier(statement, ts.SyntaxKind.ConstKeyword) ? "const enum" : "enum",
        ]),
        members: enumMembers,
      };
      addDeclaration(
        model,
        localName,
        declaration,
        isExported(statement) || implicitExports ? localName : undefined,
      );
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const declarationKind = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
        ? "const"
        : (statement.declarationList.flags & ts.NodeFlags.Let) !== 0
          ? "let"
          : "var";
      for (const variable of statement.declarationList.declarations) {
        if (!ts.isIdentifier(variable.name)) {
          if (isExported(statement)) {
            addIssue({
              code: "unsupported-declaration",
              message: "Exported destructuring declarations are not normalized.",
              sourceFile: sourcePath,
            });
          }
          continue;
        }
        if (!consumeDeclaration(budget, sourcePath, addIssue)) {
          continue;
        }
        const localName = variable.name.text;
        const declaration = baseDeclaration(statement, sourcePath, localName, "variable", [
          `${declarationKind}${propertySignature(variable.type, variable.initializer, sourceFile)}`,
        ]);
        declaration.originId = `${sourcePath}:${variable.pos}:${variable.end}:variable`;
        declaration.sourceOrder = variable.pos;
        declaration.deprecated = isDeprecated(variable) || isDeprecated(statement);
        addDeclaration(
          model,
          localName,
          declaration,
          isExported(statement) || implicitExports ? localName : undefined,
        );
      }
      continue;
    }

    if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      if (!consumeDeclaration(budget, sourcePath, addIssue)) {
        continue;
      }
      const localName = statement.name.text;
      let namespaceExports: InternalDeclaration[] = [];
      if (statement.body !== undefined && ts.isModuleBlock(statement.body)) {
        namespaceExports = resolveInlineExports(extractStatements(
          statement.body.statements,
          sourcePath,
          sourceFile,
          budget,
          addIssue,
          true,
        ));
      } else if (statement.body !== undefined && ts.isModuleDeclaration(statement.body)) {
        namespaceExports = resolveInlineExports(extractStatements(
          [statement.body],
          sourcePath,
          sourceFile,
          budget,
          addIssue,
          true,
        ));
      }
      const declaration = {
        ...baseDeclaration(statement, sourcePath, localName, "namespace", ["namespace"]),
        namespaceExports,
      };
      addDeclaration(
        model,
        localName,
        declaration,
        isExported(statement) || implicitExports ? localName : undefined,
      );
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier !== undefined
        && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
      if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        const bindings = statement.exportClause.elements.flatMap((element) =>
          consumeDeclaration(budget, sourcePath, addIssue)
            ? [{
              exportedName: element.name.text,
              importedName: element.propertyName?.text ?? element.name.text,
              typeOnly: statement.isTypeOnly || element.isTypeOnly,
            }]
            : []);
        if (specifier === undefined) {
          model.exportBindings.push(...bindings.map((binding) => ({
            exportedName: binding.exportedName,
            localName: binding.importedName,
            exportEquals: false,
            typeOnly: binding.typeOnly,
          })));
        } else {
          model.reexports.push({
            mode: "named",
            originId: `${sourcePath}:${statement.pos}:${statement.end}:reexport`,
            sourceFile: sourcePath,
            specifier,
            typeOnly: statement.isTypeOnly,
            bindings,
          });
        }
      } else if (
        statement.exportClause !== undefined
        && ts.isNamespaceExport(statement.exportClause)
        && specifier !== undefined
      ) {
        if (consumeDeclaration(budget, sourcePath, addIssue)) {
          model.reexports.push({
            mode: "namespace",
            originId: `${sourcePath}:${statement.pos}:${statement.end}:reexport`,
            sourceFile: sourcePath,
            specifier,
            exportedName: statement.exportClause.name.text,
            typeOnly: statement.isTypeOnly,
          });
        }
      } else if (specifier !== undefined && consumeDeclaration(budget, sourcePath, addIssue)) {
        model.reexports.push({
          mode: "star",
          originId: `${sourcePath}:${statement.pos}:${statement.end}:reexport`,
          sourceFile: sourcePath,
          specifier,
          typeOnly: statement.isTypeOnly,
        });
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      if (!consumeDeclaration(budget, sourcePath, addIssue)) {
        continue;
      }
      const exportEquals = statement.isExportEquals === true;
      const exportedName = exportEquals ? "export=" : "default";
      if (ts.isIdentifier(statement.expression)) {
        model.exportBindings.push({
          exportedName,
          localName: statement.expression.text,
          exportEquals,
          typeOnly: false,
        });
      } else {
        model.immediateExports.push({
          ...baseDeclaration(
          statement,
          sourcePath,
          exportedName,
          "unknown",
          [`expression ${printNode(statement.expression, sourceFile)}`],
          ),
          exportEquals,
        });
      }
      continue;
    }

    if (isExported(statement)) {
      addIssue({
        code: "unsupported-declaration",
        message: `Exported ${ts.SyntaxKind[statement.kind]} is not normalized.`,
        sourceFile: sourcePath,
      });
    }
  }
  return model;
}

export function extractFileDeclarationModel(
  sourceFile: ts.SourceFile,
  sourcePath: string,
  budget: AnalysisBudget,
  addIssue: AddIssue,
): FileDeclarationModel {
  return extractStatements(sourceFile.statements, sourcePath, sourceFile, budget, addIssue);
}

export function copyDeclaration(
  declaration: InternalDeclaration,
  exportedName: string,
  options: { exportEquals?: boolean; typeOnly?: boolean } = {},
): InternalDeclaration {
  return cloneWithIdentity(declaration, exportedName, options);
}

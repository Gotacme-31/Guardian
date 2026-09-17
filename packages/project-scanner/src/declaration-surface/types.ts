export interface DeclarationSurfaceLimits {
  maxDeclarationFiles: number;
  maxReexportDepth: number;
  maxDeclarations: number;
  maxMembers: number;
  maxDeclarationFileBytes: number;
}

export interface DeclarationSurfaceOptions {
  limits?: Partial<DeclarationSurfaceLimits>;
}

export type PublicApiDeclarationKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "namespace"
  | "external-reexport"
  | "unknown";

export type PublicApiMemberKind =
  | "constructor"
  | "method"
  | "property"
  | "getter"
  | "setter"
  | "call-signature"
  | "construct-signature"
  | "index-signature"
  | "enum-member";

export interface PublicApiMember {
  readonly name: string;
  readonly kind: PublicApiMemberKind;
  readonly visibility: "public" | "protected";
  readonly static: boolean;
  readonly optional: boolean;
  readonly readonly: boolean;
  readonly abstract: boolean;
  readonly signatures: readonly string[];
  readonly deprecated: boolean;
}

interface PublicApiDeclarationBase {
  readonly exportedName: string;
  readonly kind: PublicApiDeclarationKind;
  readonly facet: number;
  readonly sourceFile: string;
  readonly defaultExport: boolean;
  readonly exportEquals: boolean;
  readonly typeOnly: boolean;
  readonly signatures: readonly string[];
  readonly deprecated: boolean;
}

export interface SignatureApiDeclaration extends PublicApiDeclarationBase {
  readonly kind: "function" | "type" | "variable" | "unknown";
}

export interface StructuredApiDeclaration extends PublicApiDeclarationBase {
  readonly kind: "class" | "interface" | "enum";
  readonly members: readonly PublicApiMember[];
}

export interface NamespaceApiDeclaration extends PublicApiDeclarationBase {
  readonly kind: "namespace";
  readonly exports: readonly PublicApiDeclaration[];
}

export interface ExternalReexportApiDeclaration extends PublicApiDeclarationBase {
  readonly kind: "external-reexport";
  readonly externalModule: string;
  readonly importedName: string;
}

export type PublicApiDeclaration =
  | SignatureApiDeclaration
  | StructuredApiDeclaration
  | NamespaceApiDeclaration
  | ExternalReexportApiDeclaration;

interface ReferencedApiDeclarationBase {
  readonly name: string;
  readonly kind: PublicApiDeclarationKind;
  readonly facet: number;
  readonly sourceFile: string;
  readonly typeOnly: boolean;
  readonly signatures: readonly string[];
  readonly deprecated: boolean;
}

export interface SignatureReferencedApiDeclaration extends ReferencedApiDeclarationBase {
  readonly kind: "function" | "type" | "variable" | "unknown";
}

export interface StructuredReferencedApiDeclaration extends ReferencedApiDeclarationBase {
  readonly kind: "class" | "interface" | "enum";
  readonly members: readonly PublicApiMember[];
}

export interface NamespaceReferencedApiDeclaration extends ReferencedApiDeclarationBase {
  readonly kind: "namespace";
  readonly declarations: readonly ReferencedApiDeclaration[];
}

export interface ExternalReferencedApiDeclaration extends ReferencedApiDeclarationBase {
  readonly kind: "external-reexport";
  readonly externalModule: string;
  readonly importedName: string;
}

export type ReferencedApiDeclaration =
  | SignatureReferencedApiDeclaration
  | StructuredReferencedApiDeclaration
  | NamespaceReferencedApiDeclaration
  | ExternalReferencedApiDeclaration;

export interface DeclarationEntrypoint {
  readonly exportPath: string;
  readonly declarationFile: string;
  readonly conditionPaths: readonly (readonly string[])[];
  readonly exports: readonly PublicApiDeclaration[];
  readonly referencedDeclarations: readonly ReferencedApiDeclaration[];
}

export type DeclarationSurfaceIssueCode =
  | "package-json-missing"
  | "package-json-invalid"
  | "declaration-entrypoint-missing"
  | "declaration-file-missing"
  | "declaration-file-invalid"
  | "declaration-path-invalid"
  | "declaration-path-escape"
  | "unsupported-export-conditions"
  | "unsupported-export-pattern"
  | "unsupported-types-versions"
  | "external-reexport"
  | "unresolved-reexport"
  | "ambiguous-star-reexport"
  | "reexport-cycle"
  | "unsupported-declaration"
  | "analysis-limit-exceeded";

export interface DeclarationSurfaceIssue {
  readonly code: DeclarationSurfaceIssueCode;
  readonly message: string;
  readonly exportPath?: string;
  readonly declarationFile?: string;
  readonly sourceFile?: string;
  readonly specifier?: string;
  readonly limit?: keyof DeclarationSurfaceLimits;
}

export interface PackageDeclarationSurface {
  readonly packageName: string;
  readonly version: string;
  readonly entrypoints: readonly DeclarationEntrypoint[];
  readonly issues: readonly DeclarationSurfaceIssue[];
}

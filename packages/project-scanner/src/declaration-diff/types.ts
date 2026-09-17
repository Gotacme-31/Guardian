import type {
  DeclarationSurfaceIssue,
  PublicApiDeclaration,
  PublicApiMember,
  ReferencedApiDeclaration,
} from "../declaration-surface/types.js";

export type DeclarationDiffSide = "before" | "after";

export type DeclarationComparisonErrorCode = "package-mismatch";

export type ComparisonIssueCode =
  | "indeterminate-package-comparison"
  | "indeterminate-entrypoint-comparison"
  | "duplicate-entrypoint-identity"
  | "duplicate-export-identity"
  | "duplicate-member-identity"
  | "duplicate-referenced-declaration-identity"
  | "recursive-declaration-graph"
  | "comparison-limit-exceeded";

export interface DeclarationComparisonIssue {
  readonly code: ComparisonIssueCode;
  readonly message: string;
  readonly side?: DeclarationDiffSide;
  readonly exportPath?: string;
  readonly conditionPath?: readonly string[];
  readonly declarationPath?: readonly string[];
  readonly facet?: number;
  readonly facetPath?: readonly number[];
  readonly memberName?: string;
  readonly memberStatic?: boolean;
  readonly memberRole?: string;
  readonly sourceIssueCodes?: readonly string[];
}

export interface DeclarationSourceIssues {
  readonly before: readonly DeclarationSurfaceIssue[];
  readonly after: readonly DeclarationSurfaceIssue[];
}

export type DeclarationPropertyName =
  | "kind"
  | "defaultExport"
  | "exportEquals"
  | "typeOnly"
  | "visibility"
  | "optional"
  | "readonly"
  | "abstract"
  | "externalModule"
  | "importedName";

export interface DeclarationPropertyChange {
  readonly type: "property-changed";
  readonly property: DeclarationPropertyName;
  readonly before: string | boolean;
  readonly after: string | boolean;
}

export type DeprecationChange =
  | { readonly type: "deprecated-added" }
  | { readonly type: "deprecated-removed" };

export type SignatureChange =
  | {
    readonly type: "signature-added";
    readonly signature: string;
  }
  | {
    readonly type: "signature-removed";
    readonly signature: string;
  };

export type MemberChange =
  | {
    readonly type: "member-added";
    readonly member: PublicApiMember;
  }
  | {
    readonly type: "member-removed";
    readonly member: PublicApiMember;
  }
  | {
    readonly type: "member-modified";
    readonly name: string;
    readonly static: boolean;
    readonly role: string;
    readonly propertyChanges: readonly DeclarationPropertyChange[];
    readonly deprecationChange?: DeprecationChange;
    readonly signatureChanges: readonly SignatureChange[];
  };

export type ExportChange =
  | {
    readonly type: "export-added";
    readonly declarationPath: readonly string[];
    readonly facet: number;
    readonly facetPath: readonly number[];
    readonly declaration: PublicApiDeclaration;
  }
  | {
    readonly type: "export-removed";
    readonly declarationPath: readonly string[];
    readonly facet: number;
    readonly facetPath: readonly number[];
    readonly declaration: PublicApiDeclaration;
  }
  | {
    readonly type: "export-modified";
    readonly declarationPath: readonly string[];
    readonly facet: number;
    readonly facetPath: readonly number[];
    readonly propertyChanges: readonly DeclarationPropertyChange[];
    readonly deprecationChange?: DeprecationChange;
    readonly signatureChanges: readonly SignatureChange[];
    readonly memberChanges: readonly MemberChange[];
    readonly nestedExportChanges: readonly ExportChange[];
  };

export type ReferencedDeclarationChange =
  | {
    readonly type: "referenced-declaration-added";
    readonly declarationPath: readonly string[];
    readonly facet: number;
    readonly facetPath: readonly number[];
    readonly declaration: ReferencedApiDeclaration;
  }
  | {
    readonly type: "referenced-declaration-removed";
    readonly declarationPath: readonly string[];
    readonly facet: number;
    readonly facetPath: readonly number[];
    readonly declaration: ReferencedApiDeclaration;
  }
  | {
    readonly type: "referenced-declaration-modified";
    readonly declarationPath: readonly string[];
    readonly facet: number;
    readonly facetPath: readonly number[];
    readonly propertyChanges: readonly DeclarationPropertyChange[];
    readonly deprecationChange?: DeprecationChange;
    readonly signatureChanges: readonly SignatureChange[];
    readonly memberChanges: readonly MemberChange[];
    readonly nestedDeclarationChanges: readonly ReferencedDeclarationChange[];
  };

export type EntrypointChange =
  | {
    readonly type: "entrypoint-added";
    readonly exportPath: string;
    readonly conditionPath: readonly string[];
    readonly afterDeclarationFile: string;
    readonly exportChanges: readonly ExportChange[];
    readonly referencedDeclarationChanges: readonly ReferencedDeclarationChange[];
  }
  | {
    readonly type: "entrypoint-removed";
    readonly exportPath: string;
    readonly conditionPath: readonly string[];
    readonly beforeDeclarationFile: string;
    readonly exportChanges: readonly ExportChange[];
    readonly referencedDeclarationChanges: readonly ReferencedDeclarationChange[];
  }
  | {
    readonly type: "entrypoint-modified";
    readonly exportPath: string;
    readonly conditionPath: readonly string[];
    readonly beforeDeclarationFile: string;
    readonly afterDeclarationFile: string;
    readonly exportChanges: readonly ExportChange[];
    readonly referencedDeclarationChanges: readonly ReferencedDeclarationChange[];
  };

export type ProvenanceChange =
  | {
    readonly type: "entrypoint-declaration-file-changed";
    readonly exportPath: string;
    readonly conditionPath: readonly string[];
    readonly beforeDeclarationFile: string;
    readonly afterDeclarationFile: string;
  }
  | {
    readonly type: "export-source-file-changed";
    readonly exportPath: string;
    readonly conditionPath: readonly string[];
    readonly declarationPath: readonly string[];
    readonly facet: number;
    readonly facetPath: readonly number[];
    readonly beforeSourceFile: string;
    readonly afterSourceFile: string;
  }
  | {
    readonly type: "referenced-declaration-source-file-changed";
    readonly exportPath: string;
    readonly conditionPath: readonly string[];
    readonly declarationPath: readonly string[];
    readonly facet: number;
    readonly facetPath: readonly number[];
    readonly beforeSourceFile: string;
    readonly afterSourceFile: string;
  };

export interface DeclarationSurfaceDiffSummary {
  readonly entrypointsAdded: number;
  readonly entrypointsRemoved: number;
  readonly entrypointsModified: number;
  readonly exportsAdded: number;
  readonly exportsRemoved: number;
  readonly exportsModified: number;
  readonly membersAdded: number;
  readonly membersRemoved: number;
  readonly membersModified: number;
  readonly signaturesAdded: number;
  readonly signaturesRemoved: number;
  readonly referencedDeclarationsAdded: number;
  readonly referencedDeclarationsRemoved: number;
  readonly referencedDeclarationsModified: number;
  readonly provenanceChanges: number;
  readonly comparisonIssues: number;
  readonly hasApiChanges: boolean;
}

export interface PackageDeclarationSurfaceDiff {
  readonly packageName: string;
  readonly beforeVersion: string;
  readonly afterVersion: string;
  readonly entrypointChanges: readonly EntrypointChange[];
  readonly provenanceChanges: readonly ProvenanceChange[];
  readonly sourceIssues: DeclarationSourceIssues;
  readonly comparisonIssues: readonly DeclarationComparisonIssue[];
  readonly summary: DeclarationSurfaceDiffSummary;
}

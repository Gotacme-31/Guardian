import type {
  DeclarationPropertyChange,
  DeprecationChange,
  ExportChange,
  MemberChange,
  SignatureChange,
} from "../declaration-diff/types.js";
import type { SeverityReason, SeverityReasonCode } from "../breaking-change/types.js";

function internalError(message: string): Error {
  return new Error(`Migration proposal internal error: ${message}`);
}

interface CommonModificationFields {
  readonly propertyChanges: readonly DeclarationPropertyChange[];
  readonly deprecationChange?: DeprecationChange;
  readonly signatureChanges: readonly SignatureChange[];
}

/**
 * "export-modified" and "member-modified" share identical propertyChanges/deprecationChange/
 * signatureChanges shapes (see declaration-diff/types.ts) even though they are different variants
 * of different unions. Every SeverityReasonCode except "export-removed", "member-removed",
 * "nested-change", and "unexpected-change-type" is only ever produced by
 * breaking-change/classify.ts's severityForModification, which reads exactly these three fields —
 * so any change reaching this helper is guaranteed by that pairing to be one of the two "modified"
 * variants. Throws instead of guessing if that pairing is ever violated.
 */
function commonModificationFields(
  change: ExportChange | MemberChange,
  reasonCode: SeverityReasonCode,
): CommonModificationFields {
  if (change.type === "export-modified" || change.type === "member-modified") {
    return {
      propertyChanges: change.propertyChanges,
      ...(change.deprecationChange === undefined ? {} : { deprecationChange: change.deprecationChange }),
      signatureChanges: change.signatureChanges,
    };
  }
  throw internalError(
    `severity reason "${reasonCode}" was paired with a "${change.type}" change, which never `
    + "carries propertyChanges/deprecationChange/signatureChanges.",
  );
}

function describeExportRemoved(change: ExportChange | MemberChange): string {
  if (change.type !== "export-removed") {
    throw internalError(`"export-removed" reason paired with a "${change.type}" change.`);
  }
  return `Export "${change.declaration.exportedName}" (${change.declaration.kind}) was removed.`;
}

function describeMemberRemoved(change: ExportChange | MemberChange): string {
  if (change.type !== "member-removed") {
    throw internalError(`"member-removed" reason paired with a "${change.type}" change.`);
  }
  return `Member "${change.member.name}" (${change.member.kind}) was removed.`;
}

function describeKindChanged(change: ExportChange | MemberChange): string {
  const fields = commonModificationFields(change, "kind-changed");
  const kindChange = fields.propertyChanges.find((item) => item.property === "kind");
  if (kindChange === undefined) {
    throw internalError('"kind-changed" reason but no "kind" entry exists in propertyChanges.');
  }
  return `Kind changed: "${kindChange.before}" -> "${kindChange.after}".`;
}

function describePropertyChanged(change: ExportChange | MemberChange, reason: SeverityReason): string {
  const fields = commonModificationFields(change, "property-changed");
  if (reason.property === undefined) {
    throw internalError('"property-changed" reason is missing its "property" field.');
  }
  const propertyChange = fields.propertyChanges.find((item) => item.property === reason.property);
  if (propertyChange === undefined) {
    throw internalError(
      `"property-changed" reason references "${reason.property}", which is not present in `
      + "propertyChanges.",
    );
  }
  return `${propertyChange.property} changed: ${propertyChange.before} -> ${propertyChange.after}.`;
}

function describeDeprecationChanged(change: ExportChange | MemberChange): string {
  const fields = commonModificationFields(change, "deprecation-changed");
  if (fields.deprecationChange === undefined) {
    throw internalError(
      '"deprecation-changed" reason but the matched change carries no deprecationChange.',
    );
  }
  return fields.deprecationChange.type === "deprecated-added"
    ? "Marked as deprecated."
    : "No longer deprecated.";
}

function describeSignaturesRemoved(change: ExportChange | MemberChange): string {
  const fields = commonModificationFields(change, "signature-removed");
  const removed = fields.signatureChanges.filter((item) => item.type === "signature-removed");
  if (removed.length === 0) {
    throw internalError(
      '"signature-removed" reason but no signature-removed entries exist in signatureChanges.',
    );
  }
  return ["Signature(s) removed:", ...removed.map((item) => `  - ${item.signature}`)].join("\n");
}

function describeSignaturesAddedOnly(change: ExportChange | MemberChange): string {
  const fields = commonModificationFields(change, "signature-added-only");
  const added = fields.signatureChanges.filter((item) => item.type === "signature-added");
  if (added.length === 0) {
    throw internalError(
      '"signature-added-only" reason but no signature-added entries exist in signatureChanges.',
    );
  }
  return ["Signature(s) added:", ...added.map((item) => `  - ${item.signature}`)].join("\n");
}

/**
 * "nested-change" is only reachable for `export-modified`: M7's `compareMembers` never pushes a
 * `member-modified` entry unless propertyChanges/deprecationChange/signatureChanges already
 * account for it (members have no nested members or nested exports of their own to hide a change
 * in), so `severityForModification` can only fall through to "nested-change" for an
 * `export-modified` change, whose `nestedExportChanges`/`memberChanges` carry the real change.
 */
function describeNestedChange(change: ExportChange | MemberChange): string {
  if (change.type !== "export-modified") {
    throw internalError(`"nested-change" reason paired with a "${change.type}" change.`);
  }
  return "The matched change carries no property, deprecation, or signature change of its own; "
    + "the relevant modification is nested under a different export or member beneath this path. "
    + `Inspect the full diff for declarationPath ${JSON.stringify(change.declarationPath)}.`;
}

function describeUnexpectedChangeType(change: ExportChange | MemberChange): string {
  return `Unexpected "${change.type}" change matched against an existing usage. Under the normal `
    + "M6-M9 pipeline this should not be reachable — an M8 leaf only exists for a "
    + 'declaration/member already present on the "before" side, which M7 never reports as '
    + '"added" (see the comment on breaking-change/classify.ts\'s severityForChange). Reported '
    + "defensively rather than assumed impossible.";
}

/**
 * Builds a deterministic, human-readable description of a single leaf-level matched change, using
 * only data already present on `change` (or, for "property-changed", the property name already
 * carried by `reason`). Never synthesizes prose beyond formatting verbatim values.
 */
export function describeChange(change: ExportChange | MemberChange, reason: SeverityReason): string {
  switch (reason.code) {
    case "export-removed":
      return describeExportRemoved(change);
    case "member-removed":
      return describeMemberRemoved(change);
    case "kind-changed":
      return describeKindChanged(change);
    case "signature-added-only":
      return describeSignaturesAddedOnly(change);
    case "signature-removed":
      return describeSignaturesRemoved(change);
    case "property-changed":
      return describePropertyChanged(change, reason);
    case "deprecation-changed":
      return describeDeprecationChanged(change);
    case "nested-change":
      return describeNestedChange(change);
    case "unexpected-change-type":
      return describeUnexpectedChangeType(change);
  }
}

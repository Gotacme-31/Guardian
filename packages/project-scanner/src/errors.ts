export type ProjectScanErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_NOT_DIRECTORY"
  | "PACKAGE_JSON_NOT_FOUND"
  | "PACKAGE_JSON_UNREADABLE"
  | "PACKAGE_JSON_INVALID"
  | "PACKAGE_JSON_INVALID_STRUCTURE"
  | "MULTIPLE_LOCKFILES"
  | "PROJECT_UNREADABLE"
  | "SOURCE_SCAN_FAILED";

export class ProjectScanError extends Error {
  readonly code: ProjectScanErrorCode;

  constructor(code: ProjectScanErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectScanError";
    this.code = code;
  }
}

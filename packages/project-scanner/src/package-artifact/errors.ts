export type PackageArtifactErrorCode =
  | "invalid-package-name"
  | "invalid-version"
  | "artifact-metadata-timeout"
  | "artifact-metadata-network-error"
  | "artifact-metadata-rate-limited"
  | "artifact-metadata-unavailable"
  | "artifact-version-not-found"
  | "artifact-metadata-invalid"
  | "tarball-url-invalid"
  | "integrity-metadata-missing"
  | "integrity-metadata-invalid"
  | "integrity-verification-failed"
  | "download-not-found"
  | "download-rate-limited"
  | "download-unavailable"
  | "download-http-error"
  | "download-network-error"
  | "download-timeout"
  | "download-response-invalid"
  | "download-redirect-rejected"
  | "compressed-size-limit-exceeded"
  | "archive-invalid"
  | "archive-path-unsafe"
  | "archive-entry-type-unsupported"
  | "archive-entry-limit-exceeded"
  | "archive-size-limit-exceeded"
  | "archive-file-size-limit-exceeded"
  | "package-json-missing"
  | "package-json-invalid"
  | "package-name-mismatch"
  | "package-version-mismatch"
  | "installed-version-missing"
  | "target-dependency-mismatch"
  | "target-context-mismatch"
  | "non-registry-dependency"
  | "cleanup-path-invalid"
  | "cleanup-failed"
  | "filesystem-error";

export class PackageArtifactError extends Error {
  readonly code: PackageArtifactErrorCode;
  readonly httpStatus?: number;

  constructor(
    code: PackageArtifactErrorCode,
    message: string,
    options: ErrorOptions & { httpStatus?: number } = {},
  ) {
    super(message, options);
    this.name = "PackageArtifactError";
    this.code = code;
    if (options.httpStatus !== undefined) {
      this.httpStatus = options.httpStatus;
    }
  }
}

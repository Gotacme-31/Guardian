export { checkVersionBumpEligibility } from "./eligibility.js";
export { applyVersionBump, composeVersionBump } from "./apply.js";
export type {
  ComposedVersionBump,
  VersionBumpBlockingReason,
  VersionBumpEligibility,
  VersionBumpWriteError,
  VersionBumpWriteResult,
  VersionCompositionError,
  VersionRangeOperator,
} from "./types.js";

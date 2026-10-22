import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";

/**
 * Attribute a `SafeOutputTree.create` destination refusal to the caller's
 * selected directory argument. Only the caller knows whether the tree was
 * admitted: path failures after admission are host write failures on output
 * files, not argument refusals, so callers convert only pre-admission causes.
 */
export const outputDirectoryAdmissionRefusal = (
  operation: string,
  field: string,
  cause: unknown,
): unknown =>
  cause instanceof ArtifactReaderFailure &&
  cause.reason === "path" &&
  cause.cleanup === undefined
    ? new AnalysisInputError(operation, { cause, userMessage: cause.message }, [
        { path: [field], reason: "invalid_value", message: cause.message },
      ])
    : cause;

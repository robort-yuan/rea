import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { ok, type Result } from "../domain/result.js";
import { closeAnalysisClient } from "../providers/AnalysisClientCleanup.js";
import type { AnalysisClient, AnalysisExecution } from "./AnalysisProvider.js";
import { managedAnalysisCleanupFailure } from "./DirectAnalysisCleanup.js";

/** Read one absolute plist through a target-less client and always close it. */
export const readStandalonePlist = async (
  client: AnalysisClient,
  providerId: string,
  path: string,
  signal: AbortSignal | undefined,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  let result: Result<AnalysisExecution, AnalysisError>;
  try {
    result = await client.execute(
      "inspect_plist",
      { path },
      signal === undefined ? {} : { signal },
    );
  } catch (cause: unknown) {
    const closed = await closeAnalysisClient(client, providerId);
    if (!closed.ok)
      throw new AggregateError(
        [cause, closed.error],
        "Analysis and provider cleanup both failed",
        { cause },
      );
    throw cause;
  }
  const closed = await closeAnalysisClient(client, providerId);
  if (!closed.ok) return managedAnalysisCleanupFailure(result, closed.error);
  // No target exists, so the Evidence subject is explicitly absent.
  return result.ok ? ok({ ...result.value, subject: null }) : result;
};

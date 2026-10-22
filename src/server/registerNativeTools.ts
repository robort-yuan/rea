import { isAbsolute } from "node:path";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { AnalysisExecution } from "../application/AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";

import { NATIVE_TOOL_CONTRACTS } from "../contracts/native/nativeToolContracts.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import {
  retainedSummaryDelivery,
  withoutDeliveryDetail,
  type EvidenceToolFamilyOptions,
} from "./retainedSummaryDelivery.js";

const SUMMARY_DELIVERY: ReadonlySet<string> = new Set(["inspect_macho"]);

/** Inspect one absolutely selected plist without a target. */
export type StandalonePlistInspection = (
  path: string,
  signal: AbortSignal | undefined,
) => Promise<Result<AnalysisExecution, AnalysisError>>;

/** Register macOS native contracts; Mach-O inspection can deliver a retained summary. */
export const registerNativeTools = (
  server: EvidenceMcpServer,
  options: EvidenceToolFamilyOptions & {
    readonly targetSelected: () => boolean;
    readonly standalonePlistInspection: StandalonePlistInspection;
  },
): void => {
  const withoutDelivery = withoutDeliveryDetail(SUMMARY_DELIVERY);
  registerEvidenceTools(server, NATIVE_TOOL_CONTRACTS, {
    ...options,
    ...retainedSummaryDelivery(SUMMARY_DELIVERY, options),
    parametersForExecution: withoutDelivery,
    parametersForEvidence: withoutDelivery,
    analysisForAdmission: (analysis) => ({
      execute: (operation, parameters, executionOptions) => {
        const path = parameters.path;
        return operation === "inspect_plist" &&
          typeof path === "string" &&
          isAbsolute(path) &&
          !options.targetSelected()
          ? options.standalonePlistInspection(path, executionOptions?.signal)
          : analysis.execute(operation, parameters, executionOptions);
      },
    }),
  });
};

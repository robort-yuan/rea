import { expect, it } from "vitest";

import { ReverseEngineeringService } from "../../src/application/reverse/ReverseEngineeringService.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";

it("keeps resolver cleanup dependencies when cancellation wins preparation", async () => {
  let rejectResolution!: (cause: unknown) => void;
  const resolution = new Promise<{
    executable: string;
    arguments: readonly string[];
    identity: { id: string; name: string; version: null };
  }>((_resolve, reject) => {
    rejectResolution = reject;
  });
  const service = new ReverseEngineeringService({
    commands: {
      objdump: () => ({
        executable: "objdump",
        arguments: [],
        identity: { id: "gnu.objdump", name: "GNU objdump", version: null },
      }),
      rizin: () => resolution,
    },
  });
  const controller = new AbortController();
  const pending = service.executeRizinCommand(
    { path: "/tmp/resolver-cleanup-fixture", command: "iI" },
    { signal: controller.signal },
  );
  const cleanupFailure = new AnalysisOutputError(
    "execute_rizin_command",
    "Resolver-owned resource still needs cleanup.",
    {
      cleanup: {
        reason: "resolver shutdown did not settle",
        resources: ["resolver-session"],
      },
    },
  );
  controller.abort({ source: "caller" });
  rejectResolution(cleanupFailure);

  const result = await pending;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual(["resolver-session"]);
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      cleanup_reason: "resolver shutdown did not settle",
      resources: ["resolver-session"],
    },
  });

  cleanupFailure.resolveCleanup();
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cancelled",
    category: "cancelled",
  });
  await service.close();
});

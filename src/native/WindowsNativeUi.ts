import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { DEFAULT_NATIVE_UI_DEADLINE_MS } from "../domain/native/nativeDeadlines.js";
import { safeParseJson } from "../domain/safeJson.js";
import { execFileOutput } from "../process/ExecFileOutput.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import type { NativeUiHelper } from "./NativeUiObservation.js";
import { NATIVE_UI_HELPER_MAX_BUFFER } from "./NativeUiOutputBudget.js";

const source = fileURLToPath(
  new URL("../../bridge/windows/ReaWindowsUi.cs", import.meta.url),
);
const framework = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
);
const compiler = join(framework, "csc.exe");

export const createWindowsNativeUiHelperRuntime = (
  environment: Readonly<NodeJS.ProcessEnv>,
  deadlineMs = DEFAULT_NATIVE_UI_DEADLINE_MS,
) => {
  const selectedEnvironment = snapshotEnvironment(environment);
  const deadlineSignal = AbortSignal.timeout(deadlineMs);
  let root: string | undefined;
  let executable: string | undefined;
  const cleanupLease = new AnalysisCleanupLease(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });
  const invoke: NativeUiHelper = async (parameters, callerSignal) => {
    const signal =
      callerSignal === undefined
        ? deadlineSignal
        : AbortSignal.any([callerSignal, deadlineSignal]);
    if (executable === undefined) {
      root = await mkdtemp(join(tmpdir(), "rea-windows-ui-"));
      executable = join(root, "ReaWindowsUi.exe");
      await execFileOutput(
        compiler,
        [
          "/nologo",
          "/platform:x64",
          "/target:exe",
          `/r:${join(framework, "System.Drawing.dll")}`,
          `/r:${join(framework, "System.Web.Extensions.dll")}`,
          `/r:${join(framework, "WPF", "UIAutomationClient.dll")}`,
          `/r:${join(framework, "WPF", "UIAutomationTypes.dll")}`,
          `/out:${executable}`,
          source,
        ],
        {
          timeout: deadlineMs,
          maxBuffer: 1024 * 1024,
          env: selectedEnvironment,
          signal,
        },
      );
    }
    const output = await execFileOutput(
      executable,
      [JSON.stringify(parameters)],
      {
        timeout: deadlineMs,
        maxBuffer: NATIVE_UI_HELPER_MAX_BUFFER,
        env: selectedEnvironment,
        signal,
      },
    );
    const parsed = safeParseJson(output.stdout);
    if (!parsed.ok)
      throw new Error(`Native helper returned invalid JSON: ${parsed.error}`, {
        cause: parsed.cause,
      });
    return parsed.value;
  };
  return {
    invoke,
    cleanupLease,
    signal: deadlineSignal,
    deadlineMs,
    close: () => cleanupLease.release(),
    resources: () => (root === undefined ? [] : [root]),
  };
};

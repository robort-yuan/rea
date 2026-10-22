import { adbArguments } from "../../dist/adb/AdbCommand.js";
import { execFileOutput } from "../../dist/process/ExecFileOutput.js";

const CLEANUP_TIMEOUT_MS = 10_000;
const CLEANUP_MAX_OUTPUT_BYTES = 64 * 1024;
const CLEANUP_MAX_ATTEMPTS = 3;
const CLEANUP_RETRY_DELAY_MS = 100;

export async function removeVerifierProbeFile(binary, serial, devicePath) {
  const failures = [];
  for (let attempt = 1; attempt <= CLEANUP_MAX_ATTEMPTS; attempt += 1) {
    try {
      await execFileOutput(
        binary,
        adbArguments(serial, ["shell", "rm", "-f", "--", devicePath]),
        {
          timeout: CLEANUP_TIMEOUT_MS,
          maxBuffer: CLEANUP_MAX_OUTPUT_BYTES,
          stopSignal: "SIGTERM",
        },
      );
      return;
    } catch (cause) {
      failures.push(cause);
      if (attempt < CLEANUP_MAX_ATTEMPTS)
        await new Promise((resolve) =>
          setTimeout(resolve, CLEANUP_RETRY_DELAY_MS),
        );
    }
  }
  throw new AggregateError(
    failures,
    `Unable to remove verifier probe after ${CLEANUP_MAX_ATTEMPTS} attempts`,
  );
}

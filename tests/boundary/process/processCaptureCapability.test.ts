import { describe, expect, it } from "vitest";

import {
  processCaptureProbeFailureReason,
  processCaptureOwnershipUnavailableReason,
  probeProcessCaptureCapability,
} from "../../../src/process/capture/ProcessCaptureCapability.js";

describe("process capture capability diagnostics", () => {
  it("distinguishes missing native modules from runtime ABI mismatches", () => {
    expect(
      processCaptureProbeFailureReason(
        Object.assign(
          new Error("Cannot find package '@lydell/node-pty-win32-x64'"),
          {
            code: "ERR_MODULE_NOT_FOUND",
          },
        ),
      ),
    ).toContain("optional dependencies enabled");
    expect(
      processCaptureProbeFailureReason(
        Object.assign(
          new Error("compiled against a different Node.js version"),
          {
            code: "ERR_DLOPEN_FAILED",
          },
        ),
      ),
    ).toContain("incompatible with this Node.js runtime");
  });

  it("returns the actual cause from the real probe boundary", async () => {
    const capability = await probeProcessCaptureCapability({
      platform: "darwin",
      loadPty: async () => {
        throw Object.assign(new Error("optional binary was not installed"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    });
    expect(capability).toEqual({
      available: false,
      backend: "node-pty",
      reason: expect.stringContaining("optional binary was not installed"),
    });
  });

  it("preserves the actual diagnostic for a genuine probe failure", () => {
    expect(
      processCaptureProbeFailureReason(new Error("spawn EACCES")),
    ).toContain("spawn EACCES");
  });

  it("prepares Darwin ownership inspection before probing or admitting a PTY", async () => {
    let loaded = false;
    const capability = await probeProcessCaptureCapability({
      platform: "darwin",
      prepareOwnershipInspector: async () => {
        throw new Error(
          "macOS process ownership inspection requires the Apple Swift compiler via xcrun",
        );
      },
      loadPty: async () => {
        loaded = true;
        return await import("@lydell/node-pty");
      },
    });

    expect(loaded).toBe(false);
    expect(capability).toEqual({
      available: false,
      backend: "node-pty",
      reason: expect.stringContaining(
        "requires the Apple Swift compiler via xcrun",
      ),
    });
  });

  it("reports no standing Windows ownership refusal", () => {
    expect(processCaptureOwnershipUnavailableReason("win32")).toBeUndefined();
  });

  it("explains Windows capture admission before loading or spawning a PTY", async () => {
    let loaded = false;
    const capability = await probeProcessCaptureCapability({
      platform: "win32",
      verifyDescendantCleanup: async () => {
        throw new Error("Windows descendant cleanup could not be verified");
      },
      loadPty: async () => {
        loaded = true;
        throw new Error("Windows admission must precede PTY loading");
      },
    });
    expect(loaded).toBe(false);
    expect(capability).toMatchObject({
      available: false,
      reason: expect.stringContaining(
        "descendant cleanup could not be verified",
      ),
    });
  });
});

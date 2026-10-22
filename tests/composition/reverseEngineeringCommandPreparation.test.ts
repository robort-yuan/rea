import { describe, expect, it, vi } from "vitest";

import { ReverseEngineeringService } from "../../src/application/reverse/ReverseEngineeringService.js";
import { resolveWindowsProviderExecutable } from "../../src/composition/resolveWindowsProviderExecutable.js";
import { createReverseEngineeringCommandPort } from "../../src/composition/reverseEngineering.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import { AnalysisCapabilityUnavailableError } from "../../src/domain/analysisErrorCore.js";

describe("Windows provider command preparation", () => {
  it("routes drive-rooted PATH probes through the terminable owned probe", async () => {
    const expected = "Z:\\tools\\rizin.EXE";
    const ownedProbe = vi.fn((path: string) => path === expected);
    await expect(
      resolveWindowsProviderExecutable(
        "rizin",
        { PATH: "Z:\\tools", PATHEXT: ".EXE" },
        {
          cwd: "C:\\work",
          isOwnedFile: ownedProbe,
        },
      ),
    ).resolves.toBe(expected);
    expect(ownedProbe).toHaveBeenCalledExactlyOnceWith(
      expected,
      expect.any(AbortSignal),
    );
  });

  it("preserves typed failures from asynchronous command preparation", async () => {
    const failure = new AnalysisCapabilityUnavailableError(
      "objdump",
      "inspect_with_objdump",
      "provider selection is unavailable",
      {
        retryable: true,
        remediationAction: "Select a configured executable.",
      },
    );
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const service = new ReverseEngineeringService({
      commands: {
        ...createReverseEngineeringCommandPort({}, "win32"),
        objdump: async () => {
          throw failure;
        },
      },
      run,
    });
    try {
      const result = await service.inspectWithObjdump({
        operation: "architectures",
      });
      expect(result).toEqual({ ok: false, error: failure });
      expect(projectAnalysisError(failure)).toMatchObject({
        code: "capability_unavailable",
        retryable: true,
        remediation: { action: "Select a configured executable." },
      });
      expect(run).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("carries invocation CWD to launch when a bare Windows name stays unresolved", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("C:\\original");
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const service = new ReverseEngineeringService({
      commands: createReverseEngineeringCommandPort(
        { PATH: "D:\\missing", PATHEXT: ".EXE" },
        "win32",
        { windowsExecutableLookup: { isFile: () => false } },
      ),
      run,
    });
    try {
      const operation = service.inspectWithObjdump({
        operation: "architectures",
      });
      cwd.mockReturnValue("D:\\changed");
      await operation;
      expect(run).toHaveBeenCalledWith(
        "objdump",
        expect.any(Array),
        expect.objectContaining({ cwd: "C:\\original" }),
        "inspect_with_objdump",
      );
    } finally {
      cwd.mockRestore();
      await service.close();
    }
  });
});

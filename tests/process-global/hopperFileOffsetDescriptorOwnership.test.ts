import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  path: "",
  failClose: false,
  abortOnClose: undefined as (() => void) | undefined,
  closed: 0,
  handles: [] as FileHandle[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) !== state.path) return handle;
      state.handles.push(handle);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        if (state.abortOnClose !== undefined) {
          const abort = state.abortOnClose;
          state.abortOnClose = undefined;
          abort();
        }
        if (state.failClose) {
          state.failClose = false;
          throw Object.assign(
            new Error("controlled descriptor close failure"),
            {
              code: "EIO",
            },
          );
        }
        await close();
        state.closed += 1;
      };
      return handle;
    }),
  };
});

import { parseConfig } from "../../src/config/parseConfig.js";
import { createAnalysisProfile } from "../../src/domain/analysisProfile.js";
import type { BinaryTarget } from "../../src/domain/binaryTargetTypes.js";
import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import { ok } from "../../src/domain/result.js";
import type { OwnedFileHandle } from "../../src/filesystem/OwnedFileHandle.js";
import { HopperClient } from "../../src/hopper/HopperClient.js";
import { mapHopperFileOffset } from "../../src/hopper/HopperFileOffset.js";
import { HopperProvider } from "../../src/hopper/HopperProvider.js";
import { silentLogger } from "../../src/logger.js";

const targetFor = (path: string, bytes: Buffer): BinaryTarget =>
  ({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    kind: "executable",
    format: "mach-o",
    architecture: "arm64",
    availableArchitectures: ["arm64"],
  }) as BinaryTarget;

const observation = {
  address: "0x1000",
  provider_file_offset: 8,
  provider_source_path: null,
  provider_image_header_hex: null,
};

it("retains a failed-close descriptor and completed mapping facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-hopper-offset-"));
  const path = join(root, "sample");
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  await writeFile(path, bytes);
  state.path = path;
  state.failClose = true;
  state.closed = 0;
  let retained: OwnedFileHandle | undefined;
  try {
    const target = {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      kind: "executable",
      format: "mach-o",
      architecture: "arm64",
      availableArchitectures: ["arm64"],
    } as BinaryTarget;
    const result = await mapHopperFileOffset(
      target,
      {
        address: "0x1000",
        provider_file_offset: 8,
        provider_source_path: null,
        provider_image_header_hex: null,
      },
      undefined,
      {
        retainFailedClose: (owner) => {
          retained = owner;
        },
      },
    );
    if (result.ok) throw new Error("Expected cleanup failure");
    expect(result.error).toBeInstanceOf(ProviderCleanupError);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        resources: [path],
        diagnostics: {
          reason: expect.stringContaining(
            "controlled descriptor close failure",
          ),
          original_file_offset: {
            available: true,
            file_offset: 8,
            image_base_file_offset: 0,
            source_path: path,
          },
        },
      },
    });
    if (retained === undefined) throw new Error("Expected retained owner");
    expect(retained.handle.fd).toBeGreaterThanOrEqual(0);
    await retained.close();
    expect(retained.handle.fd).toBe(-1);
    expect(state.closed).toBeGreaterThanOrEqual(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("retains the provider ownership until close retries the descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-hopper-provider-offset-"));
  const path = join(root, "sample");
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  await writeFile(path, bytes);
  state.path = path;
  state.failClose = true;
  state.closed = 0;
  state.handles = [];
  try {
    const target = {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      kind: "executable",
      format: "mach-o",
      architecture: "arm64",
      availableArchitectures: ["arm64"],
    } as BinaryTarget;
    const config = parseConfig({ HOPPER_LAUNCHER_PATH: process.execPath });
    if (!config.ok) throw config.error;
    const provider = new HopperProvider(config.value, silentLogger, {});
    const profile = createAnalysisProfile(
      { id: "hopper", name: "Hopper", version: "fixture" },
      { macho_container: "thin" },
    );
    const client = provider.createClient(target, profile);
    const call = vi.spyOn(HopperClient.prototype, "callTool").mockResolvedValue(
      ok({
        address: "0x1000",
        provider_file_offset: 8,
        provider_source_path: null,
        provider_image_header_hex: null,
      }),
    );
    try {
      const result = await client.execute("address_to_file_offset", {
        address: "0x1000",
      });
      if (result.ok) throw new Error("Expected cleanup failure");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(provider.hasPendingOwnedResources()).toBe(true);
      const closed = await provider.closeOwnedResources();
      expect(closed.ok).toBe(true);
      expect(provider.hasPendingOwnedResources()).toBe(false);
      expect(state.handles.every((handle) => handle.fd === -1)).toBe(true);
      expect(state.closed).toBeGreaterThanOrEqual(1);
    } finally {
      call.mockRestore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps changed-source failure ahead of mapping when close also fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-hopper-offset-changed-"));
  const path = join(root, "sample");
  const original = Buffer.alloc(64);
  original.writeUInt32LE(0xfeedfacf, 0);
  original.writeUInt32LE(0x0100000c, 4);
  await writeFile(path, original);
  const target = targetFor(path, original);
  const changed = Buffer.from(original);
  changed.writeUInt32LE(0x01000007, 4);
  await writeFile(path, changed);
  state.path = path;
  state.failClose = true;
  state.abortOnClose = undefined;
  state.handles = [];
  let retained: OwnedFileHandle | undefined;
  try {
    const result = await mapHopperFileOffset(target, observation, undefined, {
      retainFailedClose: (owner) => {
        retained = owner;
      },
    });
    if (result.ok) throw new Error("Expected changed-source failure");
    expect(result.error._tag).toBe("AnalysisArtifactChangedError");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        resources: [path],
        execution_failure: "artifact_changed",
      },
    });
    expect(JSON.stringify(projectAnalysisError(result.error))).not.toContain(
      '"available":true',
    );
    if (retained === undefined) throw new Error("Expected retained owner");
    await retained.close();
    expect(retained.handle.fd).toBe(-1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps cancellation primary while retaining failed-close cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-hopper-offset-cancel-close-"));
  const path = join(root, "sample");
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  await writeFile(path, bytes);
  state.path = path;
  state.failClose = true;
  state.handles = [];
  const controller = new AbortController();
  const reason = { requested: "stop after completed read" };
  state.abortOnClose = () => controller.abort(reason);
  let retained: OwnedFileHandle | undefined;
  try {
    const result = await mapHopperFileOffset(
      targetFor(path, bytes),
      observation,
      controller.signal,
      {
        retainFailedClose: (owner) => {
          retained = owner;
        },
      },
    );
    if (result.ok) throw new Error("Expected cancellation with cleanup");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        cleanup: "incomplete",
        resources: [path],
        execution_failure: "cancelled",
        diagnostics: {
          original_file_offset: {
            available: true,
            file_offset: 8,
            image_base_file_offset: 0,
            source_path: path,
          },
        },
      },
    });
    if (retained === undefined) throw new Error("Expected retained owner");
    expect(retained.handle.fd).toBeGreaterThanOrEqual(0);
    await retained.close();
    expect(retained.handle.fd).toBe(-1);
  } finally {
    state.abortOnClose = undefined;
    await rm(root, { recursive: true, force: true });
  }
});

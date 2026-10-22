import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { NativeMacOSProvider } from "./NativeMacOSProvider.js";
import { resolveBundleResourcePlistSelection } from "./NativePlistSource.js";
import { NativeFixtureRunner } from "../../tests/fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { writeFile } from "node:fs/promises";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

it("inspects a resolved app plist without executable identity", async () => {
  const bundle = await createTestTempDirectory("rea-plist-resource-root-");
  const infoPlist = join(bundle, "Info.plist");
  await writeFile(infoPlist, '<?xml version="1.0"?><plist><dict/></plist>');
  const root = {
    callerPath: bundle,
    canonicalPath: bundle,
    infoPlistPath: infoPlist,
    layout: "root" as const,
    executableSha256: null,
  };
  expect(resolveBundleResourcePlistSelection(root, undefined)).toEqual({
    ok: true,
    value: { path: infoPlist, origin: "default" },
  });
  expect(resolveBundleResourcePlistSelection(root, "Info.plist")).toEqual({
    ok: true,
    value: { path: infoPlist, origin: "selected" },
  });
  const client = new NativeMacOSProvider(
    {},
    new NativeFixtureRunner(),
    "darwin",
  ).createBundleResourceClient(root);
  onTestFinished(async () => {
    await client.close();
  });
  const inspected = await client.execute("inspect_plist", {});
  expect(inspected.ok).toBe(true);
  if (inspected.ok)
    expect(inspected.value.result).toMatchObject({
      source_path: infoPlist,
      resource_root: {
        canonical_path: bundle,
        executable_sha256: null,
      },
    });
});

it("reads only absolute plist selections without a target or app root", async () => {
  const directory = await createTestTempDirectory("rea-plist-standalone-");
  const selected = join(directory, "Settings");
  await writeFile(selected, '<?xml version="1.0"?><plist><dict/></plist>');
  const client = new NativeMacOSProvider(
    {},
    new NativeFixtureRunner(),
    "darwin",
  ).createStandalonePlistClient();
  onTestFinished(async () => {
    await client.close();
  });
  const inspected = await client.execute("inspect_plist", { path: selected });
  expect(inspected.ok).toBe(true);
  if (inspected.ok)
    expect(inspected.value.result).toMatchObject({ source_path: selected });
  for (const parameters of [{ path: "Settings" }, {}]) {
    const refused = await client.execute("inspect_plist", parameters);
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(projectAnalysisError(refused.error).code).toBe("invalid_request");
  }
  const hostless = new NativeMacOSProvider(
    {},
    new NativeFixtureRunner(),
    "linux",
  ).createStandalonePlistClient();
  onTestFinished(async () => {
    await hostless.close();
  });
  const unsupported = await hostless.execute("inspect_plist", {
    path: selected,
  });
  expect(unsupported.ok).toBe(false);
  if (!unsupported.ok)
    expect(projectAnalysisError(unsupported.error).code).toBe(
      "capability_unavailable",
    );
});

it("refuses an already cancelled standalone read before running plist commands", async () => {
  const runner = new NativeFixtureRunner();
  const tools: string[] = [];
  const run = runner.run.bind(runner);
  runner.run = (tool, arguments_) => {
    tools.push(tool);
    return run(tool, arguments_);
  };
  const client = new NativeMacOSProvider(
    {},
    runner,
    "darwin",
  ).createStandalonePlistClient();
  onTestFinished(async () => {
    await client.close();
  });
  const controller = new AbortController();
  controller.abort(new Error("caller stopped"));
  const cancelled = await client.execute(
    "inspect_plist",
    { path: "/fixture/Settings" },
    { signal: controller.signal },
  );
  expect(cancelled.ok).toBe(false);
  if (!cancelled.ok)
    expect(projectAnalysisError(cancelled.error).code).toBe("cancelled");
  expect(tools).toEqual([]);
});

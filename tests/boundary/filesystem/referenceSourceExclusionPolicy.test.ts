import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareReferenceSourceImport } from "../../../src/application/ReferenceSourceImportPolicy.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { withArtifactResourceScope } from "../../fixtures/artifactInventory.js";

const prepare = (root: string, excludePaths: readonly string[]) =>
  withArtifactResourceScope((resources) =>
    prepareReferenceSourceImport(
      {
        root,
        caller: "reference-exclusion-policy-test",
        policy: { secretPatterns: [] },
        excludePaths,
      },
      resources,
    ),
  );

describe("reference source exclusion policy", () => {
  it("marks caller rules apart from default rules", async () => {
    const root = await createTestTempDirectory(
      "rea-reference-exclusion-policy-",
    );
    await mkdir(join(root, "vendor"));
    await Promise.all([
      writeFile(join(root, "vendor", "library.ts"), "export const a = 1;\n"),
      writeFile(join(root, "scratch.tmp"), "temporary\n"),
      writeFile(join(root, "source.ts"), "export const value = 1;\n"),
    ]);

    const prepared = await prepare(root, ["vendor", "*.tmp"]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const { ignored } = prepared.value;

    expect(ignored.test("vendor/")).toMatchObject({
      ignored: true,
      rule: { pattern: "vendor", mark: "caller-excluded" },
    });
    expect(ignored.test("scratch.tmp")).toMatchObject({
      ignored: true,
      rule: { pattern: "*.tmp", mark: "caller-excluded" },
    });
    expect(ignored.test("dist/")).toMatchObject({
      ignored: true,
      rule: { mark: "default-ignored" },
    });
    expect(ignored.test("source.ts")).toMatchObject({ ignored: false });
  });

  it("keeps a directory-only rule away from a file with that name", async () => {
    const root = await createTestTempDirectory(
      "rea-reference-exclusion-directory-",
    );
    await mkdir(join(root, "vendor"));

    const prepared = await prepare(root, ["vendor/"]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const { ignored } = prepared.value;

    expect(ignored.test("vendor/")).toMatchObject({
      ignored: true,
      rule: { pattern: "vendor/", mark: "caller-excluded" },
    });
    expect(ignored.test("vendor")).toMatchObject({ ignored: false });
  });
});

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

describe("compiled reference-source exclusion input boundaries", () => {
  cliTest(
    "documents the exclusion option in public command help",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: ["import-reference-source", "--help"],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--exclude-paths");
      expect(result.stdout).toContain("Git-ignore-style path exclusion rules");
    },
  );

  for (const { label, value, issue } of [
    {
      label: "malformed JSON",
      value: "vendor",
      issue: {
        path: ["excludePaths"],
        reason: "invalid_format",
        expected: "JSON",
      },
    },
    {
      label: "a value that is not a rule list",
      value: '"vendor"',
      issue: {
        path: ["excludePaths"],
        reason: "invalid_type",
        expected: "array",
      },
    },
    {
      label: "a rule that is not a string",
      value: '["vendor",7]',
      issue: {
        path: ["excludePaths", 1],
        reason: "invalid_type",
        expected: "string",
      },
    },
    {
      label: "a blank rule",
      value: '["  "]',
      issue: {
        path: ["excludePaths", 0],
        reason: "invalid_value",
        message: "Exclusion rules must not be blank.",
      },
    },
    {
      label: "an absolute host path rule",
      value: '["C:\\\\source"]',
      issue: {
        path: ["excludePaths", 0],
        reason: "invalid_value",
        message:
          "Exclusion rules must be relative to the imported root, not absolute host paths.",
      },
    },
  ]) {
    cliTest(`rejects ${label} before the import starts`, async ({ cli }) => {
      const root = await createTestTempDirectory(
        "rea-reference-exclusion-input-",
      );
      const result = await cli.run({
        arguments: [
          "import-reference-source",
          root,
          "--exclude-paths",
          value,
          "--json",
        ],
        cwd: root,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain("HistoricalSourceGraph");
      expect(result.json).toMatchObject({
        error: "Import failed",
        code: "invalid_request",
        category: "invalid_input",
        details: { operation: "import-reference-source", issues: [issue] },
      });
    });
  }
});

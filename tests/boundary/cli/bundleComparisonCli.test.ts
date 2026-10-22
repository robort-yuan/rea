import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, onTestFinished } from "vitest";

import { createEvidence } from "../../../src/domain/evidence.js";
import {
  bundleComparisonResultSchema,
  compareBundles,
} from "../../../src/domain/bundleComparison.js";
import {
  createEvidenceBundle,
  serializeEvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "compares Evidence bundles without unexplained display-only changes",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-bundle-comparison-cli-");
    const leftPath = join(root, "left.json");
    const displayPath = join(root, "display.json");
    const changedPath = join(root, "changed.json");
    const target = {
      path: join(root, "left.elf"),
      sha256: "a".repeat(64),
      format: "elf" as const,
      architecture: "x86_64" as const,
    };
    const record = createEvidence(
      target,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "observe",
        parameters: {},
        result: { observed: true },
        confidence: "observed",
        authority: "shipped-artifact",
      },
    );
    const left = createEvidenceBundle([record]);
    const displayOnly = {
      ...left,
      records: [
        {
          ...record,
          subject: {
            ...record.subject!,
            name: "renamed.elf",
            local_path: join(root, "renamed.elf"),
          },
        },
      ],
    };
    const different = createEvidenceBundle([
      createEvidence(
        target,
        { id: "fixture", name: "Fixture", version: "1" },
        {
          operation: "observe",
          parameters: {},
          result: { observed: false },
          confidence: "observed",
          authority: "shipped-artifact",
        },
      ),
    ]);
    await Promise.all([
      writeFile(leftPath, serializeEvidenceBundle(left)),
      writeFile(displayPath, serializeEvidenceBundle(displayOnly)),
      writeFile(changedPath, serializeEvidenceBundle(different)),
    ]);
    const compare = async (path: string) =>
      cli.run({ arguments: ["compare", leftPath, path, "--json"] });
    const same = await compare(leftPath);
    expect(same.exitCode).toBe(0);
    expect(bundleComparisonResultSchema.parse(same.json)).toMatchObject({
      status: "unchanged",
      changes: [],
    });
    const display = await compare(displayPath);
    expect(display.exitCode).toBe(0);
    const displayResult = bundleComparisonResultSchema.parse(display.json);
    expect(displayResult).toMatchObject({ status: "unchanged", changes: [] });
    expect(displayResult.left_bundle_sha256).not.toBe(
      displayResult.right_bundle_sha256,
    );
    const differentResult = await compare(changedPath);
    expect(differentResult.exitCode).toBe(0);
    expect(
      bundleComparisonResultSchema.parse(differentResult.json),
    ).toMatchObject({
      status: "unknown",
      summary: { unresolved: 2 },
      changes: [
        expect.objectContaining({
          entity: "evidence",
          conclusion_kind: "unresolved_branch",
        }),
        expect.objectContaining({
          entity: "evidence",
          conclusion_kind: "unresolved_branch",
        }),
      ],
    });
  },
);

const pairedBundles = async () => {
  const root = await createTestTempDirectory("rea-bundle-pairs-cli-");
  const observe = (value: number) =>
    createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "observe",
        parameters: {},
        result: { value },
        confidence: "derived",
        authority: "analyst-inference",
      },
    );
  const leftRecord = observe(1);
  const rightRecord = observe(2);
  const left = createEvidenceBundle([leftRecord]);
  const right = createEvidenceBundle([rightRecord]);
  const leftPath = join(root, "left.json");
  const rightPath = join(root, "right.json");
  const pair = {
    left_evidence_id: leftRecord.evidence_id,
    right_evidence_id: rightRecord.evidence_id,
  };
  await Promise.all([
    writeFile(leftPath, serializeEvidenceBundle(left)),
    writeFile(rightPath, serializeEvidenceBundle(right)),
  ]);
  return { root, left, right, leftPath, rightPath, pair };
};

cliTest(
  "compares only explicitly paired observations from inline JSON or a file",
  async ({ cli }) => {
    const { root, left, right, leftPath, rightPath, pair } =
      await pairedBundles();
    const pairs = JSON.stringify([pair]);
    const pairsPath = join(root, "pairs.json");
    await writeFile(pairsPath, pairs);
    const expected = compareBundles(left, right, [pair]);
    expect(expected).toMatchObject({
      status: "changed",
      summary: { records_changed: 1, unresolved: 0 },
      changes: [
        {
          left_evidence_ids: [pair.left_evidence_id],
          right_evidence_ids: [pair.right_evidence_id],
          conclusion_kind: "observed_change",
        },
      ],
    });
    for (const [command, input] of [
      ["compare", pairs],
      ["compare-bundles", pairsPath],
    ] as const) {
      const result = await cli.run({
        arguments: [
          command,
          leftPath,
          rightPath,
          "--record-pairs",
          input,
          "--json",
        ],
      });
      expect(result.exitCode).toBe(0);
      expect(bundleComparisonResultSchema.parse(result.json)).toEqual(expected);
    }
    const empty = await cli.run({
      arguments: [
        "compare",
        leftPath,
        rightPath,
        "--record-pairs",
        "[]",
        "--json",
      ],
    });
    expect(empty.exitCode).toBe(0);
    expect(bundleComparisonResultSchema.parse(empty.json)).toEqual(
      compareBundles(left, right),
    );
    expect(await readFile(leftPath, "utf8")).toBe(
      serializeEvidenceBundle(left),
    );
    expect(await readFile(rightPath, "utf8")).toBe(
      serializeEvidenceBundle(right),
    );
    const help = await cli.run({ arguments: ["compare", "--help"] });
    expect(help.stdout).toContain("--record-pairs");
    expect(help.stdout).toContain("JSON");
  },
);

cliTest(
  "rejects invalid pair selections without publishing a comparison",
  async ({ cli }) => {
    const { root, leftPath, rightPath, pair } = await pairedBundles();
    const absentId = `ev_${"0".repeat(64)}`;
    const missingFile = join(root, "missing.json");
    for (const [input, code] of [
      ["[", "invalid_request"],
      ["{}", "invalid_request"],
      [
        JSON.stringify([{ ...pair, left_evidence_id: "invalid" }]),
        "invalid_request",
      ],
      [missingFile, "invalid_request"],
      [
        JSON.stringify([{ ...pair, left_evidence_id: absentId }]),
        "evidence_integrity_mismatch",
      ],
      [
        JSON.stringify([{ ...pair, right_evidence_id: absentId }]),
        "evidence_integrity_mismatch",
      ],
      [JSON.stringify([pair, pair]), "evidence_integrity_mismatch"],
    ] as const) {
      const result = await cli.run({
        arguments: [
          "compare",
          leftPath,
          rightPath,
          "--record-pairs",
          input,
          "--json",
        ],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({ code });
      expect(result.json).not.toHaveProperty("status");
      if (input === missingFile)
        expect(result.json).toMatchObject({
          input_path: missingFile,
          input_reason: "read-failed",
        });
    }
  },
);

cliTest(
  "rejects relative bundle paths over stdio MCP while CLI resolves them from its cwd",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-bundle-path-boundary-");
    const leftPath = join(root, "left.json");
    const rightPath = join(root, "right.json");
    const encoded = serializeEvidenceBundle(createEvidenceBundle([]));
    await Promise.all([
      writeFile(leftPath, encoded),
      writeFile(rightPath, encoded),
    ]);

    const client = new Client({
      name: "bundle-path-contract-test",
      version: "1",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../../../scripts/rea.mjs", import.meta.url)),
        "mcp",
      ],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        REA_LOG_LEVEL: "silent",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    onTestFinished(async () => {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    });

    await client.connect(transport);
    for (const [left, right, rejectedField] of [
      ["left.json", "right.json", "left_bundle_path"],
      ["left.json", rightPath, "left_bundle_path"],
      [leftPath, "right.json", "right_bundle_path"],
    ] as const) {
      const result = await client.callTool({
        name: "compare_bundles",
        arguments: { left_bundle_path: left, right_bundle_path: right },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining(
          `${rejectedField}: must be an absolute local filesystem path`,
        ),
      });
    }

    const absolute = await client.callTool({
      name: "compare_bundles",
      arguments: {
        left_bundle_path: leftPath,
        right_bundle_path: rightPath,
      },
    });
    expect(absolute.isError).not.toBe(true);
    expect(absolute.structuredContent).toMatchObject({
      normalized_result: { status: "unchanged" },
    });

    const relativeCli = await cli.run({
      arguments: ["compare", "left.json", "right.json", "--json"],
      cwd: root,
      environment: { HOME: root, REA_LOG_LEVEL: "silent" },
    });
    expect(relativeCli.exitCode).toBe(0);
    expect(bundleComparisonResultSchema.parse(relativeCli.json)).toMatchObject({
      status: "unchanged",
      changes: [],
    });
  },
  60_000,
);
